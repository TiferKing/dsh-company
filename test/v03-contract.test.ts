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
  resolveAuthorizationAdmission,
  temporaryAuthorizationStatus,
} from '../src/authorizations.js'
import { parseActionRequest } from '../src/http.js'
import { currencyUnitsToMicros } from '../src/schemas.js'
import type { ModelPrice3, WorkItem } from '../src/types.js'
import { approvedTemporaryAuthorization, companyState } from './fixtures.js'

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
  releaseMoneyReservation(state, reservationId)
  assert.equal(state.moneyBudget.reservedMicros, 0)
  assert.equal(state.moneyBudget.reservations.length, 0)
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
  const authorization = approvedTemporaryAuthorization(state, {
    employeeId: 'e1', reason: 'Temporarily unblock bounded internal implementation.', startsAt: now, expiresAt: now + 1_000,
  }, { maxMs: 10_000 }, now)
  assert.equal(temporaryAuthorizationStatus(authorization, now), 'active')
  assert.equal('workId' in authorization, false)
  assert.equal('maxUses' in authorization, false)
  assert.equal('allowanceMicros' in authorization, false)

  state.approvals.push(
    { id: 'a2', kind: 'product_scope', status: 'pending', requestedBy: 'founder', summary: 'scope', payload: { action: 'update', productId: 'p1' }, risk: 'medium', requestedAt: now },
    { id: 'a3', kind: 'budget_change', status: 'pending', requestedBy: 'founder', summary: 'budget', payload: { newTotalMicros: 1, expectedTotalMicros: state.moneyBudget.totalMicros }, risk: 'high', requestedAt: now },
  )
  const work = { id: 'w1', kind: 'implementation', approvalDependencies: ['a2', 'a3'] } as WorkItem
  const admission = resolveAuthorizationAdmission(state, 'e1', work, now)!
  assert.deepEqual(admission.bypassedApprovalIds, ['a2'])
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
