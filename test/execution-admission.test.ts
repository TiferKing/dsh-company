import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installCompanyAccounting } from '../src/accounting.js'
import { ensureCompanyExecution, type ExecutionPressure } from '../src/execution.js'
import { reserveMoneyTurn } from '../src/money.js'
import { CompanyRuntime } from '../src/runtime.js'
import { installCompanyScheduler } from '../src/scheduler.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import type { BootstrapInput, CompanyState, WorkItem } from '../src/types.js'
import { companyState } from './fixtures.js'

async function harness() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-admission-'))
  const workspace = join(base, 'workspace')
  const otherWorkspace = join(base, 'other')
  await Promise.all([mkdir(workspace), mkdir(otherWorkspace)])
  let pressure: ExecutionPressure = { memoryRatio: 0.1, lagMs: 1, pendingWrites: 0 }
  let now = Date.now()
  const live = new Map<string, any>()
  const handlers = new Map<string, Function[]>()
  const calls: Array<{ session: string; kind: 'start' | 'followup'; reserved: boolean }> = []
  const warnings: string[] = []
  const founder: any = {
    id: 'founder-session', options: { provider: 'mock', model: 'mock-model' }, steer: () => undefined,
    session: {
      header: { cwd: workspace, delegationDepth: 0 },
      requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
      deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
    },
  }
  live.set(founder.id, founder)
  const accept = async (id: unknown, kind: 'start' | 'followup') => {
    const session = String(id)
    const state = (await store.readActive(workspace))!
    const employee = state.employees.find((row) => row.sessionId === session)!
    calls.push({ session, kind, reserved: state.moneyBudget.reservations.some((row) => row.employeeId === employee.id) })
    live.set(session, { id: session, status: 'running', session: { header: { cwd: workspace } } })
  }
  const ctx: any = {
    agents: { get: (id: unknown) => live.get(String(id)) },
    llm: { resolveCallConfig: async (selection: unknown) => selection },
    subagents: {
      registerContinuableSetup: () => () => undefined,
      getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }),
      startContinuable: async (spec: any) => { await accept(spec.childId, 'start'); return { childId: spec.childId, messageId: randomUUID() } },
      followup: async (_parent: unknown, id: unknown) => { await accept(id, 'followup'); return randomUUID() },
      interrupt: () => undefined,
    },
    on: (name: string, handler: Function) => {
      const rows = handlers.get(name) ?? []
      rows.push(handler)
      handlers.set(name, rows)
      return () => { const index = rows.indexOf(handler); if (index >= 0) rows.splice(index, 1) }
    },
    logger: { warn: (warning: unknown) => warnings.push(String(warning)) },
  }
  const config = resolveConfig({ stateRoot: join(base, 'state'), executionMode: 'fixed', maxConcurrentEmployees: 1, executionRetryMs: 60_000 })
  const store = new CompanyStore(config)
  const execution = ensureCompanyExecution(ctx, config, store, { sensor: () => pressure, now: () => now })
  const runtime = new CompanyRuntime(ctx, config, store)
  let scheduler: ReturnType<typeof installCompanyScheduler> | undefined
  const initialState = async () => companyState({ workspaceHash: (await store.pathsForCwd(workspace)).workspace.sha256 })
  const occupyOtherCompany = async () => {
    const other = companyState()
    other.employees[0]!.sessionId = 'other-company-employee'
    execution.observe(other, otherWorkspace)
    await execution.run('other-company-employee', otherWorkspace, 'mock', async () => {
      live.set('other-company-employee', { status: 'running' })
    })
  }
  return {
    workspace, ctx, config, store, founder, runtime, execution, calls, warnings, live, handlers, initialState, occupyOtherCompany,
    tick: (ms: number) => { now += ms },
    releaseOtherCompany: () => live.delete('other-company-employee'),
    pressure: (next: Partial<ExecutionPressure>) => { pressure = { ...pressure, ...next } },
    scheduler: () => {
      scheduler ??= installCompanyScheduler(ctx, config, store, runtime)
      runtime.attachScheduler(scheduler)
      return scheduler
    },
    state: async () => (await store.readActive(workspace))!,
    cleanup: async () => {
      runtime.stopAdmission()
      await scheduler?.dispose?.()
      execution.dispose()
      await rm(base, { recursive: true, force: true })
    },
  }
}

