import assert from 'node:assert/strict'
import test from 'node:test'
import {
  CompanyUnpricedModelError,
  matchModelPrice,
  priceUsageThreeRate,
  recordMoneyUsage,
  releaseMoneyReservation,
  reserveMoneyTurn,
  resolveRateSnapshot,
} from '../src/money.js'
import { mergeDiscoveredPriceRows, probeRegisteredModels } from '../src/models.js'
import {
  TEMP_AUTH_INTERNAL_WORK_KINDS,
  createTemporaryAuthorization,
  isTemporaryAuthorizationActive,
  resolveAuthorizationAdmission,
  revokeTemporaryAuthorization,
  temporaryAuthorizationStatus,
} from '../src/authorizations.js'
import { createApproval, resolveApproval } from '../src/approvals.js'
import { assertCompanyState, normalizeModelPrices, resolveConfig } from '../src/schemas.js'
import { buildSnapshot } from '../src/snapshot.js'
import { updateWork, workBlockedReasons } from '../src/work.js'
import type { CompanyState, MoneyRateSnapshot, WorkItem, WorkKind } from '../src/types.js'
import { companyState } from './fixtures.js'

const config = resolveConfig({ stateRoot: '/tmp/dsh-company-v03-qa' })

function rates(value: number): MoneyRateSnapshot {
  return {
    provider: 'mock', model: 'm', matchedProvider: 'mock', matchedModel: 'm', currency: 'USD',
    pricingRevision: 1, pricingDigest: 'digest',
    inputCacheMissMicrosPerMillion: value,
    inputCacheHitMicrosPerMillion: value,
    outputMicrosPerMillion: value,
  }
}

function workItem(overrides: Partial<WorkItem> = {}): WorkItem {
  const now = Date.now()
  return {
    id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Bounded work', objective: 'Verify the contract.',
    dependencies: [], approvalDependencies: [], inScope: ['src/**'], outOfScope: [], acceptance: ['Pass'], verify: [], deliverables: [],
    status: 'pending', assigneeId: 'e1', attempt: 0, attemptHistory: [], createdAt: now, updatedAt: now,
    ...overrides,
  }
}

function approved(state: CompanyState, kind: Parameters<typeof createApproval>[2]['kind'], payload: Parameters<typeof createApproval>[2]['payload']) {
  const approval = createApproval(state, 'founder', { kind, summary: `Approve ${kind}`, payload })
  approval.status = 'approved'
  approval.resolvedAt = Date.now()
  return approval
}

test('three-rate money uses one aggregate BigInt half-up rounding and never double-charges reasoning', () => {
  const usage = { inputTokens: 1, cacheReadTokens: 1, cacheWriteTokens: 0, outputTokens: 1, reasoningTokens: 1 }
  const half = priceUsageThreeRate(usage, rates(500_000))
  assert.equal(half.costMicros, 2, '1.5 aggregate micros rounds once to 2, not three independently rounded micros')
  assert.equal(half.totalTokens, 3)

  const belowHalfPerBucket = priceUsageThreeRate(usage, rates(400_000))
  assert.equal(belowHalfPerBucket.costMicros, 1, '1.2 aggregate micros rounds to 1, not zero')

  const asymmetric = priceUsageThreeRate({ inputTokens: 2, cacheWriteTokens: 3, cacheReadTokens: 7, outputTokens: 11, reasoningTokens: 11 }, {
    ...rates(0), inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 2_000_000, outputMicrosPerMillion: 3_000_000,
  })
  assert.deepEqual({ miss: asymmetric.inputCacheMissTokens, hit: asymmetric.inputCacheHitTokens, total: asymmetric.totalTokens, cost: asymmetric.costMicros }, {
    miss: 5, hit: 7, total: 23, cost: 52,
  })
})

