import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isHarnessError, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { interruptEmployee } from './employees.js'
import type { CompanyStore, MutationContext } from './state.js'
import type { CompanyState, OperationalBlock, OperationalBlockKind, ResolvedCompanyConfig } from './types.js'
import { temporaryAuthorizationStatus } from './authorizations.js'
import {
  CompanyMoneyBudgetError,
  CompanyUnpricedModelError,
  activeMoneyReservation,
  employeeMoneyTotals,
  ensureMoneyCallHeadroom,
  productMoneyTotals,
  recordMoneyUsage,
  requiredMoneyCallHeadroom,
  releaseEmployeeMoneyReservations,
  releaseMoneyReservation,
  resolveRateSnapshot,
} from './money.js'
import type { MoneyRateSnapshot, MoneyReservation } from './types.js'

interface CapturedRoute {
  provider: string
  model: string
  rates?: MoneyRateSnapshot | null
  companyId?: string
  reservation?: MoneyReservation
  authorizationUseId?: string
}

export function installCompanyAccounting(ctx: Context, store: CompanyStore, config: ResolvedCompanyConfig): () => Promise<void> {
  const routes = new Map<string, CapturedRoute>()
  const disposers: Array<() => void> = []
  const inFlight = new Map<string, Set<Promise<void>>>()
  let disposed = false

  const account = (session: Session, event: SessionEvent<'assistant/message'>): Promise<void> => {
    const key = String(session.id)
    const tasks = inFlight.get(key) ?? new Set<Promise<void>>()
    inFlight.set(key, tasks)
    const task = accountUsage(ctx, store, session, event, routes).catch(async (error) => {
      ctx.logger.warn(`dsh-company money accounting failed: ${String(error)}`)
      const agent = ctx.agents.get(SessionId(String(session.id)))
      if (agent !== undefined) await handleOperationalFailure(ctx, store, agent, {
        kind: 'money_budget', code: 'COMPANY_ACCOUNTING_FAILURE', message: String(error).slice(0, 4096), at: Date.now(),
      }, config).catch((failure) => ctx.logger.warn(`dsh-company accounting halt failed: ${String(failure)}`))
    }).finally(() => {
      tasks.delete(task)
      if (tasks.size === 0) inFlight.delete(key)
    })
    tasks.add(task)
    return task
  }

  const replay = (session: Session): void => {
    if (disposed) return
    for (const event of session.events) {
      if (event.type === 'assistant/message' && event.data.usage !== undefined) void account(session, event)
    }
  }

  disposers.push(ctx.on('agent/request', async (payload, next) => {
    // The initial lookup decides only whether this agent belongs to a company;
    // no authorization decision below relies on this potentially stale state.
    const participant = await findParticipant(store, payload.agent)
    // Resolve the actual route before revalidating employee admission. Budget
    // and execution state gate each new request, but never clamp max_tokens.
    // A provider response that exceeds its reservation is still recorded in
    // full; subsequent work can then be stopped without hiding actual spend.
    const call = await next()
    if (participant === undefined) return call
    if (participant.kind === 'founder') {
      const fresh = await store.readActive(payload.agent.session.header.cwd)
      if (fresh === undefined || fresh.id !== participant.state.id || fresh.founderSessionId !== String(payload.agent.id)) return call
      let rates: MoneyRateSnapshot | undefined
      try { rates = resolveRateSnapshot(fresh, call.provider, call.model) } catch (error) {
        if (!(error instanceof CompanyUnpricedModelError)) throw error
      }
      routes.set(routeKey(String(payload.agent.id), payload.turn, payload.step), {
        companyId: fresh.id,
        provider: call.provider,
        model: call.model,
        ...(rates === undefined ? {} : { rates }),
      })
      return call
    }
    const expectedReservationId = activeMoneyReservation(participant.state, participant.employee.id)?.id
    const validated = await store.transact(payload.agent.session.header.cwd, {
      actor: 'scheduler', type: 'money.request_validated', summary: `Validated provider request for ${participant.employee.id}`,
    }, (state) => {
      if (state.id !== participant.state.id) throw new Error('active company changed before provider request')
      const employee = state.employees.find((candidate) => candidate.sessionId === String(payload.agent.id))
      if (employee === undefined) throw new Error('employee disappeared before provider request')
      if (state.phase !== 'operating' && state.phase !== 'provisioning') throw new Error(`company is ${state.phase}; employee provider requests are not executable`)
      if (!['idle', 'working', 'provisioning'].includes(employee.status)) throw new Error(`employee ${employee.id} is ${employee.status}; provider requests are not executable`)
      if (employee.operationalBlock !== undefined) throw new Error(`employee ${employee.id} is operationally blocked: ${employee.operationalBlock.code}`)
      const reservation = activeMoneyReservation(state, employee.id)
      if (expectedReservationId === undefined || reservation === undefined) {
        throw new Error(`requested route ${call.provider}/${call.model} was not captured by the reservation`)
      }
      if (reservation.id !== expectedReservationId) throw new Error('money reservation changed before provider request')
      // startContinuable returns after inbox acceptance, before the welcome
      // turn finishes. Bootstrap briefly marks its employee idle before the
      // following transaction switches the company to operating.
      if (state.phase === 'provisioning' && (!['provisioning', 'idle'].includes(employee.status)
        || state.provisioning?.employeeIds.includes(employee.id) !== true
        || state.provisioning.reservationIds.includes(reservation.id) !== true)) {
        throw new Error(`employee ${employee.id} request is outside the current company provisioning generation`)
      }
      const capturedRoutes = reservation.routes
        ?? reservation.routeRates?.map(({ provider, model }) => ({ provider, model }))
        ?? (reservation.rates === undefined ? [] : [{ provider: reservation.rates.provider, model: reservation.rates.model }])
      if (!capturedRoutes.some((candidate) => candidate.provider === call.provider && candidate.model === call.model)) {
        throw new Error(`requested route ${call.provider}/${call.model} was not captured by the reservation`)
      }
      const now = Date.now()
      const authorizationId = reservation.authorizationId
      let authorizationUseId: string | undefined
      if (authorizationId !== undefined) {
        const authorization = state.temporaryAuthorizations.find((candidate) => candidate.id === authorizationId)
        const status = authorization === undefined ? 'missing' : temporaryAuthorizationStatus(authorization, now)
        if (status !== 'active') throw new Error(`temporary authorization ${authorizationId} is ${status}; its reservation is no longer executable`)
        for (let index = (authorization?.uses.length ?? 0) - 1; index >= 0; index -= 1) {
          const use = authorization!.uses[index]!
          if (use.workId !== reservation.workId || use.at > reservation.createdAt) continue
          authorizationUseId = use.id
          break
        }
      }
      if (reservation.remainingMicros < requiredMoneyCallHeadroom(reservation)) {
        ensureMoneyCallHeadroom(state, reservation.id, now)
      }
      const capturedRates = reservation.routeRates?.find((candidate) => candidate.provider === call.provider && candidate.model === call.model)
      const rates = capturedRates ?? (reservation.unknownCost === true
        ? undefined
        : reservation.rates ?? resolveRateSnapshot(state, call.provider, call.model))
      return { reservation: structuredClone(reservation), ...(authorizationUseId === undefined ? {} : { authorizationUseId }), ...(rates === undefined ? {} : { rates }) }
    })
    routes.set(routeKey(String(payload.agent.id), payload.turn, payload.step), {
      companyId: participant.state.id,
      reservation: validated.result.reservation,
      ...(validated.result.authorizationUseId === undefined ? {} : { authorizationUseId: validated.result.authorizationUseId }),
      provider: call.provider,
      model: call.model,
      ...(validated.result.rates === undefined ? {} : { rates: validated.result.rates }),
    })
    // The call config passes through untouched: no injected and no clamped
    // max_tokens. Only the harness/provider route capability caps output.
    return call
  }))

  // session/event is fire-and-forget in DSH. Track each accounting task and
  // join it at the awaited session/flush checkpoint; replay restored session
  // history on creation so a crash between event commit and company commit is
  // repaired idempotently by (sessionId,eventSeq).
  disposers.push(ctx.on('session/event', (session, event) => {
    if (disposed || event.type !== 'assistant/message' || event.data.usage === undefined) return
    void account(session, event)
  }))
  disposers.push(ctx.on('session/flush', async (session) => {
    const tasks = inFlight.get(String(session.id))
    if (tasks !== undefined) await Promise.all([...tasks])
  }))
  disposers.push(ctx.on('session/created', (session) => replay(session)))
  queueMicrotask(() => {
    const list = (ctx.agents as typeof ctx.agents & { list?: () => Agent[] }).list
    if (!disposed && typeof list === 'function') for (const agent of list.call(ctx.agents)) replay(agent.session)
  })

  disposers.push(ctx.on('agent/request-error', async (payload, next) => {
    const action = await next()
    if (action === undefined) {
      routes.delete(routeKey(String(payload.agent.id), payload.turn, payload.step))
      await handleOperationalFailure(ctx, store, payload.agent, blockFromFailure(payload.failure), config)
        .catch((error) => ctx.logger.warn(`dsh-company operational failure handling failed: ${String(error)}`))
    }
    return action
  }))

  disposers.push(ctx.on('agent/error', (payload) => {
    if (payload.error instanceof CompanyMoneyBudgetError || payload.error instanceof CompanyUnpricedModelError) {
      void handleOperationalFailure(ctx, store, payload.agent, {
        kind: payload.error instanceof CompanyUnpricedModelError ? 'unpriced_model' : 'money_budget',
        code: payload.error instanceof CompanyMoneyBudgetError ? `${payload.error.code}:${payload.error.level}` : payload.error.code,
        message: payload.error.message, at: Date.now(),
      }, config).catch((error) => ctx.logger.warn(`dsh-company token halt handling failed: ${String(error)}`))
      return
    }
    if (isHarnessError(payload.error)) {
      const block = blockFromCode(payload.error.code, payload.error.message)
      if (block !== undefined) void handleOperationalFailure(ctx, store, payload.agent, block, config)
        .catch((error) => ctx.logger.warn(`dsh-company agent failure handling failed: ${String(error)}`))
    }
  }))

  return async () => {
    disposed = true
    for (const dispose of disposers.reverse()) dispose()
    await Promise.all([...inFlight.values()].flatMap((tasks) => [...tasks]))
    inFlight.clear()
    routes.clear()
  }
}

