import { createHash, randomUUID } from 'node:crypto'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import { temporaryAuthorizationStatus } from './authorizations.js'
import type {
  CompanyState,
  ModelPrice3,
  MoneyRateSnapshot,
  MoneyReservation,
  MoneyUsageEntry,
} from './types.js'

const MILLION = 1_000_000n
const HALF_MILLION = 500_000n

export class CompanyMoneyBudgetError extends Error {
  readonly code = 'COMPANY_MONEY_BUDGET'
  constructor(
    readonly level: 'company' | 'product' | 'employee',
    readonly neededMicros: number,
    readonly availableMicros: number,
  ) {
    super(`${level} money budget cannot reserve ${neededMicros} micros; ${availableMicros} available`)
    this.name = 'CompanyMoneyBudgetError'
  }
}

export class CompanyUnpricedModelError extends Error {
  readonly code = 'COMPANY_UNPRICED_MODEL'
  constructor(readonly provider: string, readonly model: string, detail?: string) {
    super(detail === undefined
      ? `model route ${provider}/${model} has no complete three-rate price; monetary admission is blocked`
      : `model route ${provider}/${model} ${detail}`)
    this.name = 'CompanyUnpricedModelError'
  }
}

export interface MoneyTotals {
  spentMicros: number
  reservedMicros: number
  availableMicros: number
}

export interface MoneyAdmissionBypass {
  authorizationId: string
  bypassCompany: boolean
  bypassProduct: boolean
  bypassEmployee: boolean
}

export function availableMoney(state: Pick<CompanyState, 'moneyBudget'>): number {
  return Math.max(0, state.moneyBudget.totalMicros - state.moneyBudget.spentMicros - state.moneyBudget.reservedMicros)
}

export function isPricedRow(price: ModelPrice3): price is ModelPrice3 & Required<Pick<ModelPrice3,
  'inputCacheMissMicrosPerMillion' | 'inputCacheHitMicrosPerMillion' | 'outputMicrosPerMillion'>> {
  return price.inputCacheMissMicrosPerMillion !== undefined
    && price.inputCacheHitMicrosPerMillion !== undefined
    && price.outputMicrosPerMillion !== undefined
}

export function pricingMatrixDigest(budget: Pick<CompanyState, 'moneyBudget'>['moneyBudget']): string {
  const rows = budget.prices.map((price) => ({
    provider: price.provider,
    model: price.model,
    miss: price.inputCacheMissMicrosPerMillion ?? null,
    hit: price.inputCacheHitMicrosPerMillion ?? null,
    output: price.outputMicrosPerMillion ?? null,
    source: price.source,
    revision: price.revision,
  })).sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
  return createHash('sha256').update(JSON.stringify({ currency: budget.currency, revision: budget.pricingRevision, rows })).digest('hex')
}

export function matchModelPrice(
  prices: readonly ModelPrice3[],
  provider: string,
  model: string,
): ModelPrice3 | undefined {
  // An all-blank row represents an omitted/unpriced form row, not a negative
  // override. It must not shadow a complete provider wildcard discovered or
  // configured for the same route.
  return prices.find((price) => price.provider === provider && price.model === model && isPricedRow(price))
    ?? prices.find((price) => price.provider === provider && price.model === '*' && isPricedRow(price))
}

export function resolveModelContextWindow(state: CompanyState, provider: string, model: string): number {
  if (state.modelCatalog.stale) throw new CompanyUnpricedModelError(provider, model, 'model catalog is stale; prompt-inclusive monetary admission requires a fresh context window')
  const discovered = state.modelCatalog.models.find((candidate) => candidate.provider === provider && candidate.model === model)
  if (discovered?.contextWindow === undefined || discovered.contextWindow < 1) {
    throw new CompanyUnpricedModelError(provider, model, 'route has no discovered context window; prompt-inclusive monetary admission is blocked')
  }
  return discovered.contextWindow
}

