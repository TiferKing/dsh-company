import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { installCompanyScheduler } from '../src/scheduler.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { releaseEmployeeMoneyReservations, reserveMoneyTurn } from '../src/money.js'
import type { CompanyMessage, CompanyState } from '../src/types.js'
import { companyState } from './fixtures.js'

test('a disappeared continuable can cold-recover the same open attempt repeatedly', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } } as any
    let followups = 0
    let employeeLive: { status: string } | undefined
    const ctx = {
      agents: {
        get(id: unknown) {
          return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined
        },
      },
      subagents: {
        followup: async () => {
          followups += 1
          employeeLive = { status: 'running' }
          return `message-${followups}`
        },
      },
      logger: { warn: () => undefined },
      on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'working'
    state.workItems.push({
      id: 'w1',
      productId: 'p1',
      kind: 'design',
      subject: 'Recover design',
      objective: 'Keep the same attempt capability across cold recovery.',
      status: 'in_progress',
      assigneeId: 'e1',
      dependencies: [],
      inScope: [],
      outOfScope: [],
      acceptance: ['Same capability retained'],
      verify: [],
      deliverables: [],
      attempt: 1,
      attemptId: '550e8400-e29b-41d4-a716-446655440000',
      attemptHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    employeeLive = undefined // simulate the accepted activation disappearing before the next drive
    await scheduler.kick(workspace, founder)

    const saved = await store.readActive(workspace)
    assert.equal(followups, 2)
    assert.equal(saved?.workItems[0]?.attemptId, '550e8400-e29b-41d4-a716-446655440000')
    assert.equal(saved?.workItems[0]?.status, 'in_progress')
    assert.equal(saved?.moneyBudget.usage.length, 0)
    assert.equal(saved?.moneyBudget.reservations[0]?.remainingTokens, 128_000, 'accepted turn entitlement stays reserved until idle')
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('expired prepared work releases its reservation and restores an unoccupied employee to idle', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-expired-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => undefined } as any
    const employeeLive = { status: 'ready' }
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined } },
      subagents: { followup: async () => undefined }, logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'working'
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Expired prepare', objective: 'Recover a crash-left prepare.',
      status: 'claimed', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Recovered'], verify: [], deliverables: [],
      attempt: 1, attemptId: '550e8400-e29b-41d4-a716-446655440000', deliveryAttempts: 0, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
    state.workItems[0]!.reservationId = reservationId
    state.workItems[0]!.leaseAt = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.workItems[0]?.status, 'pending')
    assert.equal(saved?.workItems[0]?.attempt, 0)
    assert.equal(saved?.employees[0]?.status, 'idle')
    assert.equal(saved?.moneyBudget.reservations.length, 0)
    assert.equal(saved?.moneyBudget.reservedMicros, 0)
    scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an expired preparation does not fence a child already running the assignment', async () => {
  await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder }) => {
    state.workItems[0]!.status = 'claimed'
    state.workItems[0]!.deliveryAttempts = 0
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
    state.workItems[0]!.reservationId = reservationId
    state.workItems[0]!.leaseAt = 1
    await store.createStaged(workspace, state)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.workItems[0]?.status, 'claimed')
    assert.equal(saved?.workItems[0]?.attemptId, state.workItems[0]!.attemptId)
    assert.equal(saved?.moneyBudget.reservations[0]?.id, reservationId)
    assert.equal(saved?.employees[0]?.status, 'working')
  }, { liveStatus: 'running' })
})

test('an expired recovery preparation preserves the accepted attempt and its progress', async () => {
  await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder }) => {
    state.workItems[0]!.output = 'Partial result from the accepted turn.'
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
    state.workItems[0]!.reservationId = reservationId
    state.workItems[0]!.leaseAt = 1
    await store.createStaged(workspace, state)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.workItems[0]?.status, 'in_progress')
    assert.equal(saved?.workItems[0]?.attemptId, state.workItems[0]!.attemptId)
    assert.equal(saved?.workItems[0]?.output, state.workItems[0]!.output)
    assert.equal(saved?.workItems[0]?.deliveryAttempts, 2)
  })
})

