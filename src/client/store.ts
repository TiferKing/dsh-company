import {
  parseCompanySnapshot,
  type CompanyAction,
  type CompanyActionRequest,
  type CompanySnapshot,
  type SnapshotQuery,
} from './types.js'
import { loadOrganizationSnapshot, loadRunningSnapshot } from './directory-snapshot.js'

type DirectoryView = 'page' | 'organization' | 'overview'

const STATE_ROUTE = '/plugins/dsh-company/state'
const ACTION_ROUTE = '/plugins/dsh-company/action'
const MAX_RESPONSE_CHARS = 16 * 1024 * 1024
const DEFAULT_OPEN_POLL_MS = 1_000
const DEFAULT_CLOSED_POLL_MS = 15_000
const DEFAULT_REQUEST_TIMEOUT_MS = 15_000
const DEFAULT_ACTION_TIMEOUT_MS = 30_000
const MIN_POLL_MS = 500
const MAX_POLL_MS = 60_000
const MIN_TIMEOUT_MS = 1
const MAX_TIMEOUT_MS = 120_000

export interface CompanyUiState {
  /** View represented by the loaded arrays; organization arrays span all pages. */
  directoryView: DirectoryView
  sessionId: string | undefined
  snapshot: CompanySnapshot | undefined
  /** True only after both active and archived lookups confirmed absence. */
  companyAbsent: boolean
  archived: boolean
  open: boolean
  loading: boolean
  stale: boolean
  networkError: string | undefined
  action: CompanyAction | undefined
  actionError: string | undefined
}

export interface CompanyUiControllerOptions {
  fetch?: typeof globalThis.fetch
  openPollMs?: number
  closedPollMs?: number
  requestTimeoutMs?: number
  actionTimeoutMs?: number
  actionTransport?: (request: CompanyActionRequest, signal: AbortSignal) => Promise<unknown>
}

type Listener = () => void

class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
}

class RequestTimeoutError extends Error {
  override readonly name = 'RequestTimeoutError'
}

class HttpResponseError extends Error {
  override readonly name = 'HttpResponseError'

  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message)
  }
}

function messageOf(error: unknown): string {
  if (error instanceof Error && error.message.trim().length > 0) return error.message
  return String(error)
}

function clampPoll(value: number): number {
  if (!Number.isFinite(value)) return DEFAULT_OPEN_POLL_MS
  return Math.min(MAX_POLL_MS, Math.max(MIN_POLL_MS, Math.round(value)))
}

function clampTimeout(value: number, fallback: number): number {
  if (!Number.isFinite(value)) return fallback
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, Math.round(value)))
}

function timeoutReason(signal: AbortSignal): RequestTimeoutError | undefined {
  return signal.reason instanceof RequestTimeoutError ? signal.reason : undefined
}

function withTimeout<T>(
  operation: Promise<T>,
  controller: AbortController,
  timeoutMs: number,
  message: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      const error = new RequestTimeoutError(`${message} timed out after ${timeoutMs}ms`)
      controller.abort(error)
      reject(error)
    }, timeoutMs)
    operation.then(
      (value) => {
        clearTimeout(timer)
        resolve(value)
      },
      (error: unknown) => {
        clearTimeout(timer)
        reject(error)
      },
    )
  })
}

function errorCodeFromJson(value: unknown): string | undefined {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return undefined
  const input = value as Record<string, unknown>
  if (typeof input.code === 'string') return input.code
  if (typeof input.error === 'string') return input.error
  if (input.error !== null && typeof input.error === 'object' && !Array.isArray(input.error)) {
    const error = input.error as Record<string, unknown>
    if (typeof error.code === 'string') return error.code
  }
  return undefined
}

function errorMessageFromJson(value: unknown, fallback: string): string {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return fallback
  const input = value as Record<string, unknown>
  if (typeof input.message === 'string' && input.message.trim().length > 0) return input.message
  if (typeof input.error === 'string' && input.error.trim().length > 0) return input.error
  if (input.error !== null && typeof input.error === 'object' && !Array.isArray(input.error)) {
    const error = input.error as Record<string, unknown>
    if (typeof error.message === 'string' && error.message.trim().length > 0) return error.message
  }
  return fallback
}

