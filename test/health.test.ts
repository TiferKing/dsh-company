import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installCompanyAccounting } from '../src/accounting.js'
import { CompanyRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { companyState } from './fixtures.js'

test('terminal quota failure blocks same-route staff, halts globally, requeues, and permits manual resume', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-health-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    const handlers = new Map<string, Function>()
    const employee1 = { id: 'employee-session', session: { header: { cwd: workspace } } }
    const employee2 = { id: 'employee-session-2', session: { header: { cwd: workspace } } }
    let interrupts = 0
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employee1 : String(id) === 'employee-session-2' ? employee2 : undefined } },
      subagents: { registerContinuableSetup: () => () => undefined, interrupt: () => { interrupts += 1 } },
      llm: { resolveCallConfig: async (value: unknown) => value },
      logger: { warn: () => undefined },
    } as any
    founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'working'
    state.employees.push({
      id: 'e2', name: 'Reviewer', role: 'Reviewer', department: 'Engineering', orgUnitId: 'ou2',
      positionId: 'pos1', status: 'idle', sessionId: 'employee-session-2', joinedAt: Date.now(),
      llm: { provider: 'mock', model: 'mock-model', activeProvider: 'mock', activeModel: 'mock-model' },
    })
    state.counters.employee = 2
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Design', objective: 'Design.', status: 'in_progress', assigneeId: 'e1',
      dependencies: [], inScope: [], outOfScope: [], acceptance: ['Done'], verify: [], deliverables: [], attempt: 1,
      attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const dispose = installCompanyAccounting(ctx, store, config)
    const onRequestError = handlers.get('agent/request-error')!
    await onRequestError({
      agent: employee1, turn: 1, step: 1, provider: 'mock', signal: new AbortController().signal,
      failure: { code: 'QUOTA', message: 'Provider quota exhausted' }, retryPolicy: undefined,
    }, async () => undefined)

    const halted = await store.readActive(workspace)
    assert.equal(halted?.phase, 'halted')
    assert.equal(halted?.health.reason, 'quota')
    assert.deepEqual(halted?.employees.map((employee) => employee.status), ['paused', 'paused'])
    assert.ok(halted?.employees.every((employee) => employee.operationalBlock?.kind === 'quota'))
    assert.equal(halted?.workItems[0]?.status, 'pending')
    assert.equal(halted?.workItems[0]?.attempt, 0)
    assert.ok(interrupts >= 2)

    const runtime = new CompanyRuntime(ctx, config, store)
    const resumed = await runtime.control(founder, 'resume', 'Quota was replenished')
    assert.equal(resumed.phase, 'operating')
    assert.equal(resumed.health.status, 'healthy')
    assert.ok(resumed.employees.every((employee) => employee.operationalBlock === undefined))

    await store.transact(workspace, { actor: 'scheduler', type: 'test.partial_block', summary: 'Simulate a route-scoped partial block' }, (fresh) => {
      fresh.employees[0]!.status = 'paused'
      fresh.employees[0]!.operationalBlock = { kind: 'quota', code: 'QUOTA', message: 'One route remains blocked', at: Date.now() }
    })
    const partiallyResumed = await runtime.control(founder, 'resume', 'The affected route quota was replenished')
    assert.equal(partiallyResumed.phase, 'operating')
    assert.equal(partiallyResumed.employees[0]?.status, 'idle')
    assert.equal(partiallyResumed.employees[0]?.operationalBlock, undefined)
    dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
