import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { releaseEmployeeMoneyReservations, reserveMoneyTurn } from '../src/money.js'
import { installCompanyScheduler } from '../src/scheduler.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import type { CompanyState, WorkItem } from '../src/types.js'
import { companyState } from './fixtures.js'

function pendingWork(): WorkItem {
  return {
    id: 'w1', productId: 'p1', kind: 'design', subject: 'Resume queued design', objective: 'Deliver a bounded design.',
    status: 'pending', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Verified design'],
    verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
  }
}

async function fixture(initialLive: 'idle' | 'running' | undefined, setup?: (state: CompanyState) => void) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-reload-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const makeAgent = (id: string, status: 'idle' | 'running') => ({
    id, status, session: { id, header: { cwd: workspace } }, steer: () => undefined,
  })
  const founder = makeAgent('founder-session', 'idle')
  const employee = makeAgent('employee-session', initialLive ?? 'idle')
  const agents = new Map<string, ReturnType<typeof makeAgent>>([[founder.id, founder]])
  if (initialLive !== undefined) agents.set(employee.id, employee)
  const handlers = new Map<string, Function>()
  const deliveries: string[] = []
  const warnings: string[] = []
  const ctx = {
    agents: { get: (id: unknown) => agents.get(String(id)) },
    on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
    logger: { warn: (message: string) => warnings.push(message) },
    subagents: {
      followup: async (_parent: unknown, id: unknown, content: Array<{ text: string }>) => {
        deliveries.push(content[0]!.text)
        agents.set(String(id), makeAgent(String(id), 'running'))
        return `accepted-${deliveries.length}`
      },
    },
  } as any
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const paths = await store.pathsForCwd(workspace)
  const state = companyState({ workspaceHash: paths.workspace.sha256 })
  state.employees[0]!.status = 'working'
  setup?.(state)
  if (state.hrEmployeeId === undefined) {
    // Keep the target an ordinary employee: legacy normalization otherwise
    // promotes the sole fixture employee to HR and correctly blocks work.
    state.employees.push({ ...structuredClone(state.employees[0]!), id: 'e2', isHr: true, status: 'paused', sessionId: 'hr-session' })
    state.hrEmployeeId = 'e2'
    state.counters.employee = 2
  }
  reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  await store.createStaged(workspace, state)
  const scheduler = installCompanyScheduler(ctx, config, store)
  return {
    workspace, store, scheduler, founder, employee, agents, makeAgent, deliveries, warnings,
    read: async () => (await store.readActive(workspace))!,
    emit: (name: string, agent = employee, status = agent.status) => handlers.get(name)!({ agent, status }),
    async close() { await scheduler.dispose?.(); await rm(base, { recursive: true, force: true }) },
  }
}

function gateTransaction(store: CompanyStore, type: string) {
  let enter!: () => void
  let release!: () => void
  const entered = new Promise<void>((resolve) => { enter = resolve })
  const gate = new Promise<void>((resolve) => { release = resolve })
  const original = store.transact.bind(store)
  let armed = true
  ;(store as any).transact = async (...args: any[]) => {
    if (armed && args[1].type === type) {
      armed = false
      enter()
      await gate
    }
    return (original as any)(...args)
  }
  return { entered, release }
}

