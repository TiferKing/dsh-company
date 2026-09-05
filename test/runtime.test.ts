import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { createApproval } from '../src/approvals.js'
import { reserveMoneyTurn } from '../src/money.js'
import { approvedTemporaryAuthorization, companyState } from './fixtures.js'

test('reassignment finishes its durable handoff even when idle waiting is cancelled', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-runtime-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    const employeeAgent = {
      id: 'employee-session',
      status: 'running',
      whenIdle: async () => undefined,
    }
    const ctx = {
      agents: {
        get(id: unknown) {
          const value = String(id)
          if (value === 'founder-session') return founder
          if (value === 'employee-session') return employeeAgent
          return undefined
        },
      },
      subagents: {
        registerContinuableSetup: () => () => undefined,
        interrupt: () => undefined,
      },
      logger: { warn: () => undefined },
    } as any
    founder = {
      id: 'founder-session',
      session: { header: { cwd: workspace } },
    }

    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'working'
    state.workItems.push({
      id: 'w1',
      productId: 'p1',
      kind: 'design',
      subject: 'Open design',
      objective: 'Exercise a cancellation-safe handoff.',
      status: 'in_progress',
      assigneeId: 'e1',
      dependencies: [],
      inScope: [],
      outOfScope: [],
      acceptance: ['Handoff completes'],
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

    const runtime = new CompanyRuntime(ctx, config, store)
    const abort = new AbortController()
    abort.abort(new Error('handoff wait cancelled'))
    const reassigned = await runtime.reassignWork(founder, 'w1', 'founder', 'Founder takeover', abort.signal)
    assert.equal(reassigned.assigneeId, 'founder', 'best-effort idle wait failure must not report a false failed reassignment')

    const saved = await store.readActive(workspace)
    const work = saved?.workItems[0]
    assert.equal(work?.status, 'pending')
    assert.equal(work?.assigneeId, 'founder')
    assert.equal(work?.attemptId, undefined)
    assert.equal(work?.reassigning, false)
    assert.equal(work?.attemptHistory[0]?.status, 'cancelled')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('provisioning retry keeps accepted employees and fences deterministic turn reservations', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-provisioning-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let startCalls = 0
    const requestedDepths: number[] = []
    let founder: any
    const ctx = {
      agents: {
        get(id: unknown) {
          return String(id) === 'founder-session' ? founder : undefined
        },
      },
      llm: {
        resolveCallConfig: async (selection: { provider: string; model: string; reasoningEffort?: string }) => selection,
      },
      subagents: {
        registerContinuableSetup: () => () => undefined,
        getProvider: () => ({
          prepareContinuable: () => undefined,
          capabilities: { persona: true, toolFilter: true, depthLimit: true },
        }),
        startContinuable: async (spec: { childId: string; request: { maxDepth: number } }) => {
          startCalls += 1
          requestedDepths.push(spec.request.maxDepth)
          if (startCalls === 2) throw new Error('synthetic second employee start failure')
          return { childId: spec.childId, messageId: `message-${startCalls}` }
        },
        interrupt: () => undefined,
      },
      logger: { warn: () => undefined },
    } as any
    founder = {
      id: 'founder-session',
      session: { header: { cwd: workspace } },
    }

    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({
      workspaceHash: paths.workspace.sha256,
      phase: 'staged',
      approvedAt: undefined,
    })
    state.employees[0]!.status = 'planned'
    state.employees[0]!.sessionId = undefined
    state.employees[0]!.joinedAt = undefined
    state.employees.push({
      id: 'e2',
      name: 'Reviewer',
      role: 'QA Reviewer',
      status: 'planned',
      llm: { provider: 'mock', model: 'mock-model', activeProvider: 'mock', activeModel: 'mock-model' },
    })
    state.counters.employee = 2
    state.products[0]!.status = 'approved'
    state.workItems.push({
      id: 'w1',
      productId: 'p1',
      kind: 'design',
      subject: 'Plan retry',
      objective: 'Keep onboarding idempotent across a partial provisioning failure.',
      status: 'pending',
      dependencies: [],
      inScope: [],
      outOfScope: [],
      acceptance: ['Both employees are provisioned once'],
      verify: [],
      deliverables: [],
      attempt: 0,
      attemptHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const runtime = new CompanyRuntime(ctx, config, store)
    const failed = await runtime.approveBootstrap(founder, 'Approved and start the company.', { source: 'ui' })
    assert.equal(failed.phase, 'provisioning_failed')
    assert.equal(failed.employees[0]?.status, 'idle')
    assert.equal(failed.employees[1]?.status, 'failed')
    assert.equal(failed.moneyBudget.usage.length, 0)
    assert.equal(failed.moneyBudget.reservations.length, 0)
    const firstSession = failed.employees[0]?.sessionId
    const edited = await runtime.editFormation(founder, { hrName: 'Recovered HR Lead' })
    assert.equal(edited.employees[0]?.name, 'Recovered HR Lead', 'provisioning failure reopens the formation, including HR settings')

    const operating = await runtime.approveBootstrap(founder, 'Approved retry and start.', { source: 'ui' })
    assert.equal(operating.phase, 'operating')
    assert.equal(operating.employees[0]?.sessionId, firstSession)
    assert.deepEqual(operating.employees.map((employee) => employee.status), ['idle', 'idle'])
    assert.equal(operating.moneyBudget.usage.length, 0)
    assert.equal(operating.moneyBudget.reservations[0]?.remainingTokens, 128_000, 'a newly accepted turn stays entitled (context-window sized) until the employee becomes idle')
    assert.equal(startCalls, 3)
    assert.deepEqual(requestedDepths, [1, 1, 1], 'legacy maxDepth 0 is clamped for direct employees')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('startup recovery adopts a durable child and completes an interrupted bootstrap generation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-provisioning-recovery-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    let starts = 0
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : undefined } },
      subagents: {
        registerContinuableSetup: () => () => undefined,
        listChildren: async () => [{ kind: 'child', id: 'employee-session', mode: 'continuable', label: '', activity: 'inactive', hasChildren: false }],
        startContinuable: async () => { starts += 1; throw new Error('existing durable child must be adopted') },
        interrupt: () => undefined,
      },
      logger: { warn: () => undefined },
    } as any
    founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256, phase: 'provisioning' })
    state.products[0]!.status = 'approved'
    state.employees[0]!.status = 'provisioning'
    const approval = createApproval(state, 'founder', { kind: 'bootstrap', summary: 'Approve formation', payload: { companyId: state.id, stagedRevision: 1 } })
    approval.status = 'approved'
    approval.resolvedAt = Date.now()
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    state.provisioning = { id: '11111111-1111-4111-8111-111111111111', startedAt: Date.now(), approvalId: approval.id, employeeIds: ['e1'], reservationIds: [reservationId] }
    await store.createStaged(workspace, state)
    ;(ctx.subagents as any).listChildren = async () => [{
      kind: 'child', id: 'employee-session', mode: 'continuable', label: `dsh-company:${state.id}:e1`, activity: 'inactive', hasChildren: false,
    }]

    const runtime = new CompanyRuntime(ctx, config, store)
    await runtime.recoverWorkspace(founder)
    const recovered = await store.readActive(workspace)
    assert.equal(recovered?.phase, 'operating')
    assert.equal(recovered?.employees[0]?.status, 'idle')
    assert.equal(recovered?.provisioning, undefined)
    assert.equal(starts, 0)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('public Web status is readonly and cannot project participant capabilities or private evidence', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-runtime-public-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    const employeeAgent = { id: 'employee-session', status: 'idle', session: { header: { cwd: workspace } } }
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeAgent : undefined } },
      subagents: { registerContinuableSetup: () => () => undefined, interrupt: () => undefined },
      logger: { warn: () => undefined },
    } as any
    founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.failure = 'private employee failure detail'
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Private evidence work', objective: 'Keep execution evidence participant-scoped.',
      status: 'completed', assigneeId: 'e1', dependencies: [], approvalDependencies: [], inScope: ['src/**'], outOfScope: [],
      acceptance: ['Private acceptance'], verify: ['private verify command'], deliverables: ['private deliverable'], attempt: 1, attemptHistory: [],
      evidence: { changedPaths: ['src/private.ts'], acceptanceResults: ['private result'], commandsRun: ['private command'] },
      output: 'Bounded public output.', createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    createApproval(state, 'founder', { kind: 'budget_change', summary: 'Private pending approval', payload: { newTotalMicros: 100_000_000, expectedTotalMicros: 100_000_000 } })
    const now = Date.now()
    approvedTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Private authorization reason', expiresAt: now + 60_000 }, { maxMs: 120_000 }, now)
    await store.createStaged(workspace, state)

    const runtime = new CompanyRuntime(ctx, config, store)
    const snapshot = await runtime.webPublicStatus(founder)
    assert.deepEqual(snapshot.viewer, { role: 'employee', participant_id: 'web-readonly', permissions: [] })
    assert.equal(snapshot.company.founder_session_id, undefined)
    assert.equal(snapshot.inbox.length, 0)
    assert.equal(snapshot.approvals.length, 0)
    assert.equal(snapshot.temporary_authorizations.length, 0)
    assert.equal(snapshot.employees[0]?.session_id, undefined)
    assert.equal(snapshot.employees[0]?.failure, undefined)
    const work = snapshot.work.find((item) => item.id === 'w1')!
    for (const key of ['acceptance', 'verify', 'deliverables', 'changed_paths', 'acceptance_results', 'commands_run']) assert.equal(key in work, false)
    assert.equal((await store.readActive(workspace))?.founderSessionId, 'founder-session', 'public projection must not mutate durable state')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('only an applied governance approval creates a durable employee notification', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-runtime-governance-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    const ctx = {
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : undefined } },
      subagents: { registerContinuableSetup: () => () => undefined, interrupt: () => undefined },
      logger: { warn: () => undefined },
    } as any
    founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    const first = createApproval(state, 'founder', {
      kind: 'governance_change', summary: 'Update the operating mission.',
      payload: { expectedGovernanceRevision: 1, mission: 'Approved mission revision two.' },
    })
    const stale = createApproval(state, 'founder', {
      kind: 'governance_change', summary: 'Competing stale charter edit.',
      payload: { expectedGovernanceRevision: 1, charter: 'This stale charter must never apply.' },
    })
    await store.createStaged(workspace, state)
    const runtime = new CompanyRuntime(ctx, config, store)

    const applied = await runtime.resolveApproval(founder, { approvalId: first.id, decision: 'approved', humanStatement: 'Approve the mission update.' }, 'ui')
    assert.equal(applied.status, 'approved')
    let saved = await store.readActive(workspace)
    assert.equal(saved?.governanceRevision, 2)
    assert.equal(saved?.governanceNotifications.length, 1)
    assert.deepEqual(saved?.governanceNotifications[0]?.employeeIds, ['e1'])
    assert.match(saved?.governanceNotifications[0]?.content ?? '', /revision 2.*mission/iu)

    const cancelled = await runtime.resolveApproval(founder, { approvalId: stale.id, decision: 'approved', humanStatement: 'Approve this now-stale charter update.' }, 'ui')
    assert.equal(cancelled.status, 'cancelled')
    saved = await store.readActive(workspace)
    assert.equal(saved?.governanceRevision, 2)
    assert.equal(saved?.governanceNotifications.length, 1, 'stale approval must not emit a false change notification')
    assert.notEqual(saved?.formation.charter, 'This stale charter must never apply.')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
