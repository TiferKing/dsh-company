import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { createApproval, resolveApproval } from '../src/approvals.js'
import { CompanyRuntime } from '../src/runtime.js'
import { assertCompanyState, effectiveEmployeeLimit, resolveConfig, validateApprovalPayload } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { registerCompanyTools } from '../src/tools.js'
import { companyState } from './fixtures.js'

test('finite ceilings remain binding on either side of the company/host boundary', () => {
  assert.equal(effectiveEmployeeLimit('unlimited', 'unlimited'), Infinity)
  assert.equal(effectiveEmployeeLimit(8, 'unlimited'), 8)
  assert.equal(effectiveEmployeeLimit('unlimited', 16), 16)
  assert.equal(effectiveEmployeeLimit(8, 16), 8)
  assert.equal(effectiveEmployeeLimit(64, 128), 64)
})

test('saved state supports more than 32 active employees and 10000 retired identities', () => {
  const state = companyState()
  state.limits.maxEmployees = 'unlimited'
  const template = state.employees[0]!
  state.employees = Array.from({ length: 10066 }, (_, index) => ({
    ...template, id: `e${index + 1}`, sessionId: `employee-session-${index + 1}`,
    status: index < 65 ? 'idle' as const : 'retired' as const,
  }))
  state.counters.employee = state.employees.length
  assert.doesNotThrow(() => assertCompanyState(state))
  state.limits.maxEmployees = 65
  assert.doesNotThrow(() => assertCompanyState(state))
  state.limits.maxEmployees = 64
  assert.throws(() => assertCompanyState(state), /active maxEmployees/)
})

test('a capacity approval is human-gated, atomic, revision-fenced, and protects active employees from shrinking', () => {
  const state = companyState()
  const config = resolveConfig()
  const request = createApproval(state, 'founder', { kind: 'governance_change', summary: 'Remove the employee ceiling',
    payload: { expectedGovernanceRevision: 1, maxEmployees: 'unlimited' } })
  assert.equal(state.limits.maxEmployees, 8)
  assert.throws(() => resolveApproval(state, config, { approvalId: request.id, decision: 'approved', source: 'tool' }), /human_statement/)
  assert.equal(state.limits.maxEmployees, 8)
  assert.equal(request.status, 'pending')
  const stale = createApproval(state, 'founder', { kind: 'governance_change', summary: 'Competing finite ceiling',
    payload: { expectedGovernanceRevision: 1, maxEmployees: 64 } })
  resolveApproval(state, config, { approvalId: request.id, decision: 'approved', source: 'tool', humanStatement: 'Approve unlimited headcount.' })
  assert.equal(state.limits.maxEmployees, 'unlimited')
  assert.equal(state.governanceRevision, 2)
  assert.equal(resolveApproval(state, config, { approvalId: stale.id, decision: 'approved', source: 'ui' }).stale, true)
  assert.equal(state.limits.maxEmployees, 'unlimited')
  const shrink = createApproval(state, 'founder', { kind: 'governance_change', summary: 'Shrink to one',
    payload: { expectedGovernanceRevision: 2, maxEmployees: 1, mission: 'Must not apply with stale headcount' } })
  state.employees.push({ ...state.employees[0]!, id: 'e2', sessionId: 'employee-session-2' })
  const result = resolveApproval(state, config, { approvalId: shrink.id, decision: 'approved', source: 'ui' })
  assert.equal(result.stale, true)
  assert.equal(state.limits.maxEmployees, 'unlimited')
  assert.notEqual(state.mission, 'Must not apply with stale headcount')
  for (const maxEmployees of [0, 1.5, 'Infinity']) {
    assert.throws(() => validateApprovalPayload('governance_change', { expectedGovernanceRevision: 2, maxEmployees }), /maxEmployees/)
  }
})

test('historical governance recipients remain valid after retirement releases finite headcount', () => {
  const state = companyState()
  state.employees.push({ ...state.employees[0]!, id: 'e2', sessionId: 'retired-session', status: 'retired' })
  state.counters.employee = 2
  state.limits.maxEmployees = 1
  state.governanceNotifications.push({ id: randomUUID(), governanceRevision: 1, employeeIds: ['e1', 'e2'],
    deliveredEmployeeIds: ['e1', 'e2'], content: 'An earlier approved policy.', createdAt: Date.now() })
  assert.doesNotThrow(() => assertCompanyState(state))
})

