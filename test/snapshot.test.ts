import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSnapshot } from '../src/snapshot.js'
import { parseCompanySnapshot } from '../src/client/types.js'
import { approvedTemporaryAuthorization, companyState } from './fixtures.js'

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
  assert.equal(snapshot.schema_version, 5)
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

test('bounded employee history retains references from the visible authorization audit', () => {
  const state = companyState()
  const now = Date.now()
  approvedTemporaryAuthorization(state, {
    employeeId: 'e1', reason: 'Historical investigation', expiresAt: now - 1_000,
  }, { maxMs: 4_000 }, now - 2_000)
  const employee = state.employees[0]!
  employee.status = 'retired'
  employee.retiredAt = now
  for (let index = 2; index <= 205; index += 1) {
    state.employees.push({ ...structuredClone(employee), id: `e${index}`, name: `Retired ${index}`, sessionId: `session-${index}` })
  }
  state.counters.employee = 205
  const snapshot = buildSnapshot({ agents: { get: () => undefined } } as any, state,
    { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  assert.equal(snapshot.employees.length, 200)
  assert.ok(snapshot.employees.some((candidate) => candidate.id === 'e1'))
  assert.equal(parseCompanySnapshot(snapshot).temporary_authorizations[0]?.employee_id, 'e1')
})

test('large durable histories project into a bounded first-load snapshot', () => {
  const state = companyState()
  const text = 'x'.repeat(8_192)
  for (let index = 1; index <= 128; index += 1) {
    state.workItems.push({
      id: `w${index}`, productId: 'p1', kind: 'design', subject: `Work ${index}`, objective: text, status: 'completed', assigneeId: 'e1',
      dependencies: [], inScope: [], outOfScope: [], acceptance: Array(16).fill(text), verify: Array(16).fill(text), deliverables: Array(16).fill(text),
      attempt: 1, output: text, attemptHistory: [], createdAt: index, updatedAt: index,
    })
  }
  state.modelCatalog.models = Array.from({ length: 1_200 }, (_, index) => ({
    provider: 'mock', model: `model-${index}`, name: `Model ${index}`, description: text,
    reasoningEfforts: [{ id: 'high', name: 'High', description: text }], advertised: true, available: true,
  }))
  const inbox = Array.from({ length: 1_000 }, (_, index) => ({
    id: `550e8400-e29b-41d4-a716-${String(index).padStart(12, '0')}`, from: 'e1', to: 'founder' as const,
    content: text, createdAt: index, deliveryState: 'accepted' as const,
  }))
  const ctx = { agents: { get: () => undefined } } as any
  const snapshot = buildSnapshot(ctx, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, inbox)
  assert.equal(snapshot.work.length, 128)
  assert.equal(snapshot.model_catalog.models.length, 1_000)
  assert.equal(snapshot.inbox.length, 100)
  assert.ok(Buffer.byteLength(JSON.stringify(snapshot), 'utf8') < 16 * 1024 * 1024)
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
