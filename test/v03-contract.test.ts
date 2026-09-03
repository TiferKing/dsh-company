import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CompanyUnpricedModelError,
  recordMoneyUsage,
  releaseMoneyReservation,
  reserveMoneyTurn,
} from '../src/money.js'
import {
  consumeTemporaryAuthorization,
  createTemporaryAuthorization,
  resolveAuthorizationAdmission,
  temporaryAuthorizationStatus,
} from '../src/authorizations.js'
import { parseActionRequest } from '../src/http.js'
import { normalizeCompanyState } from '../src/migration.js'
import { assertCompanyState, currencyUnitsToMicros, resolveConfig } from '../src/schemas.js'
import type { ModelPrice3, WorkItem } from '../src/types.js'
import { companyState } from './fixtures.js'

function price(provider: string, model: string, rate: number): ModelPrice3 {
  return {
    provider,
    model,
    inputCacheMissMicrosPerMillion: rate,
    inputCacheHitMicrosPerMillion: rate,
    outputMicrosPerMillion: rate,
    source: 'manual',
    revision: 1,
    updatedAt: 1,
  }
}

test('money reservation derives an affordable token entitlement from primary and fallback worst rate', () => {
  const state = companyState()
  state.moneyBudget.totalMicros = 10
  state.employees[0]!.budgetMicros = 10
  state.products[0]!.budgetMicros = 10
  state.moneyBudget.prices = [price('p', 'primary', 1_000_000), price('p', 'fallback', 3_000_000)]
  state.modelCatalog.models = [
    { provider: 'p', model: 'primary', name: 'Primary', contextWindow: 1, advertised: true, available: true },
    { provider: 'p', model: 'fallback', name: 'Fallback', contextWindow: 1, advertised: true, available: true },
  ]

  const reservationId = reserveMoneyTurn(state, {
    employeeId: 'e1',
    provider: 'p',
    model: 'primary',
    fallback: { provider: 'p', model: 'fallback' },
    workId: undefined,
  }, 10)
  const reservation = state.moneyBudget.reservations.find((entry) => entry.id === reservationId)!
  assert.equal(reservation.limitTokens, 1)
  assert.equal(reservation.remainingTokens, 1)
  assert.equal(reservation.reservedMicros, 6)
  assert.equal(reservation.rates?.outputMicrosPerMillion, 3_000_000)
  assert.deepEqual(reservation.routeRates?.map((entry) => entry.model), ['primary', 'fallback'])
  assert.equal(state.tokenBudget.reservedTokens, 1)
  releaseMoneyReservation(state, reservationId)
  assert.equal(state.moneyBudget.reservedMicros, 0)
  assert.equal(state.tokenBudget.reservedTokens, 0)
})

test('known-free, unpriced, and authorized unknown-cost routes remain distinct', () => {
  const free = companyState()
  free.moneyBudget.totalMicros = 0
  free.employees[0]!.budgetMicros = 0
  free.products[0]!.budgetMicros = 0
  const freeId = reserveMoneyTurn(free, { employeeId: 'e1', provider: 'mock', model: 'mock-model' }, 1)
  assert.equal(free.moneyBudget.reservations[0]!.limitTokens, 128_000, 'zero rates: entitlement is context-window sized, money reservation stays zero')
  assert.equal(free.moneyBudget.reservations[0]!.reservedMicros, 0)
  assert.equal(free.moneyBudget.reservations[0]!.unknownCost, undefined)
  releaseMoneyReservation(free, freeId)

  const unpriced = companyState()
  unpriced.moneyBudget.prices = []
  assert.throws(
    () => reserveMoneyTurn(unpriced, { employeeId: 'e1', provider: 'p', model: 'unknown' }),
    CompanyUnpricedModelError,
  )

  const authorized = companyState()
  authorized.moneyBudget.prices = []
  const reservationId = reserveMoneyTurn(authorized, {
    employeeId: 'e1',
    provider: 'p',
    model: 'unknown',
    bypass: { authorizationId: 'ta1', bypassCompany: true, bypassProduct: true, bypassEmployee: true },
  }, 2)
  const reservation = authorized.moneyBudget.reservations[0]!
  assert.equal(reservation.id, reservationId)
  assert.equal(reservation.limitTokens, 1_000_000, 'unknown-cost placeholder entitlement when the catalog lacks the route')
  assert.equal(reservation.reservedMicros, 0)
  assert.equal(reservation.rates, undefined)
  assert.equal(reservation.unknownCost, true)
  const entry = recordMoneyUsage(authorized, {
    sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1',
    provider: 'p', model: 'unknown', usage: { inputTokens: 2, outputTokens: 3, cacheReadTokens: 1, cacheWriteTokens: 1, reasoningTokens: 2 }, at: 3,
  })!
  assert.equal(entry.priced, false)
  assert.equal(entry.costMicros, 0)
  assert.equal(entry.authorizationId, 'ta1')
  assert.equal(entry.totalTokens, 7)
})

