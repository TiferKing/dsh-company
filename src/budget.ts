import { randomUUID } from 'node:crypto'
import type { BudgetEntry, BudgetReason, CompanyState, ResolvedCompanyConfig } from './types.js'

export interface CreditSubject {
  employeeId?: string
  workId?: string
  messageId?: string
  approvalId?: string
}

export function availableCredits(state: Pick<CompanyState, 'budget'>): number {
  return state.budget.totalCredits - state.budget.spentCredits - state.budget.reservedCredits
}

export function routeCost(
  config: Pick<ResolvedCompanyConfig, 'routeCosts' | 'defaultActivationCredits'>,
  route: { provider: string; model: string; fallback?: { provider: string; model: string } },
): number {
  const primary = config.routeCosts[`${route.provider}/${route.model}`] ?? config.defaultActivationCredits
  if (route.fallback === undefined) return primary
  const fallback = config.routeCosts[`${route.fallback.provider}/${route.fallback.model}`] ?? config.defaultActivationCredits
  return Math.max(primary, fallback)
}

export function reserveCredits(
  state: CompanyState,
  credits: number,
  reason: Extract<BudgetReason, 'employee-onboarding' | 'work-dispatch' | 'message-delivery'>,
  subject: CreditSubject,
): string {
  assertPositiveCredits(credits)
  if (availableCredits(state) < credits) {
    throw new Error(`insufficient activation credits: need ${credits}, available ${availableCredits(state)}`)
  }
  if (reason === 'work-dispatch' && subject.workId !== undefined) {
    assertProductCapacity(state, subject.workId, credits)
  }
  const reservationId = randomUUID()
  state.budget.reservedCredits += credits
  state.budget.entries.push(entry('reserve', credits, reason, subject, reservationId))
  assertBudgetInvariant(state)
  return reservationId
}

export function commitReservation(
  state: CompanyState,
  reservationId: string,
  reason?: BudgetReason,
): number {
  const reserve = unresolvedReservation(state, reservationId)
  if (reserve === undefined) return 0
  state.budget.reservedCredits -= reserve.credits
  state.budget.spentCredits += reserve.credits
  state.budget.entries.push(entry('commit', reserve.credits, reason ?? reserve.reason, {
    ...(reserve.employeeId === undefined ? {} : { employeeId: reserve.employeeId }),
    ...(reserve.workId === undefined ? {} : { workId: reserve.workId }),
    ...(reserve.messageId === undefined ? {} : { messageId: reserve.messageId }),
    ...(reserve.approvalId === undefined ? {} : { approvalId: reserve.approvalId }),
  }, reservationId))
  assertBudgetInvariant(state)
  return reserve.credits
}

export function releaseReservation(state: CompanyState, reservationId: string, reason?: BudgetReason): number {
  const reserve = unresolvedReservation(state, reservationId)
  if (reserve === undefined) return 0
  state.budget.reservedCredits -= reserve.credits
  state.budget.entries.push(entry('release', reserve.credits, reason ?? reserve.reason, {
    ...(reserve.employeeId === undefined ? {} : { employeeId: reserve.employeeId }),
    ...(reserve.workId === undefined ? {} : { workId: reserve.workId }),
    ...(reserve.messageId === undefined ? {} : { messageId: reserve.messageId }),
    ...(reserve.approvalId === undefined ? {} : { approvalId: reserve.approvalId }),
  }, reservationId))
  assertBudgetInvariant(state)
  return reserve.credits
}

/** Conservatively commit crash-left prepared reservations exactly once. */
export function reconcilePreparedReservations(state: CompanyState): string[] {
  const unresolved = unresolvedReservations(state).map((reserve) => reserve.reservationId).filter((id): id is string => id !== undefined)
  for (const reservationId of unresolved) commitReservation(state, reservationId, 'recovery')
  return unresolved
}

