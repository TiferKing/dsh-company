import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCompanyState } from '../src/migration.js'
import { assertCompanyState, resolveConfig } from '../src/schemas.js'
import { companyState } from './fixtures.js'

test('legacy v1 state becomes a currency-only v2 aggregate idempotently', () => {
  const legacy = companyState() as any
  legacy.schemaVersion = 1
  legacy.budget = { unit: 'activation-credit', totalCredits: 100, reservedCredits: 0, spentCredits: 0, entries: [] }
  legacy.tokenBudget = {
    unit: 'token', currency: 'CNY', totalTokens: 9_000_000, reservedTokens: 0, usedTokens: 30,
    totalCostMicros: 7, prices: [], reservations: [],
    usage: [{
      id: 'employee-session:1', sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1,
      employeeId: 'e1', provider: 'mock', model: 'mock-model', inputTokens: 10, outputTokens: 20,
      cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 30,
      costMicros: 7, priced: true, at: Date.now(),
    }],
  }
  delete legacy.slogan
  delete legacy.governanceRevision
  delete legacy.moneyBudget
  delete legacy.modelCatalog
  delete legacy.temporaryAuthorizations
  delete legacy.formation
  delete legacy.health
  delete legacy.orgUnits
  delete legacy.positions
  delete legacy.staffingRequests
  delete legacy.hrEmployeeId
  delete legacy.counters.orgUnit
  delete legacy.counters.position
  delete legacy.counters.staffing
  delete legacy.counters.authorization
  legacy.products[0].tokenBudget = 9_000_000
  legacy.products[0].budgetCredits = 90
  delete legacy.products[0].budgetMicros
  delete legacy.employees[0].orgUnitId
  delete legacy.employees[0].positionId
  legacy.employees[0].turnTokenLimit = 1_000
  delete legacy.employees[0].budgetMicros
  delete legacy.employees[0].isHr
  legacy.employees[0].department = 'Engineering'

  const config = resolveConfig({ stateRoot: '/tmp/dsh-company-migration-test' })
  const normalized = normalizeCompanyState(legacy, config)
  assertCompanyState(normalized, legacy.workspaceHash)
  assert.equal(normalized.schemaVersion, 2)
  assert.equal('budget' in normalized, false)
  assert.equal('tokenBudget' in normalized, false)
  assert.equal('budgetCredits' in normalized.products[0]!, false)
  assert.equal('tokenBudget' in normalized.products[0]!, false)
  assert.equal(normalized.moneyBudget.currency, 'CNY')
  assert.equal(normalized.moneyBudget.spentMicros, 7)
  assert.equal(normalized.moneyBudget.usage[0]?.totalTokens, 30)
  assert.equal('turnTokenLimit' in normalized.employees[0]!, false)
  assert.equal(normalized.hrEmployeeId, 'e1')
  assert.equal(normalized.employees[0]?.isHr, true)
  assert.ok(normalized.orgUnits.some((unit) => unit.kind === 'company'))
  assert.ok(normalized.orgUnits.some((unit) => unit.name === 'Human Resources'))
  assert.equal(normalized.formation.status, 'approved')
  assert.equal(normalized.slogan, 'Build and verify one bounded example product.')

  const before = structuredClone(normalized)
  normalizeCompanyState(normalized, config)
  assert.deepEqual(normalized, before)
})
