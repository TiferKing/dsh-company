import { randomUUID } from 'node:crypto'
import { closeSync, fstatSync, openSync, readFileSync, readSync, statSync } from 'node:fs'
import { mkdir, open, stat, type FileHandle } from 'node:fs/promises'
import { dirname, join } from 'node:path'
import { isDeepStrictEqual } from 'node:util'
import { assertNotSymlink, assertNotSymlinkSync, isErrno } from './paths.js'
import { normalizeCompanyState } from './migration.js'
import { assertCompanyState } from './schemas.js'
import type { CompanyState, ResolvedCompanyConfig } from './types.js'

export interface HistoryReference { file: string; bytes: number; rows: number }
export interface HistoryAppend { file: string; offset: number; content: string }
export interface StorageMetadata { version: 1; usage: HistoryReference; audit?: HistoryReference }
export type StoredCompanyState = CompanyState & { _storage?: StorageMetadata }
export interface StateSnapshot { state: CompanyState; stored: StoredCompanyState }

const CACHE_ENTRIES = 4
const CACHE_BYTES = 64 * 1024 * 1024
const HISTORY_NAME = /^(usage|audit)-[0-9a-f-]{36}\.jsonl$/

function historyPath(stateFile: string, name: string): string {
  if (!HISTORY_NAME.test(name)) throw new Error('invalid company history filename')
  return join(dirname(stateFile), 'history', name)
}

function reference(value: unknown): HistoryReference {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid company history reference')
  const row = value as HistoryReference
  if (typeof row.file !== 'string' || !HISTORY_NAME.test(row.file)
    || !Number.isSafeInteger(row.bytes) || row.bytes < 0 || !Number.isSafeInteger(row.rows) || row.rows < 0) throw new Error('invalid company history reference')
  return { file: row.file, bytes: row.bytes, rows: row.rows }
}

export function parseHistoryAppends(value: unknown): HistoryAppend[] {
  if (!Array.isArray(value)) throw new Error('transaction journal history must be an array')
  const seen = new Set<string>()
  return value.map((raw) => {
    if (raw === null || typeof raw !== 'object' || Array.isArray(raw)) throw new Error('invalid transaction history append')
    const row = raw as HistoryAppend
    if (typeof row.file !== 'string' || !HISTORY_NAME.test(row.file) || seen.has(row.file)
      || !Number.isSafeInteger(row.offset) || row.offset < 0 || typeof row.content !== 'string'
      || (row.content !== '' && !row.content.endsWith('\n'))) throw new Error('invalid transaction history append')
    seen.add(row.file)
    return { file: row.file, offset: row.offset, content: row.content }
  })
}

function metadata(value: unknown): StorageMetadata | undefined {
  if (value === undefined) return undefined
  if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid company storage metadata')
  const raw = value as StorageMetadata
  if (raw.version !== 1) throw new Error('unsupported company storage version')
  const usage = reference(raw.usage)
  if (!usage.file.startsWith('usage-')) throw new Error('invalid company usage history reference')
  const audit = raw.audit === undefined ? undefined : reference(raw.audit)
  if (audit !== undefined && !audit.file.startsWith('audit-')) throw new Error('invalid company audit history reference')
  return { version: 1, usage, ...(audit === undefined ? {} : { audit }) }
}

function readPrefixSync(stateFile: string, ref: HistoryReference, appends: HistoryAppend[]): string {
  const overlay = appends.find((entry) => entry.file === ref.file)
  const bytes = overlay?.offset ?? ref.bytes
  if (overlay !== undefined && overlay.offset + Buffer.byteLength(overlay.content) !== ref.bytes) throw new Error('transaction history append does not match target offset')
  const file = historyPath(stateFile, ref.file)
  assertNotSymlinkSync(dirname(file), 'company history directory')
  assertNotSymlinkSync(file, 'company history file')
  let prefix = ''
  if (bytes > 0) {
    let fd: number | undefined
    try {
      fd = openSync(file, 'r')
      if (fstatSync(fd).size < bytes) throw new Error('company history is shorter than its committed prefix')
      const buffer = Buffer.alloc(bytes)
      let offset = 0
      while (offset < bytes) {
        const read = readSync(fd, buffer, offset, bytes - offset, offset)
        if (read === 0) throw new Error('company history is shorter than its committed prefix')
        offset += read
      }
      prefix = buffer.toString('utf8')
    } catch (error) {
      if (isErrno(error, 'ENOENT')) throw new Error('company history is missing; refusing incomplete state', { cause: error })
      throw error
    } finally { if (fd !== undefined) closeSync(fd) }
  }
  return prefix + (overlay?.content ?? '')
}