test('temporary authorization is employee-wide, unlimited by uses, and fail-closed outside two approval kinds', () => {
  const state = companyState()
  const now = 1_000
  const authorization = createTemporaryAuthorization(state, {
    employeeId: 'e1', reason: 'Temporarily unblock bounded internal implementation.', startsAt: now, expiresAt: now + 1_000,
  }, { maxMs: 10_000 }, now)
  assert.equal(temporaryAuthorizationStatus(authorization, now), 'active')
  assert.equal('workId' in authorization, false)
  assert.equal('maxUses' in authorization, false)
  assert.equal('allowanceMicros' in authorization, false)

  state.approvals.push(
    { id: 'a1', kind: 'product_scope', status: 'pending', requestedBy: 'founder', summary: 'scope', payload: { action: 'update', productId: 'p1' }, risk: 'medium', requestedAt: now },
    { id: 'a2', kind: 'budget_change', status: 'pending', requestedBy: 'founder', summary: 'budget', payload: { newTotalMicros: 1, expectedTotalMicros: state.moneyBudget.totalMicros }, risk: 'high', requestedAt: now },
  )
  const work = { id: 'w1', kind: 'implementation', approvalDependencies: ['a1', 'a2'] } as WorkItem
  const admission = resolveAuthorizationAdmission(state, 'e1', work, now)!
  assert.deepEqual(admission.bypassedApprovalIds, ['a1'])
  assert.equal(resolveAuthorizationAdmission(state, 'e1', { ...work, id: 'w2', kind: 'release' }, now), undefined)

  for (let index = 0; index < 20; index += 1) consumeTemporaryAuthorization(authorization, {
    employeeId: 'e1', workId: `w${index + 1}`, bypassed: ['company_budget'], amountMicros: Number.MAX_SAFE_INTEGER,
  }, now)
  assert.equal(authorization.uses.length, 20)
  assert.equal(temporaryAuthorizationStatus(authorization, now), 'active')
  assert.equal(temporaryAuthorizationStatus(authorization, now + 1_000), 'expired')
})

test('human money boundaries accept at most six decimals and HTTP actions stay closed', () => {
  assert.equal(currencyUnitsToMicros(12.345678, 'amount'), 12_345_678)
  assert.equal(currencyUnitsToMicros('0.000001', 'amount'), 1)
  assert.throws(() => currencyUnitsToMicros('1.0000001', 'amount'), /at most 6 decimal places/)

  const request = parseActionRequest({
    sessionId: 'founder-session', companyId: 'c1', expectedRevision: 4,
    action: 'request_budget_change',
    payload: {
      total_budget: 25.5,
      product_budgets: [{ product_id: 'p1', product_budget: 12.25 }],
      model_prices: [{ provider: 'p', model: 'm', input_cache_miss_per_million: 1.2, input_cache_hit_per_million: 0.3, output_per_million: 2.4 }],
      expected_pricing_revision: 2,
    },
  })
  assert.equal(request.action, 'request_budget_change')
  assert.throws(() => parseActionRequest({
    sessionId: 'founder-session', companyId: 'c1', expectedRevision: 4,
    action: 'request_budget_change', payload: { total_budget_micros: 25_500_000 },
  }), /unknown field/)
  assert.throws(() => parseActionRequest({
    sessionId: 'founder-session', companyId: 'c1', expectedRevision: 4,
    action: 'request_budget_change', payload: { total_budget: 1.0000001 },
  }), /at most 6 decimals/)
})