test('blank exact rows cannot shadow wildcard prices and discovery never mutates the independent price matrix', () => {
  const state = companyState()
  state.moneyBudget.prices = [
    { provider: 'mock', model: 'm', source: 'catalog', revision: 1, updatedAt: 1 },
    { provider: 'mock', model: '*', inputCacheMissMicrosPerMillion: 10, inputCacheHitMicrosPerMillion: 20, outputMicrosPerMillion: 30, source: 'manual', revision: 1, updatedAt: 1 },
  ]
  assert.equal(matchModelPrice(state.moneyBudget.prices, 'mock', 'm')?.model, '*')
  assert.equal(resolveRateSnapshot(state, 'mock', 'm').matchedModel, '*')

  const normalized = normalizeModelPrices([
    { provider: 'mock', model: 'blank' },
    { provider: 'mock', model: '*', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 },
  ], 'manual', 2, 2)
  assert.deepEqual(normalized.map((row) => row.model), ['*'])
  assert.equal(resolveRateSnapshot({ ...state, moneyBudget: { ...state.moneyBudget, prices: normalized, pricingRevision: 2 } }, 'mock', 'anything').outputMicrosPerMillion, 0)

  const merged = mergeDiscoveredPriceRows(normalized, {
    stale: false, generation: 2, probedAt: 2, errors: [],
    models: [{ provider: 'mock', model: 'new', name: 'New', advertised: true, available: true }],
  }, 2, 2)
  assert.deepEqual(merged, normalized)
})

test('reservation captures immutable historical rates and actual settlement preserves the snapshot', () => {
  const state = companyState()
  state.moneyBudget.totalMicros = 100
  state.products[0]!.budgetMicros = 100
  state.employees[0]!.budgetMicros = 100
  state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, source: 'manual', revision: 1, updatedAt: 1 }]
  state.modelCatalog.models[0]!.contextWindow = 1

  const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: undefined }, 10)
  state.moneyBudget.pricingRevision = 2
  state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 9_000_000, inputCacheHitMicrosPerMillion: 9_000_000, outputMicrosPerMillion: 9_000_000, source: 'manual', revision: 2, updatedAt: 11 }]

  const entry = recordMoneyUsage(state, {
    sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1', provider: 'mock', model: 'mock-model',
    usage: { inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 1 }, at: 12,
  })
  assert.equal(entry?.costMicros, 2)
  assert.equal(entry?.pricingRevision, 1)
  assert.equal(entry?.rates?.outputMicrosPerMillion, 1_000_000)
  const released = releaseMoneyReservation(state, reservationId)
  assert.equal(state.moneyBudget.spentMicros, 2)
  assert.equal(state.moneyBudget.reservedMicros, 0)
  assert.equal(released.micros, 0)
})

test('persisted priced usage is rejected when cost disagrees with its immutable rate snapshot', () => {
  const state = companyState()
  state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, source: 'manual', revision: 1, updatedAt: 1 }]
  const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' }, 1)
  recordMoneyUsage(state, { sessionId: 'employee-session', eventSeq: 7, turn: 1, step: 1, employeeId: 'e1', provider: 'mock', model: 'mock-model', usage: { inputTokens: 1, outputTokens: 0 }, at: 2 })
  releaseMoneyReservation(state, reservationId)
  const money = state.moneyBudget.usage[0]!
  const legacy = state.tokenBudget.usage[0]!
  money.costMicros = 0
  legacy.costMicros = 0
  state.moneyBudget.spentMicros = 0
  state.tokenBudget.totalCostMicros = 0
  assert.throws(() => assertCompanyState(state, state.workspaceHash), /cost does not match its immutable rate snapshot/)
})

