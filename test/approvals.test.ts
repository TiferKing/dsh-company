import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeApproval, createApproval, expirePendingApprovals, requireApproved, resolveApproval } from '../src/approvals.js'
import { employeeMoneyTotals, recordMoneyUsage, releaseMoneyReservation, reserveMoneyTurn } from '../src/money.js'
import { resolveConfig, validateApprovalPayload } from '../src/schemas.js'
import { companyState } from './fixtures.js'

test('approval detail is normalized and optional', () => {
  const state = companyState()
  const approval = createApproval(state, 'founder', {
    kind: 'external_effect',
    summary: 'Publish a release candidate',
    detail: '  Publish the bundle to the sandbox registry.\nOnly sandbox endpoints are touched.  ',
    payload: { description: 'Publish to the sandbox registry.', target: 'sandbox' },
  })
  assert.equal(approval.detail, 'Publish the bundle to the sandbox registry.\nOnly sandbox endpoints are touched.')
  const bare = createApproval(state, 'founder', {
    kind: 'external_effect',
    summary: 'Second request',
    payload: { description: 'Publish to the sandbox registry.', target: 'sandbox' },
  })
  assert.equal(bare.detail, undefined)
  assert.throws(() => createApproval(state, 'founder', {
    kind: 'external_effect',
    summary: 'Third',
    detail: ' ',
    payload: { description: 'Publish to the sandbox registry.', target: 'sandbox' },
  }), /approval detail must not be empty/)
})

test('approval payloads are closed and reject secret/command-shaped keys', () => {
  assert.throws(() => validateApprovalPayload('external_effect', {
    description: 'Deploy', target: 'staging', controls: ['manual'], command: 'kubectl apply',
  }), /unknown field|forbidden key/)
  assert.throws(() => validateApprovalPayload('external_effect', {
    description: 'Deploy', controls: ['manual'], apiKey: 'secret',
  }), /forbidden key/)
})

test('money budget approval applies atomically and terminal request cannot be resolved twice', () => {
  const state = companyState()
  const approval = createApproval(state, 'founder', {
    kind: 'budget_change',
    summary: 'Increase the company monetary ceiling',
    payload: { newTotalMicros: 120_000_000, expectedTotalMicros: 100_000_000 },
  })
  const result = resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' }), {
    approvalId: approval.id,
    decision: 'approved',
    source: 'tool',
    humanStatement: 'Approved this bounded increase.',
  })
  assert.equal(result.applied, true)
  assert.equal(state.moneyBudget.totalMicros, 120_000_000)
  assert.throws(() => resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' }), {
    approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Again',
  }), /already approved/)
})

test('employee budget approvals capture the original ceiling and apply independently of the company total', () => {
  const state = companyState()
  state.employees[0]!.isHr = true
  const payload = {
    newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000,
    employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000 }],
  }
  const approval = createApproval(state, 'founder', { kind: 'budget_change', summary: 'Set a separate HR ceiling', payload })
  assert.deepEqual(approval.payload, {
    ...payload, employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000, expectedBudgetMicros: 100_000_000 }],
  })
  assert.deepEqual(payload.employeeAllocations, [{ id: 'e1', budgetMicros: 10_000_000 }], 'caller-owned payload is not mutated')

  const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
  assert.equal(result.applied, true)
  assert.equal(state.employees[0]!.budgetMicros, 10_000_000)
  assert.equal(state.moneyBudget.totalMicros, 100_000_000)
  assert.equal(state.moneyBudget.spentMicros, 0)
})

test('an older employee budget approval cannot overwrite a newer ceiling while the company total stays unchanged', () => {
  const state = companyState()
  const older = createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Earlier HR ceiling',
    payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, employeeAllocations: [{ id: 'e1', budgetMicros: 20_000_000 }] },
  })
  const newer = createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Revised HR ceiling',
    payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000 }] },
  })
  resolveApproval(state, resolveConfig(), { approvalId: newer.id, decision: 'approved', source: 'ui' })
  const result = resolveApproval(state, resolveConfig(), { approvalId: older.id, decision: 'approved', source: 'ui' })
  assert.equal(result.stale, true)
  assert.equal(result.applied, false)
  assert.equal(older.status, 'cancelled')
  assert.match(older.resolution!.note!, /employee e1 monetary ceiling changed/)
  assert.equal(state.employees[0]!.budgetMicros, 10_000_000)
  assert.equal(state.moneyBudget.totalMicros, 100_000_000)
})