test('existing company capacity changes survive restart and tools cannot approve their own request turn', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-capacity-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const messages = [{ id: 'user-1', role: 'user', source: { kind: 'user' } }]
    const founder: any = { id: 'founder-session', session: { header: { cwd: workspace }, deriveMessages: () => messages } }
    const ctx: any = { agents: { get: (id: unknown) => String(id) === founder.id ? founder : undefined },
      subagents: { registerContinuableSetup: () => () => undefined }, logger: { warn: () => undefined } }
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    await store.createStaged(workspace, companyState({ workspaceHash: paths.workspace.sha256 }))
    const runtime = new CompanyRuntime(ctx, config, store)
    assert.equal((await store.readActive(workspace))!.limits.maxEmployees, 8)
    const request = await runtime.requestGovernanceChange(founder, { maxEmployees: 'unlimited' })
    assert.match(request.detail!, /8 -> unlimited/)
    await assert.rejects(() => runtime.resolveApproval(founder, { approvalId: request.id, decision: 'approved', humanStatement: 'Approve' }, 'tool'), /newer genuine user-source message/i)
    assert.equal((await store.readActive(workspace))!.limits.maxEmployees, 8)
    messages.push({ id: 'user-2', role: 'user', source: { kind: 'user' } })
    await runtime.resolveApproval(founder, { approvalId: request.id, decision: 'approved', humanStatement: 'Approve unlimited headcount.' }, 'tool')
    const restartedStore = new CompanyStore(config)
    const saved = await restartedStore.readActive(workspace)
    assert.equal(saved!.limits.maxEmployees, 'unlimited')
    assert.match(saved!.governanceNotifications[0]!.content, /maxEmployees/)
    const proposal = await runtime.handleUiAction(founder, { sessionId: founder.id, companyId: saved!.id,
      expectedRevision: saved!.revision, action: 'request_governance_change',
      payload: { max_employees: 64, expected_governance_revision: saved!.governanceRevision } })
    assert.equal((await store.readActive(workspace))!.limits.maxEmployees, 'unlimited', 'UI proposal also waits for approval')
    const uiApproval = proposal.approvals.find((approval) => approval.status === 'pending')!
    await runtime.handleUiAction(founder, { sessionId: founder.id, companyId: saved!.id,
      expectedRevision: proposal.revision, action: 'resolve_approval', payload: { approval_id: uiApproval.id, decision: 'approved' } })
    assert.equal((await new CompanyStore(config).readActive(workspace))!.limits.maxEmployees, 64)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an approved legacy company can hire employee 33 after its human-approved expansion', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-hire-33-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder: any = { id: 'founder-session', options: { provider: 'mock', model: 'mock-model' },
      session: { header: { cwd: workspace, delegationDepth: 0 },
        requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
        deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }] } }
    const hr: any = { id: 'employee-session-1', status: 'idle', session: { header: { cwd: workspace } } }
    const ctx: any = { agents: { get: (id: unknown) => String(id) === founder.id ? founder : String(id) === hr.id ? hr : undefined },
      llm: { resolveCallConfig: async (selection: unknown) => selection },
      subagents: { registerContinuableSetup: () => () => undefined,
        getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }),
        startContinuable: async (spec: any) => ({ childId: spec.childId, messageId: `message-${spec.childId}` }) },
      logger: { warn: () => undefined } }
    const config = resolveConfig({ stateRoot: join(base, 'state'), executionMode: 'unlimited' })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256, hrEmployeeId: 'e1' })
    state.limits.maxEmployees = 32
    const employee = state.employees[0]!
    state.employees = Array.from({ length: 32 }, (_, index) => ({ ...employee, id: `e${index + 1}`,
      name: `Worker ${index + 1}`, sessionId: `employee-session-${index + 1}`, ...(index === 0 ? { isHr: true } : {}) }))
    state.counters.employee = 32
    await store.createStaged(workspace, state)
    const runtime = new CompanyRuntime(ctx, config, store)
    const request = await runtime.requestStaffing(founder, { action: 'hire', candidateName: 'Worker 33', workProfile: 'Implement bounded work.' })
    const claim = await runtime.claimStaffingAssessment(hr, request.id)
    const recommendation = await runtime.submitStaffingAssessment(hr, { requestId: request.id, attemptId: claim.attemptId,
      difficulty: 'low', provider: 'mock', model: 'mock-model', budgetMicros: 1_000_000, rationale: 'Fits the implementation scope.',
      orgPath: ['Engineering'], positionTitle: 'Engineer', responsibilities: ['Implement bounded work'] })
    await runtime.resolveApproval(founder, { approvalId: recommendation.approvalId!, decision: 'approved', humanStatement: 'Approve the recommended hire.' }, 'ui')
    const hire = () => runtime.addEmployee(founder, { name: 'Worker 33', role: 'Engineer', staffingRequestId: request.id, approvalId: recommendation.approvalId! })
    await assert.rejects(hire, /headcount cap/)
    const expansion = await runtime.requestGovernanceChange(founder, { maxEmployees: 'unlimited' }, undefined, 'ui')
    await runtime.resolveApproval(founder, { approvalId: expansion.id, decision: 'approved', humanStatement: 'Approve unlimited headcount.' }, 'ui')
    const hired = await hire()
    assert.equal(hired.id, 'e33')
    assert.equal((await store.readActive(workspace))!.employees.length, 33)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('governance tool exposes explicit finite/unlimited capacity without applying it directly', async () => {
  const tools: any[] = []
  let input: unknown
  registerCompanyTools({ tools: { register: (tool: any) => { tools.push(tool); return () => undefined } } } as any,
    { requestGovernanceChange: async (_caller: unknown, value: unknown) => { input = value; return { status: 'pending' } } } as any)
  const tool = tools.find((candidate) => candidate.name === 'company_request_governance_change')
  assert.ok(tool.parameters.properties.max_employees)
  await tool.execute({ max_employees: 'unlimited' }, { agent: {} })
  assert.deepEqual(input, { maxEmployees: 'unlimited' })
  await tool.execute({ max_employees: 100 }, { agent: {} })
  assert.deepEqual(input, { maxEmployees: 100 })
  await assert.rejects(() => tool.execute({ max_employees: 0 }, { agent: {} }), /max_employees/)
})
