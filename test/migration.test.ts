import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeCompanyState } from '../src/migration.js'
import { assertCompanyState, resolveConfig } from '../src/schemas.js'
import { companyState } from './fixtures.js'

test('legacy v0.1 state gains HR, hierarchical organization, formation, and token accounting idempotently', () => {
  const legacy = companyState() as any
  delete legacy.slogan
  delete legacy.governanceRevision
  delete legacy.tokenBudget
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
  delete legacy.products[0].tokenBudget
  delete legacy.products[0].budgetMicros
  delete legacy.employees[0].orgUnitId
  delete legacy.employees[0].positionId
  delete legacy.employees[0].tokenSafetyLimit
  delete legacy.employees[0].budgetMicros
  delete legacy.employees[0].isHr
  legacy.employees[0].department = 'Engineering'

  const config = resolveConfig({ stateRoot: '/tmp/dsh-company-migration-test', defaultTokenBudget: 9_000_000 })
  const normalized = normalizeCompanyState(legacy, config)
  assertCompanyState(normalized, legacy.workspaceHash)
  assert.equal(normalized.tokenBudget.totalTokens, 9_000_000)
  assert.equal(normalized.products[0]?.tokenBudget, 9_000_000)
  assert.equal('turnTokenLimit' in normalized.employees[0]!, false, 'legacy turn limits are stripped')
  assert.equal(normalized.hrEmployeeId, 'e1')
  assert.equal(normalized.employees[0]?.isHr, true)
  assert.ok(normalized.orgUnits.some((unit) => unit.kind === 'company'))
  assert.ok(normalized.orgUnits.some((unit) => unit.name === 'Human Resources'))
  assert.equal(normalized.formation.status, 'approved')
  assert.equal(normalized.slogan, 'Build and verify one bounded example product.')
  assert.ok(normalized.slogan.length <= 160)

  const before = structuredClone(normalized)
  normalizeCompanyState(normalized, config)
  assert.deepEqual(normalized, before)
})
