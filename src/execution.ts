import { freemem } from 'node:os'
import { monitorEventLoopDelay } from 'node:perf_hooks'
import { getHeapStatistics } from 'node:v8'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { CompanyState, ResolvedCompanyConfig } from './types.js'

export type ExecutionWaitReason = 'concurrency' | 'memory' | 'event_loop' | 'storage' | 'provider_rate_limit' | 'employee_busy'
export class CompanyExecutionDeferredError extends Error {
  constructor(readonly reason: ExecutionWaitReason, readonly retryAfterMs: number) {
    super(`Employee execution is queued: ${reason}`)
    this.name = 'CompanyExecutionDeferredError'
  }
}

export interface ExecutionPressure {
  memoryRatio: number
  lagMs: number
  pendingWrites: number
}

interface PressureSource {
  getPressure?(): { pendingWrites: number; activeWrites: number; oldestPendingWriteMs: number; lastWriteMs: number }
}
interface Participant { companyId: string; cwd: string | undefined; provider: string }
interface Permit extends Participant { starting: boolean }
interface Waiting extends Participant { reason: ExecutionWaitReason; retryAt: number }

const controllers = new WeakMap<object, CompanyExecutionController>()

export function hasEmployeeExecution(agent: ReturnType<Context['agents']['get']>): boolean {
  // Inbox acceptance precedes the microtask that changes status to running.
  // A queued next turn owns a slot even while the Host still reports idle.
  return agent?.status === 'running' || (agent?.inbox?.nextTurn.length ?? 0) > 0
}

/** A shared Host admission controller; waiting work stays in its durable queue. */
export class CompanyExecutionController {
  private readonly permits = new Map<string, Permit>()
  private readonly waiting = new Map<string, Waiting>()
  private readonly companies = new Map<string, string>()
  private readonly providerBackoffs = new Map<string, number>()
  private readonly lag = monitorEventLoopDelay({ resolution: 20 })
  private target: number
  private adjustedAt = 0
  private lagObservedAt = 0
  private observedLagMs = 0
  private wakeup?: (cwd: string | undefined, delayMs: number) => void
  private closed = false
  private pendingAccounting = 0

  constructor(
    private readonly ctx: Pick<Context, 'agents'>,
    readonly config: ResolvedCompanyConfig,
    private readonly store: PressureSource,
    private readonly sensor?: () => ExecutionPressure,
    private readonly now: () => number = Date.now,
  ) {
    this.target = config.maxConcurrentEmployees
    if (sensor === undefined && config.executionMode !== 'unlimited') this.lag.enable()
  }

  get disposed(): boolean { return this.closed }
  setWakeup(wakeup: (cwd: string | undefined, delayMs: number) => void): void { this.wakeup = wakeup }
  setAccountingBacklog(count: number): void { this.pendingAccounting = Math.max(0, count) }
  clearWaiting(sessionId: string): void { this.waiting.delete(sessionId) }

  observe(state: CompanyState, cwd?: string): void {
    if (this.closed) return
    if (cwd !== undefined) this.companies.set(cwd, state.id)
    const current = new Set<string>()
    for (const employee of state.employees) {
      if (employee.sessionId === undefined || employee.status === 'retired') continue
      current.add(employee.sessionId)
      if (!hasEmployeeExecution(this.ctx.agents.get(SessionId(employee.sessionId))) || this.permits.has(employee.sessionId)) continue
      this.permits.set(employee.sessionId, { companyId: state.id, cwd, provider: employee.llm.activeProvider ?? employee.llm.provider, starting: false })
    }
    for (const [id, row] of this.waiting) if (row.companyId === state.id && (!current.has(id) || !['operating', 'provisioning'].includes(state.phase))) this.waiting.delete(id)
    this.reap()
  }

  private reap(): void {
    for (const [id, permit] of this.permits) {
      if (!permit.starting && !hasEmployeeExecution(this.ctx.agents.get(SessionId(id)))) this.permits.delete(id)
    }
    for (const [provider, until] of this.providerBackoffs) if (until <= this.now()) this.providerBackoffs.delete(provider)
  }

  private pressure(): ExecutionPressure {
    if (this.sensor !== undefined) return this.sensor()
    const memory = process.memoryUsage()
    const measuredAvailable = typeof process.availableMemory === 'function' ? process.availableMemory() : undefined
    const available = measuredAvailable !== undefined && Number.isFinite(measuredAvailable) && measuredAvailable >= 0 ? measuredAvailable : freemem()
    if (this.now() - this.lagObservedAt >= Math.min(1_000, this.config.executionRetryMs)) {
      const measured = this.lag.percentile(99) / 1e6
      this.observedLagMs = Number.isFinite(measured) ? measured : 0
      this.lag.reset()
      this.lagObservedAt = this.now()
    }
    return {
      memoryRatio: Math.max(memory.heapUsed / getHeapStatistics().heap_size_limit, memory.rss / Math.max(1, memory.rss + available)),
      lagMs: this.observedLagMs,
      pendingWrites: (this.store.getPressure?.().pendingWrites ?? 0) + this.pendingAccounting,
    }
  }