test('paused employee attempts are not recovered or silently reset to idle', async () => {
  await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder, deliveries }) => {
    state.employees[0]!.status = 'paused'
    await store.createStaged(workspace, state)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(deliveries.length, 0)
    assert.equal(saved?.employees[0]?.status, 'paused')
    assert.equal(saved?.workItems[0]?.attemptId, state.workItems[0]!.attemptId)
  })
})

test('a stale idle event cannot release the replacement employee session reservation', async () => {
  const beforeReplacement = companyState()
  const current = structuredClone(beforeReplacement)
  current.employees[0]!.sessionId = 'replacement-session'
  current.employees[0]!.status = 'working'
  const reservationId = reserveMoneyTurn(current, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  let statusHandler!: (event: { agent: any; status: 'idle' }) => void
  let committed!: () => void
  const transactionFinished = new Promise<void>((resolve) => { committed = resolve })
  const store = {
    readActive: async () => structuredClone(beforeReplacement),
    transact: async (_cwd: string, _meta: unknown, operation: (state: CompanyState) => void) => {
      operation(current)
      committed()
      return { state: current }
    },
  } as unknown as CompanyStore
  const ctx = {
    on: (_name: string, callback: typeof statusHandler) => { statusHandler = callback },
    logger: { warn: () => undefined },
  } as any
  const scheduler = installCompanyScheduler(ctx, resolveConfig({}), store)
  statusHandler({ agent: { id: 'employee-session', session: { header: { cwd: '/workspace' } } }, status: 'idle' })
  await transactionFinished
  await scheduler.dispose?.()
  assert.equal(current.employees[0]!.status, 'working')
  assert.equal(current.moneyBudget.reservations[0]?.id, reservationId)
})

test('scheduler disposal aborts an in-flight model reprobe without retry or warning', { timeout: 10_000 }, async (t) => {
  const timers = t.mock.method(globalThis, 'setTimeout')
  const state = companyState({ employees: [] })
  state.modelCatalog.stale = true
  const founder = { id: state.founderSessionId, session: { header: { cwd: '/workspace' } } } as any
  const warnings: string[] = []
  let observedSignal: AbortSignal | undefined
  let probeStarted!: () => void
  const started = new Promise<void>((resolve) => { probeStarted = resolve })
  const store = {
    pathsForCwd: async () => ({ workspace: { key: 'workspace' } }),
    readActive: async () => state,
  } as unknown as CompanyStore
  const ctx = { agents: { get: () => founder }, logger: { warn: (message: string) => warnings.push(message) }, on: () => () => undefined } as any
  const scheduler = installCompanyScheduler(ctx, resolveConfig({}), store, {
    recoverWorkspace: async () => undefined,
    reprobeModels: async (_founder, _revision, signal) => {
      observedSignal = signal
      probeStarted()
      return new Promise<never>((_resolve, reject) => {
        signal?.addEventListener('abort', () => reject(signal.reason), { once: true })
      })
    },
  })
  const driving = scheduler.kick('/workspace', founder)
  await started
  await scheduler.dispose?.()
  await driving
  assert.equal(observedSignal?.aborted, true)
  assert.deepEqual(warnings, [])
  assert.equal(timers.mock.calls.some((call) => call.arguments[1] === 30_000), false)
})

test('a transient model reprobe failure schedules a later retry', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  const state = companyState({ employees: [] })
  state.modelCatalog.stale = true
  const founder = { id: state.founderSessionId, session: { header: { cwd: '/workspace' } } } as any
  let probes = 0
  let retried!: () => void
  const secondProbe = new Promise<void>((resolve) => { retried = resolve })
  const store = {
    pathsForCwd: async () => ({ workspace: { key: 'workspace' } }),
    readActive: async () => state,
  } as unknown as CompanyStore
  const ctx = { agents: { get: () => founder }, logger: { warn: () => undefined }, on: () => () => undefined } as any
  const scheduler = installCompanyScheduler(ctx, resolveConfig({}), store, {
    recoverWorkspace: async () => undefined,
    reprobeModels: async () => {
      probes += 1
      if (probes === 1) throw new Error('Temporary model registry failure')
      state.modelCatalog.stale = false
      retried()
      return state.modelCatalog
    },
  })
  await scheduler.kick('/workspace', founder)
  t.mock.timers.tick(30_001)
  await secondProbe
  await scheduler.dispose?.()
  assert.equal(probes, 2)
})

