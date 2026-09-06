import { createHash, randomUUID } from 'node:crypto'
import { constants, type BigIntStats } from 'node:fs'
import { lstat, open, readFile, readlink, rename, unlink } from 'node:fs/promises'
import { withFileLock } from '@deepseek-ai/dsh-atomic-write'

type OwnerState = 'alive' | 'dead' | 'unknown'
interface LockScope { platform: 'linux'; bootId: string; pidNamespace: string }
interface LockOwner { version: 1; pid: number; scope: LockScope }
interface LockCandidate { identity: string; content: string; pid: number; scope?: LockScope }
const MAX_LOCK_BYTES = 1024
let cachedScope: Promise<LockScope | undefined> | undefined
export interface CompanyFileLockOptions {
  waitMs?: number
  onRecovered?: (pid: number) => void
}

function isErrno(error: unknown, code: string): boolean {
  return typeof error === 'object' && error !== null && 'code' in error && error.code === code
}

function identity(info: BigIntStats): string {
  return `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
}

function ownerState(pid: number): OwnerState {
  try { process.kill(pid, 0); return 'alive' }
  catch (error) { return isErrno(error, 'ESRCH') ? 'dead' : 'unknown' }
}

function processScope(): Promise<LockScope | undefined> {
  return cachedScope ??= (async () => {
    if (process.platform !== 'linux') return undefined
    try {
      const [bootId, pidNamespace] = await Promise.all([readFile('/proc/sys/kernel/random/boot_id', 'utf8'), readlink('/proc/self/ns/pid')])
      return parseScope({ platform: 'linux', bootId: bootId.trim(), pidNamespace })
    } catch { return undefined }
  })()
}

function parseScope(value: unknown): LockScope | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const scope = value as LockScope
  if (Object.keys(scope).sort().join(',') !== 'bootId,pidNamespace,platform' || scope.platform !== 'linux'
    || typeof scope.bootId !== 'string' || !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u.test(scope.bootId)
    || typeof scope.pidNamespace !== 'string' || !/^pid:\[[0-9]+\]$/u.test(scope.pidNamespace)) return undefined
  return scope
}

function parseOwner(content: string): { pid: number; scope?: LockScope } | undefined {
  // Legacy Host locks remain readable for annotating a lock we just acquired,
  // but absence of a scope never authorizes recovery of an existing lock.
  const legacy = /^([1-9][0-9]{0,9})\n?$/u.exec(content)
  if (legacy !== null) {
    const pid = Number(legacy[1])
    return pid <= 2_147_483_647 ? { pid } : undefined
  }
  try {
    const owner = JSON.parse(content) as LockOwner
    if (owner === null || typeof owner !== 'object' || Array.isArray(owner)
      || Object.keys(owner).sort().join(',') !== 'pid,scope,version' || owner.version !== 1
      || !Number.isSafeInteger(owner.pid) || owner.pid < 1 || owner.pid > 2_147_483_647) return undefined
    const scope = parseScope(owner.scope)
    return scope === undefined ? undefined : { pid: owner.pid, scope }
  } catch { return undefined }
}

function sameScope(left: LockScope | undefined, right: LockScope | undefined): boolean {
  return left !== undefined && right !== undefined && left.platform === right.platform
    && left.bootId === right.bootId && left.pidNamespace === right.pidNamespace
}

/** Read a bounded, stable regular file without following a lock symlink. */
async function candidateAt(lockPath: string): Promise<LockCandidate | undefined> {
  let handle
  try {
    const before = await lstat(lockPath, { bigint: true })
    if (!before.isFile() || before.size > BigInt(MAX_LOCK_BYTES)) return undefined
    handle = await open(lockPath, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0))
    const opened = await handle.stat({ bigint: true })
    if (!opened.isFile() || identity(before) !== identity(opened)) return undefined
    const buffer = Buffer.alloc(MAX_LOCK_BYTES + 1)
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0)
    if (bytesRead > MAX_LOCK_BYTES || BigInt(bytesRead) !== opened.size) return undefined
    const content = buffer.toString('utf8', 0, bytesRead)
    const owner = parseOwner(content)
    if (owner === undefined) return undefined
    const after = await lstat(lockPath, { bigint: true })
    if (!after.isFile() || identity(opened) !== identity(after)) return undefined
    return { identity: identity(opened), content, ...owner }
  } catch (error) {
    if (['ENOENT', 'ELOOP', 'EACCES', 'EPERM'].some((code) => isErrno(error, code))) return undefined
    throw error
  } finally { await handle?.close() }
}

/** Annotate only the exact regular lock created for us by the Host protocol. */
async function annotateOwnedLock(lockPath: string): Promise<void> {
  const scope = await processScope()
  if (scope === undefined) return // unsupported or unavailable namespace proof
  const candidate = await candidateAt(lockPath)
  if (candidate === undefined || candidate.pid !== process.pid || candidate.scope !== undefined) throw new Error('company writer lock changed before ownership annotation')
  const handle = await open(lockPath, constants.O_RDWR | (constants.O_NOFOLLOW ?? 0))
  try {
    const current = await handle.stat({ bigint: true })
    const named = await lstat(lockPath, { bigint: true })
    if (!current.isFile() || !named.isFile() || identity(current) !== candidate.identity || identity(named) !== candidate.identity) throw new Error('company writer lock changed before ownership annotation')
    const content = `${JSON.stringify({ version: 1, pid: process.pid, scope } satisfies LockOwner)}\n`
    await handle.writeFile(content)
    await handle.truncate(Buffer.byteLength(content))
  } finally { await handle.close() }
}

/**
 * Recover only a demonstrably dead owner in the same boot and PID namespace.
 * Bare legacy PIDs, foreign namespaces and unavailable scope fail closed.
 * A claim tied to the old inode elects
 * one reaper, which rechecks the file and owner before quarantining the lock.
 * Ordinary writers retain the Host's wx lock protocol. A reaper that itself
 * crashes before quarantine leaves its claim in place: we deliberately fail
 * closed instead of recursively guessing whether another recovery is safe.
 */
export async function recoverAbandonedCompanyLock(
  lockPath: string,
  probe: (pid: number) => OwnerState = ownerState,
): Promise<number | undefined> {
  const candidate = await candidateAt(lockPath)
  if (candidate === undefined || !sameScope(candidate.scope, await processScope()) || probe(candidate.pid) !== 'dead') return undefined
  const key = createHash('sha256').update(candidate.identity).update('\0').update(candidate.content).digest('hex').slice(0, 24)
  const claimPath = `${lockPath}.recover-${key}`
  let claim
  try {
    claim = await open(claimPath, 'wx', 0o600)
  } catch (error) {
    if (['EEXIST', 'EPERM', 'EACCES'].some((code) => isErrno(error, code))) return undefined
    throw error
  }
  let claimIdentity: string | undefined
  try {
    await claim.writeFile(`${process.pid}\n`)
    claimIdentity = identity(await claim.stat({ bigint: true }))
    const fresh = await candidateAt(lockPath)
    if (fresh?.identity !== candidate.identity || fresh.content !== candidate.content || probe(candidate.pid) !== 'dead') return undefined
    await rename(lockPath, `${lockPath}.stale-${candidate.pid}-${randomUUID()}`)
    return candidate.pid
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return undefined
    throw error
  } finally {
    await claim.close()
    try {
      const current = await lstat(claimPath, { bigint: true })
      if (claimIdentity !== undefined && current.isFile() && identity(current) === claimIdentity) await unlink(claimPath)
    } catch (error) { if (!isErrno(error, 'ENOENT')) throw error }
  }
}

/** Keep the Host lock protocol, adding conservative crash recovery on retry. */
export async function withCompanyFileLock<T>(filename: string, operation: () => Promise<T>, options: CompanyFileLockOptions = {}): Promise<T> {
  const deadline = Date.now() + (options.waitMs ?? 30_000)
  const lockPath = `${filename}.lock`
  for (;;) {
    const recovered = await recoverAbandonedCompanyLock(lockPath)
    if (recovered !== undefined) options.onRecovered?.(recovered)
    let started = false
    try {
      return await withFileLock(filename, async () => {
        started = true
        await annotateOwnedLock(lockPath)
        return operation()
      }, { waitMs: Math.max(0, Math.min(200, deadline - Date.now())) })
    } catch (error) {
      // Never repeat an operation which threw after acquiring its lock.
      if (started || !(error instanceof Error) || !error.message.startsWith('atomic-write: timed out waiting for the writer lock') || Date.now() >= deadline) throw error
    }
  }
}