  private admissionReason(provider: string): { reason: ExecutionWaitReason; delay: number } | undefined {
    const retry = this.config.executionRetryMs
    const backoff = (this.providerBackoffs.get(provider) ?? 0) - this.now()
    if (backoff > 0) return { reason: 'provider_rate_limit', delay: Math.max(retry, backoff) }
    if (this.config.executionMode === 'unlimited') return undefined
    const pressure = this.pressure()
    const reason = pressure.memoryRatio >= this.config.executionMemoryHighWatermark ? 'memory'
      : pressure.lagMs >= this.config.executionLagHighWatermarkMs ? 'event_loop'
        : pressure.pendingWrites >= this.config.executionMaxPendingWrites ? 'storage' : undefined
    if (reason !== undefined) {
      if (this.config.executionMode === 'adaptive' && this.now() - this.adjustedAt >= retry) {
        this.target = Math.max(1, Math.floor(this.target / 2))
        this.adjustedAt = this.now()
      }
      return { reason, delay: retry }
    }
    if (this.config.executionMode === 'fixed') {
      return this.permits.size >= this.config.maxConcurrentEmployees ? { reason: 'concurrency', delay: retry } : undefined
    }
    // Additive growth under sustained headroom; the initial target is not a
    // hard ceiling. Pressure reduces new admission, never aborts accepted work.
    if (this.permits.size >= this.target && this.now() - this.adjustedAt >= retry
      && pressure.memoryRatio < this.config.executionMemoryHighWatermark * 0.85
      && pressure.lagMs < this.config.executionLagHighWatermarkMs * 0.5 && pressure.pendingWrites === 0) {
      this.target += 1
      this.adjustedAt = this.now()
    }
    return this.permits.size >= this.target ? { reason: 'concurrency', delay: retry } : undefined
  }

  check(sessionId: string, cwd: string | undefined, provider: string): void {
    if (this.closed) throw new Error('Company execution admission is disposed')
    this.reap()
    const participant = { companyId: cwd === undefined ? '' : this.companies.get(cwd) ?? '', cwd, provider }
    const refused = this.permits.has(sessionId) || hasEmployeeExecution(this.ctx.agents.get(SessionId(sessionId)))
      ? { reason: 'employee_busy' as const, delay: this.config.executionRetryMs }
      : this.admissionReason(provider)
    if (refused !== undefined) {
      this.waiting.set(sessionId, { ...participant, reason: refused.reason, retryAt: this.now() + refused.delay })
      this.wakeup?.(cwd, refused.delay)
      throw new CompanyExecutionDeferredError(refused.reason, refused.delay)
    }
  }

  async run<T>(sessionId: string, cwd: string | undefined, provider: string, operation: () => Promise<T>): Promise<T> {
    this.check(sessionId, cwd, provider)
    const participant = { companyId: cwd === undefined ? '' : this.companies.get(cwd) ?? '', cwd, provider }
    const permit: Permit = { ...participant, starting: true }
    this.permits.set(sessionId, permit)
    this.waiting.delete(sessionId)
    try {
      const result = await operation()
      permit.starting = false
      this.reap()
      return result
    } catch (error) {
      if (this.permits.get(sessionId) === permit) this.permits.delete(sessionId)
      throw error
    }
  }

  rateLimited(provider: string, retryAfterMs = 30_000, cwd?: string): void {
    if (this.closed) return
    const delay = Number.isFinite(retryAfterMs) ? Math.max(this.config.executionRetryMs, retryAfterMs) : 30_000
    const until = Math.max(this.providerBackoffs.get(provider) ?? 0, this.now() + delay)
    this.providerBackoffs.set(provider, until)
    for (const [id, participant] of this.permits) {
      if (participant.provider !== provider) continue
      this.waiting.set(id, { ...participant, reason: 'provider_rate_limit', retryAt: until })
      this.wakeup?.(participant.cwd, until - this.now())
    }
    if (cwd !== undefined) this.wakeup?.(cwd, until - this.now())
  }

  snapshot(companyId: string): { mode: ResolvedCompanyConfig['executionMode']; running: number; limit: number | null; waiting: number; reason?: string; retry_at?: number } {
    this.reap()
    const rows = [...this.waiting.values()].filter((row) => row.companyId === companyId)
    const next = rows.reduce<Waiting | undefined>((first, row) => first === undefined || row.retryAt < first.retryAt ? row : first, undefined)
    return {
      mode: this.config.executionMode,
      running: this.permits.size,
      limit: this.config.executionMode === 'unlimited' ? null : this.config.executionMode === 'fixed' ? this.config.maxConcurrentEmployees : this.target,
      waiting: rows.length,
      ...(next === undefined ? {} : { reason: next.reason, retry_at: next.retryAt }),
    }
  }

  dispose(): void {
    this.closed = true
    this.lag.disable()
    this.permits.clear()
    this.waiting.clear()
    this.companies.clear()
    this.providerBackoffs.clear()
  }
}

export function getCompanyExecution(ctx: Pick<Context, 'agents'>): CompanyExecutionController | undefined {
  return controllers.get(ctx.agents)
}

export function ensureCompanyExecution(ctx: Context, config: ResolvedCompanyConfig, store: PressureSource, options: { sensor?: () => ExecutionPressure; now?: () => number } = {}): CompanyExecutionController {
  const previous = getCompanyExecution(ctx)
  if (previous !== undefined && !previous.disposed) return previous
  const controller = new CompanyExecutionController(ctx, config, store, options.sensor, options.now)
  controllers.set(ctx.agents, controller)
  return controller
}
