import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApproval, consumeApproval } from '../src/approvals.js'
import { reserveMoneyTurn } from '../src/money.js'
import { CompanyRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { companyState } from './fixtures.js'

async function fixture() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-lifecycle-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const paths = await store.pathsForCwd(workspace)
  const state = companyState({ workspaceHash: paths.workspace.sha256 })
  const founder = { id: 'founder-session', session: { header: { cwd: workspace } } } as any
  const ctx = {
    agents: { get: (id: unknown) => String(id) === String(founder.id) ? founder : undefined },
    subagents: { registerContinuableSetup: () => () => undefined, interrupt: () => undefined },
    logger: { warn: () => undefined },
  } as any
  return { base, workspace, config, store, state, founder, ctx }
}

for (const accepted of [false, true]) test(`concurrent cold recovery persists HR succession and releases ${accepted ? 'accepted' : 'prepared'} assessment reservations`, async () => {
  const f = await fixture()
  try {
    const { state, store, workspace } = f
    const now = Date.now()
    const oldHr = state.employees[0]!
    oldHr.isHr = true
    state.hrEmployeeId = oldHr.id
    state.orgUnits[1]!.name = 'Human Resources'
    state.employees.push({ ...structuredClone(oldHr), id: 'e2', name: 'Successor', status: 'provisioning', sessionId: 'successor-session' })
    state.counters.employee = 2
    const approval = createApproval(state, 'founder', {
      kind: 'organization_change', summary: 'Appoint a successor',
      payload: { action: 'hire', staffingRequestId: 'sr1', designateAsHr: true },
    })
    approval.status = 'approved'
    approval.resolvedAt = now
    consumeApproval(approval)
    state.staffingRequests.push({
      id: 'sr1', action: 'hire', status: 'approved', requestedBy: 'founder', candidateName: 'Successor',
      employeeId: 'e2', hrEmployeeId: 'e1', workProfile: 'Lead HR', approvalId: approval.id,
      recommendation: {
        difficulty: 'high', provider: 'mock', model: 'mock-model', budgetMicros: 100_000_000,
        rationale: 'Continue governance', orgPath: ['Human Resources'], positionTitle: 'HR Lead',
        responsibilities: ['Assess staffing'], designateAsHr: true, assessedAt: now,
      }, createdAt: now, updatedAt: now,
    }, {
      id: 'sr2', action: 'hire', status: 'in_review', requestedBy: 'founder', candidateName: 'Next Engineer',
      hrEmployeeId: 'e1', workProfile: 'Build the product', attemptId: 'old-hr-attempt',
      reviewDeliveryAttempts: 2, createdAt: now, updatedAt: now,
    })
    state.counters.staffing = 2
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', staffingRequestId: 'sr2', provider: 'mock', model: 'mock-model' })
    if (!accepted) Object.assign(state.staffingRequests[1]!, { reservationId, leaseAt: now })
    await store.createStaged(workspace, state)
    let probes = 0
    f.ctx.subagents.listChildren = async () => {
      probes += 1
      return [{ kind: 'child', mode: 'continuable', id: 'successor-session', label: `dsh-company:${state.id}:e2` }]
    }
    const runtime = new CompanyRuntime(f.ctx, f.config, store)
    await Promise.all([runtime.recoverWorkspace(f.founder), runtime.recoverWorkspace(f.founder)])
    const saved = (await store.readActive(workspace))!
    assert.equal(probes, 1, 'duplicate root recovery shares one operation')
    assert.equal(saved.hrEmployeeId, 'e2')
    assert.equal(saved.employees[0]!.isHr, false)
    assert.equal(saved.employees[1]!.status, 'idle')
    assert.equal(saved.orgUnits[1]!.managerEmployeeId, 'e2')
    assert.equal(saved.staffingRequests[0]!.status, 'applied')
    assert.equal(saved.staffingRequests[1]!.hrEmployeeId, 'e2')
    assert.equal(saved.staffingRequests[1]!.status, 'pending')
    assert.equal(saved.staffingRequests[1]!.attemptId, undefined)
    assert.equal(saved.staffingRequests[1]!.reservationId, undefined)
    assert.equal(saved.staffingRequests[1]!.reviewDeliveryAttempts, 0)
    assert.equal(saved.moneyBudget.reservations.find((r) => r.id === reservationId), undefined)
    assert.equal(saved.governanceNotifications.length, 1)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('archiving a company with support and an open ticket produces a valid closed aggregate', async () => {
  const f = await fixture()
  try {
    await f.store.createStaged(f.workspace, f.state)
    const runtime = new CompanyRuntime(f.ctx, f.config, f.store)
    await runtime.designateSupport(f.founder, 'e1')
    const ticket = await runtime.fileTicket(f.founder, { productId: 'p1', title: 'Repair needed', description: 'The product has an issue.' })
    const prepared = await f.store.transact(f.workspace, { actor: 'founder', type: 'test.approval', summary: 'Approve closure' }, (state) => {
      const approval = createApproval(state, 'founder', { kind: 'forced_archive', summary: 'Close company', payload: { reason: 'End operations' } })
      approval.status = 'approved'
      approval.resolvedAt = Date.now()
      return approval.id
    })
    const archived = await runtime.control(f.founder, 'archive', 'End operations', prepared.result)
    assert.equal(archived.phase, 'archived')
    assert.equal(archived.supportEmployeeId, undefined)
    assert.equal(archived.tickets[0]!.id, ticket.id)
    assert.equal(archived.tickets[0]!.status, 'closed')
    assert.match(archived.tickets[0]!.reply!, /cancelled/)
    assert.equal(archived.workItems[0]!.status, 'cancelled')
    assert.equal((await f.store.readArchived(f.workspace))[0]!.id, archived.id)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('archive rechecks unfinished work created during employee quiescence', async () => {
  const f = await fixture()
  try {
    await f.store.createStaged(f.workspace, f.state)
    const runtime = new CompanyRuntime(f.ctx, f.config, f.store)
    const employee = { id: 'employee-session', status: 'running', whenIdle: async () => {
      await runtime.createWork(f.founder, { productId: 'p1', kind: 'design', subject: 'Concurrent work', objective: 'Must not be silently cancelled', inScope: [], acceptance: ['Reviewed'] })
    } }
    f.ctx.agents.get = (id: unknown) => String(id) === 'founder-session' ? f.founder : String(id) === employee.id ? employee : undefined
    await assert.rejects(runtime.control(f.founder, 'archive', 'End operations'), /forced_archive approval_id is required/)
    const saved = (await f.store.readActive(f.workspace))!
    assert.equal(saved.phase, 'operating')
    assert.equal(saved.workItems[0]!.status, 'pending')
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('a mutation before formation does not leave an empty active directory blocking bootstrap', async () => {
  const f = await fixture()
  try {
    await assert.rejects(f.store.transact(f.workspace, { actor: 'founder', type: 'test.missing', summary: 'No company yet' }, () => undefined), /no active company/)
    const created = await f.store.createStaged(f.workspace, f.state)
    assert.equal(created.id, f.state.id)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})

test('final release requires a named independent reviewer of completed work in the same product', async () => {
  const f = await fixture()
  try {
    const { state } = f
    state.products[0]!.status = 'validating'
    state.workItems.push(
      { id: 'w1', productId: 'p1', kind: 'verification', subject: 'Verify', objective: 'Check product', status: 'completed', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Verified'], verify: [], deliverables: [], attempt: 1, attemptHistory: [], createdAt: 1, updatedAt: 1 },
      { id: 'w2', productId: 'p1', kind: 'review', subject: 'Review', objective: 'Review verification', status: 'completed', assigneeId: 'e1', reviewedWorkId: 'w1', verdict: 'pass', dependencies: ['w1'], inScope: [], outOfScope: [], acceptance: ['Reviewed'], verify: [], deliverables: [], attempt: 1, attemptHistory: [], createdAt: 1, updatedAt: 1 },
    )
    state.counters.work = 2
    const approval = createApproval(state, 'founder', { kind: 'release', summary: 'Release the product', payload: { productId: 'p1' } })
    approval.status = 'approved'
    approval.resolvedAt = Date.now()
    await f.store.createStaged(f.workspace, state)
    const runtime = new CompanyRuntime(f.ctx, f.config, f.store)
    await assert.rejects(runtime.updateProduct(f.founder, { productId: 'p1', status: 'released', approvalId: approval.id }), /independent passing review/)
    assert.equal((await f.store.readActive(f.workspace))!.approvals[0]!.consumedAt, undefined)
  } finally { await rm(f.base, { recursive: true, force: true }) }
})