async function eventually(predicate: () => Promise<boolean>): Promise<void> {
  const deadline = Date.now() + 5_000
  while (!await predicate()) {
    assert.ok(Date.now() < deadline, 'scheduler lifecycle event did not settle')
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}

for (const residency of [undefined, 'idle'] as const) {
  test(`reload reconciles working without an open assignment when Host employee is ${residency ?? 'unloaded'}`, async () => {
    const h = await fixture(residency)
    try {
      await h.scheduler.kick(h.workspace)
      const saved = await h.read()
      assert.equal(saved.employees[0]!.status, 'idle')
      assert.equal(saved.moneyBudget.reservations.length, 0)
      assert.equal(saved.moneyBudget.usage.length, 0)
      assert.equal(h.deliveries.length, 0, 'reconciliation must not manufacture an assignment')
    } finally { await h.close() }
  })
}

for (const assignment of ['work', 'hr', 'mail'] as const) {
  test(`reload lets a stale working employee receive pending ${assignment}`, async () => {
    const h = await fixture(undefined, (state) => {
      if (assignment === 'work') {
        state.workItems.push(pendingWork())
        state.counters.work = 1
      }
      if (assignment === 'hr') {
        state.employees[0]!.isHr = true
        state.hrEmployeeId = 'e1'
        state.staffingRequests.push({
          id: 'sr1', action: 'hire', status: 'pending', requestedBy: 'founder', hrEmployeeId: 'e1', candidateName: 'Designer',
          workProfile: 'Design a bounded feature.', createdAt: Date.now(), updatedAt: Date.now(),
        })
        state.counters.staffing = 1
      }
    })
    try {
      if (assignment === 'mail') await h.store.transact(h.workspace, { actor: 'founder', type: 'test.mail', summary: 'Queue durable message' }, async (_state, io) => {
        await io.writeMailbox('e1', [{ id: randomUUID(), from: 'founder', to: 'e1', content: 'Review the assigned design constraints.', createdAt: Date.now(), deliveryState: 'queued' }])
      })
      const previousReservation = (await h.read()).moneyBudget.reservations[0]!.id
      await h.scheduler.kick(h.workspace)
      const saved = await h.read()
      assert.equal(h.deliveries.length, 1)
      assert.notEqual(saved.moneyBudget.reservations[0]?.id, previousReservation)
      assert.equal(saved.moneyBudget.reservations.length, 1)
      if (assignment === 'work') assert.equal(saved.workItems[0]!.status, 'claimed')
      if (assignment === 'hr') assert.match(h.deliveries[0]!, /sr1/)
      if (assignment === 'mail') assert.equal((await h.store.readMailbox(h.workspace, 'e1'))[0]!.deliveryState, 'accepted')
    } finally { await h.close() }
  })
}

for (const race of ['new turn', 'new Agent instance'] as const) {
  test(`a delayed idle event cannot clear a ${race}'s reservation`, async () => {
    const h = await fixture('idle')
    const gate = gateTransaction(h.store, 'employee.activity')
    try {
      h.emit('agent/status', h.employee, 'idle')
      await gate.entered
      if (race === 'new turn') h.employee.status = 'running'
      else h.agents.set(h.employee.id, h.makeAgent(h.employee.id, 'running'))
      const replacement = await h.store.transact(h.workspace, { actor: 'scheduler', type: 'test.new_turn', summary: 'Begin a new turn during the old event' }, (state) => {
        releaseEmployeeMoneyReservations(state, 'e1')
        reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
        return structuredClone(state.moneyBudget.reservations[0]!)
      })
      gate.release()
      await eventually(async () => (await h.read()).revision > replacement.state.revision)
      const saved = await h.read()
      assert.equal(saved.employees[0]!.status, 'working')
      assert.deepEqual(saved.moneyBudget.reservations[0], replacement.result)
      assert.equal(h.deliveries.length, 0)
    } finally { gate.release(); await h.close() }
  })
}

for (const race of ['new turn', 'changed session'] as const) {
  test(`reload reconciliation rechecks a ${race} after waiting for its transaction`, async () => {
    const h = await fixture('idle')
    const gate = gateTransaction(h.store, 'employee.activity_reconciled')
    let driving: Promise<void> | undefined
    try {
      driving = h.scheduler.kick(h.workspace)
      await gate.entered
      const replacement = await h.store.transact(h.workspace, { actor: 'scheduler', type: 'test.replacement', summary: 'Replace the activation before reconciliation commits' }, (state) => {
        releaseEmployeeMoneyReservations(state, 'e1')
        if (race === 'changed session') state.employees[0]!.sessionId = 'replacement-session'
        reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
        return structuredClone(state.moneyBudget.reservations[0]!)
      })
      if (race === 'new turn') h.employee.status = 'running'
      else h.agents.set('replacement-session', h.makeAgent('replacement-session', 'idle'))
      gate.release()
      await driving
      const saved = await h.read()
      assert.equal(saved.employees[0]!.status, 'working')
      assert.deepEqual(saved.moneyBudget.reservations[0], replacement.result)
      assert.equal(h.deliveries.length, 0)
    } finally { gate.release(); await driving; await h.close() }
  })
}

for (const event of ['agent/created', 'agent/disposed'] as const) {
  test(`${event} wakes the affected company without a status poll`, async () => {
    const h = await fixture('running', (state) => { state.workItems.push(pendingWork()); state.counters.work = 1 })
    try {
      if (event === 'agent/created') {
        h.employee.status = 'idle'
        h.agents.set(h.employee.id, h.employee)
      } else h.agents.delete(h.employee.id)
      h.emit(event)
      await eventually(async () => h.deliveries.length === 1 && (await h.read()).workItems[0]!.deliveryAttempts === 1)
      assert.equal((await h.read()).workItems[0]!.status, 'claimed')
      assert.equal(h.warnings.length, 0)
    } finally { await h.close() }
  })
}

test('a child disposal and stale caller-held Founder cannot revive an unloaded company', async () => {
  const h = await fixture('running', (state) => { state.workItems.push(pendingWork()); state.counters.work = 1 })
  try {
    h.agents.delete(h.founder.id)
    h.agents.delete(h.employee.id)
    h.emit('agent/disposed')
    await h.scheduler.kick(h.workspace, h.founder as any)
    assert.equal(h.deliveries.length, 0)
    assert.equal((await h.read()).workItems[0]!.status, 'pending')
  } finally { await h.close() }
})