async function readResponseJson(response: Response): Promise<unknown> {
  const declaredLength = response.headers.get('content-length')
  if (declaredLength !== null && Number(declaredLength) > MAX_RESPONSE_CHARS) {
    throw new Error('Company response is too large')
  }
  const text = await response.text()
  if (text.length > MAX_RESPONSE_CHARS) throw new Error('Company response is too large')
  if (text.trim().length === 0) return undefined
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new Error(`HTTP ${response.status}: invalid JSON response`)
  }
}

/**
 * One fiber-owned controller shared by the per-session header entry and the
 * root overlay. It is the only polling/action owner, so duplicate React mounts
 * never multiply HTTP requests.
 */
export class CompanyUiController {
  readonly subscribe = (listener: Listener): (() => void) => {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  readonly getSnapshot = (): CompanyUiState => this.state

  private state: CompanyUiState = Object.freeze({
    directoryView: 'page',
    sessionId: undefined,
    snapshot: undefined,
    companyAbsent: false,
    archived: false,
    open: false,
    loading: false,
    stale: false,
    networkError: undefined,
    action: undefined,
    actionError: undefined,
  })

  private readonly listeners = new Set<Listener>()
  private readonly snapshotCache = new Map<string, { etag: string; snapshot: CompanySnapshot }>()
  private readonly fetcher: typeof globalThis.fetch
  private readonly openPollMs: number
  private readonly closedPollMs: number
  private readonly requestTimeoutMs: number
  private readonly actionTimeoutMs: number
  private readonly actionTransport: ((request: CompanyActionRequest, signal: AbortSignal) => Promise<unknown>) | undefined
  private visible = true
  private disposed = false
  private generation = 0
  private directoryQuery: SnapshotQuery = {}
  private directoryView: DirectoryView = 'page'
  private activityLimit = 5
  private timer: ReturnType<typeof setTimeout> | undefined
  private request:
    | { generation: number; controller: AbortController; promise: Promise<void> }
    | undefined
  private actionController: AbortController | undefined
  private returnFocus: HTMLElement | null = null

  constructor(options: CompanyUiControllerOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.openPollMs = clampPoll(options.openPollMs ?? DEFAULT_OPEN_POLL_MS)
    this.closedPollMs = clampPoll(options.closedPollMs ?? DEFAULT_CLOSED_POLL_MS)
    this.requestTimeoutMs = clampTimeout(options.requestTimeoutMs ?? DEFAULT_REQUEST_TIMEOUT_MS, DEFAULT_REQUEST_TIMEOUT_MS)
    this.actionTimeoutMs = clampTimeout(options.actionTimeoutMs ?? DEFAULT_ACTION_TIMEOUT_MS, DEFAULT_ACTION_TIMEOUT_MS)
    this.actionTransport = options.actionTransport
  }

  setCurrentSession(sessionId: string | undefined): void {
    if (this.disposed || sessionId === this.state.sessionId) return
    this.generation += 1
    this.directoryQuery = {}
    this.directoryView = 'page'
    this.activityLimit = 5
    this.cancelTimer()
    this.cancelRequest()
    this.snapshotCache.clear()
    this.actionController?.abort()
    this.actionController = undefined
    this.returnFocus = null
    this.publish({
      sessionId,
      directoryView: 'page',
      snapshot: undefined,
      companyAbsent: false,
      archived: false,
      open: false,
      loading: sessionId !== undefined,
      stale: false,
      networkError: undefined,
      action: undefined,
      actionError: undefined,
    })
    if (sessionId !== undefined && this.visible) void this.refresh('session-change')
  }

  setVisible(visible: boolean): void {
    if (this.disposed || this.visible === visible) return
    this.visible = visible
    if (!visible) {
      this.cancelTimer()
      this.cancelRequest()
      return
    }
    if (this.state.sessionId !== undefined) void this.refresh('visible')
  }

  setDirectoryQuery(query: SnapshotQuery): void {
    if (this.disposed || this.state.action !== undefined) return
    this.directoryQuery = { ...query }
    this.generation += 1
    this.cancelTimer()
    this.cancelRequest()
    this.snapshotCache.clear()
    this.publish({ loading: true, networkError: undefined })
    void this.refresh('directory-page')
  }

  setDirectoryView(view: DirectoryView): void {
    if (this.disposed || this.state.action !== undefined || view === this.directoryView) return
    this.directoryView = view
    this.activityLimit = 5
    this.reloadDirectory()
  }

  loadMoreActivity(limit: number): void {
    if (this.disposed || this.state.action !== undefined || this.directoryView !== 'overview') return
    if (!Number.isSafeInteger(limit) || limit < 5) return
    this.activityLimit = limit
    this.reloadDirectory()
  }

  private reloadDirectory(): void {
    this.generation += 1
    this.cancelTimer()
    this.cancelRequest()
    this.snapshotCache.clear()
    this.publish({ loading: true, networkError: undefined })
    void this.refresh('directory-view')
  }

  open(sessionId: string, trigger?: HTMLElement): void {
    if (this.disposed) return
    if (sessionId !== this.state.sessionId) this.setCurrentSession(sessionId)
    this.returnFocus = trigger ?? null
    this.publish({ open: true, actionError: undefined })
    void this.refresh('open')
  }

  close(restoreFocus = true): void {
    if (this.disposed || !this.state.open) return
    const target = restoreFocus ? this.returnFocus : null
    this.publish({ open: false, actionError: undefined })
    this.schedule()
    if (target?.isConnected === true) {
      queueMicrotask(() => target.focus())
    }
  }

  connectionReset(): void {
    if (this.disposed) return
    this.generation += 1
    this.cancelTimer()
    this.cancelRequest()
    this.snapshotCache.clear()
    this.actionController?.abort()
    this.actionController = undefined
    this.publish({
      stale: this.state.snapshot !== undefined,
      networkError: undefined,
      action: undefined,
      actionError: undefined,
    })
    if (this.visible && this.state.sessionId !== undefined) void this.refresh('connection-reset')
  }

  async refresh(_reason = 'manual'): Promise<void> {
    if (this.disposed || !this.visible || this.state.sessionId === undefined) return
    if (this.request !== undefined && this.request.generation === this.generation) {
      return this.request.promise
    }

    this.cancelTimer()
    const sessionId = this.state.sessionId
    const generation = this.generation
    const controller = new AbortController()
    const promise = this.pull(sessionId, generation, controller)
    this.request = { generation, controller, promise }
    return promise
  }

  async performAction(action: CompanyAction, payload: unknown, expectedRevision?: number): Promise<boolean> {
    const { sessionId, snapshot } = this.state
    if (this.disposed || sessionId === undefined || snapshot === undefined || this.state.archived) return false
    if (this.state.action !== undefined) return false

    this.cancelTimer()
    this.cancelRequest()
    this.actionController?.abort()
    const controller = new AbortController()
    this.actionController = controller
    const generation = this.generation
    const request: CompanyActionRequest = {
      sessionId,
      companyId: snapshot.company.id,
      expectedRevision: expectedRevision ?? snapshot.revision,
      action,
      payload,
    }
    this.publish({ action, actionError: undefined, networkError: undefined })

    try {
      const body = await withTimeout((async () => {
        if (this.actionTransport !== undefined) {
          return this.actionTransport(request, controller.signal)
        }
        const response = await this.fetcher(ACTION_ROUTE, {
          method: 'POST',
          cache: 'no-store',
          credentials: 'same-origin',
          headers: {
            accept: 'application/json',
            'content-type': 'application/json',
          },
          body: JSON.stringify(request),
          signal: controller.signal,
        })
        const responseBody = await readResponseJson(response)
        if (!response.ok) {
          throw new HttpResponseError(
            response.status,
            errorMessageFromJson(responseBody, `Company action failed (HTTP ${response.status})`),
          )
        }
        return responseBody
      })(), controller, this.actionTimeoutMs, 'Company action')
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return false

      // A manual/visibility refresh may have started during the mutation.
      // It cannot serve as the authoritative read after that mutation.
      this.cancelRequest()
      this.snapshotCache.clear()
      // A Host may return the next snapshot directly. Validate it before use,
      // then still repull: the HTTP state endpoint remains the presentation truth.
      if (body !== undefined && this.directoryView === 'page' && Object.keys(this.directoryQuery).length === 0) {
        try {
          const next = parseCompanySnapshot(body)
          if (next.company.id === snapshot.company.id) {
            this.publish({
              snapshot: next,
              archived: next.company.phase === 'archived',
              stale: false,
            })
          }
        } catch {
          // Receipts without a snapshot are valid; refresh below resolves truth.
        }
      }

      await this.refresh('action-success')
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return false
      this.publish({ action: undefined })
      this.schedule()
      return true
    } catch (error) {
      const timeout = timeoutReason(controller.signal)
      if (this.disposed || generation !== this.generation) return false
      if (controller.signal.aborted && timeout === undefined) return false
      const failure = timeout ?? error
      const conflict = failure instanceof HttpResponseError && failure.status === 409
      this.publish({
        action: undefined,
        actionError: messageOf(failure),
        stale: this.state.snapshot !== undefined,
      })
      if (conflict) {
        this.cancelRequest()
        await this.refresh('revision-conflict')
      }
      else this.schedule()
      return false
    } finally {
      if (this.actionController === controller) this.actionController = undefined
    }
  }

  dispose(): void {
    if (this.disposed) return
    this.disposed = true
    this.generation += 1
    this.cancelTimer()
    this.cancelRequest()
    this.actionController?.abort()
    this.actionController = undefined
    this.returnFocus = null
    this.snapshotCache.clear()
    this.listeners.clear()
  }

  private async pull(sessionId: string, generation: number, controller: AbortController): Promise<void> {
    const hadSnapshot = this.state.snapshot !== undefined
    // Keep the last failure visible while a retry runs: opening the diagnostic
    // drawer immediately refreshes, and must not erase the reason it appeared.
    this.publish({ loading: this.state.loading || !hadSnapshot })
    try {
      let snapshot: CompanySnapshot | undefined
      let archived = false
      try {
        snapshot = await this.fetchSnapshot(sessionId, false, controller)
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error
        try {
          snapshot = await this.fetchSnapshot(sessionId, true, controller)
          archived = snapshot !== undefined
        } catch (archiveError) {
          if (!(archiveError instanceof NotFoundError)) throw archiveError
        }
      }

      const timeout = timeoutReason(controller.signal)
      if (timeout !== undefined) throw timeout
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return
      this.publish({
        snapshot,
        directoryView: this.directoryView,
        companyAbsent: snapshot === undefined,
        archived,
        loading: false,
        stale: false,
        networkError: undefined,
      })
    } catch (error) {
      const timeout = timeoutReason(controller.signal)
      if (this.disposed || generation !== this.generation) return
      if (controller.signal.aborted && timeout === undefined) return
      this.publish({
        loading: false,
        companyAbsent: false,
        stale: this.state.snapshot !== undefined,
        networkError: messageOf(timeout ?? error),
      })
    } finally {
      if (this.request?.controller === controller) this.request = undefined
      if (!this.disposed && generation === this.generation) this.schedule()
    }
  }

  private async fetchSnapshot(
    sessionId: string,
    archived: boolean,
    controller: AbortController,
  ): Promise<CompanySnapshot> {
    const view = this.directoryView
    const limit = this.activityLimit
    const query: SnapshotQuery = view === 'organization'
      ? { employeeLimit: 100, orgLimit: 100, positionLimit: 100 }
      : view === 'overview' ? {} : this.directoryQuery
    const first = await this.fetchSnapshotPage(sessionId, archived, controller, query)
    const fetchPage = (next: SnapshotQuery) => this.fetchSnapshotPage(sessionId, archived, controller, next, false)
    if (view === 'organization') return loadOrganizationSnapshot(first, fetchPage)
    if (view === 'overview') {
      // Keep the primary employee page for formation HR fields and recovery
      // controls. Only the activity card uses the running-employee prefix.
      if (first.directory === undefined || first.directory.employees.next_offset === null) {
        return { ...first, activity_employees: first.employees.filter((employee) => employee.status !== 'retired' && employee.activity?.state === 'running').slice(0, limit) }
      }
      const running = await loadRunningSnapshot(await fetchPage({ employeeStatus: 'running', employeeLimit: Math.min(limit, 100) }), limit, fetchPage)
      if (running.directory === undefined || running.company.id !== first.company.id || running.revision !== first.revision || running.schema_version !== first.schema_version
        || running.viewer.role !== first.viewer.role || running.viewer.participant_id !== first.viewer.participant_id
        || [...running.viewer.permissions].sort().join('\u0000') !== [...first.viewer.permissions].sort().join('\u0000')) throw new Error('Company directory changed while loading. Refresh to retry.')
      return { ...first, activity_employees: running.employees, directory: { ...first.directory, summary: running.directory.summary } }
    }
    return first
  }

  private async fetchSnapshotPage(
    sessionId: string,
    archived: boolean,
    controller: AbortController,
    directoryQuery: SnapshotQuery,
    cache = true,
  ): Promise<CompanySnapshot> {
    controller.signal.throwIfAborted()
    const query = new URLSearchParams({
      sessionId,
      archived: archived ? '1' : '0',
    })
    for (const [key, value] of Object.entries(directoryQuery)) if (value !== undefined && value !== '') query.set(key, String(value))
    const cacheKey = `${sessionId}\u0000${archived ? 'archive' : 'active'}`
    const cached = cache ? this.snapshotCache.get(cacheKey) : undefined
    const { response, body } = await withTimeout((async () => {
      const response = await this.fetcher(`${STATE_ROUTE}?${query.toString()}`, {
        cache: 'no-cache',
        credentials: 'same-origin',
        headers: { accept: 'application/json', ...(cached === undefined ? {} : { 'if-none-match': cached.etag }) },
        signal: controller.signal,
      })
      return { response, body: response.status === 304 ? undefined : await readResponseJson(response) }
    })(), controller, this.requestTimeoutMs, 'Company request')
    if (response.status === 304) {
      if (cached === undefined) throw new Error('Host returned 304 without a matching cached company snapshot')
      return cached.snapshot
    }
    // Validators belong to a successfully parsed representation, never to a
    // failed response or to whichever snapshot happens to be on screen.
    if (cache && !controller.signal.aborted && this.state.sessionId === sessionId) this.snapshotCache.delete(cacheKey)
    const message = errorMessageFromJson(body, `Could not load company (HTTP ${response.status})`)
    const code = errorCodeFromJson(body)
    if (
      response.status === 404 && (
        code === 'company_not_found' ||
        (code === 'not_found' && message === 'no company exists for this workspace')
      )
    ) {
      throw new NotFoundError('Company not found')
    }
    if (!response.ok) {
      throw new HttpResponseError(response.status, message)
    }
    const snapshot = parseCompanySnapshot(body)
    const nextEtag = response.headers.get('etag')
    if (cache && nextEtag !== null && !controller.signal.aborted && this.state.sessionId === sessionId) {
      this.snapshotCache.set(cacheKey, { etag: nextEtag, snapshot })
    }
    return snapshot
  }

  private schedule(): void {
    this.cancelTimer()
    if (
      this.disposed ||
      !this.visible ||
      this.state.sessionId === undefined ||
      this.state.action !== undefined
    ) {
      return
    }

    const requested = this.state.snapshot?.poll_after_ms
    const fast = clampPoll(requested ?? this.openPollMs)
    const delay = this.state.open && !this.state.archived ? fast : this.closedPollMs
    this.timer = setTimeout(() => {
      this.timer = undefined
      void this.refresh('poll')
    }, clampPoll(delay))
  }

  private cancelTimer(): void {
    if (this.timer === undefined) return
    clearTimeout(this.timer)
    this.timer = undefined
  }

  private cancelRequest(): void {
    this.request?.controller.abort()
    this.request = undefined
  }

  private publish(patch: Partial<CompanyUiState>): void {
    if (this.disposed) return
    this.state = Object.freeze({ ...this.state, ...patch })
    for (const listener of this.listeners) listener()
  }
}