function pendingWork(): WorkItem {
  return {
    id: 'w1', productId: 'p1', kind: 'design', subject: 'Prepare interface', objective: 'Produce a testable interface.',
    status: 'pending', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Interface checked'],
    verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  }
}

function designateHr(state: CompanyState): void {
  state.hrEmployeeId = 'e1'
  state.employees[0]!.isHr = true
}

test('a company waiting on another company does not claim work or spend an attempt before admission', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const state = await h.initialState()
    state.hrEmployeeId = 'e2'
    state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', name: 'HR', isHr: true, status: 'paused', sessionId: 'hr-session' })
    state.counters.employee = 2
    state.workItems.push(pendingWork())
    state.counters.work = 1
    await h.store.createStaged(h.workspace, state)
    await h.occupyOtherCompany()
    const scheduler = h.scheduler()
    await scheduler.kick(h.workspace, h.founder)
    await scheduler.kick(h.workspace, h.founder)
    const waiting = await h.state()
    assert.equal(h.calls.length, 0)
    assert.equal(waiting.workItems[0]!.attempt, 0)
    assert.equal(waiting.workItems[0]!.status, 'pending')
    assert.equal(waiting.workItems[0]!.attemptId, undefined)
    assert.equal(waiting.moneyBudget.reservations.length, 0)
    assert.equal(waiting.employees[0]!.operationalBlock, undefined)
    h.releaseOtherCompany()
    await scheduler.kick(h.workspace, h.founder)
    const accepted = await h.state()
    assert.equal(h.calls.length, 1, h.warnings.join('\n'))
    assert.equal(h.calls[0]!.reserved, true)
    assert.equal(accepted.workItems[0]!.attempt, 1)
    assert.equal(accepted.workItems[0]!.status, 'claimed')
    assert.equal(accepted.workItems[0]!.deliveryAttempts, 1)
  } finally { await h.cleanup() }
})

test('cancelling queued work removes its obsolete execution wait without releasing another company turn', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const state = await h.initialState()
    state.hrEmployeeId = 'e2'
    state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', name: 'HR', isHr: true, status: 'paused', sessionId: 'hr-session' })
    state.counters.employee = 2
    state.workItems.push(pendingWork())
    state.counters.work = 1
    await h.store.createStaged(h.workspace, state)
    await h.occupyOtherCompany()
    const scheduler = h.scheduler()
    await scheduler.kick(h.workspace, h.founder)
    assert.equal(h.execution.snapshot(state.id).waiting, 1)
    await h.store.transact(h.workspace, { actor: 'founder', type: 'test.cancelled', summary: 'Cancel queued work' }, (fresh) => {
      fresh.workItems[0]!.status = 'cancelled'
      fresh.workItems[0]!.output = 'The founder cancelled this work before dispatch.'
    })
    await scheduler.kick(h.workspace, h.founder)
    const snapshot = h.execution.snapshot(state.id)
    assert.equal(snapshot.waiting, 0)
    assert.equal(snapshot.reason, undefined)
    assert.equal(snapshot.running, 1, 'the unrelated company still owns its live turn')
    assert.equal(h.calls.length, 0)
  } finally { await h.cleanup() }
})

