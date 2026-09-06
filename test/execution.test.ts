import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanyExecutionController, CompanyExecutionDeferredError, ensureCompanyExecution, getCompanyExecution, type ExecutionPressure } from '../src/execution.js'
import { resolveConfig } from '../src/schemas.js'
import type { CompanyConfig, CompanyState } from '../src/types.js'
import { companyState } from './fixtures.js'

function harness(input: CompanyConfig = {}) {
  let now = 10_000
  let pressure: ExecutionPressure = { memoryRatio: 0.1, lagMs: 1, pendingWrites: 0 }
  const live = new Map<string, { status: string }>()
  const ctx = { agents: { get: (id: unknown) => live.get(String(id)) } } as any
  const config = resolveConfig({ executionMode: 'fixed', maxConcurrentEmployees: 2, ...input })
  const controller = new CompanyExecutionController(ctx, config, {}, () => pressure, () => now)
  const company = (cwd: string, sessions: string[]): CompanyState => {
    const state = companyState()
    const employee = state.employees[0]!
    state.employees = sessions.map((sessionId, index) => ({ ...employee, id: `e${index + 1}`, sessionId }))
    controller.observe(state, cwd)
    return state
  }
  const start = (session: string, cwd = '/one', provider = 'mock') => controller.run(session, cwd, provider, async () => {
    live.set(session, { status: 'running' })
    return session
  })
  return { controller, config, ctx, live, company, start,
    setPressure: (value: Partial<ExecutionPressure>) => { pressure = { ...pressure, ...value } },
    tick: (ms = 1000) => { now += ms }, now: () => now }
}

function deferred(reason: CompanyExecutionDeferredError['reason']) {
  return (error: unknown) => error instanceof CompanyExecutionDeferredError && error.reason === reason
}

test('fixed execution capacity is shared across companies and released only when the live turn stops', async () => {
  const h = harness()
  try {
    const first = h.company('/one', ['one-a', 'one-b'])
    const second = h.company('/two', ['two-a', 'two-b'])
    await h.start('one-a', '/one')
    await h.start('two-a', '/two')
    await assert.rejects(() => h.start('one-b', '/one'), deferred('concurrency'))
    assert.equal(h.controller.snapshot(first.id).running, 2, 'the displayed resource occupancy is Host-wide')
    assert.equal(h.controller.snapshot(first.id).waiting, 1)
    assert.equal(h.controller.snapshot(second.id).waiting, 0, 'waiting detail stays scoped to its company')
    h.controller.observe(first, '/one')
    await assert.rejects(() => h.start('two-b', '/two'), deferred('concurrency'))
    h.live.get('one-a')!.status = 'idle'
    await h.start('two-b', '/two')
    assert.equal(h.controller.snapshot(second.id).running, 2)
    assert.equal(h.controller.snapshot(second.id).waiting, 0)
  } finally { h.controller.dispose() }
})

test('starting operations reserve capacity synchronously and prevent duplicate employee deliveries', async () => {
  const h = harness({ maxConcurrentEmployees: 1 })
  h.company('/one', ['a', 'b'])
  let resolveStart!: () => void
  const starting = h.controller.run('a', '/one', 'mock', () => new Promise<void>((resolve) => { resolveStart = () => {
    h.live.set('a', { status: 'running' })
    resolve()
  } }))
  try {
    assert.equal(h.controller.snapshot('any').running, 1, 'an unresolved start already occupies its permit')
    let accidentalCalls = 0
    await assert.rejects(() => h.controller.run('b', '/one', 'mock', async () => { accidentalCalls += 1 }), deferred('concurrency'))
    await assert.rejects(() => h.controller.run('a', '/one', 'mock', async () => { accidentalCalls += 1 }), deferred('employee_busy'))
    assert.equal(accidentalCalls, 0)
    resolveStart()
    await starting
    await assert.rejects(() => h.start('b'), deferred('concurrency'))
    h.live.delete('a')
    await h.start('b')
    assert.equal(h.controller.snapshot('any').running, 1)
  } finally { resolveStart(); await starting; h.controller.dispose() }
})

test('failed host acceptance releases its permit so the next employee can start', async () => {
  const h = harness({ maxConcurrentEmployees: 1 })
  try {
    h.company('/one', ['a', 'b'])
    await assert.rejects(() => h.controller.run('a', '/one', 'mock', async () => { throw new Error('start was rejected') }), /start was rejected/)
    await h.start('b')
    assert.equal(h.controller.snapshot('any').running, 1)
  } finally { h.controller.dispose() }
})

test('accepted inbox delivery retains its permit while the Host has not entered the running turn yet', async () => {
  const h = harness({ maxConcurrentEmployees: 1 })
  try {
    const state = h.company('/one', ['a', 'b'])
    const queuedAgent = { status: 'idle', inbox: { nextTurn: [] as string[] } }
    h.live.set('a', queuedAgent)
    await h.controller.run('a', '/one', 'mock', async () => {
      queuedAgent.inbox.nextTurn.push('accepted-inbox-message')
      return 'accepted-inbox-message'
    })
    assert.equal(h.controller.snapshot(state.id).running, 1, 'inbox acceptance can resolve before the Host driver marks its turn running')
    await assert.rejects(() => h.start('b'), deferred('concurrency'))
    await assert.rejects(() => h.start('a'), deferred('employee_busy'))
    h.controller.observe(state, '/one')
    assert.equal(h.controller.snapshot(state.id).running, 1, 'observing the pre-turn idle state cannot release accepted work')
    queuedAgent.status = 'running'
    queuedAgent.inbox.nextTurn = []
    h.controller.observe(state, '/one')
    await assert.rejects(() => h.start('b'), deferred('concurrency'))
    queuedAgent.status = 'idle'
    h.controller.observe(state, '/one')
    await h.start('b')
    assert.equal(h.controller.snapshot(state.id).running, 1, 'capacity is transferred only after the accepted turn actually settles')
  } finally { h.controller.dispose() }
})