test('a transient delivery failure retries without a new Host event', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let retried!: () => void
  const secondDelivery = new Promise<void>((resolve) => { retried = resolve })
  await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder, deliveries }) => {
    await store.createStaged(workspace, state)
    await scheduler.kick(workspace, founder)
    assert.equal(deliveries.length, 1)
    t.mock.timers.tick(30_001)
    await secondDelivery
    assert.equal(deliveries.length, 2)
  }, { transientFailures: 1, onDelivery: (count) => { if (count === 2) retried() } })
})

test('an unclaimed HR request is delivered again when its cooldown expires', { timeout: 10_000 }, async (t) => {
  t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
  let redelivered!: () => void
  const secondDelivery = new Promise<void>((resolve) => { redelivered = resolve })
  await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder, deliveries }) => {
    state.workItems = []
    state.employees[0]!.status = 'idle'
    state.employees[0]!.isHr = true
    state.employees[1]!.isHr = false
    state.hrEmployeeId = 'e1'
    state.staffingRequests.push({ id: 'sr1', action: 'hire', status: 'pending', requestedBy: 'founder', candidateName: 'Engineer', workProfile: 'Build.', hrEmployeeId: 'e1', createdAt: Date.now(), updatedAt: Date.now() })
    state.counters.staffing = 1
    await store.createStaged(workspace, state)
    await scheduler.kick(workspace, founder)
    assert.equal(deliveries.length, 1)
    // The accepted HR turn ended without claiming the request. Mirror the
    // Host idle accounting before advancing time without another event.
    await store.transact(workspace, { actor: 'scheduler', type: 'test.idle', summary: 'HR turn ended without a claim' }, (fresh) => {
      releaseEmployeeMoneyReservations(fresh, 'e1')
    })
    t.mock.timers.tick(5 * 60_000 + 1)
    await secondDelivery
    assert.equal(deliveries.length, 2)
  }, { onDelivery: (count) => { if (count === 2) redelivered() } })
})

test('scheduler disposal clears its pending retry timer', async (t) => {
  const timers = t.mock.method(globalThis, 'setTimeout')
  const cleared = t.mock.method(globalThis, 'clearTimeout')
  await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder, deliveries }) => {
    await store.createStaged(workspace, state)
    await scheduler.kick(workspace, founder)
    const retry = timers.mock.calls.find((call) => call.arguments[1] === 30_000)?.result
    assert.notEqual(retry, undefined)
    await scheduler.dispose?.()
    assert.ok(cleared.mock.calls.some((call) => call.arguments[0] === retry))
    assert.equal(deliveries.length, 1)
  }, { transientFailures: 1 })
})