test('accepted idle inbox work retains its expired preparation, turn budget, and capability across scheduler and idle events', { timeout: 15_000 }, async (t) => {
  const h = await harness()
  try {
    const state = await h.initialState()
    state.hrEmployeeId = 'e2'
    state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', name: 'HR', isHr: true, status: 'paused', sessionId: 'hr-session' })
    state.employees[0]!.status = 'working'
    state.counters.employee = 2
    const work = pendingWork()
    Object.assign(work, { status: 'claimed', attempt: 1, attemptId: randomUUID(), deliveryAttempts: 0, leaseAt: 1 })
    state.workItems.push(work)
    state.counters.work = 1
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
    work.reservationId = reservationId
    await h.store.createStaged(h.workspace, state)
    const employee: any = { id: 'employee-session', status: 'idle', inbox: { nextTurn: [{ id: 'accepted-before-commit' }] },
      session: { id: 'employee-session', header: { cwd: h.workspace }, events: [] } }
    h.live.set(employee.id, employee)
    const scheduler = h.scheduler()
    await scheduler.kick(h.workspace, h.founder)
    await scheduler.kick(h.workspace, h.founder)
    let finishSync!: () => void
    const synced = new Promise<void>((resolve) => { finishSync = resolve })
    const originalTransact = h.store.transact.bind(h.store)
    t.mock.method(h.store, 'transact', async (...args: any[]) => {
      const result = await (originalTransact as any)(...args)
      if (args[1].type === 'employee.activity') finishSync()
      return result
    })
    h.handlers.get('agent/status')![0]!({ agent: employee, status: 'idle' })
    await synced
    const saved = await h.state()
    assert.equal(saved.employees[0]!.status, 'working', 'queued inbox acceptance is real activity even before status becomes running')
    assert.equal(saved.workItems[0]!.status, 'claimed')
    assert.equal(saved.workItems[0]!.attemptId, work.attemptId, 'an expired preparation cannot revoke an inbox-accepted capability')
    assert.equal(saved.workItems[0]!.attempt, 1)
    assert.equal(saved.workItems[0]!.deliveryAttempts, 0)
    assert.equal(saved.workItems[0]!.reservationId, reservationId)
    assert.equal(saved.moneyBudget.reservations[0]!.id, reservationId)
    assert.equal(saved.moneyBudget.reservations[0]!.remainingTokens, state.moneyBudget.reservations[0]!.remainingTokens)
    assert.equal(h.execution.snapshot(state.id).running, 1)
    assert.equal(h.calls.length, 0, 'neither drive passes nor an idle event may duplicate the accepted message')
  } finally { await h.cleanup() }
})

for (const entry of ['staffing', 'mail'] as const) {
  test(`${entry} uses the shared employee capacity and resumes its durable queue without a failure count`, { timeout: 15_000 }, async () => {
    const h = await harness()
    try {
      const state = await h.initialState()
      if (entry === 'staffing') {
        designateHr(state)
        state.staffingRequests.push({ id: 'sr1', action: 'hire', status: 'pending', requestedBy: 'founder', candidateName: 'Engineer',
          workProfile: 'Implement bounded work.', hrEmployeeId: 'e1', createdAt: Date.now(), updatedAt: Date.now() })
        state.counters.staffing = 1
      }
      await h.store.createStaged(h.workspace, state)
      if (entry === 'mail') await h.store.transact(h.workspace, { actor: 'test', type: 'test.message', summary: 'Queue a message' },
        async (_fresh, io) => io.writeMailbox('e1', [{ id: randomUUID(), from: 'founder', to: 'e1', content: 'Check the specification.', createdAt: Date.now(), deliveryState: 'queued' }]))
      await h.occupyOtherCompany()
      const scheduler = h.scheduler()
      await scheduler.kick(h.workspace, h.founder)
      await scheduler.kick(h.workspace, h.founder)
      const waiting = await h.state()
      assert.equal(h.calls.length, 0)
      assert.equal(waiting.moneyBudget.reservations.length, 0)
      assert.equal(waiting.employees[0]!.operationalBlock, undefined)
      if (entry === 'staffing') {
        assert.equal(waiting.staffingRequests[0]!.lastDeliveredAt, undefined)
        assert.equal(waiting.staffingRequests[0]!.attemptId, undefined)
      } else {
        const message = (await h.store.readMailbox(h.workspace, 'e1'))[0]!
        assert.equal(message.deliveryState, 'queued')
        assert.equal(message.attempts ?? 0, 0)
      }
      h.releaseOtherCompany()
      await scheduler.kick(h.workspace, h.founder)
      assert.equal(h.calls.length, 1)
      assert.equal(h.calls[0]!.reserved, true)
      if (entry === 'staffing') assert.ok((await h.state()).staffingRequests[0]!.lastDeliveredAt)
      else assert.equal((await h.store.readMailbox(h.workspace, 'e1'))[0]!.deliveryState, 'accepted')
    } finally { await h.cleanup() }
  })
}