async function readPrefix(stateFile: string, ref: HistoryReference): Promise<string> {
  const file = historyPath(stateFile, ref.file)
  await assertNotSymlink(dirname(file), 'company history directory')
  await assertNotSymlink(file, 'company history file')
  if (ref.bytes === 0) return ''
  try {
    const handle = await open(file, 'r')
    try {
      if ((await handle.stat()).size < ref.bytes) throw new Error('company history is shorter than its committed prefix')
      const buffer = Buffer.alloc(ref.bytes)
      let offset = 0
      while (offset < ref.bytes) {
        const read = await handle.read(buffer, offset, ref.bytes - offset, offset)
        if (read.bytesRead === 0) throw new Error('company history is shorter than its committed prefix')
        offset += read.bytesRead
      }
      return buffer.toString('utf8')
    } finally { await handle.close() }
  } catch (error) {
    if (isErrno(error, 'ENOENT')) throw new Error('company history is missing; refusing incomplete state', { cause: error })
    throw error
  }
}

function usageRows(content: string, ref: HistoryReference): CompanyState['moneyBudget']['usage'] {
  if (content !== '' && !content.endsWith('\n')) throw new Error('company committed usage history ends in a partial record')
  const rows = content === '' ? [] : content.slice(0, -1).split('\n').map((line) => JSON.parse(line) as CompanyState['moneyBudget']['usage'][number])
  if (rows.length !== ref.rows) throw new Error('company usage history row count does not match its committed prefix')
  return rows
}

function validateAppends(meta: StorageMetadata | undefined, appends: HistoryAppend[]): void {
  for (const append of appends) {
    const ref = [meta?.usage, meta?.audit].find((entry) => entry?.file === append.file)
    if (ref === undefined || append.offset + Buffer.byteLength(append.content) !== ref.bytes) throw new Error('transaction history append does not match a committed reference')
  }
}

/** Recovery must not replace any bytes that the previous state committed. */
export function validateHistoryBase(base: StoredCompanyState | undefined, target: StoredCompanyState, appends: HistoryAppend[]): void {
  for (const append of appends) {
    const previous = [base?._storage?.usage, base?._storage?.audit].find((entry) => entry?.file === append.file)
    if (base?.revision === target.revision) continue // this exact WAL already committed
    if (append.offset !== (previous?.bytes ?? 0)) throw new Error('transaction history base offset conflicts with committed state')
  }
}

function freeze<T>(value: T): T {
  if (value !== null && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) freeze(child)
    Object.freeze(value)
  }
  return value
}

function stamp(info: { dev: bigint; ino: bigint; size: bigint; mtimeNs: bigint; ctimeNs: bigint }): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

/** File-identity cache, bounded by both workspace count and serialized size.
 * Entries are immutable. Atomic company.json replacement invalidates every
 * process's cache, while committed history prefixes never change in place. */
export class CompanyStateStorage {
  private readonly cache = new Map<string, { stamp: string; snapshot: StateSnapshot; bytes: number }>()
  private readonly loading = new Map<string, { stamp: string; promise: Promise<StateSnapshot> }>()
  constructor(private readonly config: ResolvedCompanyConfig) {}

  private decoded(stored: StoredCompanyState, hash: string, rows?: CompanyState['moneyBudget']['usage']): StateSnapshot {
    const { _storage, ...value } = stored
    const state = normalizeCompanyState(rows === undefined ? value : { ...value, moneyBudget: { ...value.moneyBudget, usage: rows } }, this.config)
    assertCompanyState(state, hash)
    const normalizedStored = _storage === undefined ? state : { ...state, moneyBudget: { ...state.moneyBudget, usage: [] }, _storage }
    return freeze({ state, stored: normalizedStored })
  }