test('model probe deduplicates advertisements, records partial failures, preserves missing routes, and advances generation', async () => {
  const previous = {
    stale: true, generation: 4, invalidatedAt: 40,
    models: [
      { provider: 'gone', model: 'legacy', name: 'Legacy', advertised: true, available: true },
      { provider: 'a', model: 'hidden', name: 'Hidden', advertised: false, available: true },
    ], errors: [],
  }
  const ctx = {
    llm: {
      listProviders: () => [{ id: 'a', name: 'A' }, { id: 'b', name: 'B' }],
      listModels: async (provider: string) => {
        if (provider === 'b') throw new Error('provider unavailable')
        return [{ id: 'm2', name: 'M2' }, { id: 'm1', name: 'M1', inputModalities: ['text'] }, { id: 'm1', name: 'M1 duplicate' }]
      },
      resolveModelInfo: async (provider: string, model: string) => {
        if (provider === 'a' && model === 'm1') return { provider, id: model, name: 'Resolved M1', inputModalities: ['text'], context: { contextWindow: 128_000 }, defaultMaxTokens: 8192 }
        if (provider === 'a' && model === 'hidden') return { provider, id: model, name: 'Hidden', inputModalities: ['text'] }
        throw new Error('not resolvable')
      },
    },
  } as any
  const catalog = await probeRegisteredModels(ctx, previous, undefined, 50)
  assert.equal(catalog.stale, false)
  assert.equal(catalog.generation, 5)
  assert.equal(catalog.probedAt, 50)
  assert.equal(catalog.models.filter((model) => model.provider === 'a' && model.model === 'm1').length, 1)
  assert.equal(catalog.models.find((model) => model.provider === 'a' && model.model === 'm1')?.available, true)
  assert.equal(catalog.models.find((model) => model.provider === 'a' && model.model === 'm2')?.available, false)
  assert.deepEqual(catalog.models.find((model) => model.provider === 'gone' && model.model === 'legacy'), {
    provider: 'gone', model: 'legacy', name: 'Legacy', advertised: false, available: false,
  })
  assert.equal(catalog.models.find((model) => model.provider === 'a' && model.model === 'hidden')?.available, true)
  assert.ok(catalog.errors.some((error) => error.provider === 'b' && error.message.includes('provider unavailable')))
  assert.ok(catalog.errors.some((error) => error.provider === 'a' && error.message.includes('m2')))
})

