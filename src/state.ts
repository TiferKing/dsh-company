import { readFileSync } from 'node:fs'
import { mkdir, readFile, readdir, rename, rm } from 'node:fs/promises'
import { basename, dirname, join } from 'node:path'
import { withFileLock, writeFileAtomic } from '@deepseek-ai/dsh-atomic-write'
import {
  assertNotSymlink,
  assertNotSymlinkSync,
  canonicalWorkspace,
  canonicalWorkspaceSync,
  ensurePrivateRoot,
  isErrno,
  workspacePaths,
} from './paths.js'
import { assertCompanyMessage, assertCompanyState } from './schemas.js'
import { normalizeCompanyState } from './migration.js'
import { reconcilePreparedReservations } from './budget.js'
import { releaseEmployeeReservations } from './tokens.js'
import { releaseEmployeeMoneyReservations, releaseMoneyReservation } from './money.js'
import { consumeApproval, requireApproved } from './approvals.js'
import type {
  CompanyAuditEvent,
  CompanyMessage,
  CompanyState,
  ResolvedCompanyConfig,
  WorkspaceIdentity,
  WorkspacePaths,
} from './types.js'

const FILE_MODE = 0o600
const DIR_MODE = 0o700
const LOCK_WAIT_MS = 30_000

export interface MutationContext {
  paths: WorkspacePaths
  readMailbox(participantId: 'founder' | string): Promise<CompanyMessage[]>
  writeMailbox(participantId: 'founder' | string, messages: CompanyMessage[]): Promise<void>
}

export interface MutationOptions {
  expectedRevision?: number
  actor: 'founder' | 'scheduler' | 'human-ui' | string
  type: string
  summary: string
}

export interface CompanyStoreOptions {
  onWarning?: (message: string, error?: unknown) => void
}

/** Workspace-keyed, schema-validating durable company storage. */
export class CompanyStore {
  readonly config: ResolvedCompanyConfig
  private readonly queues = new Map<string, Promise<void>>()
  private readonly onWarning: (message: string, error?: unknown) => void

  constructor(config: ResolvedCompanyConfig, options: CompanyStoreOptions = {}) {
    this.config = config
    this.onWarning = options.onWarning ?? (() => undefined)
  }