async function accountUsage(
  ctx: Context,
  store: CompanyStore,
  session: Session,
  event: SessionEvent<'assistant/message'>,
  routes: Map<string, CapturedRoute>,
): Promise<void> {
  const cwd = session.header.cwd
  if (cwd === undefined || event.data.usage === undefined) return
  const state = await store.readActive(cwd)
  if (state === undefined) return
  // Retirement stops future work, but a response already sent to the provider
  // still belongs in the company's factual ledger.
  const employee = state.employees.find((candidate) => candidate.sessionId === String(session.id))
  const founderUsage = state.founderSessionId === String(session.id)
  if (employee === undefined && !founderUsage) return
  const usageId = `${String(session.id)}:${event.seq}`
  const key = routeKey(String(session.id), event.data.turn, event.data.step)
  if (state.moneyBudget.usage.some((entry) => entry.id === usageId)) {
    routes.delete(key)
    return
  }
  let route = routes.get(key)
  if (route?.companyId !== undefined && route.companyId !== state.id) return
  const currentReservation = employee === undefined ? undefined : activeMoneyReservation(state, employee.id)
  const reservation = route?.reservation ?? (currentReservation !== undefined && currentReservation.createdAt <= event.time ? currentReservation : undefined)
  const missingEmployeeReservation = employee !== undefined && reservation === undefined
  let missingRouteAttribution = false
  if (route === undefined && employee !== undefined && reservation !== undefined) {
    const capturedRoutes = reservation.routes ?? reservation.routeRates?.map(({ provider, model }) => ({ provider, model }))
      ?? (reservation.rates === undefined ? [] : [{ provider: reservation.rates.provider, model: reservation.rates.model }])
    const onlyRoute = capturedRoutes.length === 1 ? capturedRoutes[0] : undefined
    if (onlyRoute === undefined) {
      // A restored assistant event does not identify which fallback was used.
      // The current active route cannot establish a historical price.
      missingRouteAttribution = true
      route = { provider: 'dsh-employee', model: 'historical-unattributed-route', rates: null }
    } else {
      const capturedRates = reservation.routeRates?.find((candidate) => candidate.provider === onlyRoute.provider && candidate.model === onlyRoute.model)
      const rates = capturedRates ?? (reservation.unknownCost === true ? undefined : reservation.rates)
      route = { ...onlyRoute, ...(rates === undefined ? {} : { rates }) }
    }
  }
  if (route === undefined && employee !== undefined && reservation === undefined) {
    route = {
      provider: employee.llm.activeProvider ?? employee.llm.provider,
      model: employee.llm.activeModel ?? employee.llm.model,
    }
  }
  if (route === undefined && founderUsage) {
    if (Number.isSafeInteger(session.firstLiveSeq) && event.seq < session.firstLiveSeq) {
      route = { provider: 'dsh-founder', model: 'historical-unattributed-route' }
    } else {
      const founder = ctx.agents.get(SessionId(String(session.id)))
      const request = founder?.session.requestHeader()?.config
      const provider = request?.provider ?? founder?.options.provider
      const model = request?.model ?? founder?.options.model
      if (provider === undefined || model === undefined) throw new Error(`founder usage ${usageId} has no attributable model route`)
      let rates: MoneyRateSnapshot | undefined
      try { rates = resolveRateSnapshot(state, provider, model) } catch (error) {
        if (!(error instanceof CompanyUnpricedModelError)) throw error
      }
      route = { provider, model, ...(rates === undefined ? {} : { rates }) }
    }
  }
  if (route === undefined) throw new Error(`usage ${usageId} has no attributable route`)
  const actorId = employee?.id ?? 'founder'
  const open = state.workItems.find((work) => work.assigneeId === actorId && (work.status === 'claimed' || work.status === 'in_progress'))
  const attributedWorkId = reservation?.workId ?? (employee === undefined ? open?.id : undefined)
  const accounted = await store.transact(cwd, {
    actor: 'scheduler', type: 'money.recorded', summary: `Recorded factual model usage ${session.id}:${event.seq}`,
  }, async (fresh, io) => {
    if (fresh.id !== state.id) return
    const currentEmployee = employee === undefined ? undefined : fresh.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === String(session.id))
    if (employee !== undefined && currentEmployee === undefined) return
    if (employee === undefined && fresh.founderSessionId !== String(session.id)) return
    const entry = recordMoneyUsage(fresh, {
      sessionId: String(session.id), eventSeq: event.seq, turn: event.data.turn, step: event.data.step,
      employeeId: actorId, ...(attributedWorkId === undefined ? {} : { workId: attributedWorkId }),
      provider: route.provider, model: route.model, ...(route.rates === undefined ? {} : { rates: route.rates }),
      reservation: reservation ?? null,
      ...(route.authorizationUseId === undefined ? {} : { authorizationUseId: route.authorizationUseId }),
      ...(founderUsage || missingEmployeeReservation || missingRouteAttribution ? { allowUnpriced: true } : {}), usage: event.data.usage!, at: event.time,
    })
    if (entry === undefined) return
    if ((missingEmployeeReservation || missingRouteAttribution) && !entry.priced && currentEmployee !== undefined && currentEmployee.status !== 'retired') {
      currentEmployee.status = 'paused'
      currentEmployee.operationalBlock = {
        kind: 'unknown',
        code: 'COMPANY_ACCOUNTING_RECONCILIATION',
        message: `Usage ${entry.id} was recovered without an attributable immutable model route or reservation. Token counts are preserved as unknown cost; inspect and resume explicitly.`,
        at: event.time,
      }
      await releaseEmployeeAssignments(fresh, io, currentEmployee.id, event.time)
      fresh.health = { status: 'degraded', reason: 'unknown', detail: currentEmployee.operationalBlock.message, detectedAt: event.time, resumable: true }
      return [structuredClone(currentEmployee)]
    }
    const authorizedOverrun = entry.authorizationId !== undefined
    const companyOverrun = !authorizedOverrun && fresh.moneyBudget.spentMicros + fresh.moneyBudget.reservedMicros > fresh.moneyBudget.totalMicros
    const employeeOverrun = currentEmployee === undefined ? false : !authorizedOverrun && employeeMoneyTotals(fresh, currentEmployee.id).spentMicros
      + employeeMoneyTotals(fresh, currentEmployee.id).reservedMicros > (currentEmployee.budgetMicros ?? 0)
    const productOverrun = authorizedOverrun || entry.productId === undefined ? false : (() => {
      const product = fresh.products.find((candidate) => candidate.id === entry.productId)
      const totals = productMoneyTotals(fresh, entry.productId!)
      return totals.spentMicros + totals.reservedMicros > (product?.budgetMicros ?? 0)
    })()
    if (!companyOverrun && !employeeOverrun && !productOverrun) return
    const block: OperationalBlock = {
      kind: 'money_budget',
      code: 'COMPANY_MONEY_BUDGET',
      message: companyOverrun ? 'Company monetary budget is overdrawn.'
        : productOverrun ? `Product ${entry.productId} monetary budget is overdrawn.`
          : `Employee ${currentEmployee?.id ?? 'founder'} monetary budget is overdrawn.`,
      at: event.time,
    }
    if (fresh.phase !== 'operating') {
      if (fresh.phase === 'staged' || fresh.phase === 'provisioning' || fresh.phase === 'provisioning_failed') {
        fresh.health = { status: 'degraded', reason: 'money_budget', detail: block.message, detectedAt: event.time, resumable: true }
      }
      return
    }
    const targets = companyOverrun || currentEmployee === undefined
      ? fresh.employees.filter((candidate) => candidate.status !== 'retired' && candidate.status !== 'failed')
      : currentEmployee.status === 'retired' || currentEmployee.status === 'failed' ? [] : [currentEmployee]
    for (const target of targets) {
      target.operationalBlock = { ...block }
      target.status = 'paused'
      await releaseEmployeeAssignments(fresh, io, target.id, event.time)
    }
    if (companyOverrun) {
      fresh.phase = 'halted'
      fresh.pausedAt = event.time
      fresh.health = { status: 'halted', reason: 'money_budget', detail: block.message, detectedAt: event.time, resumable: true }
    } else {
      fresh.health = { status: 'degraded', reason: 'money_budget', detail: block.message, detectedAt: event.time, resumable: true }
    }
    return targets.map((target) => structuredClone(target))
  })
  routes.delete(key)
  const founder = ctx.agents.get(SessionId(accounted.state.founderSessionId))
  if (founder !== undefined) {
    for (const target of accounted.result ?? []) interruptEmployee(ctx, founder, target)
  }
  if (accounted.state.moneyBudget.spentMicros > accounted.state.moneyBudget.totalMicros) {
    ctx.logger.warn(`dsh-company ${accounted.state.id} monetary usage exceeded its configured limit; actual spend was preserved`)
  }
}

