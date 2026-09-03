import { randomUUID } from 'node:crypto'
import type { TokenUsage } from '@deepseek-ai/dsh-llm'
import type {
  CompanyState,
  TokenBudget,
  TokenPrice,
  TokenUsageEntry,
} from './types.js'

export function availableTokens(state: Pick<CompanyState, 'tokenBudget'>): number {
  return Math.max(0, state.tokenBudget.totalTokens - state.tokenBudget.usedTokens - state.tokenBudget.reservedTokens)
}

export function releaseTurnReservation(state: CompanyState, reservationId: string | undefined): number {
  if (reservationId === undefined) return 0
  const index = state.tokenBudget.reservations.findIndex((reservation) => reservation.id === reservationId)
  if (index < 0) return 0
  const reservation = state.tokenBudget.reservations[index]!
  state.tokenBudget.reservedTokens -= reservation.remainingTokens
  state.tokenBudget.reservations.splice(index, 1)
  assertTokenBudgetInvariant(state.tokenBudget)
  return reservation.remainingTokens
}

export function releaseEmployeeReservations(state: CompanyState, employeeId: string): number {
  let released = 0
  for (const reservation of [...state.tokenBudget.reservations]) {
    if (reservation.employeeId !== employeeId) continue
    released += releaseTurnReservation(state, reservation.id)
  }
  return released
}

export function activeEmployeeReservation(state: CompanyState, employeeId: string) {
  return state.tokenBudget.reservations.find((reservation) => reservation.employeeId === employeeId)
}

export function recordTokenUsage(
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
  },
): TokenUsageEntry | undefined {
  const id = `${input.sessionId}:${input.eventSeq}`
  if (state.tokenBudget.usage.some((entry) => entry.id === id)) return undefined
  const usage = normalizeUsage(input.usage)
  const priced = priceUsage(state.tokenBudget.prices, input.provider, input.model, usage)
  const entry: TokenUsageEntry = {
    id,
    sessionId: input.sessionId,
    eventSeq: input.eventSeq,
    turn: input.turn,
    step: input.step,
    employeeId: input.employeeId,
    ...(input.workId === undefined ? {} : { workId: input.workId }),
    provider: input.provider,
    model: input.model,
    ...usage,
    costMicros: priced.costMicros,
    priced: priced.priced,
    at: input.at,
  }
  const reservation = activeEmployeeReservation(state, input.employeeId)
  if (reservation !== undefined) {
    const consumed = Math.min(reservation.remainingTokens, usage.totalTokens)
    reservation.remainingTokens -= consumed
    state.tokenBudget.reservedTokens -= consumed
    if (reservation.remainingTokens === 0) {
      state.tokenBudget.reservations.splice(state.tokenBudget.reservations.indexOf(reservation), 1)
    }
  }
  state.tokenBudget.usedTokens += usage.totalTokens
  state.tokenBudget.totalCostMicros = safeAdd(state.tokenBudget.totalCostMicros, priced.costMicros, 'token cost')
  state.tokenBudget.usage.push(entry)
  assertTokenBudgetInvariant(state.tokenBudget)
  return entry
}

export function adjustTokenBudget(state: CompanyState, totalTokens: number): void {
  assertTokenCount(totalTokens, 'total token budget', 0)
  if (totalTokens < state.tokenBudget.usedTokens + state.tokenBudget.reservedTokens) {
    throw new Error('cannot reduce token budget below used plus reserved tokens')
  }
  state.tokenBudget.totalTokens = totalTokens
  state.tokenBudget.warningAtTokens = Math.max(1, Math.floor(totalTokens * 0.2))
  assertTokenBudgetInvariant(state.tokenBudget)
}

export function replaceTokenPrices(state: CompanyState, currency: string, prices: TokenPrice[]): void {
  state.tokenBudget.currency = currency
  state.tokenBudget.prices = structuredClone(prices)
}

export function employeeTokenTotals(state: CompanyState, employeeId: string) {
  const entries = state.tokenBudget.usage.filter((entry) => entry.employeeId === employeeId)
  return sumUsage(entries)
}

export function productTokenTotals(state: CompanyState, productId: string) {
  const workIds = new Set(state.workItems.filter((work) => work.productId === productId).map((work) => work.id))
  return sumUsage(state.tokenBudget.usage.filter((entry) => entry.workId !== undefined && workIds.has(entry.workId)))
}