  async pathsForCwd(cwd: string | undefined, create = true): Promise<WorkspacePaths> {
    const workspace = await canonicalWorkspace(cwd)
    const paths = workspacePaths(this.config.stateRoot, workspace)
    if (create) {
      await this.ensureWorkspacePaths(paths)
    } else {
      await assertNotSymlink(this.config.stateRoot, 'dsh-company state root')
      await assertNotSymlink(paths.root, 'dsh-company workspace state root')
      await assertNotSymlink(paths.activeDir, 'dsh-company active directory')
      await assertNotSymlink(paths.identityFile, 'dsh-company workspace identity file')
      try {
        const parsed: unknown = JSON.parse(stripBom(await readFile(paths.identityFile, 'utf8')))
        this.verifyIdentity(parsed, paths.workspace)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
    }
    return paths
  }

  pathsForCwdSync(cwd: string | undefined): WorkspacePaths {
    const workspace = canonicalWorkspaceSync(cwd)
    const paths = workspacePaths(this.config.stateRoot, workspace)
    assertNotSymlinkSync(this.config.stateRoot, 'dsh-company state root')
    assertNotSymlinkSync(paths.root, 'dsh-company workspace state root')
    assertNotSymlinkSync(paths.activeDir, 'dsh-company active directory')
    assertNotSymlinkSync(paths.identityFile, 'dsh-company workspace identity file')
    this.verifyIdentitySync(paths)
    return paths
  }

  async createStaged(cwd: string | undefined, state: CompanyState): Promise<CompanyState> {
    const paths = await this.pathsForCwd(cwd, true)
    const normalized = normalizeCompanyState(state, this.config)
    assertCompanyState(normalized, paths.workspace.sha256)
    state = normalized
    return this.serialize(paths.root, async () => {
      await assertNotSymlink(paths.activeDir, 'dsh-company active directory')
      try {
        await mkdir(paths.activeDir, { mode: DIR_MODE })
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw new Error('an active company already exists for this workspace')
        throw error
      }
      let committed = false
      try {
        await mkdir(paths.mailboxDir, { recursive: true, mode: DIR_MODE })
        await writeFileAtomic(paths.stateFile, serializeJson(state), { mode: FILE_MODE, dirMode: DIR_MODE })
        await writeFileAtomic(paths.auditFile, '', { mode: FILE_MODE, dirMode: DIR_MODE })
        committed = true
        return structuredClone(state)
      } finally {
        if (!committed) await rm(paths.activeDir, { recursive: true, force: true }).catch(() => undefined)
      }
    })
  }

  async readActive(cwd: string | undefined): Promise<CompanyState | undefined> {
    const paths = await this.pathsForCwd(cwd, false)
    return this.readStateFile(paths.stateFile, paths.workspace.sha256)
  }

  readActiveSync(cwd: string | undefined): CompanyState | undefined {
    const paths = this.pathsForCwdSync(cwd)
    try {
      const parsed = normalizeCompanyState(JSON.parse(stripBom(readFileSync(paths.stateFile, 'utf8'))), this.config)
      assertCompanyState(parsed, paths.workspace.sha256)
      return parsed
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      throw error
    }
  }

  async transact<T>(
    cwd: string | undefined,
    options: MutationOptions,
    mutation: (state: CompanyState, context: MutationContext) => Promise<T> | T,
  ): Promise<{ state: CompanyState; result: T }> {
    const paths = await this.pathsForCwd(cwd, false)
    return this.serialize(paths.stateFile, async () => {
      await assertNotSymlink(paths.activeDir, 'dsh-company active directory')
      await mkdir(dirname(paths.stateFile), { recursive: true, mode: DIR_MODE })
      return withFileLock(paths.stateFile, async () => {
        const state = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
        if (state === undefined) throw new Error('no active company exists for this workspace')
        if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
          throw new RevisionConflictError(options.expectedRevision, state.revision)
        }
        // Mailbox mutations are staged in memory and flushed only after the
        // state write succeeds, so a failed mutation never leaves mailbox
        // changes behind while the state rolls back.
        const pendingMailboxes = new Map<string, CompanyMessage[]>()
        const context: MutationContext = {
          paths,
          readMailbox: (participantId) => {
            const buffered = pendingMailboxes.get(participantId)
            if (buffered !== undefined) return Promise.resolve(structuredClone(buffered))
            return this.readMailboxFile(paths, participantId, state.limits.maxMailboxMessages)
          },
          writeMailbox: (participantId, messages) => {
            if (messages.length > state.limits.maxMailboxMessages) throw new Error(`mailbox ${participantId} is full (${state.limits.maxMailboxMessages}); compact read records before sending more`)
            for (const message of messages) {
              assertCompanyMessage(message)
              if (message.to !== participantId) throw new Error('mailbox recipient mismatch')
            }
            pendingMailboxes.set(participantId, structuredClone(messages))
            return Promise.resolve()
          },
        }
        const result = await mutation(state, context)
        state.revision += 1
        state.updatedAt = Date.now()
        state.counters.event += 1
        assertCompanyState(state, paths.workspace.sha256)
        // Persist the audit row before the state: a mutation never commits
        // without its audit record, and an audit failure aborts the
        // transaction entirely.
        await writeFileAtomic(paths.auditFile, await this.buildAuditContent(paths, state, options), { mode: FILE_MODE, dirMode: DIR_MODE })
        try {
          await writeFileAtomic(paths.stateFile, serializeJson(state), { mode: FILE_MODE, dirMode: DIR_MODE })
        } catch (error) {
          await this.appendAuditRollback(paths, state, options).catch((rollbackError) => {
            this.onWarning(`dsh-company audit rollback append failed for ${state.id}`, rollbackError)
          })
          throw error
        }
        for (const [participantId, messages] of pendingMailboxes) {
          await this.writeMailboxFile(paths, participantId, messages, state.limits.maxMailboxMessages).catch((error) => {
            this.onWarning(`dsh-company mailbox flush failed for ${participantId} after state commit`, error)
          })
        }
        return { state: structuredClone(state), result }
      }, { waitMs: LOCK_WAIT_MS })
    })
  }