export function resolveRateSnapshot(state: CompanyState, provider: string, model: string): MoneyRateSnapshot {
  const price = matchModelPrice(state.moneyBudget.prices, provider, model)
  if (price === undefined || !isPricedRow(price)) throw new CompanyUnpricedModelError(provider, model)
  return {
    provider,
    model,
    matchedProvider: price.provider,
    matchedModel: price.model,
    currency: state.moneyBudget.currency,
    pricingRevision: state.moneyBudget.pricingRevision,
    pricingDigest: pricingMatrixDigest(state.moneyBudget),
    inputCacheMissMicrosPerMillion: price.inputCacheMissMicrosPerMillion,
    inputCacheHitMicrosPerMillion: price.inputCacheHitMicrosPerMillion,
    outputMicrosPerMillion: price.outputMicrosPerMillion,
  }
}

/**
 * Price one usage event using the v0.3 three-rate contract. The complete BigInt
 * numerator is rounded exactly once, half-up; reasoning is already a subset of
 * output and never contributes a fourth term.
 */
export function priceUsageThreeRate(
  usage: Pick<TokenUsage, 'inputTokens' | 'outputTokens' | 'cacheReadTokens' | 'cacheWriteTokens' | 'reasoningTokens'>,
  rates: Pick<MoneyRateSnapshot,
    'inputCacheMissMicrosPerMillion' | 'inputCacheHitMicrosPerMillion' | 'outputMicrosPerMillion'>,
): {
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  inputCacheMissTokens: number
  inputCacheHitTokens: number
  totalTokens: number
  costMicros: number
} {
  const inputTokens = tokenField(usage.inputTokens, 'inputTokens')
  const outputTokens = tokenField(usage.outputTokens, 'outputTokens')
  const cacheReadTokens = tokenField(usage.cacheReadTokens, 'cacheReadTokens')
  const cacheWriteTokens = tokenField(usage.cacheWriteTokens, 'cacheWriteTokens')
  const reasoningTokens = tokenField(usage.reasoningTokens, 'reasoningTokens')
  if (reasoningTokens > outputTokens) throw new Error('reasoningTokens must not exceed outputTokens')
  const inputCacheMissTokens = safeAdd(inputTokens, cacheWriteTokens, 'input cache miss tokens')
  const inputCacheHitTokens = cacheReadTokens
  const totalTokens = safeAdd(safeAdd(inputCacheMissTokens, inputCacheHitTokens, 'total tokens'), outputTokens, 'total tokens')
  const numerator = BigInt(inputCacheMissTokens) * BigInt(rates.inputCacheMissMicrosPerMillion)
    + BigInt(inputCacheHitTokens) * BigInt(rates.inputCacheHitMicrosPerMillion)
    + BigInt(outputTokens) * BigInt(rates.outputMicrosPerMillion)
  const rounded = (numerator + HALF_MILLION) / MILLION
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    inputCacheMissTokens,
    inputCacheHitTokens,
    totalTokens,
    costMicros: safeBigIntNumber(rounded, 'money usage cost'),
  }
}

/** Conservative upper bound for one token-safety entitlement. */
export function maximumReservationMicros(limitTokens: number, rates: MoneyRateSnapshot): number {
  assertSafeInteger(limitTokens, 'token safety limit', 1)
  const maximum = Math.max(
    rates.inputCacheMissMicrosPerMillion,
    rates.inputCacheHitMicrosPerMillion,
    rates.outputMicrosPerMillion,
  )
  const numerator = BigInt(limitTokens) * BigInt(maximum)
  return safeBigIntNumber((numerator + MILLION - 1n) / MILLION, 'money reservation')
}

function maximumCategoryReservationMicros(tokens: number, microsPerMillion: number): number {
  assertSafeInteger(tokens, 'category reservation tokens', 0)
  assertSafeInteger(microsPerMillion, 'category rate', 0)
  if (tokens === 0 || microsPerMillion === 0) return 0
  return safeBigIntNumber((BigInt(tokens) * BigInt(microsPerMillion) + MILLION - 1n) / MILLION, 'category money reservation')
}