test('legacy employee budget approvals remain readable but require a fresh request before applying', () => {
  const state = companyState()
  const payload = {
    newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000,
    employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000 }],
  }
  assert.doesNotThrow(() => validateApprovalPayload('budget_change', payload))
  const approval = createApproval(state, 'founder', { kind: 'budget_change', summary: 'Legacy HR ceiling request', payload })
  approval.payload = payload // Persisted requests from older versions have no captured employee ceiling.
  const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
  assert.equal(result.stale, true)
  assert.equal(approval.status, 'cancelled')
  assert.match(approval.resolution!.note!, /budget precondition is missing; request a new budget approval/)
  assert.equal(state.employees[0]!.budgetMicros, 100_000_000)
})

test('employee budget approvals reject an explicitly stale original ceiling without creating a request', () => {
  const state = companyState()
  assert.throws(() => createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Stale HR ceiling',
    payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000, expectedBudgetMicros: 20_000_000 }] },
  }), /employee e1 monetary ceiling changed/)
  assert.equal(state.approvals.length, 0)
  assert.equal(state.counters.approval, 0)
  assert.throws(() => validateApprovalPayload('budget_change', {
    newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000,
    employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000, expectedBudgetMicros: -1 }],
  }), /expectedBudgetMicros must be a safe integer/)
})

test('employee budget approvals reject duplicate targets before capturing or applying any allocation', () => {
  const state = companyState()
  assert.throws(() => createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Ambiguous employee ceiling',
    payload: {
      newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000,
      employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000 }, { id: 'e1', budgetMicros: 20_000_000 }],
    },
  }), /duplicate employee id e1/)
  assert.equal(state.approvals.length, 0)
  assert.equal(state.counters.approval, 0)
  assert.equal(state.employees[0]!.budgetMicros, 100_000_000)
})

test('legacy duplicate employee budget targets remain readable but cancel the approval', () => {
  const state = companyState()
  const payload = {
    newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000,
    employeeAllocations: [
      { id: 'e1', budgetMicros: 10_000_000, expectedBudgetMicros: 100_000_000 },
      { id: 'e1', budgetMicros: 20_000_000, expectedBudgetMicros: 100_000_000 },
    ],
  }
  assert.doesNotThrow(() => validateApprovalPayload('budget_change', payload))
  const approval = createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Legacy duplicate employee targets',
    payload: { ...payload, employeeAllocations: [payload.employeeAllocations[0]!] },
  })
  approval.payload = payload // Historical payload validation must not make the entire company unreadable.
  const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
  assert.equal(result.stale, true)
  assert.equal(result.applied, false)
  assert.equal(approval.status, 'cancelled')
  assert.match(approval.resolution!.note!, /duplicate employee id e1; request a new budget approval/)
  assert.equal(state.employees[0]!.budgetMicros, 100_000_000)
})

test('employee budget approvals reject missing and retired targets both when requested and when resolved', () => {
  for (const target of ['missing', 'retired'] as const) {
    const state = companyState()
    const input = {
      kind: 'budget_change' as const, summary: 'Change employee ceiling',
      payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, employeeAllocations: [{ id: 'e1', budgetMicros: 10_000_000 }] },
    }
    const approval = createApproval(state, 'founder', input)
    if (target === 'missing') state.employees = []
    else state.employees[0]!.status = 'retired'
    assert.throws(() => createApproval(state, 'founder', input), /must target an active employee/)
    const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
    assert.equal(result.stale, true)
    assert.equal(approval.status, 'cancelled')
    assert.match(approval.resolution!.note!, /employee e1 is no longer active/)
  }
})

