import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { isHarnessError, type LlmCallConfig, type LlmFailure } from '@deepseek-ai/dsh-llm'
import { SessionId, type Session, type SessionEvent } from '@deepseek-ai/dsh-session'
import { interruptEmployee } from './employees.js'
import type { CompanyStore } from './state.js'
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
import type { MoneyRateSnapshot } from './types.js'

export function installCompanyAccounting(ctx: Context, store: CompanyStore, config: ResolvedCompanyConfig): () => void {
  const routes = new Map<string, { provider: string; model: string; rates?: MoneyRateSnapshot }>()
  const disposers: Array<() => void> = []

  disposers.push(ctx.on('agent/request', async (payload, next) => {
    const participant = await findEmployee(store, payload.agent)
    // Per-turn output limits are deliberately NOT enforced here. A company
    // reservation is an accounting unit, never a truncation device: blocking
    // mid-turn or clamping max_tokens would destroy agent output the human
    // explicitly wants to always finish, even over budget. The budget is
    // enforced purely post-hoc: usage is recorded beyond the reservation when
    // it happens, and the company halts only when spending exceeds the money
    // budget.
    const call = await next()
    if (participant === undefined) return call
    const reservation = activeMoneyReservation(participant.state, participant.employee.id)
    const capturedRoutes = reservation?.routes
      ?? reservation?.routeRates?.map(({ provider, model }) => ({ provider, model }))
      ?? (reservation?.rates === undefined ? [] : [{ provider: reservation.rates.provider, model: reservation.rates.model }])
    if (!capturedRoutes.some((candidate) => candidate.provider === call.provider && candidate.model === call.model)) {
      throw new Error(`requested route ${call.provider}/${call.model} was not captured by the reservation`)
    }
    const authorizationId = reservation?.authorizationId
    if (authorizationId !== undefined) {
      const authorization = participant.state.temporaryAuthorizations.find((candidate) => candidate.id === authorizationId)
      const status = authorization === undefined ? 'missing' : temporaryAuthorizationStatus(authorization, Date.now())
      if (status !== 'active') throw new Error(`temporary authorization ${authorizationId} is ${status}; its reservation is no longer executable`)
    }
    if (reservation !== undefined && reservation.remainingMicros < requiredMoneyCallHeadroom(reservation)) {
      await store.transact(payload.agent.session.header.cwd, {
        actor: 'scheduler', type: 'money.call_headroom', summary: `Renewed prompt-inclusive call headroom for ${participant.employee.id}`,
      }, (state) => {
        const employee = state.employees.find((candidate) => candidate.sessionId === String(payload.agent.id) && candidate.status !== 'retired')
        if (employee === undefined) throw new Error('employee disappeared while renewing monetary call headroom')
        const active = activeMoneyReservation(state, employee.id)
        if (active === undefined || active.id !== reservation!.id) throw new Error('money reservation changed before provider request')
        ensureMoneyCallHeadroom(state, active.id, Date.now())
        return structuredClone(active)
      })
    }
    const capturedRates = reservation?.routeRates?.find((candidate) => candidate.provider === call.provider && candidate.model === call.model)
    const rates = capturedRates ?? (reservation?.unknownCost === true
      ? undefined
      : reservation?.rates ?? resolveRateSnapshot(participant.state, call.provider, call.model))
    routes.set(routeKey(String(payload.agent.id), payload.turn, payload.step), { provider: call.provider, model: call.model, ...(rates === undefined ? {} : { rates }) })
    // The call config passes through untouched: no injected and no clamped
    // max_tokens. Only the harness/provider route capability caps output.
    return call
  }))

  disposers.push(ctx.on('session/event', async (session, event) => {
    if (event.type !== 'assistant/message' || event.data.usage === undefined) return
    try {
      await accountUsage(ctx, store, session, event, routes)
    } catch (error) {
      ctx.logger.warn(`dsh-company money accounting failed: ${String(error)}`)
      const agent = ctx.agents.get(SessionId(String(session.id)))
      if (agent !== undefined) await handleOperationalFailure(ctx, store, agent, {
        kind: 'money_budget', code: 'COMPANY_ACCOUNTING_FAILURE', message: String(error).slice(0, 4096), at: Date.now(),
      }, config).catch((failure) => ctx.logger.warn(`dsh-company accounting halt failed: ${String(failure)}`))
    }
  }))

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

  return () => { routes.clear(); for (const dispose of disposers.reverse()) dispose() }
}