function maximumCategoryTokensForMoney(availableMicros: number, microsPerMillion: number, ceiling: number): number {
  assertSafeInteger(availableMicros, 'category available money', 0)
  assertSafeInteger(microsPerMillion, 'category rate', 0)
  assertSafeInteger(ceiling, 'category token ceiling', 0)
  if (microsPerMillion === 0) return ceiling
  return Math.min(ceiling, safeBigIntNumber(BigInt(availableMicros) * MILLION / BigInt(microsPerMillion), 'category money-bounded tokens'))
}

export function maximumTokensForMoney(remainingMicros: number, remainingTokens: number, rates: MoneyRateSnapshot): number {
  assertSafeInteger(remainingMicros, 'remaining money', 0)
  assertSafeInteger(remainingTokens, 'remaining turn tokens', 0)
  const maximum = Math.max(
    rates.inputCacheMissMicrosPerMillion,
    rates.inputCacheHitMicrosPerMillion,
    rates.outputMicrosPerMillion,
  )
  if (maximum === 0) return remainingTokens
  const bounded = (BigInt(remainingMicros) * MILLION) / BigInt(maximum)
  return Math.min(remainingTokens, safeBigIntNumber(bounded, 'money-bounded token maximum'))
}

export function employeeMoneyTotals(state: CompanyState, employeeId: string): MoneyTotals {
  const employee = state.employees.find((candidate) => candidate.id === employeeId)
  const total = employee?.budgetMicros ?? 0
  const spentMicros = state.moneyBudget.usage
    .filter((entry) => entry.employeeId === employeeId)
    .reduce((sum, entry) => safeAdd(sum, entry.costMicros, 'employee spend'), 0)
  const reservedMicros = state.moneyBudget.reservations
    .filter((entry) => entry.employeeId === employeeId)
    .reduce((sum, entry) => safeAdd(sum, entry.remainingMicros, 'employee reservations'), 0)
  return { spentMicros, reservedMicros, availableMicros: Math.max(0, total - spentMicros - reservedMicros) }
}

export function productMoneyTotals(state: CompanyState, productId: string): MoneyTotals {
  const product = state.products.find((candidate) => candidate.id === productId)
  const total = product?.budgetMicros ?? 0
  const spentMicros = state.moneyBudget.usage
    .filter((entry) => entry.productId === productId)
    .reduce((sum, entry) => safeAdd(sum, entry.costMicros, 'product spend'), 0)
  const reservedMicros = state.moneyBudget.reservations
    .filter((entry) => entry.productId === productId)
    .reduce((sum, entry) => safeAdd(sum, entry.remainingMicros, 'product reservations'), 0)
  return { spentMicros, reservedMicros, availableMicros: Math.max(0, total - spentMicros - reservedMicros) }
}