export function assertTokenBudgetInvariant(budget: TokenBudget): void {
  for (const [name, value] of Object.entries({
    totalTokens: budget.totalTokens,
    reservedTokens: budget.reservedTokens,
    usedTokens: budget.usedTokens,
    totalCostMicros: budget.totalCostMicros,
  })) assertTokenCount(value, `token budget ${name}`, 0)
  const reservationTotal = budget.reservations.reduce((sum, reservation) => safeAdd(sum, reservation.remainingTokens, 'token reservations'), 0)
  if (reservationTotal !== budget.reservedTokens) throw new Error('token reservation aggregate mismatch')
  const usageTotal = budget.usage.reduce((sum, entry) => safeAdd(sum, entry.totalTokens, 'token usage aggregate'), 0)
  if (usageTotal !== budget.usedTokens) throw new Error('token usage aggregate mismatch')
  const costTotal = budget.usage.reduce((sum, entry) => safeAdd(sum, entry.costMicros, 'token cost aggregate'), 0)
  if (costTotal !== budget.totalCostMicros) throw new Error('token cost aggregate mismatch')
}

function normalizeUsage(usage: TokenUsage) {
  const inputTokens = tokenField(usage.inputTokens, 'inputTokens')
  const outputTokens = tokenField(usage.outputTokens, 'outputTokens')
  const cacheReadTokens = tokenField(usage.cacheReadTokens ?? 0, 'cacheReadTokens')
  const cacheWriteTokens = tokenField(usage.cacheWriteTokens ?? 0, 'cacheWriteTokens')
  const reasoningTokens = Math.min(tokenField(usage.reasoningTokens ?? 0, 'reasoningTokens'), outputTokens)
  const totalTokens = [inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens]
    .reduce((sum, value) => safeAdd(sum, value, 'token usage'), 0)
  return { inputTokens, outputTokens, cacheReadTokens, cacheWriteTokens, reasoningTokens, totalTokens }
}

function priceUsage(
  prices: TokenPrice[],
  provider: string,
  model: string,
  usage: ReturnType<typeof normalizeUsage>,
): { priced: boolean; costMicros: number } {
  const price = prices.find((candidate) => candidate.provider === provider && candidate.model === model)
    ?? prices.find((candidate) => candidate.provider === provider && candidate.model === '*')
  if (price === undefined) return { priced: false, costMicros: 0 }
  const reasoning = Math.min(usage.reasoningTokens, usage.outputTokens)
  const ordinaryOutput = price.reasoningMicrosPerMillion === undefined ? usage.outputTokens : usage.outputTokens - reasoning
  const parts: Array<[number, number]> = [
    [usage.inputTokens, price.inputMicrosPerMillion],
    [usage.cacheReadTokens, price.cacheReadMicrosPerMillion],
    [usage.cacheWriteTokens, price.cacheWriteMicrosPerMillion],
    [ordinaryOutput, price.outputMicrosPerMillion],
  ]
  if (price.reasoningMicrosPerMillion !== undefined) parts.push([reasoning, price.reasoningMicrosPerMillion])
  const costMicros = parts.reduce((sum, [tokens, rate]) => safeAdd(sum, proratedMicros(tokens, rate), 'token cost'), 0)
  return { priced: true, costMicros }
}

function proratedMicros(tokens: number, microsPerMillion: number): number {
  if (tokens === 0 || microsPerMillion === 0) return 0
  const numerator = BigInt(tokens) * BigInt(microsPerMillion)
  const rounded = (numerator + 500_000n) / 1_000_000n
  const value = Number(rounded)
  if (!Number.isSafeInteger(value)) throw new Error('token price calculation overflow')
  return value
}

function sumUsage(entries: TokenUsageEntry[]) {
  return entries.reduce((total, entry) => ({
    inputTokens: safeAdd(total.inputTokens, entry.inputTokens, 'employee input tokens'),
    outputTokens: safeAdd(total.outputTokens, entry.outputTokens, 'employee output tokens'),
    cacheReadTokens: safeAdd(total.cacheReadTokens, entry.cacheReadTokens, 'employee cache-read tokens'),
    cacheWriteTokens: safeAdd(total.cacheWriteTokens, entry.cacheWriteTokens, 'employee cache-write tokens'),
    reasoningTokens: safeAdd(total.reasoningTokens, entry.reasoningTokens, 'employee reasoning tokens'),
    totalTokens: safeAdd(total.totalTokens, entry.totalTokens, 'employee total tokens'),
    costMicros: safeAdd(total.costMicros, entry.costMicros, 'employee token cost'),
  }), { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, costMicros: 0 })
}

function tokenField(value: number, name: string): number {
  assertTokenCount(value, name, 0)
  return value
}

function assertTokenCount(value: number, name: string, min: number): void {
  if (!Number.isSafeInteger(value) || value < min) throw new Error(`${name} must be a safe integer >= ${min}`)
}

function safeAdd(left: number, right: number, name: string): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) throw new Error(`${name} arithmetic overflow`)
  return value
}