  decodeSync(value: unknown, file: string, hash: string, appends: HistoryAppend[] = []): StateSnapshot {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid company state')
    const stored = value as StoredCompanyState
    const meta = metadata(stored._storage)
    validateAppends(meta, appends)
    if (meta !== undefined && (!Array.isArray(stored.moneyBudget?.usage) || stored.moneyBudget.usage.length !== 0)) throw new Error('split company state must not contain inline usage')
    if (meta?.audit !== undefined) {
      const filePath = historyPath(file, meta.audit.file)
      assertNotSymlinkSync(dirname(filePath), 'company history directory')
      assertNotSymlinkSync(filePath, 'company history file')
      const bytes = appends.find((entry) => entry.file === meta.audit!.file)?.offset ?? meta.audit.bytes
      if (bytes > 0) {
        try { if (statSync(filePath).size < bytes) throw new Error('company audit history is shorter than its committed prefix') }
        catch (error) { if (isErrno(error, 'ENOENT')) throw new Error('company audit history is missing', { cause: error }); throw error }
      }
    }
    return this.decoded(stored, hash, meta === undefined ? undefined : usageRows(readPrefixSync(file, meta.usage, appends), meta.usage))
  }

  private remember(file: string, version: string, snapshot: StateSnapshot, hotBytes: number): StateSnapshot {
    const bytes = hotBytes + (snapshot.stored._storage?.usage.bytes ?? 0)
    this.cache.delete(file)
    if (bytes <= CACHE_BYTES) this.cache.set(file, { stamp: version, snapshot, bytes })
    let total = [...this.cache.values()].reduce((sum, entry) => sum + entry.bytes, 0)
    while (this.cache.size > CACHE_ENTRIES || total > CACHE_BYTES) {
      const oldest = this.cache.keys().next().value!
      total -= this.cache.get(oldest)!.bytes
      this.cache.delete(oldest)
    }
    return snapshot
  }

  private async load(handle: FileHandle, file: string, hash: string, version: string, hotBytes: number): Promise<StateSnapshot> {
    const stored = JSON.parse((await handle.readFile('utf8')).replace(/^\uFEFF/, '')) as StoredCompanyState
    const meta = metadata(stored?._storage)
    if (meta !== undefined && (!Array.isArray(stored.moneyBudget?.usage) || stored.moneyBudget.usage.length !== 0)) throw new Error('split company state must not contain inline usage')
    const rows = meta === undefined ? undefined : usageRows(await readPrefix(file, meta.usage), meta.usage)
    if (meta?.audit !== undefined && meta.audit.bytes > 0) {
      const auditFile = historyPath(file, meta.audit.file)
      await assertNotSymlink(dirname(auditFile), 'company history directory')
      await assertNotSymlink(auditFile, 'company history file')
      try { if ((await stat(auditFile)).size < meta.audit.bytes) throw new Error('company audit history is shorter than its committed prefix') }
      catch (error) { if (isErrno(error, 'ENOENT')) throw new Error('company audit history is missing', { cause: error }); throw error }
    }
    return this.remember(file, version, this.decoded(stored, hash, rows), hotBytes)
  }

  async read(file: string, hash: string): Promise<StateSnapshot | undefined> {
    await assertNotSymlink(file, 'company state file')
    let handle
    try { handle = await open(file, 'r') } catch (error) {
      if (isErrno(error, 'ENOENT')) { this.cache.delete(file); return undefined }
      throw error
    }
    let openedStamp: string | undefined
    try {
      const info = await handle.stat({ bigint: true })
      const version = stamp(info)
      openedStamp = version
      const cached = this.cache.get(file)
      if (cached?.stamp === version) return cached.snapshot
      let loading = this.loading.get(file)
      if (loading?.stamp !== version) {
        loading = { stamp: version, promise: this.load(handle, file, hash, version, Number(info.size)) }
        this.loading.set(file, loading)
      }
      try { return await loading.promise }
      finally { if (this.loading.get(file) === loading) this.loading.delete(file) }
    } catch (error) {
      // active/ may be moved to archive between opening company.json and its
      // history. Retry a replacement identity; missing committed history with
      // the same company-file identity remains a hard corruption error.
      let current
      try { current = await stat(file, { bigint: true }) } catch (lookupError) {
        if (isErrno(lookupError, 'ENOENT')) { this.cache.delete(file); return undefined }
        throw error
      }
      if (openedStamp === undefined || stamp(current) === openedStamp) throw error
    } finally { await handle.close() }
    return this.read(file, hash)
  }

