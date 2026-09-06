import assert from 'node:assert/strict'
import test from 'node:test'
import { buildSnapshot, normalizeSnapshotQuery } from '../src/snapshot.js'
import { parseCompanySnapshot } from '../src/client/types.js'
import { approvedTemporaryAuthorization, companyState } from './fixtures.js'

test('employee live activity does not inherit a working flag left by an interrupted process', () => {
  for (const liveStatus of [undefined, 'idle', 'ready', 'running'] as const) {
    const state = companyState()
    state.employees[0]!.status = 'working'
    const before = structuredClone(state)
    const ctx = { agents: { get: () => liveStatus === undefined ? undefined : { status: liveStatus } } } as any
    const snapshot = buildSnapshot(ctx, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
    assert.equal(snapshot.employees[0]!.status, 'working', 'the durable lifecycle is not rewritten by a read')
    assert.equal(snapshot.employees[0]!.activity, liveStatus ?? 'ready', `Host state: ${liveStatus ?? 'unloaded'}`)
    const running = liveStatus === 'running' ? 1 : 0
    assert.equal(snapshot.employees.filter((employee) => employee.activity === 'running').length, running)
    for (const unit of snapshot.org_units) {
      assert.equal(unit.load.open_work, 0)
      assert.equal(unit.load.effective_sum, running, 'a saved working flag alone must not inflate department load')
      assert.equal(unit.load.band, running === 1 ? 'normal' : 'very_idle')
    }
    assert.equal(parseCompanySnapshot(snapshot).employees[0]!.activity!.state, liveStatus ?? 'ready')
    assert.deepEqual(state, before)
  }
})

test('Host activity is authoritative while unfinished work remains visible after interruption', () => {
  const state = companyState()
  const employee = state.employees[0]!
  employee.status = 'working'
  state.workItems.push({
    id: 'w1', productId: 'p1', kind: 'design', subject: 'Interrupted design', objective: 'Finish the design', status: 'in_progress', assigneeId: 'e1',
    dependencies: [], inScope: [], outOfScope: [], acceptance: ['Contract reviewed'], verify: [], deliverables: ['Design'],
    attempt: 1, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  })
  state.counters.work = 1
  const ctx = { agents: { get: () => undefined } } as any
  const snapshot = buildSnapshot(ctx, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  assert.equal(snapshot.employees[0]!.activity, 'ready')
  assert.equal(snapshot.work[0]!.status, 'in_progress')
  assert.equal(snapshot.org_units[0]!.load.open_work, 1)
  assert.equal(snapshot.org_units[0]!.load.effective_sum, 1, 'unfinished work still contributes to department load')

  employee.status = 'idle'
  assert.equal(buildSnapshot({ agents: { get: () => ({ status: 'ready' }) } } as any, state,
    { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, []).employees[0]!.activity, 'ready')
  assert.equal(buildSnapshot({ agents: { get: () => ({ status: 'running' }) } } as any, state,
    { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, []).employees[0]!.activity, 'running')

  employee.status = 'retired'
  const retired = buildSnapshot({ agents: { get: () => ({ status: 'running' }) } } as any, state,
    { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [])
  assert.equal(retired.employees[0]!.activity, 'retired')
  assert.equal(retired.org_units[0]!.load.people, 0)
  assert.equal(retired.org_units[0]!.load.effective_sum, 0)
})

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

test('employee history pages retain authorization references to employees on other pages', () => {
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
    { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [], undefined, { employeeOffset: 150 })
  assert.equal(snapshot.employees.length, 50)
  assert.equal(snapshot.directory?.employees.total, 205)
  assert.equal(snapshot.employees.some((candidate) => candidate.id === 'e1'), false)
  assert.equal(parseCompanySnapshot(snapshot).temporary_authorizations[0]?.employee_id, 'e1')
})

test('server directory pages traverse more than 256 employees and 64 occupants without losing aggregate counts', () => {
  const state = companyState()
  const template = state.employees[0]!
  state.employees = Array.from({ length: 1_001 }, (_, index) => ({ ...structuredClone(template), id: `e${index + 1}`, name: `Engineer ${index + 1}`, sessionId: `session-${index + 1}`, status: index === 1_000 ? 'retired' as const : 'idle' as const }))
  state.limits.maxEmployees = 'unlimited'
  const ctx = { agents: { get: (id: string) => id === 'session-1000' ? { status: 'running' } : undefined } } as any
  const actor = { kind: 'founder', id: 'founder', sessionId: 'founder-session' } as const
  const ids = new Set<string>()
  let offset = 0
  do {
    const snapshot = buildSnapshot(ctx, state, actor, [], undefined, { employeeOffset: offset, employeeLimit: 100 })
    const parsed = parseCompanySnapshot(snapshot)
    assert.equal(parsed.positions[0]!.employee_count, 1_000)
    assert.ok(parsed.positions[0]!.employee_ids.length <= 100)
    assert.equal(parsed.directory!.summary.active_employees, 1_000)
    assert.equal(parsed.directory!.summary.running_employees, 1)
    assert.equal(parsed.org_units[0]!.load.people, 1_000)
    for (const employee of parsed.employees) { assert.equal(ids.has(employee.id), false); ids.add(employee.id) }
    offset = snapshot.directory!.employees.next_offset ?? -1
  } while (offset !== -1)
  assert.equal(ids.size, 1_001)
  const running = buildSnapshot(ctx, state, actor, [], undefined, { employeeStatus: 'running' })
  assert.deepEqual(running.employees.map((employee) => employee.id), ['e1000'])
  const search = buildSnapshot(ctx, state, actor, [], undefined, { employeeSearch: 'Engineer 999', employeePositionId: 'pos1', employeeOrgUnitId: 'ou2' })
  assert.deepEqual(search.employees.map((employee) => employee.id), ['e999'])
  assert.equal(search.directory!.employees.total, 1_001)
  assert.equal(search.directory!.employees.filtered_total, 1)
})

test('organization and position pages accept references outside the current page and retain full fanout counts', () => {
  const state = companyState()
  state.orgUnits = [{ id: 'ou1', name: 'Company', kind: 'company', createdAt: 1 }, ...Array.from({ length: 300 }, (_, index) => ({ id: `ou${index + 2}`, name: `Team ${index}`, kind: 'team' as const, parentId: 'ou1', createdAt: 1 }))]
  state.positions = Array.from({ length: 1_001 }, (_, index) => ({ id: `pos${index + 1}`, title: `Role ${index}`, orgUnitId: 'ou301', responsibilities: [], createdAt: 1 }))
  state.employees[0]!.orgUnitId = 'ou301'
  state.employees[0]!.positionId = 'pos1001'
  const ctx = { agents: { get: () => undefined } } as any
  const actor = { kind: 'founder', id: 'founder', sessionId: 'founder-session' } as const
  const root = parseCompanySnapshot(buildSnapshot(ctx, state, actor, [], undefined, { orgLimit: 100, positionLimit: 100 }))
  assert.equal(root.org_units[0]!.child_count, 300)
  assert.equal(root.org_units[0]!.child_ids.length, 99)
  assert.equal(root.positions[0]!.org_unit_id, 'ou301')
  const end = parseCompanySnapshot(buildSnapshot(ctx, state, actor, [], undefined, { orgOffset: 300, positionOffset: 1_000 }))
  assert.equal(end.org_units[0]!.parent_id, 'ou1')
  assert.equal(end.org_units[0]!.position_count, 1_001)
  assert.deepEqual(end.positions[0]!.employee_ids, ['e1'])
})

test('directory input validation bounds pages and normalizes empty and out-of-range results', () => {
  for (const query of [{ employeeLimit: 101 }, { orgOffset: -1 }, { positionLimit: 0 }, { employeeOffset: 1.5 }, { employeeSearch: 'x'.repeat(257) }]) assert.throws(() => normalizeSnapshotQuery(query))
  assert.deepEqual(normalizeSnapshotQuery({ employeeId: '   ', employeeSearch: ' ' }), {})
  const ctx = { agents: { get: () => undefined } } as any
  const actor = { kind: 'founder', id: 'founder', sessionId: 'founder-session' } as const
  const empty = parseCompanySnapshot(buildSnapshot(ctx, companyState(), actor, [], undefined, { employeeOffset: 50, employeeSearch: 'no matching employee' }))
  assert.equal(empty.directory!.employees.offset, 0)
  assert.equal(empty.directory!.employees.returned, 0)
  const last = parseCompanySnapshot(buildSnapshot(ctx, companyState(), actor, [], undefined, { employeeOffset: 9_999 }))
  assert.equal(last.directory!.employees.offset, 0)
  assert.equal(last.employees.length, 1)
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