test('direct messages wait under memory pressure and remain retryable instead of being marked budget-blocked', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.store.createStaged(h.workspace, await h.initialState())
    h.pressure({ memoryRatio: 0.99 })
    const message = await h.runtime.sendMessage(h.founder, 'e1', 'Continue after capacity becomes available.')
    assert.equal(message.deliveryState, 'queued')
    assert.equal(h.calls.length, 0)
    assert.equal((await h.state()).moneyBudget.reservations.length, 0)
    h.pressure({ memoryRatio: 0.1 })
    await h.scheduler().kick(h.workspace, h.founder)
    assert.equal(h.calls.length, 1)
    assert.equal((await h.store.readMailbox(h.workspace, 'e1'))[0]!.deliveryState, 'accepted')
  } finally { await h.cleanup() }
})

const proposal: BootstrapInput = {
  name: 'Admission Co', mission: 'Build a bounded product.', charter: 'Human approval governs the company.',
  totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'USD',
  firstProduct: { name: 'Tool', summary: 'A testable tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
  modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
}

test('an approved initial HR welcome waits durably and recovers with its budget entitlement intact', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, proposal)
    await h.occupyOtherCompany()
    const waiting = await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
    assert.equal(waiting.phase, 'provisioning')
    assert.equal(waiting.employees[0]!.status, 'provisioning')
    assert.equal(h.calls.length, 0)
    const generation = waiting.provisioning!.id
    const scheduler = h.scheduler()
    await scheduler.kick(h.workspace, h.founder)
    assert.equal((await h.state()).provisioning!.id, generation)
    h.releaseOtherCompany()
    await scheduler.kick(h.workspace, h.founder)
    const resumed = await h.state()
    assert.equal(resumed.phase, 'operating')
    assert.equal(resumed.employees[0]!.sessionId, waiting.employees[0]!.sessionId)
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]!.reserved, true, 'delayed welcome retains or reacquires a budget reservation before Host acceptance')
  } finally { await h.cleanup() }
})

test('unloaded runtime recovery cannot use the replacement controller or damage its durable provisioning', { timeout: 15_000 }, async () => {
  const h = await harness()
  let replacement: CompanyRuntime | undefined
  let releaseChildren: (() => void) | undefined
  try {
    await h.runtime.bootstrap(h.founder, proposal)
    await h.occupyOtherCompany()
    const waiting = await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
    h.releaseOtherCompany()
    let readChildren!: () => void
    const readingChildren = new Promise<void>((resolve) => { readChildren = resolve })
    h.ctx.subagents.listChildren = async () => {
      readChildren()
      await new Promise<void>((resolve) => { releaseChildren = resolve })
      return []
    }
    const obsoleteRecovery = h.runtime.recoverWorkspace(h.founder).catch((error: unknown) => error)
    await readingChildren
    h.runtime.stopAdmission()
    const controller = ensureCompanyExecution(h.ctx, h.config, h.store, { sensor: () => ({ memoryRatio: 0.1, lagMs: 1, pendingWrites: 0 }) })
    assert.notEqual(controller, h.execution)
    replacement = new CompanyRuntime(h.ctx, h.config, h.store)
    releaseChildren!()
    await obsoleteRecovery
    assert.equal(h.calls.length, 0, 'the obsolete recovery remains fenced after a new controller is registered for the same Host')
    const saved = await h.state()
    assert.equal(saved.phase, 'provisioning', 'unloading is not a provisioning failure')
    assert.equal(saved.provisioning!.id, waiting.provisioning!.id)
    assert.equal(controller.disposed, false)
    delete h.ctx.subagents.listChildren
    await replacement.recoverWorkspace(h.founder)
    assert.equal(h.calls.length, 1)
    assert.equal((await h.state()).phase, 'operating')
  } finally {
    releaseChildren?.()
    replacement?.stopAdmission()
    await h.cleanup()
  }
})