async function handleOperationalFailure(
  ctx: Context,
  store: CompanyStore,
  agent: Agent,
  block: OperationalBlock | undefined,
  _config: ResolvedCompanyConfig,
): Promise<void> {
  if (block === undefined || agent.session.header.cwd === undefined) return
  const snapshot = await store.readActive(agent.session.header.cwd)
  const employee = snapshot?.employees.find((candidate) => candidate.sessionId === String(agent.id) && candidate.status !== 'retired')
  if (snapshot === undefined || employee === undefined) return
  await handleEmployeeOperationalFailure(ctx, store, agent.session.header.cwd, employee.id, block)
}

export async function handleEmployeeOperationalFailure(
  ctx: Context,
  store: CompanyStore,
  cwd: string,
  employeeId: string,
  block: OperationalBlock,
): Promise<void> {
  const snapshot = await store.readActive(cwd)
  const employee = snapshot?.employees.find((candidate) => candidate.id === employeeId && candidate.status !== 'retired')
  if (snapshot === undefined || employee === undefined || snapshot.phase !== 'operating') return
  const handled = await store.transact(cwd, {
    actor: 'scheduler', type: 'company.operational_block', summary: `${employee.id} blocked by ${block.kind}: ${block.code}`,
  }, async (state, io) => {
    if (state.phase !== 'operating') return
    const current = state.employees.find((candidate) => candidate.id === employee.id)
    if (current === undefined || current.status === 'retired') return
    const provider = current.llm.activeProvider ?? current.llm.provider
    const companyMoneyBlock = block.kind === 'money_budget' && block.code.endsWith(':company')
    const employeeScoped = block.kind === 'unpriced_model'
      || (block.kind === 'money_budget' && !companyMoneyBlock)
    const targets = state.employees.filter((candidate) => candidate.status !== 'retired' && candidate.status !== 'failed' && (
      block.kind === 'network' || companyMoneyBlock ? true
        : employeeScoped ? candidate.id === current.id
          : (candidate.llm.activeProvider ?? candidate.llm.provider) === provider
    ))
    for (const target of targets) {
      target.operationalBlock = { ...block }
      target.status = 'paused'
      await releaseEmployeeAssignments(state, io, target.id, Date.now())
    }
    haltIfAllBlocked(state, block.kind, block.message)
    if (state.phase === 'operating') state.health = { status: 'degraded', reason: block.kind, detail: block.message, detectedAt: Date.now(), resumable: true }
    return targets.map((target) => structuredClone(target))
  })
  const founder = ctx.agents.get(SessionId(handled.state.founderSessionId))
  if (founder !== undefined) for (const target of handled.result ?? []) interruptEmployee(ctx, founder, target)
  ctx.logger.warn(`dsh-company employee ${employee.id} halted: ${block.code}`)
}