test('adaptive admission grows beyond its initial target gradually under sustained resource headroom', async () => {
  const h = harness({ executionMode: 'adaptive', maxConcurrentEmployees: 2 })
  try {
    const state = h.company('/one', ['a', 'b', 'c', 'd'])
    await h.start('a')
    await h.start('b')
    await h.start('c')
    assert.equal(h.controller.snapshot(state.id).limit, 3, 'configured initial count is not an adaptive hard cap')
    await assert.rejects(() => h.start('d'), deferred('concurrency'))
    h.tick()
    await h.start('d')
    assert.equal(h.controller.snapshot(state.id).limit, 4)
    assert.equal(h.controller.snapshot(state.id).running, 4)
  } finally { h.controller.dispose() }
})

test('memory, event-loop and persistence pressure delay new work without interrupting accepted turns', async () => {
  for (const [pressure, reason] of [
    [{ memoryRatio: 0.8 }, 'memory'], [{ lagMs: 200 }, 'event_loop'], [{ pendingWrites: 32 }, 'storage'],
  ] as const) {
    const h = harness({ executionMode: 'adaptive', maxConcurrentEmployees: 4 })
    try {
      const state = h.company('/one', ['a', 'b'])
      const wakeups: Array<{ cwd: string | undefined; delay: number }> = []
      h.controller.setWakeup((cwd, delay) => wakeups.push({ cwd, delay }))
      await h.start('a')
      h.setPressure(pressure)
      await assert.rejects(() => h.start('b'), deferred(reason))
      assert.equal(h.live.get('a')!.status, 'running')
      const view = h.controller.snapshot(state.id)
      assert.equal(view.running, 1)
      assert.equal(view.reason, reason)
      assert.equal(view.waiting, 1)
      assert.equal(view.retry_at, h.now() + h.config.executionRetryMs)
      assert.deepEqual(wakeups, [{ cwd: '/one', delay: 1000 }])
      h.setPressure({ memoryRatio: 0.1, lagMs: 1, pendingWrites: 0 })
      h.tick()
      await h.start('b')
      assert.equal(h.controller.snapshot(state.id).waiting, 0)
    } finally { h.controller.dispose() }
  }
})

test('unlimited execution has no numeric cap and retains the one-turn-per-employee boundary', async () => {
  const h = harness({ executionMode: 'unlimited', maxConcurrentEmployees: 1 })
  try {
    const ids = Array.from({ length: 100 }, (_, index) => `session-${index}`)
    const state = h.company('/one', ids)
    h.setPressure({ memoryRatio: 0.99, lagMs: 10_000, pendingWrites: 10_000 })
    await Promise.all(ids.map((id) => h.start(id)))
    const snapshot = h.controller.snapshot(state.id)
    assert.equal(snapshot.limit, null)
    assert.equal(snapshot.running, 100)
    await assert.rejects(() => h.start(ids[0]!), deferred('employee_busy'))
  } finally { h.controller.dispose() }
})

test('provider cooldown preserves other providers and its deadline cannot be shortened by a later signal', async () => {
  const h = harness({ executionMode: 'unlimited' })
  try {
    const state = h.company('/one', ['a', 'b'])
    h.controller.rateLimited('limited', 5000)
    h.controller.rateLimited('limited', 1000)
    await assert.rejects(() => h.start('a', '/one', 'limited'), deferred('provider_rate_limit'))
    assert.equal(h.controller.snapshot(state.id).retry_at, h.now() + 5000)
    await h.start('b', '/one', 'available')
    h.tick(4999)
    await assert.rejects(() => h.start('a', '/one', 'limited'), deferred('provider_rate_limit'))
    h.tick(1)
    await h.start('a', '/one', 'limited')
    assert.equal(h.controller.snapshot(state.id).waiting, 0)
  } finally { h.controller.dispose() }
})

test('startup observation counts already-running employees and disposal prevents subsequent admission', async () => {
  const h = harness({ maxConcurrentEmployees: 1 })
  try {
    h.live.set('resumed', { status: 'running' })
    h.company('/one', ['resumed', 'next'])
    await assert.rejects(() => h.start('next'), deferred('concurrency'))
    h.controller.dispose()
    await assert.rejects(() => h.start('next'), /disposed/)
    assert.equal(h.live.get('resumed')!.status, 'running', 'disposing admission does not abort Host-owned turns')
  } finally { h.controller.dispose() }
})

test('contexts using the same Host agent service share the controller until it is disposed', () => {
  const ctx = { agents: { get: () => undefined } } as any
  const config = resolveConfig({ executionMode: 'unlimited' })
  const first = ensureCompanyExecution(ctx, config, {})
  try {
    assert.equal(ensureCompanyExecution({ ...ctx } as any, config, {}), first)
    assert.equal(getCompanyExecution(ctx), first)
    first.dispose()
    const replacement = ensureCompanyExecution(ctx, config, {})
    assert.notEqual(replacement, first)
    replacement.dispose()
  } finally { first.dispose() }
})