  readSync(file: string, hash: string): StateSnapshot | undefined {
    assertNotSymlinkSync(file, 'company state file')
    let fd: number
    try { fd = openSync(file, 'r') } catch (error) {
      if (isErrno(error, 'ENOENT')) { this.cache.delete(file); return undefined }
      throw error
    }
    let openedStamp: string | undefined
    try {
      const info = fstatSync(fd, { bigint: true })
      const version = stamp(info)
      openedStamp = version
      const cached = this.cache.get(file)
      if (cached?.stamp === version) return cached.snapshot
      return this.remember(file, version, this.decodeSync(JSON.parse(readFileSync(fd, 'utf8').replace(/^\uFEFF/, '')), file, hash), Number(info.size))
    } catch (error) {
      let current
      try { current = statSync(file, { bigint: true }) } catch (lookupError) {
        if (isErrno(lookupError, 'ENOENT')) { this.cache.delete(file); return undefined }
        throw error
      }
      if (openedStamp === undefined || stamp(current) === openedStamp) throw error
    } finally { closeSync(fd) }
    return this.readSync(file, hash)
  }

  /** Publish a separately owned immutable view after an atomic commit. */
  async committed(file: string, state: CompanyState, stored: StoredCompanyState): Promise<void> {
    const handle = await open(file, 'r')
    try {
      const info = await handle.stat({ bigint: true })
      const ownedState = structuredClone(state)
      const ownedStored = { ...ownedState, moneyBudget: { ...ownedState.moneyBudget, usage: [] }, _storage: structuredClone(stored._storage) }
      this.remember(file, stamp(info), freeze({ state: ownedState, stored: ownedStored }), Number(info.size))
    } finally { await handle.close() }
  }
}

/** Preserve immutable history prefixes. A general mutation that edits old rows
 * starts a new generation, leaving the previous generation available for audit. */
export function prepareStoredState(state: CompanyState, base?: StateSnapshot, audit?: { before: string; line: string }): { stored: StoredCompanyState; appends: HistoryAppend[] } {
  const appends: HistoryAppend[] = []
  const previous = base?.stored._storage
  const oldRows = base?.state.moneyBudget.usage ?? []
  const rows = state.moneyBudget.usage
  const appendOnly = previous !== undefined && rows.length >= oldRows.length && oldRows.every((entry, index) => isDeepStrictEqual(entry, rows[index]))
  const usageBase = appendOnly ? previous.usage : { file: `usage-${randomUUID()}.jsonl`, bytes: 0, rows: 0 }
  const added = rows.slice(appendOnly ? oldRows.length : 0)
  const usageContent = added.map((entry) => `${JSON.stringify(entry)}\n`).join('')
  const usage = { ...usageBase, bytes: usageBase.bytes + Buffer.byteLength(usageContent), rows: rows.length }
  if (usageContent !== '') appends.push({ file: usage.file, offset: usageBase.bytes, content: usageContent })
  let auditRef = previous?.audit
  if (audit !== undefined) {
    const prefix = auditRef === undefined && audit.before !== '' ? `${audit.before.replace(/\n?$/, '')}\n` : ''
    const content = `${prefix}${audit.line}\n`
    const auditBase = auditRef ?? { file: `audit-${randomUUID()}.jsonl`, bytes: 0, rows: 0 }
    appends.push({ file: auditBase.file, offset: auditBase.bytes, content })
    auditRef = { file: auditBase.file, bytes: auditBase.bytes + Buffer.byteLength(content), rows: auditBase.rows + content.split('\n').length - 1 }
  }
  const stored: StoredCompanyState = { ...state, moneyBudget: { ...state.moneyBudget, usage: [] }, _storage: { version: 1, usage, ...(auditRef === undefined ? {} : { audit: auditRef }) } }
  return { stored, appends }
}

/** Idempotent WAL replay: overwrite only the uncommitted suffix, fsync it, then
 * let company.json publish the new committed prefix. Never mutate old prefixes. */
export async function applyHistoryAppends(stateFile: string, appends: HistoryAppend[]): Promise<void> {
  for (const append of appends) {
    const file = historyPath(stateFile, append.file)
    await assertNotSymlink(dirname(file), 'company history directory')
    await mkdir(dirname(file), { recursive: true, mode: 0o700 })
    await assertNotSymlink(file, 'company history file')
    let handle
    try { handle = await open(file, 'r+') } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      if (append.offset !== 0) throw new Error('company history is missing before transaction append', { cause: error })
      handle = await open(file, 'wx+', 0o600)
    }
    try {
      if ((await handle.stat()).size < append.offset) throw new Error('company history is shorter than transaction base offset')
      const content = Buffer.from(append.content)
      let written = 0
      while (written < content.length) {
        const result = await handle.write(content, written, content.length - written, append.offset + written)
        if (result.bytesWritten === 0) throw new Error('company history write made no progress')
        written += result.bytesWritten
      }
      await handle.truncate(append.offset + content.length)
      await handle.sync()
    } finally { await handle.close() }
  }
}