  async readMailbox(cwd: string | undefined, participantId: 'founder' | string): Promise<CompanyMessage[]> {
    const paths = await this.pathsForCwd(cwd, false)
    const state = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
    if (state === undefined) return []
    return this.readMailboxFile(paths, participantId, state.limits.maxMailboxMessages)
  }

  async archive(cwd: string | undefined, expectedRevision?: number, forcedApprovalId?: string): Promise<CompanyState> {
    const paths = await this.pathsForCwd(cwd, false)
    const closed = await this.transact(cwd, {
      expectedRevision,
      actor: 'founder',
      type: 'company.archived',
      summary: 'Company archived and scheduling authority revoked',
    }, (state) => {
      reconcilePreparedReservations(state)
      // The forced-archive authorization is consumed atomically with the
      // archive marking so a failed archive never burns the approval.
      if (forcedApprovalId !== undefined) consumeApproval(requireApproved(state, forcedApprovalId, 'forced_archive'))
      state.phase = 'archived'
      state.archivedAt = Date.now()
      for (const employee of state.employees) {
        releaseEmployeeReservations(state, employee.id)
        releaseEmployeeMoneyReservations(state, employee.id)
        if (employee.status !== 'retired') employee.status = 'retired'
        employee.retiredAt ??= Date.now()
      }
      for (const work of state.workItems) {
        if (work.status === 'claimed' || work.status === 'in_progress') {
          if (work.reservationId !== undefined) releaseMoneyReservation(state, work.reservationId)
          work.attemptHistory.push({
            attempt: work.attempt,
            ...(work.assigneeId === undefined ? {} : { assigneeId: work.assigneeId }),
            status: 'cancelled',
            output: 'Company archived; attempt capability revoked.',
            closedAt: Date.now(),
          })
        }
        if (work.status === 'pending' || work.status === 'claimed' || work.status === 'in_progress') work.status = 'cancelled'
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
        work.updatedAt = Date.now()
      }
    })
    const target = join(paths.archiveDir, closed.state.id)
    await this.serialize(paths.root, async () => {
      await mkdir(paths.archiveDir, { recursive: true, mode: DIR_MODE })
      try {
        await mkdir(target, { mode: DIR_MODE })
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw new Error(`archive ${closed.state.id} already exists; refusing to overwrite it`)
        throw error
      }
      await rm(target, { recursive: true, force: true })
      try {
        await rename(paths.activeDir, target)
      } catch (error) {
        throw new Error(`company state was marked archived but active directory move failed: ${String(error)}`, { cause: error })
      }
    })
    return closed.state
  }

