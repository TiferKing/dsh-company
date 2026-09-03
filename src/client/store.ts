import {
  isCompanyLive,
  parseCompanySnapshot,
  type CompanyAction,
  type CompanyActionRequest,
  type CompanySnapshot,
} from './types.js'

const STATE_ROUTE = '/plugins/dsh-company/state'
const ACTION_ROUTE = '/plugins/dsh-company/action'
const MAX_RESPONSE_CHARS = 4 * 1024 * 1024
const DEFAULT_OPEN_POLL_MS = 1_000
const DEFAULT_CLOSED_POLL_MS = 15_000
const MIN_POLL_MS = 500
const MAX_POLL_MS = 60_000

export interface CompanyUiState {
  sessionId: string | undefined
  snapshot: CompanySnapshot | undefined
  archived: boolean
  open: boolean
  loading: boolean
  stale: boolean
  lastSuccessfulAt: number | undefined
  networkError: string | undefined
  action: CompanyAction | undefined
  actionError: string | undefined
}

export interface CompanyUiControllerOptions {
  fetch?: typeof globalThis.fetch
  now?: () => number
  openPollMs?: number
  closedPollMs?: number
  actionTransport?: (request: CompanyActionRequest, signal: AbortSignal) => Promise<unknown>
}

type Listener = () => void

class NotFoundError extends Error {
  override readonly name = 'NotFoundError'
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
    sessionId: undefined,
    snapshot: undefined,
    archived: false,
    open: false,
    loading: false,
    stale: false,
    lastSuccessfulAt: undefined,
    networkError: undefined,
    action: undefined,
    actionError: undefined,
  })

  private readonly listeners = new Set<Listener>()
  private readonly fetcher: typeof globalThis.fetch
  private readonly now: () => number
  private readonly openPollMs: number
  private readonly closedPollMs: number
  private readonly actionTransport: ((request: CompanyActionRequest, signal: AbortSignal) => Promise<unknown>) | undefined
  private visible = true
  private disposed = false
  private generation = 0
  private timer: ReturnType<typeof setTimeout> | undefined
  private request:
    | { generation: number; controller: AbortController; promise: Promise<void> }
    | undefined
  private actionController: AbortController | undefined
  private returnFocus: HTMLElement | null = null

  constructor(options: CompanyUiControllerOptions = {}) {
    this.fetcher = options.fetch ?? globalThis.fetch.bind(globalThis)
    this.now = options.now ?? Date.now
    this.openPollMs = clampPoll(options.openPollMs ?? DEFAULT_OPEN_POLL_MS)
    this.closedPollMs = clampPoll(options.closedPollMs ?? DEFAULT_CLOSED_POLL_MS)
    this.actionTransport = options.actionTransport
  }

  setCurrentSession(sessionId: string | undefined): void {
    if (this.disposed || sessionId === this.state.sessionId) return
    this.generation += 1
    this.cancelTimer()
    this.cancelRequest()
    this.actionController?.abort()
    this.actionController = undefined
    this.returnFocus = null
    this.publish({
      sessionId,
      snapshot: undefined,
      archived: false,
      open: false,
      loading: sessionId !== undefined,
      stale: false,
      lastSuccessfulAt: undefined,
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

  clearActionError(): void {
    if (this.state.actionError !== undefined) this.publish({ actionError: undefined })
  }

  connectionReset(): void {
    if (this.disposed) return
    this.generation += 1
    this.cancelTimer()
    this.cancelRequest()
    this.publish({ stale: this.state.snapshot !== undefined, networkError: undefined })
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

  async performAction(action: CompanyAction, payload: unknown): Promise<boolean> {
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
      expectedRevision: snapshot.revision,
      action,
      payload,
    }
    this.publish({ action, actionError: undefined, networkError: undefined })

    try {
      let body: unknown
      if (this.actionTransport !== undefined) {
        body = await this.actionTransport(request, controller.signal)
      } else {
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
        body = await readResponseJson(response)
        if (!response.ok) {
          throw new HttpResponseError(
            response.status,
            errorMessageFromJson(body, `Company action failed (HTTP ${response.status})`),
          )
        }
      }
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return false

      // A Host may return the next snapshot directly. Validate it before use,
      // then still repull: the HTTP state endpoint remains the presentation truth.
      if (body !== undefined) {
        try {
          const next = parseCompanySnapshot(body)
          if (next.company.id === snapshot.company.id) {
            this.publish({
              snapshot: next,
              archived: next.company.phase === 'archived',
              stale: false,
              lastSuccessfulAt: this.now(),
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
      if (controller.signal.aborted || this.disposed || generation !== this.generation) return false
      const conflict = error instanceof HttpResponseError && error.status === 409
      this.publish({
        action: undefined,
        actionError: messageOf(error),
        stale: this.state.snapshot !== undefined,
      })
      if (conflict) await this.refresh('revision-conflict')
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
    this.listeners.clear()
  }

  private async pull(sessionId: string, generation: number, controller: AbortController): Promise<void> {
    const hadSnapshot = this.state.snapshot !== undefined
    this.publish({ loading: !hadSnapshot, networkError: undefined })
    try {
      let snapshot: CompanySnapshot | undefined
      let archived = false
      try {
        snapshot = await this.fetchSnapshot(sessionId, false, controller.signal)
      } catch (error) {
        if (!(error instanceof NotFoundError)) throw error
        try {
          snapshot = await this.fetchSnapshot(sessionId, true, controller.signal)
          archived = snapshot !== undefined
        } catch (archiveError) {
          if (!(archiveError instanceof NotFoundError)) throw archiveError
        }
      }

      if (this.disposed || controller.signal.aborted || generation !== this.generation) return
      this.publish({
        snapshot,
        archived,
        loading: false,
        stale: false,
        lastSuccessfulAt: this.now(),
        networkError: undefined,
      })
    } catch (error) {
      if (this.disposed || controller.signal.aborted || generation !== this.generation) return
      this.publish({
        loading: false,
        stale: this.state.snapshot !== undefined,
        networkError: messageOf(error),
      })
    } finally {
      if (this.request?.controller === controller) this.request = undefined
      if (!this.disposed && generation === this.generation) this.schedule()
    }
  }

  private async fetchSnapshot(
    sessionId: string,
    archived: boolean,
    signal: AbortSignal,
  ): Promise<CompanySnapshot> {
    const query = new URLSearchParams({
      sessionId,
      archived: archived ? '1' : '0',
    })
    const response = await this.fetcher(`${STATE_ROUTE}?${query.toString()}`, {
      cache: 'no-store',
      credentials: 'same-origin',
      headers: { accept: 'application/json' },
      signal,
    })
    const body = await readResponseJson(response)
    const message = errorMessageFromJson(body, `Could not load company (HTTP ${response.status})`)
    if (
      response.status === 404 ||
      (response.status === 422 && message === 'no company exists for this workspace')
    ) {
      throw new NotFoundError('Company not found')
    }
    if (!response.ok) {
      throw new HttpResponseError(response.status, message)
    }
    return parseCompanySnapshot(body)
  }

  private schedule(): void {
    this.cancelTimer()
    if (
      this.disposed ||
      !this.visible ||
      this.state.sessionId === undefined ||
      this.state.archived ||
      this.state.action !== undefined
    ) {
      return
    }

    const requested = this.state.snapshot?.poll_after_ms
    const fast = clampPoll(requested ?? this.openPollMs)
    let delay: number
    if (
      this.state.open ||
      (this.state.snapshot !== undefined && isCompanyLive(this.state.snapshot))
    ) {
      delay = fast
    } else {
      delay = Math.max(fast * 15, this.closedPollMs)
    }
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
