import assert from 'node:assert/strict'
import test from 'node:test'
import { recordMoneyUsage, releaseMoneyReservation, reserveMoneyTurn } from '../src/money.js'
import { consumeTemporaryAuthorization } from '../src/authorizations.js'
import { approvedTemporaryAuthorization, companyState } from './fixtures.js'

test('a large valid budget is bounded by the model context before conversion from BigInt', () => {
  const state = companyState()
  state.moneyBudget.totalMicros = 1_000_000_000_000
  state.employees[0]!.budgetMicros = state.moneyBudget.totalMicros
  state.products[0]!.budgetMicros = state.moneyBudget.totalMicros
  state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1
  state.moneyBudget.prices[0]!.outputMicrosPerMillion = 1
  reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  assert.equal(state.moneyBudget.reservations[0]!.limitTokens, 128_000)
  assert.equal(state.moneyBudget.reservedMicros, 2)
})

test('delayed authorized usage is charged to the admission that existed when its reservation was created', () => {
  const state = companyState()
  state.workItems.push({ id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Build', objective: 'Build.', status: 'pending', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['built'], verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: 1, updatedAt: 1 })
  state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
  const authorization = approvedTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Allow internal retries.', startsAt: 1, expiresAt: 1_000 }, { maxMs: 1_000 }, 1)
  const input = { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1', bypass: { authorizationId: authorization.id, bypassCompany: true, bypassProduct: true, bypassEmployee: true } }
  const firstId = reserveMoneyTurn(state, input, 10)
  consumeTemporaryAuthorization(authorization, { employeeId: 'e1', workId: 'w1', bypassed: ['company_budget'] }, 10)
  const captured = structuredClone(state.moneyBudget.reservations[0]!)
  releaseMoneyReservation(state, firstId)
  reserveMoneyTurn(state, input, 20)
  consumeTemporaryAuthorization(authorization, { employeeId: 'e1', workId: 'w1', bypassed: ['company_budget'] }, 20)
  recordMoneyUsage(state, { sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1', provider: 'mock', model: 'mock-model', usage: { inputTokens: 7, outputTokens: 0 }, at: 21, reservation: captured })
  assert.equal(authorization.uses[0]!.amountMicros, 7)
  assert.equal(authorization.uses[1]!.amountMicros, undefined)
  authorization.uses[1]!.at = 10
  recordMoneyUsage(state, { sessionId: 'employee-session', eventSeq: 2, turn: 1, step: 2, employeeId: 'e1', provider: 'mock', model: 'mock-model', usage: { inputTokens: 7, outputTokens: 0 }, at: 22, reservation: captured, authorizationUseId: authorization.uses[0]!.id })
  assert.equal(authorization.uses[0]!.amountMicros, 14)
  assert.equal(authorization.uses[1]!.amountMicros, undefined)
})