export function adjustBudgetTotal(
  state: CompanyState,
  newTotalCredits: number,
  maxBudgetCredits: number,
  approvalId: string,
): void {
  if (!Number.isSafeInteger(newTotalCredits) || newTotalCredits < 0 || newTotalCredits > maxBudgetCredits) {
    throw new Error(`new activation-credit total must be a safe integer in 0..${maxBudgetCredits}`)
  }
  if (newTotalCredits < state.budget.spentCredits + state.budget.reservedCredits) {
    throw new Error('cannot decrease activation-credit total below spent plus reserved credits')
  }
  const difference = newTotalCredits - state.budget.totalCredits
  if (difference === 0) return
  state.budget.totalCredits = newTotalCredits
  state.budget.entries.push(entry(difference > 0 ? 'increase' : 'decrease', Math.abs(difference), 'human-adjustment', { approvalId }))
  assertBudgetInvariant(state)
}

export function activeReservationFor(state: CompanyState, reservationId: string | undefined): BudgetEntry | undefined {
  return reservationId === undefined ? undefined : unresolvedReservation(state, reservationId)
}

export function productCreditsUsed(state: CompanyState, productId: string): number {
  const workIds = new Set(state.workItems.filter((work) => work.productId === productId).map((work) => work.id))
  let used = 0
  const reservations = new Map<string, number>()
  for (const item of state.budget.entries) {
    if (item.reason !== 'work-dispatch' || item.workId === undefined || !workIds.has(item.workId)) continue
    if (item.kind === 'reserve' && item.reservationId !== undefined) reservations.set(item.reservationId, item.credits)
    if (item.kind === 'commit' && item.reservationId !== undefined) {
      used += item.credits
      reservations.delete(item.reservationId)
    }
    if (item.kind === 'release' && item.reservationId !== undefined) reservations.delete(item.reservationId)
  }
  for (const credits of reservations.values()) used += credits
  return used
}

export function assertBudgetInvariant(state: Pick<CompanyState, 'budget'>): void {
  const { totalCredits, reservedCredits, spentCredits } = state.budget
  if (![totalCredits, reservedCredits, spentCredits].every(Number.isSafeInteger)) throw new Error('activation-credit arithmetic overflow')
  if (totalCredits < 0 || reservedCredits < 0 || spentCredits < 0 || totalCredits - reservedCredits - spentCredits < 0) {
    throw new Error('activation-credit invariant violated')
  }
}

function assertProductCapacity(state: CompanyState, workId: string, credits: number): void {
  const work = state.workItems.find((candidate) => candidate.id === workId)
  if (work === undefined) throw new Error(`cannot reserve activation credits for unknown work ${workId}`)
  const product = state.products.find((candidate) => candidate.id === work.productId)
  if (product === undefined) throw new Error(`work ${workId} references an unknown product`)
  const remaining = product.budgetCredits - productCreditsUsed(state, product.id)
  if (remaining < credits) throw new Error(`product ${product.id} has ${remaining} activation credits remaining; dispatch needs ${credits}`)
}

function unresolvedReservations(state: CompanyState): BudgetEntry[] {
  const reserves = new Map<string, BudgetEntry>()
  for (const item of state.budget.entries) {
    if (item.reservationId === undefined) continue
    if (item.kind === 'reserve') reserves.set(item.reservationId, item)
    else if (item.kind === 'commit' || item.kind === 'release') reserves.delete(item.reservationId)
  }
  return [...reserves.values()]
}

function unresolvedReservation(state: CompanyState, reservationId: string): BudgetEntry | undefined {
  return unresolvedReservations(state).find((item) => item.reservationId === reservationId)
}

function entry(
  kind: BudgetEntry['kind'],
  credits: number,
  reason: BudgetReason,
  subject: CreditSubject,
  reservationId?: string,
): BudgetEntry {
  return {
    id: randomUUID(),
    kind,
    credits,
    reason,
    ...(subject.employeeId === undefined ? {} : { employeeId: subject.employeeId }),
    ...(subject.workId === undefined ? {} : { workId: subject.workId }),
    ...(subject.messageId === undefined ? {} : { messageId: subject.messageId }),
    ...(subject.approvalId === undefined ? {} : { approvalId: subject.approvalId }),
    ...(reservationId === undefined ? {} : { reservationId }),
    at: Date.now(),
  }
}

function assertPositiveCredits(credits: number): void {
  if (!Number.isSafeInteger(credits) || credits <= 0) throw new Error('activation credits must be a positive safe integer')
}