test('employee budget reductions recheck spending and reservations added after the request', () => {
  for (const exposure of ['spent', 'reserved'] as const) {
    const state = companyState()
    state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
    const approval = createApproval(state, 'founder', {
      kind: 'budget_change', summary: 'Reduce employee ceiling to zero',
      payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, employeeAllocations: [{ id: 'e1', budgetMicros: 0 }] },
    })
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    if (exposure === 'spent') {
      recordMoneyUsage(state, { sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1', provider: 'mock', model: 'mock-model', usage: { inputTokens: 5, outputTokens: 0 }, at: Date.now() })
      releaseMoneyReservation(state, reservationId)
    }
    assert.throws(() => resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' }), /employee e1 budget is below spent plus reserved micros/)
    assert.equal(approval.status, 'pending')
    assert.equal(state.employees[0]!.budgetMicros, 100_000_000)
  }
})

test('employee budget may equal the current spent plus reserved amount', () => {
  const state = companyState()
  state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
  reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  recordMoneyUsage(state, { sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1', provider: 'mock', model: 'mock-model', usage: { inputTokens: 5, outputTokens: 0 }, at: Date.now() })
  const totals = employeeMoneyTotals(state, 'e1')
  assert.ok(totals.spentMicros > 0 && totals.reservedMicros > 0)
  const budgetMicros = totals.spentMicros + totals.reservedMicros
  const approval = createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Keep enough budget for committed usage',
    payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000, employeeAllocations: [{ id: 'e1', budgetMicros }] },
  })
  const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
  assert.equal(result.applied, true)
  assert.equal(state.employees[0]!.budgetMicros, budgetMicros)
  assert.equal(employeeMoneyTotals(state, 'e1').availableMicros, 0)
})

test('expired pending approvals are swept before they can exhaust the cap', () => {
  const state = companyState()
  state.limits.maxPendingApprovals = 1
  const expired = createApproval(state, 'founder', {
    kind: 'external_effect', summary: 'Short-lived request', payload: { description: 'Test expiry.' }, expiresAt: Date.now() + 10_000,
  })
  expired.expiresAt = Date.now() - 1
  assert.equal(expirePendingApprovals(state), 1)
  assert.equal(expired.status, 'expired')
  assert.doesNotThrow(() => createApproval(state, 'founder', {
    kind: 'external_effect', summary: 'Replacement request', payload: { description: 'Uses the released slot.' },
  }))
})

test('resolving an expired HR approval also closes its staffing recommendation', () => {
  const state = companyState()
  const approval = createApproval(state, 'founder', {
    kind: 'organization_change', summary: 'Retire e1', payload: { action: 'retire', employeeId: 'e1', staffingRequestId: 'sr1' }, expiresAt: Date.now() + 60_000,
  })
  state.staffingRequests.push({ id: 'sr1', action: 'retire', employeeId: 'e1', status: 'recommended', requestedBy: 'founder', workProfile: 'Review retirement.', hrEmployeeId: 'e1', approvalId: approval.id, createdAt: 1, updatedAt: 1 })
  approval.expiresAt = Date.now() - 1
  const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
  assert.equal(result.applied, false)
  assert.equal(approval.status, 'expired')
  assert.equal(state.staffingRequests[0]!.status, 'rejected')
})

test('approved organization authorization is one-shot', () => {
  const state = companyState()
  const approval = createApproval(state, 'founder', {
    kind: 'organization_change',
    summary: 'Remove e1',
    payload: { action: 'remove', employeeId: 'e1' },
  })
  approval.status = 'approved'
  approval.resolvedAt = Date.now()
  consumeApproval(requireApproved(state, approval.id, 'organization_change'))
  assert.throws(() => requireApproved(state, approval.id, 'organization_change'), /already been consumed/)
})

test('release approval excludes its own pending release work from prerequisites', () => {
  const state = companyState()
  state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', name: 'Independent reviewer', sessionId: 'reviewer-session' })
  state.counters.employee = 2
  state.workItems.push(
    { id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Build', objective: 'Build.', status: 'completed', assigneeId: 'e1', dependencies: [], inScope: ['product'], outOfScope: [], acceptance: ['built'], verify: [], deliverables: [], attempt: 1, output: 'built', attemptHistory: [], createdAt: 1, updatedAt: 1 },
    { id: 'w2', productId: 'p1', kind: 'verification', subject: 'Verify', objective: 'Verify.', status: 'completed', assigneeId: 'e2', dependencies: ['w1'], inScope: [], outOfScope: [], acceptance: ['verified'], verify: [], deliverables: [], attempt: 1, output: 'verified', attemptHistory: [], createdAt: 2, updatedAt: 2 },
    { id: 'w3', productId: 'p1', kind: 'review', subject: 'Review', objective: 'Review.', status: 'completed', assigneeId: 'e2', dependencies: ['w1'], inScope: [], outOfScope: [], acceptance: ['reviewed'], verify: [], deliverables: [], reviewedWorkId: 'w1', attempt: 1, output: 'pass', verdict: 'pass', attemptHistory: [], createdAt: 3, updatedAt: 3 },
  )
  const approval = createApproval(state, 'founder', { kind: 'release', summary: 'Release product', payload: { productId: 'p1' } })
  state.workItems.push({ id: 'w4', productId: 'p1', kind: 'release', subject: 'Publish release', objective: 'Publish.', status: 'pending', dependencies: ['w2', 'w3'], approvalDependencies: [approval.id], inScope: ['product'], outOfScope: [], acceptance: ['published'], verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: 4, updatedAt: 4 })

  const result = resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' }), {
    approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Approve the release gate.',
  })
  assert.equal(result.applied, true)
  assert.equal(approval.status, 'approved')
  assert.equal(state.products[0]?.status, 'validating')
})