test('temporary authorization has exact work/approval fences, strict time bounds, no terminal-decision waiver, and no overlap', () => {
  const now = 10_000
  const state = companyState()
  const productScope = createApproval(state, 'founder', { kind: 'product_scope', summary: 'Pending scope', payload: { action: 'update', productId: 'p1' } })
  const modelRoute = createApproval(state, 'founder', { kind: 'model_route', summary: 'Pending route', payload: { employeeId: 'e1', provider: 'mock', model: 'mock-model' } })
  const budget = createApproval(state, 'founder', { kind: 'budget_change', summary: 'Pending budget', payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000 } })
  const authorization = createTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Bounded exception', startsAt: now, expiresAt: now + 1_000 }, { maxMs: 5_000 }, now)

  assert.equal(temporaryAuthorizationStatus(authorization, now - 1), 'scheduled')
  assert.equal(temporaryAuthorizationStatus(authorization, now), 'active')
  assert.equal(isTemporaryAuthorizationActive(authorization, now + 999), true)
  assert.equal(isTemporaryAuthorizationActive(authorization, now + 1_000), false)

  for (const kind of TEMP_AUTH_INTERNAL_WORK_KINDS) {
    const admission = resolveAuthorizationAdmission(state, 'e1', workItem({ kind, approvalDependencies: [productScope.id, modelRoute.id, budget.id] }), now)
    assert.deepEqual(admission?.bypassedApprovalIds, [productScope.id, modelRoute.id], `${kind} has only the two fixed waivable approval kinds`)
  }
  for (const kind of ['release', 'operations'] as const) assert.equal(resolveAuthorizationAdmission(state, 'e1', workItem({ kind }), now), undefined)

  productScope.status = 'rejected'
  assert.deepEqual(resolveAuthorizationAdmission(state, 'e1', workItem({ approvalDependencies: [productScope.id] }), now)?.bypassedApprovalIds, [])
  productScope.status = 'cancelled'
  assert.deepEqual(resolveAuthorizationAdmission(state, 'e1', workItem({ approvalDependencies: [productScope.id] }), now)?.bypassedApprovalIds, [])
  assert.throws(() => createTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Overlap', startsAt: now + 500, expiresAt: now + 1_500 }, { maxMs: 5_000 }, now), /overlapping/)
  revokeTemporaryAuthorization(state, authorization.id, 'No longer needed', now + 200)
  assert.equal(temporaryAuthorizationStatus(authorization, now + 200), 'revoked')
  assert.doesNotThrow(() => createTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Replacement', startsAt: now + 500, expiresAt: now + 1_500 }, { maxMs: 5_000 }, now + 200))
})

test('release and operations work require exact protected approval kinds and cannot use unrelated approvals', () => {
  const state = companyState()
  const unrelated = approved(state, 'product_scope', { action: 'update', productId: 'p1' })
  const release = workItem({ kind: 'release', approvalDependencies: [unrelated.id], status: 'in_progress', attempt: 1, attemptId: 'attempt-release' })
  state.workItems = [release]
  assert.ok(workBlockedReasons(state, release, 'e1').includes('release_approval_required'))
  assert.throws(() => updateWork(state, '/workspace', 'e1', {
    workId: release.id, attemptId: 'attempt-release', status: 'completed', output: 'Released.',
    changedPaths: ['src/release.ts'], acceptanceResults: ['Release evidence passed.'],
  }), /matching approved request/)

  const correctRelease = approved(state, 'release', { productId: 'p1' })
  release.approvalDependencies = [correctRelease.id]
  assert.equal(workBlockedReasons(state, release, 'e1').includes('release_approval_required'), false)

  const route = approved(state, 'model_route', { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  const operations = workItem({ id: 'w2', kind: 'operations', approvalDependencies: [route.id], status: 'in_progress', attempt: 1, attemptId: 'attempt-operations' })
  state.workItems = [operations]
  assert.ok(workBlockedReasons(state, operations, 'e1').includes('operations_approval_required'))
  assert.throws(() => updateWork(state, '/workspace', 'e1', {
    workId: operations.id, attemptId: 'attempt-operations', status: 'completed', output: 'Operated.',
    changedPaths: ['src/operation.ts'], acceptanceResults: ['Operation evidence passed.'],
  }), /matching approved request/)
  const external = approved(state, 'external_effect', { description: 'Operate bounded infrastructure', controls: ['manual review'] })
  operations.approvalDependencies = [external.id]
  assert.equal(workBlockedReasons(state, operations, 'e1').includes('operations_approval_required'), false)
})

test('governance approval is atomic, revision-fenced, rejectable, expirable, and terminal', () => {
  const applyState = companyState()
  const apply = createApproval(applyState, 'founder', {
    kind: 'governance_change', summary: 'Update governance',
    payload: { expectedGovernanceRevision: 1, slogan: 'New slogan', mission: 'Expanded mission', charter: '1. First\n  1.1 Child' },
  })
  const result = resolveApproval(applyState, config, { approvalId: apply.id, decision: 'approved', source: 'tool', humanStatement: 'Approved.' })
  assert.equal(result.applied, true)
  assert.deepEqual({ slogan: applyState.slogan, mission: applyState.mission, charter: applyState.formation.charter, revision: applyState.governanceRevision }, {
    slogan: 'New slogan', mission: 'Expanded mission', charter: '1. First\n  1.1 Child', revision: 2,
  })
  assert.throws(() => resolveApproval(applyState, config, { approvalId: apply.id, decision: 'approved', source: 'tool', humanStatement: 'Replay.' }), /terminal|already approved/)

  const staleState = companyState()
  const stale = createApproval(staleState, 'founder', { kind: 'governance_change', summary: 'Stale governance', payload: { expectedGovernanceRevision: 1, mission: 'Must not apply' } })
  staleState.governanceRevision = 2
  const staleResult = resolveApproval(staleState, config, { approvalId: stale.id, decision: 'approved', source: 'tool', humanStatement: 'Approved stale request.' })
  assert.equal(staleResult.stale, true)
  assert.equal(stale.status, 'cancelled')
  assert.notEqual(staleState.mission, 'Must not apply')

  const rejectedState = companyState()
  const rejected = createApproval(rejectedState, 'founder', { kind: 'governance_change', summary: 'Reject governance', payload: { expectedGovernanceRevision: 1, charter: 'Must not apply' } })
  resolveApproval(rejectedState, config, { approvalId: rejected.id, decision: 'rejected', source: 'tool', humanStatement: 'Rejected.' })
  assert.equal(rejected.status, 'rejected')
  assert.notEqual(rejectedState.formation.charter, 'Must not apply')

  const expiredState = companyState()
  const expired = createApproval(expiredState, 'founder', { kind: 'governance_change', summary: 'Expire governance', payload: { expectedGovernanceRevision: 1, slogan: 'Must not apply' }, expiresAt: Date.now() + 10_000 })
  expired.expiresAt = Date.now() - 1
  resolveApproval(expiredState, config, { approvalId: expired.id, decision: 'approved', source: 'tool', humanStatement: 'Too late.' })
  assert.equal(expired.status, 'expired')
  assert.notEqual(expiredState.slogan, 'Must not apply')
})

test('financial migration remediation requires explicit legacy acceptance and never auto-resumes', () => {
  const state = companyState()
  state.phase = 'halted'
  state.health = { status: 'halted', reason: 'financial_migration', resumable: false }
  state.moneyBudget.migrationRequired = true
  state.moneyBudget.legacyV02 = { totalTokens: 10, usedTokens: 0, reservedTokens: 0, totalCostMicros: 0, prices: [], treatment: 'unverified' }

  const unsafe = createApproval(state, 'founder', { kind: 'budget_change', summary: 'Unsafe remediation', payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000 } })
  assert.throws(() => resolveApproval(state, config, { approvalId: unsafe.id, decision: 'approved', source: 'tool', humanStatement: 'Approved.' }), /explicitly accept/)
  assert.equal(unsafe.status, 'pending')
  assert.equal(state.moneyBudget.migrationRequired, true)

  const safe = createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Accepted remediation',
    payload: {
      newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, legacyTreatment: 'accepted',
      productAllocations: [{ id: 'p1', budgetMicros: 100_000_000 }], employeeAllocations: [{ id: 'e1', budgetMicros: 100_000_000 }],
    },
  })
  resolveApproval(state, config, { approvalId: safe.id, decision: 'approved', source: 'tool', humanStatement: 'I accept the preserved ledger treatment.' })
  assert.equal(state.moneyBudget.legacyV02.treatment, 'accepted')
  assert.equal(state.moneyBudget.migrationRequired, false)
  assert.equal(state.phase, 'halted', 'clearing the money migration gate must not implicitly resume')
})

