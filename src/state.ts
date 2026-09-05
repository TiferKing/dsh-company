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

interface OptionalFileSnapshot {
  exists: boolean
  content: string
}

interface TransactionJournal {
  schemaVersion: 1
  workspaceHash: string
  baseRevision: number
  state: CompanyState
  auditContent: string
  mailboxes: Array<{ participantId: string; messages: CompanyMessage[] }>
}

/** Remove oldest terminal rows only; queued/reserved work is never evicted. */
export function makeMailboxRoom(messages: CompanyMessage[], cap: number, incoming = 1): void {
  while (messages.length + incoming > cap) {
    const index = messages.findIndex((message) => message.deliveryState === 'accepted' || message.deliveryState === 'dead')
    if (index < 0) throw new Error(`mailbox is full (${cap}); no delivered record can be compacted safely`)
    messages.splice(index, 1)
  }
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
    await this.recoverPendingTransaction(paths)
    const state = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
    if (state?.phase === 'archived') {
      await this.finalizeArchivedDirectory(paths)
      return undefined
    }
    return state
  }

  readActiveSync(cwd: string | undefined): CompanyState | undefined {
    const paths = this.pathsForCwdSync(cwd)
    try {
      try {
        const journal = this.parseTransactionJournal(JSON.parse(stripBom(readFileSync(paths.transactionFile, 'utf8'))), paths)
        return journal.state.phase === 'archived' ? undefined : structuredClone(journal.state)
      } catch (error) {
        if (!isErrno(error, 'ENOENT')) throw error
      }
      const parsed = normalizeCompanyState(JSON.parse(stripBom(readFileSync(paths.stateFile, 'utf8'))), this.config)
      assertCompanyState(parsed, paths.workspace.sha256)
      return parsed.phase === 'archived' ? undefined : parsed
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
    return this.serialize(paths.root, async () => {
      await assertNotSymlink(paths.activeDir, 'dsh-company active directory')
      // The identity file stays outside active/, so this workspace-wide lock also
      // remains stable while active/ is atomically renamed during archive.
      return withFileLock(paths.identityFile, async () => {
        await this.recoverPendingTransactionLocked(paths)
        return this.transactLocked(paths, options, mutation)
      }, { waitMs: LOCK_WAIT_MS })
    })
  }

  async readMailbox(cwd: string | undefined, participantId: 'founder' | string): Promise<CompanyMessage[]> {
    const paths = await this.pathsForCwd(cwd, false)
    await this.recoverPendingTransaction(paths)
    const state = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
    if (state === undefined) return []
    return this.readMailboxFile(paths, participantId, state.limits.maxMailboxMessages)
  }

  async archive(
    cwd: string | undefined,
    expectedRevision?: number,
    forcedApprovalId?: string,
    guard?: { companyId: string; reason: string; stagedOnly?: boolean },
  ): Promise<CompanyState> {
    const paths = await this.pathsForCwd(cwd, false)
    return this.serialize(paths.root, async () => withFileLock(paths.identityFile, async () => {
      await this.recoverPendingTransactionLocked(paths)
      const current = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
      if (current === undefined) throw new Error('no active company exists for this workspace')
      const target = join(paths.archiveDir, current.id)
      await mkdir(paths.archiveDir, { recursive: true, mode: DIR_MODE })
      // Preflight collision and destination writability before consuming approval
      // or changing the authoritative aggregate.
      try {
        await mkdir(target, { mode: DIR_MODE })
      } catch (error) {
        if (isErrno(error, 'EEXIST')) throw new Error(`archive ${current.id} already exists; refusing to overwrite it`)
        throw error
      }
      await rm(target, { recursive: true, force: true })
      const previousState = await readFile(paths.stateFile, 'utf8')
      const previousAudit = await this.readOptionalFile(paths.auditFile)
      const closed = await this.transactLocked(paths, {
        expectedRevision,
        actor: 'founder',
        type: 'company.archived',
        summary: 'Company archived and scheduling authority revoked',
      }, (state) => {
        if (guard !== undefined) {
          if (state.id !== guard.companyId) throw new Error('active company changed before archive')
          if (guard.stagedOnly && state.phase !== 'staged') throw new Error('discard_staged applies only to a staged company')
          if (!guard.stagedOnly && state.workItems.some((work) => !['completed', 'cancelled'].includes(work.status))) {
            requireApproved(state, forcedApprovalId, 'forced_archive', (payload) =>
              typeof payload === 'object' && payload !== null && !Array.isArray(payload) && payload.reason === guard.reason)
          }
        }
        if (forcedApprovalId !== undefined) consumeApproval(requireApproved(state, forcedApprovalId, 'forced_archive'))
        state.phase = 'archived'
        state.archivedAt = Date.now()
        state.supportEmployeeId = undefined
        for (const employee of state.employees) {
          releaseEmployeeMoneyReservations(state, employee.id)
          if (employee.status !== 'retired') employee.status = 'retired'
          employee.retiredAt ??= Date.now()
        }
        for (const request of state.staffingRequests) {
          request.reservationId = undefined
          request.leaseAt = undefined
          if (request.status === 'in_review') {
            request.status = 'pending'
            request.attemptId = undefined
          }
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
          if (work.status === 'pending' || work.status === 'claimed' || work.status === 'in_progress') {
            work.status = 'cancelled'
            work.output ??= 'Company archived before this work began.'
          }
          work.attemptId = undefined
          work.handoffId = undefined
          work.reassigning = false
          work.reservationId = undefined
          work.leaseAt = undefined
          work.updatedAt = Date.now()
        }
        // Closing a company cancels outstanding repairs, not resolves them.
        // Keep ticket/work backlinks valid and leave an explicit closure reply.
        for (const ticket of state.tickets) {
          if (ticket.status === 'closed') continue
          ticket.status = 'closed'
          ticket.closedAt = state.archivedAt
          ticket.reply ??= 'Company archived; this ticket is closed. Any unfinished repair was cancelled.'
        }
        state.provisioning = undefined
      })
      try {
        await rename(paths.activeDir, target)
      } catch (error) {
        try {
          await writeFileAtomic(paths.stateFile, previousState, { mode: FILE_MODE, dirMode: DIR_MODE })
          await this.restoreOptionalFile(paths.auditFile, previousAudit)
        } catch (rollbackError) {
          throw new AggregateError([error, rollbackError], 'archive move and authoritative rollback both failed')
        }
        throw new Error(`archive directory move failed; state and approval were rolled back: ${String(error)}`, { cause: error })
      }
      return closed.state
    }, { waitMs: LOCK_WAIT_MS }))
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

  private async transactLocked<T>(
    paths: WorkspacePaths,
    options: MutationOptions,
    mutation: (state: CompanyState, context: MutationContext) => Promise<T> | T,
  ): Promise<{ state: CompanyState; result: T }> {
    const state = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
    if (state === undefined) throw new Error('no active company exists for this workspace')
    if (options.expectedRevision !== undefined && state.revision !== options.expectedRevision) {
      throw new RevisionConflictError(options.expectedRevision, state.revision)
    }
    const pendingMailboxes = new Map<string, CompanyMessage[]>()
    const context: MutationContext = {
      paths,
      readMailbox: (participantId) => {
        const buffered = pendingMailboxes.get(participantId)
        if (buffered !== undefined) return Promise.resolve(structuredClone(buffered))
        return this.readMailboxFile(paths, participantId, state.limits.maxMailboxMessages)
      },
      writeMailbox: (participantId, messages) => {
        if (messages.length > state.limits.maxMailboxMessages) throw new Error(`mailbox ${participantId} is full (${state.limits.maxMailboxMessages}); compact accepted records before sending more`)
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

    const auditBefore = await this.readOptionalFile(paths.auditFile)
    const auditAfter = await this.buildAuditContent(paths, state, options)
    const mailboxBefore = new Map<string, OptionalFileSnapshot>()
    for (const participantId of pendingMailboxes.keys()) mailboxBefore.set(participantId, await this.readOptionalFile(this.mailboxFile(paths, participantId)))
    const journal: TransactionJournal = {
      schemaVersion: 1,
      workspaceHash: paths.workspace.sha256,
      baseRevision: state.revision - 1,
      state: structuredClone(state),
      auditContent: auditAfter,
      mailboxes: [...pendingMailboxes].map(([participantId, messages]) => ({ participantId, messages: structuredClone(messages) })),
    }
    await writeFileAtomic(paths.transactionFile, serializeJson(journal), { mode: FILE_MODE, dirMode: DIR_MODE })
    try {
      // Mailbox and audit changes are written before the single authoritative
      // state commit. Any ordinary write failure restores their prior snapshots;
      // after state succeeds there is no remaining fallible write.
      for (const [participantId, messages] of pendingMailboxes) await this.writeMailboxFile(paths, participantId, messages, state.limits.maxMailboxMessages)
      await writeFileAtomic(paths.auditFile, auditAfter, { mode: FILE_MODE, dirMode: DIR_MODE })
      await writeFileAtomic(paths.stateFile, serializeJson(state), { mode: FILE_MODE, dirMode: DIR_MODE })
    } catch (error) {
      const rollbackErrors: unknown[] = []
      for (const [participantId, snapshot] of mailboxBefore) {
        try { await this.restoreOptionalFile(this.mailboxFile(paths, participantId), snapshot) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      }
      try { await this.restoreOptionalFile(paths.auditFile, auditBefore) } catch (rollbackError) { rollbackErrors.push(rollbackError) }
      if (rollbackErrors.length > 0) {
        this.onWarning(`dsh-company transaction rollback had ${rollbackErrors.length} file error(s); journal retained for recovery`, new AggregateError(rollbackErrors))
      } else {
        await rm(paths.transactionFile, { force: true }).catch((cleanupError) => this.onWarning('dsh-company rolled-back journal cleanup failed', cleanupError))
      }
      throw error
    }
    await rm(paths.transactionFile, { force: true }).catch((error) => this.onWarning('dsh-company committed journal cleanup failed; recovery is idempotent', error))
    return { state: structuredClone(state), result }
  }

  private async finalizeArchivedDirectory(paths: WorkspacePaths): Promise<void> {
    await this.serialize(paths.root, async () => withFileLock(paths.identityFile, async () => {
      const current = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
      if (current === undefined || current.phase !== 'archived') return
      const target = join(paths.archiveDir, current.id)
      await mkdir(paths.archiveDir, { recursive: true, mode: DIR_MODE })
      try {
        await rename(paths.activeDir, target)
      } catch (error) {
        if (isErrno(error, 'ENOENT')) return
        if (isErrno(error, 'EEXIST')) throw new Error(`cannot recover archived company ${current.id}: destination already exists`, { cause: error })
        throw error
      }
      this.onWarning(`dsh-company completed crash-interrupted archive ${current.id}`)
    }, { waitMs: LOCK_WAIT_MS }))
  }

  private async recoverPendingTransaction(paths: WorkspacePaths): Promise<void> {
    if (!(await this.readOptionalFile(paths.transactionFile)).exists) return
    await this.serialize(paths.root, async () => withFileLock(paths.identityFile, () => this.recoverPendingTransactionLocked(paths), { waitMs: LOCK_WAIT_MS }))
  }

  private async recoverPendingTransactionLocked(paths: WorkspacePaths): Promise<void> {
    const snapshot = await this.readOptionalFile(paths.transactionFile)
    if (!snapshot.exists) return
    let parsed: unknown
    try {
      parsed = JSON.parse(stripBom(snapshot.content))
    } catch (error) {
      throw new Error('malformed dsh-company transaction journal; refusing ambiguous recovery', { cause: error })
    }
    const journal = this.parseTransactionJournal(parsed, paths)
    const current = await this.readStateFile(paths.stateFile, paths.workspace.sha256)
    if (current !== undefined && current.revision > journal.state.revision) {
      await rm(paths.transactionFile, { force: true })
      return
    }
    if (current !== undefined && current.id !== journal.state.id) throw new Error('transaction journal company identity does not match active state')
    if (current !== undefined && current.revision !== journal.baseRevision && current.revision !== journal.state.revision) {
      throw new Error(`transaction journal revision ${journal.baseRevision}->${journal.state.revision} conflicts with active revision ${current.revision}`)
    }
    for (const mailbox of journal.mailboxes) await this.writeMailboxFile(paths, mailbox.participantId, mailbox.messages, journal.state.limits.maxMailboxMessages)
    await writeFileAtomic(paths.auditFile, journal.auditContent, { mode: FILE_MODE, dirMode: DIR_MODE })
    await writeFileAtomic(paths.stateFile, serializeJson(journal.state), { mode: FILE_MODE, dirMode: DIR_MODE })
    await rm(paths.transactionFile, { force: true })
    this.onWarning(`dsh-company recovered interrupted transaction at revision ${journal.state.revision}`)
  }

  private parseTransactionJournal(value: unknown, paths: WorkspacePaths): TransactionJournal {
    if (value === null || typeof value !== 'object' || Array.isArray(value)) throw new Error('invalid dsh-company transaction journal')
    const raw = value as Record<string, unknown>
    if (raw.schemaVersion !== 1 || raw.workspaceHash !== paths.workspace.sha256 || !Number.isSafeInteger(raw.baseRevision) || (raw.baseRevision as number) < 1) {
      throw new Error('transaction journal identity or base revision is invalid')
    }
    const state = normalizeCompanyState(raw.state, this.config)
    assertCompanyState(state, paths.workspace.sha256)
    if (state.revision !== (raw.baseRevision as number) + 1) throw new Error('transaction journal target revision is not contiguous')
    if (typeof raw.auditContent !== 'string' || Buffer.byteLength(raw.auditContent, 'utf8') > state.limits.maxAuditBytes) throw new Error('transaction journal audit content is invalid')
    if (!Array.isArray(raw.mailboxes)) throw new Error('transaction journal mailboxes must be an array')
    const seen = new Set<string>()
    const mailboxes = raw.mailboxes.map((entry, index) => {
      if (entry === null || typeof entry !== 'object' || Array.isArray(entry)) throw new Error(`transaction journal mailbox ${index} is invalid`)
      const row = entry as Record<string, unknown>
      if (typeof row.participantId !== 'string' || !Array.isArray(row.messages) || seen.has(row.participantId)) throw new Error(`transaction journal mailbox ${index} is invalid`)
      seen.add(row.participantId)
      const messages = row.messages as CompanyMessage[]
      if (messages.length > state.limits.maxMailboxMessages) throw new Error(`transaction journal mailbox ${row.participantId} exceeds its cap`)
      for (const message of messages) {
        assertCompanyMessage(message)
        if (message.to !== row.participantId) throw new Error(`transaction journal mailbox ${row.participantId} recipient mismatch`)
      }
      // Validate the participant id through the canonical filename boundary.
      this.mailboxFile(paths, row.participantId)
      return { participantId: row.participantId, messages: structuredClone(messages) }
    })
    return {
      schemaVersion: 1,
      workspaceHash: paths.workspace.sha256,
      baseRevision: raw.baseRevision as number,
      state: structuredClone(state),
      auditContent: raw.auditContent,
      mailboxes,
    }
  }

  private async readOptionalFile(file: string): Promise<OptionalFileSnapshot> {
    try {
      return { exists: true, content: await readFile(file, 'utf8') }
    } catch (error) {
      if (isErrno(error, 'ENOENT')) return { exists: false, content: '' }
      throw error
    }
  }

  private async restoreOptionalFile(file: string, snapshot: OptionalFileSnapshot): Promise<void> {
    if (!snapshot.exists) {
      await rm(file, { force: true })
      return
    }
    await writeFileAtomic(file, snapshot.content, { mode: FILE_MODE, dirMode: DIR_MODE })
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
          const value: unknown = normalizeCompanyMessage(JSON.parse(line))
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
    lines.push(this.serializeAuditEvent(event, state.limits.maxAuditBytes))
    return this.boundAuditContent(lines, state.limits.maxAuditBytes)
  }

  private serializeAuditEvent(event: CompanyAuditEvent, maxAuditBytes: number): string {
    let candidate = { ...event }
    let line = JSON.stringify(candidate)
    while (Buffer.byteLength(`${line}\n`, 'utf8') > maxAuditBytes && candidate.summary.length > 1) {
      candidate = { ...candidate, summary: bound(candidate.summary, Math.max(1, Math.floor(candidate.summary.length / 2))) }
      line = JSON.stringify(candidate)
    }
    if (Buffer.byteLength(`${line}\n`, 'utf8') > maxAuditBytes) throw new Error(`maxAuditBytes ${maxAuditBytes} cannot hold one audit event`)
    return line
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

function normalizeCompanyMessage(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const message = value as Record<string, unknown>
  if (message.deliveryState === 'read') message.deliveryState = 'accepted'
  delete message.readAt
  return value
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