test('release approval cannot infer independent review from an unidentified author', () => {
  const state = companyState()
  state.workItems.push(
    { id: 'w1', productId: 'p1', kind: 'verification', subject: 'Verify', objective: 'Verify.', status: 'completed', dependencies: [], inScope: [], outOfScope: [], acceptance: ['verified'], verify: [], deliverables: [], attempt: 1, output: 'verified', attemptHistory: [], createdAt: 1, updatedAt: 1 },
    { id: 'w2', productId: 'p1', kind: 'review', subject: 'Review', objective: 'Review.', status: 'completed', assigneeId: 'e1', reviewedWorkId: 'w1', dependencies: ['w1'], inScope: [], outOfScope: [], acceptance: ['reviewed'], verify: [], deliverables: [], attempt: 1, output: 'pass', verdict: 'pass', attemptHistory: [], createdAt: 2, updatedAt: 2 },
  )
  const approval = createApproval(state, 'founder', { kind: 'release', summary: 'Release product', payload: { productId: 'p1' } })
  const result = resolveApproval(state, resolveConfig(), { approvalId: approval.id, decision: 'approved', source: 'ui' })
  assert.equal(result.stale, true)
  assert.equal(approval.status, 'cancelled')
  assert.match(approval.resolution!.note!, /no independent passing review/)
})

test('product-scope resolution authorizes only a later exact transition', () => {
  const state = companyState()
  state.products[0]!.status = 'proposed'
  const approval = createApproval(state, 'founder', {
    kind: 'product_scope',
    summary: 'Cancel the proposed product',
    payload: { action: 'cancel', productId: 'p1' },
  })
  const result = resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' }), {
    approvalId: approval.id,
    decision: 'approved',
    source: 'tool',
    humanStatement: 'Approved the bounded cancellation request.',
  })

  assert.equal(result.applied, false)
  assert.equal(state.products[0]?.status, 'proposed')
  assert.equal(approval.consumedAt, undefined)
  assert.equal(requireApproved(state, approval.id, 'product_scope', (payload) =>
    typeof payload === 'object' && payload !== null && !Array.isArray(payload)
      && payload.action === 'cancel' && payload.productId === 'p1').id, approval.id)
})