async function releaseEmployeeAssignments(state: CompanyState, io: MutationContext, employeeId: string, now: number): Promise<void> {
  releaseEmployeeMoneyReservations(state, employeeId)
  const messages = await io.readMailbox(employeeId)
  let mailboxChanged = false
  for (const message of messages) {
    if (message.deliveryState !== 'reserved') continue
    message.deliveryState = 'queued'
    message.reservationId = undefined
    message.leaseAt = undefined
    mailboxChanged = true
  }
  if (mailboxChanged) await io.writeMailbox(employeeId, messages)
  for (const request of state.staffingRequests) {
    if (request.hrEmployeeId !== employeeId) continue
    request.reservationId = undefined
    request.leaseAt = undefined
    if (request.status === 'in_review') {
      request.status = 'pending'
      request.attemptId = undefined
      request.reviewDeliveryAttempts = 0
      request.lastDeliveredAt = undefined
      request.updatedAt = now
    }
  }
  for (const work of state.workItems) {
    if (work.assigneeId !== employeeId || (work.status !== 'claimed' && work.status !== 'in_progress')) continue
    if (work.reservationId !== undefined) releaseMoneyReservation(state, work.reservationId)
    work.status = 'pending'
    work.attempt = Math.max(0, work.attempt - 1)
    work.deliveryAttempts = 0
    work.attemptId = undefined
    work.reservationId = undefined
    work.leaseAt = undefined
    work.updatedAt = now
  }
}

