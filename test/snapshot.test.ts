import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSnapshot } from '../src/snapshot.js'
import { companyState } from './fixtures.js'

test('browser snapshot omits attempt capabilities and execution prompts', () => {
  const state = companyState()
  state.employees[0]!.executionPrompt = 'private role instruction'
  state.workItems.push({
    id: 'w1', productId: 'p1', kind: 'design', subject: 'Design', objective: 'Design bounded API', status: 'claimed', assigneeId: 'e1',
    dependencies: [], inScope: [], outOfScope: [], acceptance: ['Contract reviewed'], verify: [], deliverables: ['Design'],
    attempt: 1, attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  })
  state.counters.work = 1
  const ctx = {
    agents: { get: () => undefined },
  } as any
  const snapshot = buildSnapshot(ctx, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  const serialized = JSON.stringify(snapshot)
  assert.doesNotMatch(serialized, /550e8400-e29b-41d4-a716-446655440000/)
  assert.doesNotMatch(serialized, /private role instruction/)
  assert.equal(snapshot.viewer.role, 'founder')
  assert.equal(snapshot.budget.unit, 'micro-currency')
  assert.equal(snapshot.schema_version, 4)
})

test('employee snapshot exposes only its own mailbox', () => {
  const state = companyState()
  const ctx = { agents: { get: () => undefined } } as any
  const snapshot = buildSnapshot(ctx, state, { kind: 'employee', id: 'e1', sessionId: 'employee-session' }, [
    { id: '550e8400-e29b-41d4-a716-446655440000', from: 'founder', to: 'e1', content: 'assigned', createdAt: Date.now(), deliveryState: 'accepted' },
    { id: '550e8400-e29b-41d4-a716-446655440001', from: 'e1', to: 'founder', content: 'hidden', createdAt: Date.now(), deliveryState: 'queued' },
  ])
  assert.deepEqual(snapshot.inbox.map((message) => message.content), ['assigned'])
  assert.deepEqual(snapshot.budget.usage_detail.items, [])
})

test('snapshot diagnostics recursively redact credential-shaped values and endpoints', () => {
  const state = companyState()
  state.health = { status: 'degraded', resumable: true, detail: 'api_key=sk-supersecret123 at https://internal.example/v1?token=abc' }
  state.employees[0]!.failure = 'Authorization: Bearer abc.def.ghi'
  state.modelCatalog.errors = [{ provider: 'mock', message: 'password=hunter2 from http://127.0.0.1:9999/private' }]
  const ctx = { agents: { get: () => undefined } } as any
  const snapshot = buildSnapshot(ctx, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  const serialized = JSON.stringify(snapshot)
  assert.doesNotMatch(serialized, /supersecret|hunter2|abc\.def\.ghi|internal\.example|127\.0\.0\.1:9999/)
  assert.match(serialized, /REDACTED/)
})
