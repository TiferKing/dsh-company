import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { reserveMoneyTurn } from '../src/money.js'
import { companyState } from './fixtures.js'

test('pause interrupts everyone, releases reservations, and requeues without attempt penalty', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-pause-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    let interrupts = 0
    const employeeAgent = { id: 'employee-session', status: 'running', whenIdle: async () => undefined }
    const ctx = {
      agents: { get: (id: unknown) => String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeAgent : undefined },
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
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Design', objective: 'Design.', status: 'in_progress', assigneeId: 'e1',
      dependencies: [], inScope: [], outOfScope: [], acceptance: ['Done'], verify: [], deliverables: [], attempt: 1,
      attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    state.staffingRequests.push({
      id: 'sr1', action: 'hire', requestedBy: 'founder', hrEmployeeId: 'e1', candidateName: 'Future Engineer',
      workProfile: 'Future work.', status: 'in_review', attemptId: '550e8400-e29b-41d4-a716-446655440001', createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.staffing = 1
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
    state.workItems[0]!.reservationId = reservationId
    state.workItems[0]!.leaseAt = Date.now()
    await store.createStaged(workspace, state)
    await store.transact(workspace, { actor: 'founder', type: 'test.mail', summary: 'Seed reserved mail' }, async (_fresh, io) => {
      await io.writeMailbox('e1', [{
        id: '550e8400-e29b-41d4-a716-446655440002', from: 'founder', to: 'e1', content: 'Reserved mail', createdAt: Date.now(),
        deliveryState: 'reserved', reservationId: '550e8400-e29b-41d4-a716-446655440003', leaseAt: Date.now(),
      }])
    })
    const runtime = new CompanyRuntime(ctx, config, store)

    const paused = await runtime.control(founder, 'pause', 'Maintenance pause')
    assert.equal(paused.phase, 'paused')
    assert.equal(paused.health.status, 'manual_pause')
    assert.equal(paused.employees[0]?.status, 'paused')
    assert.equal(paused.tokenBudget.reservedTokens, 0)
    assert.equal(paused.workItems[0]?.status, 'pending')
    assert.equal(paused.workItems[0]?.attempt, 0)
    assert.equal(paused.workItems[0]?.attemptId, undefined)
    assert.deepEqual(paused.workItems[0]?.attemptHistory, [])
    assert.equal(paused.staffingRequests[0]?.status, 'pending')
    assert.equal(paused.staffingRequests[0]?.attemptId, undefined)
    const pausedMailbox = await store.readMailbox(workspace, 'e1')
    assert.equal(pausedMailbox[0]?.deliveryState, 'queued')
    assert.equal(pausedMailbox[0]?.reservationId, undefined)
    assert.ok(interrupts >= 1)
    const pausedMessage = await runtime.sendMessage(founder, 'e1', 'Wait until resume.')
    assert.equal(pausedMessage.deliveryState, 'queued', 'pause must not activate an employee for direct mail')

    const resumed = await runtime.control(founder, 'resume', 'Maintenance complete')
    assert.equal(resumed.phase, 'operating')
    assert.equal(resumed.health.status, 'healthy')
    assert.equal(resumed.employees[0]?.status, 'idle')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