  async readArchived(cwd: string | undefined, companyId?: string): Promise<CompanyState[]> {
    const paths = await this.pathsForCwd(cwd, false)
    let entries
    try {
      entries = await readdir(paths.archiveDir, { withFileTypes: true })
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
    const states: CompanyState[] = []
    for (const entry of entries) {
      if (!entry.isDirectory() || (companyId !== undefined && entry.name !== companyId)) continue
      const state = await this.readStateFile(join(paths.archiveDir, entry.name, 'company.json'), paths.workspace.sha256)
      if (state !== undefined) states.push(state)
    }
    return states.sort((a, b) => (b.archivedAt ?? b.updatedAt) - (a.archivedAt ?? a.updatedAt))
  }

  async recordRetiredSession(cwd: string | undefined, sessionId: string): Promise<void> {
    const paths = await this.pathsForCwd(cwd, true)
    await this.serialize(paths.retiredSessionsFile, async () => {
      await mkdir(dirname(paths.retiredSessionsFile), { recursive: true, mode: DIR_MODE })
      await withFileLock(paths.retiredSessionsFile, async () => {
        let ids: string[] = []
        try {
          const parsed: unknown = JSON.parse(stripBom(await readFile(paths.retiredSessionsFile, 'utf8')))
          if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== 'string' || item === '')) throw new Error('invalid retired-sessions index')
          ids = parsed
        } catch (error) {
          if (!isErrno(error, 'ENOENT')) throw error
        }
        if (!ids.includes(sessionId)) ids.push(sessionId)
        ids.sort()
        await writeFileAtomic(paths.retiredSessionsFile, serializeJson(ids), { mode: FILE_MODE, dirMode: DIR_MODE })
      }, { waitMs: LOCK_WAIT_MS })
    })
  }

  async isRetiredSession(cwd: string | undefined, sessionId: string): Promise<boolean> {
    const paths = await this.pathsForCwd(cwd, false)
    try {
      const parsed: unknown = JSON.parse(stripBom(await readFile(paths.retiredSessionsFile, 'utf8')))
      return Array.isArray(parsed) && parsed.includes(sessionId)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return false
      throw error
    }
  }

  private async ensureWorkspacePaths(paths: WorkspacePaths): Promise<void> {
    await ensurePrivateRoot(this.config.stateRoot)
    await assertNotSymlink(paths.root, 'dsh-company workspace state root')
    await mkdir(paths.root, { recursive: true, mode: DIR_MODE })
    await assertNotSymlink(paths.root, 'dsh-company workspace state root')
    await assertNotSymlink(paths.identityFile, 'dsh-company workspace identity file')
    await withFileLock(paths.identityFile, async () => {
      await assertNotSymlink(paths.identityFile, 'dsh-company workspace identity file')
      try {
        const parsed: unknown = JSON.parse(stripBom(await readFile(paths.identityFile, 'utf8')))
        this.verifyIdentity(parsed, paths.workspace)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
        await writeFileAtomic(paths.identityFile, serializeJson(paths.workspace), { mode: FILE_MODE, dirMode: DIR_MODE })
        const parsed: unknown = JSON.parse(stripBom(await readFile(paths.identityFile, 'utf8')))
        this.verifyIdentity(parsed, paths.workspace)
      }
    }, { waitMs: LOCK_WAIT_MS })
  }

  private verifyIdentitySync(paths: WorkspacePaths): void {
    try {
      const parsed: unknown = JSON.parse(stripBom(readFileSync(paths.identityFile, 'utf8')))
      this.verifyIdentity(parsed, paths.workspace)
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return
      throw error
    }
  }

  private verifyIdentity(value: unknown, expected: WorkspaceIdentity): void {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid dsh-company workspace identity')
    const identity = value as Partial<WorkspaceIdentity>
    if (identity.schemaVersion !== 1 || identity.canonicalPath !== expected.canonicalPath || identity.sha256 !== expected.sha256 || identity.key !== expected.key) {
      throw new Error('dsh-company workspace identity hash/path mismatch; refusing cross-workspace state access')
    }
  }

  private async readStateFile(file: string, workspaceHash: string): Promise<CompanyState | undefined> {
    try {
      const raw = await readFile(file, 'utf8')
      const parsed = normalizeCompanyState(JSON.parse(stripBom(raw)), this.config)
      assertCompanyState(parsed, workspaceHash)
      return parsed
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return undefined
      if (error instanceof SyntaxError) throw new Error(`malformed dsh-company state in ${basename(file)}; refusing to treat it as absent`, { cause: error })
      throw error
    }
  }

  private mailboxFile(paths: WorkspacePaths, participantId: 'founder' | string): string {
    if (participantId !== 'founder' && !/^e[1-9][0-9]*$/.test(participantId)) throw new Error('invalid mailbox participant id')
    return join(paths.mailboxDir, `${participantId}.jsonl`)
  }

  private async readMailboxFile(paths: WorkspacePaths, participantId: 'founder' | string, cap: number): Promise<CompanyMessage[]> {
    const file = this.mailboxFile(paths, participantId)
    try {
      const raw = await readFile(file, 'utf8')
      const lines = raw.split('\n')
      const messages: CompanyMessage[] = []
      for (let index = 0; index < lines.length; index += 1) {
        const line = stripBom(lines[index] ?? '')
        if (line.trim() === '') continue
        try {
          const value: unknown = JSON.parse(line)
          assertCompanyMessage(value)
          if (value.to !== participantId) throw new Error(`mailbox recipient mismatch at line ${index + 1}`)
          messages.push(value)
        } catch (error) {
          const tornFinal = index === lines.length - 1 && !raw.endsWith('\n')
          if (tornFinal) {
            this.onWarning(`ignored torn final mailbox line ${index + 1} in ${basename(file)}`, error)
            break
          }
          throw new Error(`malformed complete mailbox record at ${basename(file)}:${index + 1}`, { cause: error })
        }
      }
      if (messages.length > cap) throw new Error(`mailbox ${participantId} exceeds saved cap ${cap}`)
      return messages
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return []
      throw error
    }
  }

  private async writeMailboxFile(paths: WorkspacePaths, participantId: 'founder' | string, messages: CompanyMessage[], cap: number): Promise<void> {
    if (messages.length > cap) throw new Error(`mailbox ${participantId} is full (${cap} messages); compact read records before sending more`)
    for (const message of messages) {
      assertCompanyMessage(message)
      if (message.to !== participantId) throw new Error('mailbox recipient mismatch')
    }
    await mkdir(paths.mailboxDir, { recursive: true, mode: DIR_MODE })
    const content = messages.length === 0 ? '' : `${messages.map((message) => JSON.stringify(message)).join('\n')}\n`
    await writeFileAtomic(this.mailboxFile(paths, participantId), content, { mode: FILE_MODE, dirMode: DIR_MODE })
  }

  private async buildAuditContent(paths: WorkspacePaths, state: CompanyState, options: MutationOptions): Promise<string> {
    const event: CompanyAuditEvent = {
      schemaVersion: 1,
      id: state.counters.event,
      at: state.updatedAt,
      type: options.type,
      actor: options.actor,
      summary: bound(options.summary, 2048),
      revision: state.revision,
    }
    const lines = await this.readAuditLines(paths)
    lines.push(JSON.stringify(event))
    return this.boundAuditContent(lines, state.limits.maxAuditBytes)
  }

  /**
   * The audit row was written before the state write failed. Append a marker
   * with the same event id so the uncommitted row is visibly invalidated.
   */
  private async appendAuditRollback(paths: WorkspacePaths, state: CompanyState, options: MutationOptions): Promise<void> {
    const event: CompanyAuditEvent = {
      schemaVersion: 1,
      id: state.counters.event,
      at: Date.now(),
      type: 'mutation.state_write_failed',
      actor: options.actor,
      summary: bound(`State write failed for mutation "${options.type}"; the preceding audit row with this id did not commit.`, 2048),
      revision: state.revision,
    }
    const lines = await this.readAuditLines(paths)
    lines.push(JSON.stringify(event))
    await writeFileAtomic(paths.auditFile, this.boundAuditContent(lines, state.limits.maxAuditBytes), { mode: FILE_MODE, dirMode: DIR_MODE })
  }

  private async readAuditLines(paths: WorkspacePaths): Promise<string[]> {
    try {
      return (await readFile(paths.auditFile, 'utf8')).split('\n').filter((line) => line.trim() !== '')
    } catch (error) {
      if (!isErrno(error, 'ENOENT')) throw error
      return []
    }
  }

  private boundAuditContent(lines: string[], maxAuditBytes: number): string {
    let content = `${lines.join('\n')}\n`
    while (Buffer.byteLength(content, 'utf8') > maxAuditBytes && lines.length > 1) {
      lines.shift()
      content = `${lines.join('\n')}\n`
    }
    return content
  }

  private async serialize<T>(key: string, operation: () => Promise<T>): Promise<T> {
    const previous = this.queues.get(key) ?? Promise.resolve()
    let release!: () => void
    const gate = new Promise<void>((resolve) => { release = resolve })
    const tail = previous.catch(() => undefined).then(() => gate)
    this.queues.set(key, tail)
    await previous.catch(() => undefined)
    try {
      return await operation()
    } finally {
      release()
      if (this.queues.get(key) === tail) this.queues.delete(key)
    }
  }
}

export class RevisionConflictError extends Error {
  readonly expectedRevision: number
  readonly latestRevision: number

  constructor(expectedRevision: number, latestRevision: number) {
    super(`company revision conflict: expected ${expectedRevision}, latest is ${latestRevision}`)
    this.name = 'RevisionConflictError'
    this.expectedRevision = expectedRevision
    this.latestRevision = latestRevision
  }
}

function stripBom(value: string): string {
  return value.charCodeAt(0) === 0xfeff ? value.slice(1) : value
}

function serializeJson(value: unknown): string {
  return `${JSON.stringify(value, null, 2)}\n`
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}
