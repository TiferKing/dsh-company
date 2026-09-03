import assert from 'node:assert/strict'
import test from 'node:test'
import { consumeApproval, createApproval, requireApproved, resolveApproval } from '../src/approvals.js'
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

test('budget approval applies atomically and terminal request cannot be resolved twice', () => {
  const state = companyState()
  const approval = createApproval(state, 'founder', {
    kind: 'budget_change',
    summary: 'Increase bounded activation credits',
    payload: { newTotalCredits: 120, expectedTotalCredits: 100 },
  })
  const result = resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state', maxBudgetCredits: 500 }), {
    approvalId: approval.id,
    decision: 'approved',
    source: 'tool',
    humanStatement: 'Approved this bounded increase.',
  })
  assert.equal(result.applied, true)
  assert.equal(state.budget.totalCredits, 120)
  assert.throws(() => resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' }), {
    approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Again',
  }), /already approved/)
})

test('token budget approval atomically changes the ceiling, currency, and per-million price matrix', () => {
  const state = companyState()
  const approval = createApproval(state, 'founder', {
    kind: 'budget_change', summary: 'Configure deterministic token accounting',
    payload: {
      newTotalTokens: 25_000_000, expectedTotalTokens: 20_000_000, currency: 'cny',
      prices: [{ provider: 'mock', model: 'mock-model', inputPerMillion: 1.5, cacheReadPerMillion: 0.2, cacheWritePerMillion: 1.5, outputPerMillion: 4 }],
    },
  })
  const result = resolveApproval(state, resolveConfig({ stateRoot: '/tmp/dsh-company-test-state', maxTokenBudget: 30_000_000 }), {
    approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Approved token and pricing configuration.',
  })
  assert.equal(result.applied, true)
  assert.equal(state.tokenBudget.totalTokens, 25_000_000)
  assert.equal(state.tokenBudget.currency, 'CNY')
  assert.equal(state.tokenBudget.prices[0]?.inputMicrosPerMillion, 1_500_000)
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