for (const stoppedBy of ['pause', 'archive', 'founder_unload'] as const) {
  test(`a scheduled retry does not dispatch after ${stoppedBy}`, { timeout: 10_000 }, async (t) => {
    t.mock.timers.enable({ apis: ['setTimeout', 'Date'], now: Date.now() })
    let founderLive = true
    await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder, deliveries }) => {
      await store.createStaged(workspace, state)
      await scheduler.kick(workspace, founder)
      assert.equal(deliveries.length, 1)
      if (stoppedBy === 'pause') await store.transact(workspace, { actor: 'founder', type: 'test.paused', summary: 'Pause before retry' }, (fresh) => {
        fresh.phase = 'paused'
        fresh.employees[0]!.status = 'paused'
        fresh.health = { status: 'manual_pause', reason: 'manual', detail: 'Pause before retry', detectedAt: Date.now(), resumable: true }
      })
      if (stoppedBy === 'founder_unload') founderLive = false
      let readOnWake!: () => void
      const wakeRead = new Promise<void>((resolve) => { readOnWake = resolve })
      const originalRead = store.readActive.bind(store)
      t.mock.method(store, 'readActive', async (...args: Parameters<typeof store.readActive>) => {
        const active = stoppedBy === 'archive' ? undefined : await originalRead(...args)
        readOnWake()
        return active
      })
      t.mock.timers.tick(30_001)
      await wakeRead
      await scheduler.dispose?.()
      assert.equal(deliveries.length, 1)
    }, { transientFailures: 1, hasFounder: () => founderLive })
  })
}

for (const subject of ['work', 'staffing'] as const) {
  test(`an unrecoverable ${subject} session stops automatic recovery retries`, async () => {
    await withSchedulerScenario(async ({ state, store, workspace, scheduler, founder, deliveries }) => {
      if (subject === 'staffing') {
        state.workItems = []
        state.employees[0]!.isHr = true
        state.employees[1]!.isHr = false
        state.hrEmployeeId = 'e1'
        state.staffingRequests.push({ id: 'sr1', action: 'hire', status: 'in_review', requestedBy: 'founder', candidateName: 'Engineer', workProfile: 'Build.', hrEmployeeId: 'e1', attemptId: '550e8400-e29b-41d4-a716-446655440030', reviewDeliveryAttempts: 1, createdAt: Date.now(), updatedAt: Date.now() })
        state.counters.staffing = 1
      } else state.supportEmployeeId = 'e1'
      await store.createStaged(workspace, state)
      await scheduler.kick(workspace, founder)
      await scheduler.kick(workspace, founder)
      const saved = await store.readActive(workspace)
      assert.equal(deliveries.length, 1)
      assert.equal(saved?.employees[0]?.status, 'failed')
      assert.equal(saved?.employees[0]?.operationalBlock?.kind, 'session_unrecoverable')
      assert.equal(saved?.supportEmployeeId, undefined)
      assert.equal(saved?.moneyBudget.reservations.length, 0)
    }, { failDelivery: true })
  })
}

async function withSchedulerScenario(
  run: (scenario: {
    state: CompanyState
    store: CompanyStore
    workspace: string
    scheduler: ReturnType<typeof installCompanyScheduler>
    founder: any
    deliveries: string[]
  }) => Promise<void>,
  options: { liveStatus?: string; failDelivery?: boolean; transientFailures?: number; onDelivery?: (count: number) => void; hasFounder?: () => boolean } = {},
): Promise<void> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-scenario-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => undefined } as any
  const live = { status: options.liveStatus ?? 'idle' }
  const deliveries: string[] = []
  const ctx = {
    agents: { get(id: unknown) { return String(id) === founder.id ? options.hasFounder?.() === false ? undefined : founder : String(id) === 'employee-session' ? live : undefined } },
    subagents: { followup: async (_founder: unknown, _id: unknown, content: Array<{ text: string }>) => {
      deliveries.push(content[0]!.text)
      options.onDelivery?.(deliveries.length)
      if (deliveries.length <= (options.transientFailures ?? 0)) throw new Error('Transient transport failure')
      if (options.failDelivery) throw new SubagentError('The saved session is missing.', 'NOT_RESUMABLE')
    } },
    logger: { warn: () => undefined }, on: () => () => undefined,
  } as any
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const paths = await store.pathsForCwd(workspace)
  const state = companyState({ workspaceHash: paths.workspace.sha256 })
  state.employees[0]!.status = 'working'
  state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', isHr: true, status: 'paused', sessionId: 'hr-session' })
  state.hrEmployeeId = 'e2'
  state.counters.employee = 2
  state.workItems.push({
    id: 'w1', productId: 'p1', kind: 'design', subject: 'Recover', objective: 'Preserve the current attempt.', status: 'in_progress', assigneeId: 'e1',
    dependencies: [], inScope: [], outOfScope: [], acceptance: ['Preserved'], verify: [], deliverables: [], attempt: 1,
    attemptId: '550e8400-e29b-41d4-a716-446655440000', deliveryAttempts: 1, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  })
  state.counters.work = 1
  const scheduler = installCompanyScheduler(ctx, config, store)
  try {
    await run({ state, store, workspace, scheduler, founder, deliveries })
  } finally {
    await scheduler.dispose?.()
    await rm(base, { recursive: true, force: true })
  }
}