async function findParticipant(store: CompanyStore, agent: Agent): Promise<
  | { kind: 'founder'; state: CompanyState }
  | { kind: 'employee'; state: CompanyState; employee: CompanyState['employees'][number] }
  | undefined
> {
  if (agent.session.header.cwd === undefined) return undefined
  const state = await store.readActive(agent.session.header.cwd)
  if (state === undefined) return undefined
  if (state.founderSessionId === String(agent.id)) return { kind: 'founder', state }
  const employee = state.employees.find((candidate) => candidate.sessionId === String(agent.id))
  return employee === undefined ? undefined : { kind: 'employee', state, employee }
}

function haltIfAllBlocked(state: CompanyState, kind: OperationalBlockKind, detail: string): void {
  const active = state.employees.filter((employee) => employee.status !== 'retired' && employee.status !== 'failed')
  if (active.length === 0 || active.some((employee) => employee.operationalBlock === undefined)) return
  state.phase = 'halted'
  state.pausedAt = Date.now()
  state.health = { status: 'halted', reason: kind, detail, detectedAt: Date.now(), resumable: true }
}

function blockFromFailure(failure: LlmFailure): OperationalBlock | undefined {
  return blockFromCode(failure.code, failure.message)
}

function blockFromCode(code: string, message: string): OperationalBlock | undefined {
  const kind: OperationalBlockKind | undefined = code === 'QUOTA' ? 'quota'
    : code === 'TRANSPORT' || code === 'TIMEOUT' ? 'network'
      : code === 'RATE_LIMIT' ? 'rate_limit'
        : ['AUTH', 'INVALID_CREDENTIAL', 'MISSING_CREDENTIAL', 'NO_ADAPTER', 'SERVER'].includes(code) ? 'provider'
          : code === 'COMPANY_MONEY_BUDGET' ? 'money_budget'
            : code === 'COMPANY_UNPRICED_MODEL' ? 'unpriced_model'
              : code === 'NOT_RESUMABLE' ? 'session_unrecoverable'
            : undefined
  return kind === undefined ? undefined : { kind, code, message: message.slice(0, 4096), at: Date.now() }
}

function routeKey(sessionId: string, turn: number, step: number): string {
  return `${sessionId}:${turn}:${step}`
}