async function accountUsage(
  ctx: Context,
  store: CompanyStore,
  session: Session,
  event: SessionEvent<'assistant/message'>,
  routes: Map<string, { provider: string; model: string; rates?: MoneyRateSnapshot }>,
): Promise<void> {
  const cwd = session.header.cwd
  if (cwd === undefined || event.data.usage === undefined) return
  const state = await store.readActive(cwd)
  const employee = state?.employees.find((candidate) => candidate.sessionId === String(session.id) && candidate.status !== 'retired')
  if (state === undefined || employee === undefined) return
  const usageId = `${String(session.id)}:${event.seq}`
  const key = routeKey(String(session.id), event.data.turn, event.data.step)
  if (state.moneyBudget.usage.some((entry) => entry.id === usageId)) {
    routes.delete(key)
    return
  }
  const reservation = activeMoneyReservation(state, employee.id)
  const defaultProvider = employee.llm.activeProvider ?? employee.llm.provider
  const defaultModel = employee.llm.activeModel ?? employee.llm.model
  const capturedDefault = reservation?.routeRates?.find((candidate) => candidate.provider === defaultProvider && candidate.model === defaultModel)
  const defaultRates = capturedDefault ?? (reservation?.unknownCost === true ? undefined : reservation?.rates ?? resolveRateSnapshot(state, defaultProvider, defaultModel))
  const route = routes.get(key) ?? {
    provider: defaultProvider,
    model: defaultModel,
    ...(defaultRates === undefined ? {} : { rates: defaultRates }),
  }
  routes.delete(key)
  const open = state.workItems.find((work) => work.assigneeId === employee.id && (work.status === 'claimed' || work.status === 'in_progress'))
  const attributedWorkId = reservation?.workId ?? open?.id
  const accounted = await store.transact(cwd, {
    actor: 'scheduler', type: 'money.recorded', summary: `Recorded priced model usage ${session.id}:${event.seq}`,
  }, async (fresh, io) => {
    const currentEmployee = fresh.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === String(session.id))
    if (currentEmployee === undefined) return
    const entry = recordMoneyUsage(fresh, {
      sessionId: String(session.id), eventSeq: event.seq, turn: event.data.turn, step: event.data.step,
      employeeId: employee.id, ...(attributedWorkId === undefined ? {} : { workId: attributedWorkId }),
      provider: route.provider, model: route.model, ...(route.rates === undefined ? {} : { rates: route.rates }), usage: event.data.usage!, at: event.time,
    })
    if (entry === undefined) return
    const authorizedOverrun = entry.authorizationId !== undefined
    const companyOverrun = !authorizedOverrun && fresh.moneyBudget.spentMicros + fresh.moneyBudget.reservedMicros > fresh.moneyBudget.totalMicros
    const employeeOverrun = !authorizedOverrun && employeeMoneyTotals(fresh, currentEmployee.id).spentMicros
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
          : `Employee ${currentEmployee.id} monetary budget is overdrawn.`,
      at: event.time,
    }
    const targets = companyOverrun
      ? fresh.employees.filter((candidate) => candidate.status !== 'retired' && candidate.status !== 'failed')
      : [currentEmployee]
    for (const target of targets) {
      target.operationalBlock = { ...block }
      target.status = 'paused'
      releaseEmployeeMoneyReservations(fresh, target.id)
      const messages = await io.readMailbox(target.id)
      let mailboxChanged = false
      for (const message of messages) {
        if (message.deliveryState !== 'reserved') continue
        message.deliveryState = 'queued'
        message.reservationId = undefined
        message.leaseAt = undefined
        mailboxChanged = true
      }
      if (mailboxChanged) await io.writeMailbox(target.id, messages)
      for (const work of fresh.workItems) {
        if (work.assigneeId !== target.id || (work.status !== 'claimed' && work.status !== 'in_progress')) continue
        if (work.reservationId !== undefined) releaseMoneyReservation(fresh, work.reservationId)
        work.status = 'pending'
        work.attempt = Math.max(0, work.attempt - 1)
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
        work.updatedAt = event.time
      }
    }
    if (companyOverrun) {
      fresh.phase = 'halted'
      fresh.pausedAt = event.time
      fresh.health = { status: 'halted', reason: 'money_budget', detail: block.message, detectedAt: event.time, resumable: true }
    } else {
      fresh.health = { status: 'degraded', reason: 'money_budget', detail: block.message, detectedAt: event.time, resumable: true }
    }
  })
  if (accounted.state.phase === 'halted') {
    const founder = ctx.agents.get(SessionId(accounted.state.founderSessionId))
    if (founder !== undefined) for (const target of accounted.state.employees.filter((candidate) => candidate.operationalBlock?.kind === 'money_budget')) interruptEmployee(ctx, founder, target)
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
    const employeeScoped = block.kind === 'turn_limit' || block.kind === 'unpriced_model'
      || (block.kind === 'money_budget' && !companyMoneyBlock)
    const targets = state.employees.filter((candidate) => candidate.status !== 'retired' && candidate.status !== 'failed' && (
      block.kind === 'network' || block.kind === 'token_budget' || companyMoneyBlock ? true
        : employeeScoped ? candidate.id === current.id
          : (candidate.llm.activeProvider ?? candidate.llm.provider) === provider
    ))
    for (const target of targets) {
      target.operationalBlock = { ...block }
      target.status = 'paused'
      releaseEmployeeMoneyReservations(state, target.id)
      const messages = await io.readMailbox(target.id)
      let mailboxChanged = false
      for (const message of messages) {
        if (message.deliveryState !== 'reserved') continue
        message.deliveryState = 'queued'
        message.reservationId = undefined
        message.leaseAt = undefined
        mailboxChanged = true
      }
      if (mailboxChanged) await io.writeMailbox(target.id, messages)
      for (const request of state.staffingRequests) {
        if (request.hrEmployeeId !== target.id || request.status !== 'in_review') continue
        request.status = 'pending'
        request.attemptId = undefined
        request.updatedAt = Date.now()
      }
      for (const work of state.workItems) {
        if (work.assigneeId !== target.id || (work.status !== 'claimed' && work.status !== 'in_progress')) continue
        if (work.reservationId !== undefined) releaseMoneyReservation(state, work.reservationId)
        work.status = 'pending'
        work.attempt = Math.max(0, work.attempt - 1)
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
        work.updatedAt = Date.now()
      }
    }
    haltIfAllBlocked(state, block.kind, block.message)
    if (state.phase === 'operating') state.health = { status: 'degraded', reason: block.kind, detail: block.message, detectedAt: Date.now(), resumable: true }
    return targets.map((target) => structuredClone(target))
  })
  const founder = ctx.agents.get(SessionId(handled.state.founderSessionId))
  if (founder !== undefined) for (const target of handled.result ?? []) interruptEmployee(ctx, founder, target)
  ctx.logger.warn(`dsh-company employee ${employee.id} halted: ${block.code}`)
}

async function findEmployee(store: CompanyStore, agent: Agent) {
  if (agent.session.header.cwd === undefined) return undefined
  const state = await store.readActive(agent.session.header.cwd)
  const employee = state?.employees.find((candidate) => candidate.sessionId === String(agent.id) && candidate.status !== 'retired')
  return state === undefined || employee === undefined ? undefined : { state, employee }
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
              : code === 'COMPANY_TOKEN_BUDGET' ? 'token_budget'
                : code === 'COMPANY_TURN_TOKEN_LIMIT' ? 'turn_limit'
              : undefined
  return kind === undefined ? undefined : { kind, code, message: message.slice(0, 4096), at: Date.now() }
}

function routeKey(sessionId: string, turn: number, step: number): string {
  return `${sessionId}:${turn}:${step}`
}