test('an interrupted in-review HR assessment cold-recovers the same capability', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-staffing-recovery-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let followups = 0
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => undefined } as any
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : undefined } },
      subagents: { followup: async () => { followups += 1; return 'message' } }, logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.isHr = true
    state.hrEmployeeId = 'e1'
    state.staffingRequests.push({
      id: 'sr1', action: 'hire', status: 'in_review', requestedBy: 'founder', candidateName: 'Engineer', workProfile: 'Build.',
      hrEmployeeId: 'e1', attemptId: '550e8400-e29b-41d4-a716-446655440030', reviewDeliveryAttempts: 1, createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.staffing = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(followups, 1)
    assert.equal(saved?.staffingRequests[0]?.status, 'in_review')
    assert.equal(saved?.staffingRequests[0]?.attemptId, '550e8400-e29b-41d4-a716-446655440030')
    assert.equal(saved?.staffingRequests[0]?.reviewDeliveryAttempts, 2)
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('expired prepared staffing delivery releases its durable reservation pointer', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-staffing-lease-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => undefined } as any
    const employeeLive = { status: 'ready' }
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined } },
      subagents: { followup: async () => undefined }, logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.isHr = true
    state.hrEmployeeId = 'e1'
    state.employees[0]!.status = 'working'
    state.staffingRequests.push({ id: 'sr1', action: 'hire', status: 'pending', requestedBy: 'founder', candidateName: 'Engineer', workProfile: 'Build.', hrEmployeeId: 'e1', createdAt: Date.now(), updatedAt: Date.now() })
    state.counters.staffing = 1
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', staffingRequestId: 'sr1' })
    state.staffingRequests[0]!.reservationId = reservationId
    state.staffingRequests[0]!.leaseAt = Date.now() - 120_000
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.staffingRequests[0]?.reservationId, undefined)
    assert.equal(saved?.moneyBudget.reservations.length, 0)
    assert.equal(saved?.employees[0]?.status, 'idle')
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('failed cold recovery releases the newly created reservation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-recovery-fail-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => undefined } as any
    const employeeLive = { status: 'idle' }
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined } },
      subagents: { followup: async () => { throw new Error('followup failed') } }, logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'working'
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Recover failure', objective: 'Release failed recovery reservation.',
      status: 'in_progress', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Retryable'], verify: [], deliverables: [],
      attempt: 1, attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.workItems[0]?.attemptId, '550e8400-e29b-41d4-a716-446655440000')
    assert.equal(saved?.workItems[0]?.reservationId, undefined)
    assert.equal(saved?.employees[0]?.status, 'idle')
    assert.equal(saved?.moneyBudget.reservations.length, 0)
    assert.equal(saved?.moneyBudget.reservedMicros, 0)
    scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('scheduler dispose aborts an in-flight followup and prevents acceptance commit', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-dispose-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => undefined } as any
    const employeeLive = { status: 'idle' }
    let observedSignal: AbortSignal | undefined
    let followupStarted!: () => void
    const started = new Promise<void>((resolve) => { followupStarted = resolve })
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined } },
      subagents: {
        followup: async (_founder: unknown, _id: unknown, _messages: unknown, options: { signal: AbortSignal }) => {
          observedSignal = options.signal
          followupStarted()
          await new Promise<void>((_resolve, reject) => options.signal.addEventListener('abort', () => reject(options.signal.reason), { once: true }))
        },
      },
      logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees.push({
      ...state.employees[0]!, id: 'e2', name: 'HR Lead', isHr: true, status: 'paused', sessionId: 'hr-session',
    })
    state.hrEmployeeId = 'e2'
    state.counters.employee = 2
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Dispose followup', objective: 'Abort on scheduler disposal.',
      status: 'pending', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Aborted'], verify: [], deliverables: [],
      attempt: 0, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    const driving = scheduler.kick(workspace, founder)
    await started
    scheduler.dispose?.()
    await driving
    assert.equal(observedSignal?.aborted, true)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.workItems[0]?.status, 'claimed')
    assert.notEqual(saved?.workItems[0]?.reservationId, undefined, 'prepared lease remains for startup recovery')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an attempt stops after three accepted prompts without a terminal update', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-supervision-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let steers = 0
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => { steers += 1 } } as any
    const employeeLive = { status: 'idle' }
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined } },
      subagents: { followup: async () => { throw new Error('must not deliver a fourth prompt') } }, logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'idle'
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Unresponsive attempt', objective: 'Require a terminal update.',
      status: 'in_progress', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Report'], verify: [], deliverables: [],
      attempt: 1, attemptId: '550e8400-e29b-41d4-a716-446655440020', deliveryAttempts: 3, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.workItems[0]?.status, 'failed')
    assert.equal(saved?.workItems[0]?.attemptHistory.length, 1)
    assert.equal(saved?.employees[0]?.status, 'idle')
    assert.equal(steers, 1)
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('budget-blocked messages remain deliverable after replenishment without consuming retries', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-message-dead-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let steers = 0
    let followups = 0
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } }, steer: () => { steers += 1 } } as any
    const employeeLive = { status: 'idle' }
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined } },
      subagents: { followup: async () => { followups += 1 }, interrupt: () => undefined }, logger: { warn: () => undefined }, on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.totalMicros = 0
    state.moneyBudget.warningAtMicros = 1
    state.products[0]!.budgetMicros = 0
    state.employees[0]!.budgetMicros = 0
    state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, source: 'manual', revision: 1, updatedAt: Date.now() }]
    await store.createStaged(workspace, state)
    const message: CompanyMessage = {
      id: '550e8400-e29b-41d4-a716-446655440001', from: 'founder', to: 'e1', content: 'Queued message', createdAt: Date.now(), deliveryState: 'queued',
    }
    await store.transact(workspace, { actor: 'founder', type: 'test.message', summary: 'Queue test message' }, async (_fresh, io) => {
      await io.writeMailbox('e1', [message])
    })

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    await scheduler.kick(workspace, founder)
    await scheduler.kick(workspace, founder)
    const messages = await store.readMailbox(workspace, 'e1')
    assert.equal(messages[0]?.deliveryState, 'held_budget')
    assert.equal(messages[0]?.attempts, undefined)
    assert.equal(messages[0]?.reservationId, undefined)
    assert.equal(steers, 0)
    assert.equal(followups, 0)
    await store.transact(workspace, { actor: 'founder', type: 'test.replenished', summary: 'Replenish and resume' }, (fresh) => {
      fresh.moneyBudget.totalMicros = 100_000_000
      fresh.products[0]!.budgetMicros = 100_000_000
      fresh.employees[0]!.budgetMicros = 100_000_000
      fresh.employees[0]!.operationalBlock = undefined
      fresh.employees[0]!.status = 'idle'
      fresh.phase = 'operating'
      fresh.health = { status: 'healthy', resumable: true }
    })
    await scheduler.kick(workspace, founder)
    assert.equal(followups, 1)
    assert.equal((await store.readMailbox(workspace, 'e1'))[0]?.deliveryState, 'accepted')
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