test('v0.2 financial migration halts, preserves raw usage and booked cost, and never invents a money ceiling', () => {
  const legacy = companyState() as any
  delete legacy.moneyBudget
  legacy.phase = 'operating'
  legacy.hrEmployeeId = 'e1'
  legacy.tokenBudget.currency = 'USD'
  legacy.tokenBudget.totalTokens = 20_000_000
  legacy.tokenBudget.usedTokens = 8
  legacy.tokenBudget.totalCostMicros = 123
  legacy.tokenBudget.prices = [{
    provider: 'legacy', model: 'lossy', inputMicrosPerMillion: 1, cacheReadMicrosPerMillion: 2,
    cacheWriteMicrosPerMillion: 3, outputMicrosPerMillion: 4, reasoningMicrosPerMillion: 5,
  }]
  legacy.tokenBudget.usage = [{
    id: 'old-use', sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1',
    provider: 'legacy', model: 'lossy', inputTokens: 2, outputTokens: 3, cacheReadTokens: 1,
    cacheWriteTokens: 1, reasoningTokens: 2, totalTokens: 7, costMicros: 123, priced: true, at: legacy.updatedAt,
  }, {
    id: 'old-unpriced', sessionId: 'employee-session', eventSeq: 2, turn: 1, step: 2, employeeId: 'e1',
    provider: 'legacy', model: 'unknown', inputTokens: 1, outputTokens: 0, cacheReadTokens: 0,
    cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 1, costMicros: 0, priced: false, at: legacy.updatedAt,
  }]
  const config = resolveConfig({ stateRoot: '/tmp/dsh-company-v03-migration-test' })
  const normalized = normalizeCompanyState(legacy, config)
  assertCompanyState(normalized, legacy.workspaceHash)
  assert.equal(normalized.phase, 'halted')
  assert.equal(normalized.health.status, 'halted')
  assert.equal(normalized.health.resumable, false)
  assert.equal(normalized.moneyBudget.totalMicros, 0)
  assert.equal(normalized.moneyBudget.spentMicros, 123)
  assert.equal(normalized.moneyBudget.migrationRequired, true)
  assert.equal(normalized.moneyBudget.legacyV02?.totalCostMicros, 123)
  assert.equal(normalized.moneyBudget.usage.find((entry: any) => entry.id === 'old-use')?.totalTokens, 7)
  assert.equal(normalized.moneyBudget.usage.find((entry: any) => entry.id === 'old-use')?.costMicros, 123)
  assert.equal(normalized.moneyBudget.usage.find((entry: any) => entry.id === 'old-use')?.pricingProvenance, 'legacy_recorded_event')
  assert.deepEqual(
    normalized.moneyBudget.usage.filter((entry: any) => entry.id === 'old-unpriced').map((entry: any) => ({ priced: entry.priced, costMicros: entry.costMicros, pricingProvenance: entry.pricingProvenance })),
    [{ priced: false, costMicros: 0, pricingProvenance: undefined }],
  )
  assert.equal(normalized.moneyBudget.usage.find((entry: any) => entry.pricingProvenance === 'legacy_recorded_total'), undefined)
  const lossy = normalized.moneyBudget.prices.find((entry: any) => entry.provider === 'legacy' && entry.model === 'lossy')
  assert.ok(lossy)
  assert.equal(lossy.inputCacheMissMicrosPerMillion, undefined)
  assert.equal(lossy.source, 'legacy')

  const before = structuredClone(normalized)
  normalizeCompanyState(normalized, config)
  assert.deepEqual(normalized, before)
})

test('draft and incomplete-provisioning migrations stay on the editable formation retry path', () => {
  const config = resolveConfig({ stateRoot: '/tmp/dsh-company-v03-formation-migration-test' })
  const staged = companyState() as any
  delete staged.moneyBudget
  for (const product of staged.products) delete product.budgetMicros
  for (const employee of staged.employees) delete employee.budgetMicros
  staged.phase = 'staged'
  staged.formation.status = 'draft'
  const stagedNormalized = normalizeCompanyState(staged, config)
  assertCompanyState(stagedNormalized, staged.workspaceHash)
  assert.equal(stagedNormalized.phase, 'staged')
  assert.equal(stagedNormalized.moneyBudget.migrationRequired, false)
  assert.equal(stagedNormalized.moneyBudget.legacyV02?.treatment, 'accepted')

  const provisioning = companyState() as any
  delete provisioning.moneyBudget
  for (const product of provisioning.products) delete product.budgetMicros
  for (const employee of provisioning.employees) delete employee.budgetMicros
  provisioning.phase = 'provisioning'
  provisioning.formation.status = 'approved'
  provisioning.employees[0].status = 'provisioning'
  provisioning.provisioning = {
    id: '11111111-1111-4111-8111-111111111111', startedAt: provisioning.updatedAt, approvalId: 'a1',
    employeeIds: ['e1'], reservationIds: ['22222222-2222-4222-8222-222222222222'],
  }
  provisioning.workItems = [{
    id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Interrupted work', objective: 'Fence old provisioning work.',
    status: 'claimed', assigneeId: 'e1', dependencies: [], approvalDependencies: [], inScope: ['src/**'], outOfScope: [],
    acceptance: ['Requeued'], verify: [], deliverables: [], attempt: 1, attemptId: 'old-attempt', attemptHistory: [], createdAt: provisioning.updatedAt, updatedAt: provisioning.updatedAt,
  }]
  const retriable = normalizeCompanyState(provisioning, config)
  assertCompanyState(retriable, provisioning.workspaceHash)
  assert.equal(retriable.phase, 'provisioning_failed')
  assert.equal(retriable.formation.status, 'draft')
  assert.equal(retriable.provisioning, undefined)
  assert.equal(retriable.employees[0]?.status, 'failed')
  assert.deepEqual({ status: retriable.workItems[0]?.status, attempt: retriable.workItems[0]?.attempt, attemptId: retriable.workItems[0]?.attemptId }, {
    status: 'pending', attempt: 0, attemptId: undefined,
  })
  assert.equal(retriable.moneyBudget.migrationRequired, false)
})