test('Host department load oracle reconciles nested subtree evidence and exact four-band boundaries', () => {
  const ctx = { agents: { get: () => undefined } } as any
  const rootLoad = (state: CompanyState) => buildSnapshot(ctx, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, []).org_units.find((unit) => unit.id === 'ou1')!.load

  const empty = companyState()
  empty.employees[0]!.status = 'retired'
  assert.deepEqual(rootLoad(empty), { band: 'very_idle', people: 0, open_work: 0, effective_sum: 0, average: 0, max_effective: 0 })

  const running = companyState()
  running.employees[0]!.status = 'working'
  assert.deepEqual(rootLoad(running), { band: 'normal', people: 1, open_work: 0, effective_sum: 1, average: 1, max_effective: 1 })

  const busy = companyState()
  busy.workItems = [workItem({ id: 'w1' }), workItem({ id: 'w2' })]
  assert.deepEqual(rootLoad(busy), { band: 'busy', people: 1, open_work: 2, effective_sum: 2, average: 2, max_effective: 2 })

  const pressure = companyState()
  pressure.workItems = [1, 2, 3, 4].map((value) => workItem({ id: `w${value}` }))
  assert.deepEqual(rootLoad(pressure), { band: 'pressure', people: 1, open_work: 4, effective_sum: 4, average: 4, max_effective: 4 })

  const nested = companyState()
  nested.orgUnits.push({ id: 'ou3', name: 'Nested team', kind: 'team', parentId: 'ou2', createdAt: Date.now() })
  nested.employees.push({ ...structuredClone(nested.employees[0]!), id: 'e2', name: 'Nested employee', orgUnitId: 'ou3', positionId: undefined, sessionId: 'employee-2', status: 'idle' })
  nested.workItems = [workItem({ id: 'w1', assigneeId: 'e1' }), workItem({ id: 'w2', assigneeId: 'e2' })]
  const root = rootLoad(nested)
  assert.deepEqual(root, { band: 'normal', people: 2, open_work: 2, effective_sum: 2, average: 1, max_effective: 1 })
  const snapshot = buildSnapshot(ctx, nested, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  assert.deepEqual(snapshot.org_units.find((unit) => unit.id === 'ou2')?.load, root)
})

test('Host employee projection exposes priced/unpriced counts so unknown cost is never inferred as zero', () => {
  const state = companyState()
  state.moneyBudget.prices = []
  const authorization = createTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Unpriced bounded work', expiresAt: Date.now() + 60_000 }, { maxMs: 120_000 }, Date.now())
  reserveMoneyTurn(state, {
    employeeId: 'e1', provider: 'unknown', model: 'model',
    bypass: { authorizationId: authorization.id, bypassCompany: true, bypassProduct: true, bypassEmployee: true },
  })
  recordMoneyUsage(state, { sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1', provider: 'unknown', model: 'model', usage: { inputTokens: 3, outputTokens: 2 }, at: Date.now() })
  const snapshot = buildSnapshot({ agents: { get: () => undefined } } as any, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  assert.deepEqual({ priced: snapshot.employees[0]?.token_usage?.priced_calls, unpriced: snapshot.employees[0]?.token_usage?.unpriced_calls, cost: snapshot.employees[0]?.token_usage?.cost_micros }, { priced: 0, unpriced: 1, cost: 0 })
  assert.deepEqual({ priced: snapshot.budget.provider_model_aggregates[0]?.priced_calls, unpriced: snapshot.budget.provider_model_aggregates[0]?.unpriced_calls }, { priced: 0, unpriced: 1 })
})

test('priced admission also fails closed when prompt context is stale or unknown', () => {
  const stale = companyState()
  Object.assign(stale.moneyBudget.prices[0]!, { inputCacheMissMicrosPerMillion: 1, inputCacheHitMicrosPerMillion: 1, outputMicrosPerMillion: 1 })
  stale.modelCatalog.stale = true
  assert.throws(() => reserveMoneyTurn(stale, { employeeId: 'e1', provider: 'mock', model: 'mock-model' }), /catalog is stale/)
  assert.equal(stale.moneyBudget.reservations.length, 0)

  const missing = companyState()
  Object.assign(missing.moneyBudget.prices[0]!, { inputCacheMissMicrosPerMillion: 1, inputCacheHitMicrosPerMillion: 1, outputMicrosPerMillion: 1 })
  delete missing.modelCatalog.models[0]!.contextWindow
  assert.throws(() => reserveMoneyTurn(missing, { employeeId: 'e1', provider: 'mock', model: 'mock-model' }), /no discovered context window/)
  assert.equal(missing.moneyBudget.reservations.length, 0)
})

test('unpriced admission still fails closed without a temporary authorization', () => {
  const state = companyState()
  state.moneyBudget.prices = []
  assert.throws(() => reserveMoneyTurn(state, { employeeId: 'e1', provider: 'unknown', model: 'model' }), CompanyUnpricedModelError)
  assert.equal(state.moneyBudget.reservations.length, 0)
  assert.equal(state.moneyBudget.reservedMicros, 0)
})