export function reserveMoneyTurn(
  state: CompanyState,
  input: {
    employeeId: string
    provider: string
    model: string
    fallback?: { provider: string; model: string }
    workId?: string
    messageId?: string
    bypass?: MoneyAdmissionBypass
  },
  now = Date.now(),
): string {
  if (state.moneyBudget.reservations.some((reservation) => reservation.employeeId === input.employeeId)) {
    throw new Error(`employee ${input.employeeId} already has an active money reservation`)
  }
  const employee = state.employees.find((candidate) => candidate.id === input.employeeId)
  if (employee === undefined) throw new Error(`unknown employee ${input.employeeId}`)
  const work = input.workId === undefined ? undefined : state.workItems.find((candidate) => candidate.id === input.workId)
  const productId = work?.productId
  const routes = [{ provider: input.provider, model: input.model }]
  if (input.fallback !== undefined && !routes.some((route) => route.provider === input.fallback!.provider && route.model === input.fallback!.model)) routes.push(input.fallback)
  const routeRates: MoneyRateSnapshot[] = []
  let firstUnpriced: CompanyUnpricedModelError | undefined
  for (const route of routes) {
    try { routeRates.push(resolveRateSnapshot(state, route.provider, route.model)) }
    catch (error) {
      if (!(error instanceof CompanyUnpricedModelError)) throw error
      firstUnpriced ??= error
    }
  }
  if (firstUnpriced !== undefined && input.bypass === undefined) throw firstUnpriced
  const unknownCost = firstUnpriced !== undefined
  // No configured turn-token limit exists any more: the entitlement used for
  // worst-case money reservation is bounded by the route context windows
  // (and affordability), never by a human-picked token number.
  let entitlement = Number.MAX_SAFE_INTEGER
  try {
    entitlement = Math.min(entitlement, ...routes.map((route) => resolveModelContextWindow(state, route.provider, route.model)))
  } catch {
    // Unpriced/bypass paths tolerate a stale or context-less catalog; the
    // legacy token ledger then books a 1M placeholder instead.
    entitlement = 1_000_000
  }
  let rates: MoneyRateSnapshot | undefined
  let reservedMicros = 0
  let callHeadroomMicros = 0
  if (!unknownCost) {
    rates = compositeWorstRates(routeRates)
    const candidates: Array<{ level: CompanyMoneyBudgetError['level']; available: number }> = []
    if (input.bypass?.bypassCompany !== true) candidates.push({ level: 'company', available: availableMoney(state) })
    if (input.bypass?.bypassEmployee !== true) candidates.push({ level: 'employee', available: employeeMoneyTotals(state, input.employeeId).availableMicros })
    if (productId !== undefined && input.bypass?.bypassProduct !== true) candidates.push({ level: 'product', available: productMoneyTotals(state, productId).availableMicros })
    const limiting = candidates.reduce<{ level: CompanyMoneyBudgetError['level']; available: number } | undefined>((lowest, candidate) => lowest === undefined || candidate.available < lowest.available ? candidate : lowest, undefined)
    let promptHeadroomMicros = 0
    const hasNonzeroRate = rates.inputCacheMissMicrosPerMillion > 0 || rates.inputCacheHitMicrosPerMillion > 0 || rates.outputMicrosPerMillion > 0
    if (hasNonzeroRate) {
      try {
        const contextWindows = routes.map((route) => resolveModelContextWindow(state, route.provider, route.model))
        const maxContextWindow = Math.max(...contextWindows)
        const maxInputRate = Math.max(rates.inputCacheMissMicrosPerMillion, rates.inputCacheHitMicrosPerMillion)
        promptHeadroomMicros = maximumCategoryReservationMicros(maxContextWindow, maxInputRate)
        entitlement = Math.min(entitlement, ...contextWindows)
      } catch (error) {
        // A fixed authorization may deliberately bypass monetary admission. Normal
        // admission cannot promise a hard cap without a bounded prompt context.
        if (input.bypass === undefined) throw error
      }
    }
    if (limiting !== undefined) {
      const outputAvailable = Math.max(0, limiting.available - promptHeadroomMicros)
      entitlement = Math.min(entitlement, maximumCategoryTokensForMoney(outputAvailable, rates.outputMicrosPerMillion, entitlement))
      const needed = safeAdd(promptHeadroomMicros, maximumCategoryReservationMicros(Math.max(1, entitlement), rates.outputMicrosPerMillion), 'prompt-inclusive money reservation')
      if (entitlement < 1 || needed > limiting.available) throw new CompanyMoneyBudgetError(limiting.level, needed, limiting.available)
    }
    const outputHeadroomMicros = maximumCategoryReservationMicros(entitlement, rates.outputMicrosPerMillion)
    callHeadroomMicros = safeAdd(promptHeadroomMicros, outputHeadroomMicros, 'prompt-inclusive call headroom')
    reservedMicros = callHeadroomMicros
  }
  const id = randomUUID()
  state.moneyBudget.reservations.push({
    id,
    employeeId: input.employeeId,
    ...(input.workId === undefined ? {} : { workId: input.workId }),
    ...(productId === undefined ? {} : { productId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    limitTokens: entitlement,
    remainingTokens: entitlement,
    reservedMicros,
    remainingMicros: reservedMicros,
    callHeadroomMicros,
    routes: routes.map((route) => ({ ...route })),
    ...(rates === undefined ? {} : { rates }),
    ...(routeRates.length === 0 ? {} : { routeRates }),
    ...(input.bypass === undefined ? {} : { authorizationId: input.bypass.authorizationId }),
    ...(unknownCost ? { unknownCost: true } : {}),
    createdAt: now,
  })
  state.moneyBudget.reservedMicros = safeAdd(state.moneyBudget.reservedMicros, reservedMicros, 'company reservations')
  state.tokenBudget.reservations.push({
    id,
    employeeId: input.employeeId,
    ...(input.workId === undefined ? {} : { workId: input.workId }),
    ...(input.messageId === undefined ? {} : { messageId: input.messageId }),
    limitTokens: entitlement,
    remainingTokens: entitlement,
    createdAt: now,
  })
  state.tokenBudget.reservedTokens = safeAdd(state.tokenBudget.reservedTokens, entitlement, 'legacy token reservations')
  assertMoneyBudgetInvariant(state)
  return id
}

export function activeMoneyReservation(state: CompanyState, employeeId: string) {
  return state.moneyBudget.reservations.find((reservation) => reservation.employeeId === employeeId)
}

export function requiredMoneyCallHeadroom(reservation: MoneyReservation): number {
  const initial = reservation.callHeadroomMicros ?? reservation.reservedMicros
  if (reservation.callHeadroomMicros === undefined || reservation.rates === undefined) return initial
  const initialOutput = maximumCategoryReservationMicros(reservation.limitTokens, reservation.rates.outputMicrosPerMillion)
  const remainingOutput = maximumCategoryReservationMicros(reservation.remainingTokens, reservation.rates.outputMicrosPerMillion)
  return safeAdd(Math.max(0, initial - initialOutput), remainingOutput, 'remaining prompt-inclusive call headroom')
}

/** Retain one full prompt+remaining-output cost envelope before every provider call. */
export function ensureMoneyCallHeadroom(state: CompanyState, reservationId: string, now = Date.now()): void {
  const reservation = state.moneyBudget.reservations.find((candidate) => candidate.id === reservationId)
  if (reservation === undefined) throw new Error(`money reservation ${reservationId} is no longer active`)
  const headroom = requiredMoneyCallHeadroom(reservation)
  if (reservation.remainingMicros >= headroom) return
  const additional = headroom - reservation.remainingMicros
  if (reservation.authorizationId !== undefined) {
    const authorization = state.temporaryAuthorizations.find((candidate) => candidate.id === reservation.authorizationId)
    const status = authorization === undefined ? 'missing' : temporaryAuthorizationStatus(authorization, now)
    if (status !== 'active') throw new Error(`temporary authorization ${reservation.authorizationId} is ${status}; call headroom cannot be renewed`)
  } else {
    const candidates: Array<{ level: CompanyMoneyBudgetError['level']; available: number }> = [
      { level: 'company', available: availableMoney(state) },
      { level: 'employee', available: employeeMoneyTotals(state, reservation.employeeId).availableMicros },
    ]
    if (reservation.productId !== undefined) candidates.push({ level: 'product', available: productMoneyTotals(state, reservation.productId).availableMicros })
    const limiting = candidates.reduce((lowest, candidate) => candidate.available < lowest.available ? candidate : lowest)
    if (additional > limiting.available) throw new CompanyMoneyBudgetError(limiting.level, additional, limiting.available)
  }
  reservation.reservedMicros = safeAdd(reservation.reservedMicros, additional, 'reservation cumulative headroom')
  reservation.remainingMicros = safeAdd(reservation.remainingMicros, additional, 'reservation remaining headroom')
  state.moneyBudget.reservedMicros = safeAdd(state.moneyBudget.reservedMicros, additional, 'company call headroom')
  assertMoneyBudgetInvariant(state)
}

export function releaseMoneyReservation(state: CompanyState, reservationId: string | undefined): { micros: number; tokens: number } {
  if (reservationId === undefined) return { micros: 0, tokens: 0 }
  const index = state.moneyBudget.reservations.findIndex((reservation) => reservation.id === reservationId)
  if (index < 0) return { micros: 0, tokens: 0 }
  const reservation = state.moneyBudget.reservations[index]!
  state.moneyBudget.reservedMicros -= reservation.remainingMicros
  state.tokenBudget.reservedTokens = Math.max(0, state.tokenBudget.reservedTokens - reservation.remainingTokens)
  const legacyIndex = state.tokenBudget.reservations.findIndex((candidate) => candidate.id === reservation.id)
  if (legacyIndex >= 0) state.tokenBudget.reservations.splice(legacyIndex, 1)
  state.moneyBudget.reservations.splice(index, 1)
  assertMoneyBudgetInvariant(state)
  return { micros: reservation.remainingMicros, tokens: reservation.remainingTokens }
}

export function releaseEmployeeMoneyReservations(state: CompanyState, employeeId: string): { micros: number; tokens: number } {
  let micros = 0
  let tokens = 0
  for (const reservation of [...state.moneyBudget.reservations]) {
    if (reservation.employeeId !== employeeId) continue
    const released = releaseMoneyReservation(state, reservation.id)
    micros = safeAdd(micros, released.micros, 'released money')
    tokens = safeAdd(tokens, released.tokens, 'released tokens')
  }
  return { micros, tokens }
}

export function recordMoneyUsage(
  state: CompanyState,
  input: {
    sessionId: string
    eventSeq: number
    turn: number
    step: number
    employeeId: string
    workId?: string
    provider: string
    model: string
    usage: TokenUsage
    at: number
    rates?: MoneyRateSnapshot
  },
): MoneyUsageEntry | undefined {
  const id = `${input.sessionId}:${input.eventSeq}`
  if (state.moneyBudget.usage.some((entry) => entry.id === id)) return undefined
  const reservation = activeMoneyReservation(state, input.employeeId)
  const rates = input.rates
    ?? reservation?.routeRates?.find((candidate) => candidate.provider === input.provider && candidate.model === input.model)
    ?? (reservation?.unknownCost === true ? undefined : reservation?.rates)
  if (rates === undefined && reservation?.authorizationId === undefined) throw new CompanyUnpricedModelError(input.provider, input.model)
  const normalized = normalizeUnpricedUsage(input.usage)
  const priced = rates !== undefined
  const calculated = rates === undefined ? { ...normalized, costMicros: 0 } : priceUsageThreeRate(input.usage, rates)
  const workId = input.workId ?? reservation?.workId
  const productId = reservation?.productId
    ?? (workId === undefined ? undefined : state.workItems.find((work) => work.id === workId)?.productId)
  const entry: MoneyUsageEntry = {
    id,
    sessionId: input.sessionId,
    eventSeq: input.eventSeq,
    turn: input.turn,
    step: input.step,
    employeeId: input.employeeId,
    ...(workId === undefined ? {} : { workId }),
    ...(productId === undefined ? {} : { productId }),
    provider: input.provider,
    model: input.model,
    ...calculated,
    priced,
    currency: rates?.currency ?? state.moneyBudget.currency,
    pricingRevision: rates?.pricingRevision ?? state.moneyBudget.pricingRevision,
    ...(rates === undefined ? {} : {
      matchedPriceKey: `${rates.matchedProvider}/${rates.matchedModel}`,
      rates: structuredClone(rates),
    }),
    ...(reservation?.authorizationId === undefined ? {} : { authorizationId: reservation.authorizationId }),
    at: input.at,
  }
  state.moneyBudget.usage.push(entry)
  if (entry.authorizationId !== undefined && entry.workId !== undefined) {
    const authorization = state.temporaryAuthorizations.find((candidate) => candidate.id === entry.authorizationId)
    let use = authorization?.uses[authorization.uses.length - 1]
    while (use !== undefined && use.workId !== entry.workId) {
      const priorIndex = authorization!.uses.indexOf(use) - 1
      use = priorIndex < 0 ? undefined : authorization!.uses[priorIndex]
    }
    if (use !== undefined) {
      use.usageId ??= entry.id
      use.amountMicros = safeAdd(use.amountMicros ?? 0, entry.costMicros, 'temporary authorization recorded cost')
      use.unknownCost = use.unknownCost === true || !entry.priced
    }
  }
  state.moneyBudget.spentMicros = safeAdd(state.moneyBudget.spentMicros, entry.costMicros, 'company spend')
  state.tokenBudget.usedTokens = safeAdd(state.tokenBudget.usedTokens, entry.totalTokens, 'legacy token usage')
  state.tokenBudget.totalCostMicros = safeAdd(state.tokenBudget.totalCostMicros, entry.costMicros, 'legacy token cost')
  state.tokenBudget.usage.push({
    id: entry.id,
    sessionId: entry.sessionId,
    eventSeq: entry.eventSeq,
    turn: entry.turn,
    step: entry.step,
    employeeId: entry.employeeId,
    ...(entry.workId === undefined ? {} : { workId: entry.workId }),
    provider: entry.provider,
    model: entry.model,
    inputTokens: entry.inputTokens,
    outputTokens: entry.outputTokens,
    cacheReadTokens: entry.cacheReadTokens,
    cacheWriteTokens: entry.cacheWriteTokens,
    reasoningTokens: entry.reasoningTokens,
    totalTokens: entry.totalTokens,
    costMicros: entry.costMicros,
    priced: entry.priced,
    at: entry.at,
  })
  if (reservation !== undefined) {
    const consumedTokens = Math.min(reservation.remainingTokens, entry.totalTokens)
    reservation.remainingTokens -= consumedTokens
    const legacy = state.tokenBudget.reservations.find((candidate) => candidate.id === reservation.id)
    if (legacy !== undefined) {
      legacy.remainingTokens = Math.max(0, legacy.remainingTokens - consumedTokens)
      if (legacy.remainingTokens === 0) state.tokenBudget.reservations.splice(state.tokenBudget.reservations.indexOf(legacy), 1)
    }
    state.tokenBudget.reservedTokens = Math.max(0, state.tokenBudget.reservedTokens - consumedTokens)
    const committedMicros = Math.min(reservation.remainingMicros, entry.costMicros)
    reservation.remainingMicros -= committedMicros
    state.moneyBudget.reservedMicros = Math.max(0, state.moneyBudget.reservedMicros - committedMicros)
  }
  assertMoneyBudgetInvariant(state)
  return entry
}

export function adjustMoneyBudgetTotal(state: CompanyState, newTotalMicros: number): void {
  assertSafeInteger(newTotalMicros, 'total money budget', 0)
  if (newTotalMicros < state.moneyBudget.spentMicros + state.moneyBudget.reservedMicros) {
    throw new Error('money budget cannot be below spent plus reserved micros')
  }
  const allocatedProduct = state.products
    .filter((product) => !['retired', 'cancelled'].includes(product.status))
    .reduce((sum, product) => safeAdd(sum, product.budgetMicros ?? 0, 'product allocations'), 0)
  if (newTotalMicros < allocatedProduct) throw new Error('money budget cannot be below active product allocations')
  for (const employee of state.employees) {
    if (employee.status !== 'retired' && (employee.budgetMicros ?? 0) > newTotalMicros) throw new Error(`employee ${employee.id} monetary ceiling exceeds company budget`)
  }
  state.moneyBudget.totalMicros = newTotalMicros
  state.moneyBudget.warningAtMicros = Math.max(1, Math.floor(newTotalMicros * 0.2))
}

export function replaceModelPrices(state: CompanyState, prices: ModelPrice3[], now = Date.now()): void {
  // Active reservations retain immutable call-time snapshots; matrix changes are prospective.
  state.moneyBudget.pricingRevision += 1
  const revision = state.moneyBudget.pricingRevision
  state.moneyBudget.prices = prices.map((price) => ({ ...structuredClone(price), revision, updatedAt: now }))
}

export function assertMoneyBudgetInvariant(state: Pick<CompanyState, 'moneyBudget'>): void {
  const budget = state.moneyBudget
  for (const [label, value] of Object.entries({
    totalMicros: budget.totalMicros,
    reservedMicros: budget.reservedMicros,
    spentMicros: budget.spentMicros,
    pricingRevision: budget.pricingRevision,
  })) assertSafeInteger(value, `moneyBudget.${label}`, label === 'pricingRevision' ? 1 : 0)
  const reserved = budget.reservations.reduce((sum, reservation) => safeAdd(sum, reservation.remainingMicros, 'money reservations'), 0)
  if (reserved !== budget.reservedMicros) throw new Error('money reservedMicros does not equal active reservations')
  const spent = budget.usage.reduce((sum, entry) => safeAdd(sum, entry.costMicros, 'money usage'), 0)
  if (spent !== budget.spentMicros) throw new Error('money spentMicros does not equal usage entries')
}

function compositeWorstRates(rates: readonly MoneyRateSnapshot[]): MoneyRateSnapshot {
  const first = rates[0]
  if (first === undefined) throw new Error('at least one priced route is required')
  return {
    ...structuredClone(first),
    inputCacheMissMicrosPerMillion: Math.max(...rates.map((entry) => entry.inputCacheMissMicrosPerMillion)),
    inputCacheHitMicrosPerMillion: Math.max(...rates.map((entry) => entry.inputCacheHitMicrosPerMillion)),
    outputMicrosPerMillion: Math.max(...rates.map((entry) => entry.outputMicrosPerMillion)),
  }
}

function normalizeUnpricedUsage(usage: TokenUsage) {
  const inputTokens = tokenField(usage.inputTokens, 'inputTokens')
  const outputTokens = tokenField(usage.outputTokens, 'outputTokens')
  const cacheReadTokens = tokenField(usage.cacheReadTokens, 'cacheReadTokens')
  const cacheWriteTokens = tokenField(usage.cacheWriteTokens, 'cacheWriteTokens')
  const reasoningTokens = tokenField(usage.reasoningTokens, 'reasoningTokens')
  if (reasoningTokens > outputTokens) throw new Error('reasoningTokens must not exceed outputTokens')
  const inputCacheMissTokens = safeAdd(inputTokens, cacheWriteTokens, 'input cache miss tokens')
  const inputCacheHitTokens = cacheReadTokens
  return {
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    inputCacheMissTokens,
    inputCacheHitTokens,
    totalTokens: safeAdd(safeAdd(inputCacheMissTokens, inputCacheHitTokens, 'total tokens'), outputTokens, 'total tokens'),
  }
}

function tokenField(value: number | undefined, name: string): number {
  const normalized = value ?? 0
  assertSafeInteger(normalized, name, 0)
  return normalized
}

function assertSafeInteger(value: number, name: string, minimum: number): void {
  if (!Number.isSafeInteger(value) || value < minimum) throw new Error(`${name} must be a safe integer >= ${minimum}`)
}

function safeAdd(left: number, right: number, name: string): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) throw new Error(`${name} arithmetic overflow`)
  return value
}

function safeBigIntNumber(value: bigint, name: string): number {
  if (value < 0n || value > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${name} arithmetic overflow`)
  return Number(value)
}