test('an approved hire remains provisioning during pressure and resumes without a second approval or identity', { timeout: 15_000 }, async () => {
  const h = await harness()
  try {
    const state = await h.initialState()
    designateHr(state)
    await h.store.createStaged(h.workspace, state)
    const hr: any = { id: 'employee-session', status: 'idle', session: { header: { cwd: h.workspace } } }
    h.live.set(hr.id, hr)
    const request = await h.runtime.requestStaffing(h.founder, { action: 'hire', candidateName: 'New Engineer', workProfile: 'Implement bounded work.' })
    const claim = await h.runtime.claimStaffingAssessment(hr, request.id)
    const recommendation = await h.runtime.submitStaffingAssessment(hr, { requestId: request.id, attemptId: claim.attemptId,
      difficulty: 'low', provider: 'mock', model: 'mock-model', budgetMicros: 1_000_000, rationale: 'Fits the implementation scope.',
      orgPath: ['Engineering'], positionTitle: 'Engineer', responsibilities: ['Implement bounded work'] })
    await h.runtime.resolveApproval(h.founder, { approvalId: recommendation.approvalId!, decision: 'approved', humanStatement: 'Approve the recommended hire.' }, 'ui')
    await h.occupyOtherCompany()
    const hired = await h.runtime.addEmployee(h.founder, { name: 'New Engineer', role: 'Engineer', staffingRequestId: request.id, approvalId: recommendation.approvalId! })
    assert.equal(hired.status, 'provisioning')
    assert.equal(h.calls.length, 0)
    const scheduler = h.scheduler()
    await scheduler.kick(h.workspace, h.founder)
    const waiting = await h.state()
    assert.equal(waiting.employees.length, 2)
    assert.equal(waiting.employees[1]!.status, 'provisioning')
    assert.equal(waiting.staffingRequests[0]!.status, 'approved')
    assert.ok(waiting.approvals.find((row) => row.id === recommendation.approvalId)!.consumedAt)
    h.releaseOtherCompany()
    await scheduler.kick(h.workspace, h.founder)
    const resumed = await h.state()
    assert.equal(resumed.employees.length, 2)
    assert.equal(resumed.employees[1]!.sessionId, hired.sessionId)
    assert.equal(resumed.staffingRequests[0]!.status, 'applied')
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]!.reserved, true)
  } finally { await h.cleanup() }
})

test('an exhausted Host rate limit keeps the open attempt and automatically recovers after provider cooldown', { timeout: 15_000 }, async () => {
  const h = await harness()
  let disposeAccounting: (() => Promise<void>) | undefined
  try {
    const state = await h.initialState()
    state.hrEmployeeId = 'e2'
    state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', name: 'HR', isHr: true, status: 'paused', sessionId: 'hr-session' })
    state.employees[0]!.status = 'working'
    state.counters.employee = 2
    const work = pendingWork()
    Object.assign(work, { status: 'in_progress', attempt: 1, attemptId: randomUUID(), deliveryAttempts: 1, output: 'Partially checked interface.' })
    state.workItems.push(work)
    state.counters.work = 1
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
    await h.store.createStaged(h.workspace, state)
    const employee: any = { id: 'employee-session', status: 'running', session: { id: 'employee-session', header: { cwd: h.workspace }, events: [] } }
    h.live.set(employee.id, employee)
    const scheduler = h.scheduler()
    disposeAccounting = installCompanyAccounting(h.ctx, h.store, h.config)
    await h.handlers.get('agent/request-error')![0]!({ agent: employee, turn: 1, step: 2,
      failure: { code: 'RATE_LIMIT', message: 'Request retries exhausted.' } }, async () => undefined)
    let saved = await h.state()
    assert.equal(saved.phase, 'operating')
    assert.equal(saved.employees[0]!.operationalBlock, undefined)
    assert.equal(saved.workItems[0]!.status, 'in_progress')
    assert.equal(saved.workItems[0]!.attemptId, work.attemptId)
    assert.equal(saved.workItems[0]!.output, work.output)
    employee.status = 'idle'
    await scheduler.kick(h.workspace, h.founder)
    assert.equal(h.calls.length, 0)
    assert.equal(h.execution.snapshot(state.id).reason, 'provider_rate_limit')
    saved = await h.state()
    assert.equal(saved.workItems[0]!.deliveryAttempts, 1, 'cooldown is not a failed delivery')
    h.tick(60_001)
    await scheduler.kick(h.workspace, h.founder)
    saved = await h.state()
    assert.equal(h.calls.length, 1)
    assert.equal(h.calls[0]!.reserved, true)
    assert.equal(saved.workItems[0]!.attemptId, work.attemptId)
    assert.equal(saved.workItems[0]!.attempt, 1)
    assert.equal(saved.workItems[0]!.deliveryAttempts, 2)
    assert.equal(saved.employees[0]!.operationalBlock, undefined)
  } finally {
    await disposeAccounting?.()
    await h.cleanup()
  }
})
