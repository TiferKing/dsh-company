import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { EMPLOYEE_DENIED_SPAWN_TOOLS, FOUNDER_ONLY_TOOLS } from '../src/employees.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'

test('budget-only adjustment keeps the employee session; route change reprovisions with handoff', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-adjust-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', options: { provider: 'mock', model: 'mock-model' }, session: { header: { cwd: workspace, delegationDepth: 0 }, requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }), deriveMessages: () => [{ id: 'u1', role: 'user', source: { kind: 'user' } }] } } as any
    const ctx = { agents: { get: (id: unknown) => String(id) === 'founder-session' ? founder : undefined }, llm: { resolveCallConfig: async (sel: any) => sel }, subagents: { registerContinuableSetup: () => () => undefined, getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }), startContinuable: async (spec: any) => ({ childId: spec.childId, messageId: `m-${spec.childId}` }), followup: async () => 'mf', interrupt: () => undefined }, logger: { warn: () => undefined }, on: () => () => undefined } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const runtime = new CompanyRuntime(ctx, config, store)
    await runtime.bootstrap(founder, { name: 'C', mission: 'm', charter: '1. a', firstProduct: { name: 'P', summary: 's', productRoot: 'p', successCriteria: ['x'], budgetMicros: 1_000_000 }, totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY', draftedBy: 'ai', modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }] })
    await runtime.approveBootstrap(founder, 'Approved and start.', { source: 'ui' })
    const hr = (await store.readActive(workspace))!.employees[0]!
    const hrAgent = { id: hr.sessionId, status: 'idle', session: { header: { cwd: workspace } } } as any
    ;(ctx.agents as any).get = (id: unknown) => { const k = String(id); return k === 'founder-session' ? founder : k === hr.sessionId ? hrAgent : undefined }

    const hire = async (candidate: string) => {
      const rq = await runtime.requestStaffing(founder, { action: 'hire', candidateName: candidate, workProfile: 'w' })
      const cl = await runtime.claimStaffingAssessment(hrAgent, rq.id)
      const rec = await runtime.submitStaffingAssessment(hrAgent, { requestId: rq.id, attemptId: cl.attemptId, difficulty: 'low', provider: 'mock', model: 'mock-model', budgetMicros: 50_000, rationale: 'r', orgPath: ['T'], positionTitle: 'E', responsibilities: ['x'] })
      await runtime.resolveApproval(founder, { approvalId: rec.approvalId!, decision: 'approved', humanStatement: 'ok' }, 'ui')
      return runtime.addEmployee(founder, { name: candidate, role: 'E', staffingRequestId: rq.id, approvalId: rec.approvalId! })
    }
    const emp = await hire('W')
    const sessionBefore = emp.sessionId

    // Budget-only adjust: same route, same position → session survives.
    const adjust = async (budget: number, positionTitle: string) => {
      const rq = await runtime.requestStaffing(founder, { action: 'adjust', employeeId: emp.id, workProfile: 'bump' })
      const cl = await runtime.claimStaffingAssessment(hrAgent, rq.id)
      const rec = await runtime.submitStaffingAssessment(hrAgent, { requestId: rq.id, attemptId: cl.attemptId, difficulty: 'low', provider: 'mock', model: 'mock-model', budgetMicros: budget, rationale: 'r', orgPath: ['T'], positionTitle, responsibilities: ['x'] })
      await runtime.resolveApproval(founder, { approvalId: rec.approvalId!, decision: 'approved', humanStatement: 'ok' }, 'ui')
      return runtime.applyStaffingAdjustment(founder, rq.id, rec.approvalId!)
    }
    const kept = await adjust(100_000, 'E')
    assert.equal(kept.sessionId, sessionBefore, 'budget-only adjustment keeps the continuable session')
    assert.equal(kept.budgetMicros, 100_000)
    assert.notEqual(kept.status, 'provisioning')

    // Position (persona) change forces reprovision with a new session.
    const reprovisioned = await adjust(100_000, 'Senior E')
    assert.notEqual(reprovisioned.sessionId, sessionBefore, 'persona change reprovisions')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('employees are hard-denied from spawning their own subagents', () => {
  // Spawn tools are denied DYNAMICALLY via a tools.guard at call time, not in
  // the static toolFilter (a static deny for an unregistered tool breaks the
  // continuable creation). The guard list is checked at execution time only.
  assert.ok(!FOUNDER_ONLY_TOOLS.includes('subagent' as never), 'spawn tools removed from static deny')
  assert.ok(!FOUNDER_ONLY_TOOLS.includes('agent_teams_create' as never), 'agent_teams_create removed from static deny')
  assert.ok(EMPLOYEE_DENIED_SPAWN_TOOLS.has('subagent'), 'guard set covers subagent')
  assert.ok(EMPLOYEE_DENIED_SPAWN_TOOLS.has('subagent_fork'))
  assert.ok(EMPLOYEE_DENIED_SPAWN_TOOLS.has('ralph'))
  assert.ok(EMPLOYEE_DENIED_SPAWN_TOOLS.has('workflow'))
  assert.ok(EMPLOYEE_DENIED_SPAWN_TOOLS.has('agent_teams_create'))
})

test('formation is editable, provisions HR first, and gates later hiring through HR', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-formation-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    let founder: any
    let hrAgent: any
    const ctx = {
      agents: {
        get(id: unknown) {
          if (String(id) === 'founder-session') return founder
          if (hrAgent !== undefined && String(id) === String(hrAgent.id)) return hrAgent
          return undefined
        },
      },
      llm: { resolveCallConfig: async (selection: any) => selection },
      subagents: {
        registerContinuableSetup: () => () => undefined,
        getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }),
        startContinuable: async (spec: any) => ({ childId: spec.childId, messageId: `message-${spec.childId}` }),
        interrupt: () => undefined,
      },
      logger: { warn: () => undefined },
    } as any
    founder = {
      id: 'founder-session',
      options: { provider: 'mock', model: 'mock-model' },
      session: {
        header: { cwd: workspace, delegationDepth: 0 },
        requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
        deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
      },
    }
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const runtime = new CompanyRuntime(ctx, config, store)

    const multilineCharter = '1. Human approval governs formation and staffing.\n2. Money is bounded.\n  2.1 Overspending requires an approved budget change.'
    await runtime.bootstrap(founder, {
      name: 'Draft Co', mission: 'Build one bounded tool.', charter: multilineCharter,
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
      totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY',
      modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
      draftedBy: 'ai',
    })
    let staged = await store.readActive(workspace)
    assert.equal(staged?.formation.status, 'draft')
    assert.equal(staged?.formation.charter, multilineCharter, 'multi-line charters are stored verbatim')
    assert.equal(staged?.employees.length, 1)
    assert.equal(staged?.employees[0]?.isHr, true)
    assert.equal(staged?.products[0]?.name, 'Tool')
    await assert.rejects(() => runtime.editFormation(founder, { currency: 'USD' }), /explicit replacement model price matrix/)

    staged = await runtime.editFormation(founder, {
      name: 'Approved Draft Co', charter: 'Edited charter; humans approve staffing.',
      firstProduct: { name: 'Tool v1' },
    })
    assert.equal(staged.name, 'Approved Draft Co')
    assert.equal(staged.formation.draftedBy, 'user')
    assert.equal(staged.products[0]?.name, 'Tool v1')

    await assert.rejects(() => runtime.addEmployee(founder, { name: 'Bypass', role: 'Engineer' } as any), /requires a completed HR staffing recommendation/)

    const operating = await runtime.approveBootstrap(founder, 'Approved from Web UI.', { source: 'ui' })
    assert.equal(operating.phase, 'operating')
    assert.equal(operating.formation.status, 'approved')
    assert.equal(operating.employees.length, 1, 'only HR is provisioned by formation approval')
    const hr = operating.employees[0]!
    hrAgent = { id: hr.sessionId, session: { header: { cwd: workspace } } }

    const request = await runtime.requestStaffing(founder, { action: 'hire', candidateName: 'Engineer', workProfile: 'Implement Tool v1.' })
    const claim = await runtime.claimStaffingAssessment(hrAgent, request.id)
    // HR may only recommend enabled (three-rate priced) routes: an unpriced
    // catalog model is rejected without burning the assessment capability.
    await assert.rejects(() => runtime.submitStaffingAssessment(hrAgent, {
      requestId: request.id, attemptId: claim.attemptId, difficulty: 'low', provider: 'mock', model: 'unpriced-model', budgetMicros: 50_000,
      rationale: 'Should be rejected.', orgPath: ['Product'], positionTitle: 'Engineer', responsibilities: ['Build'],
    }), /enabled \(three-rate priced\) on the recruiting page/)
    const recommendation = await runtime.submitStaffingAssessment(hrAgent, {
      requestId: request.id, attemptId: claim.attemptId, difficulty: 'high', provider: 'mock', model: 'mock-model',
      reasoningEffort: 'default', budgetMicros: 50_000, rationale: 'Implementation needs a strong coding route.',
      orgPath: ['Product', 'Tool v1', 'Engineering'], positionTitle: 'Software Engineer', responsibilities: ['Implement and test Tool v1'],
    })
    assert.equal(recommendation.status, 'recommended')
    assert.ok(recommendation.approvalId)
    await assert.rejects(() => runtime.resolveApproval(founder, {
      approvalId: recommendation.approvalId!, decision: 'approved', humanStatement: 'Model must not approve in the request turn.',
    }), /newer genuine user-source message/)
    await runtime.resolveApproval(founder, {
      approvalId: recommendation.approvalId!, decision: 'approved', humanStatement: 'I approve this HR staffing recommendation.',
    }, 'ui')
    const hired = await runtime.addEmployee(founder, {
      name: 'Engineer', role: 'Software Engineer', staffingRequestId: request.id, approvalId: recommendation.approvalId,
    })
    assert.equal(hired.status, 'idle')
    const final = await store.readActive(workspace)
    assert.equal(final?.staffingRequests[0]?.status, 'applied')
    const unit = final?.orgUnits.find((candidate) => candidate.id === hired.orgUnitId)
    assert.equal(unit?.name, 'Engineering')
    assert.ok(final?.orgUnits.some((candidate) => candidate.name === 'Tool v1'))

    // The singleton HR role has an explicit succession path, so the original
    // formation HR lead is not immortal.
    const successorRequest = await runtime.requestStaffing(founder, { action: 'hire', candidateName: 'HR Successor', workProfile: 'Take over people and model governance.' })
    const successorClaim = await runtime.claimStaffingAssessment(hrAgent, successorRequest.id)
    const successorRecommendation = await runtime.submitStaffingAssessment(hrAgent, {
      requestId: successorRequest.id, attemptId: successorClaim.attemptId, difficulty: 'critical', provider: 'mock', model: 'mock-model',
      budgetMicros: 100_000, rationale: 'Continuity requires a human-approved successor.', orgPath: ['Human Resources'],
      positionTitle: 'People Governance Director', responsibilities: ['Own staffing and model governance'], designateAsHr: true,
    })
    await runtime.resolveApproval(founder, { approvalId: successorRecommendation.approvalId!, decision: 'approved', humanStatement: 'I approve the HR succession.' }, 'ui')
    const successor = await runtime.addEmployee(founder, { name: 'HR Successor', role: 'People Governance Director', staffingRequestId: successorRequest.id, approvalId: successorRecommendation.approvalId! })
    let successionState = (await store.readActive(workspace))!
    assert.equal(successionState.hrEmployeeId, successor.id)
    assert.equal(successionState.employees.find((employee) => employee.id === hr.id)?.isHr, false)
    assert.equal(successionState.employees.find((employee) => employee.id === successor.id)?.isHr, true)

    hrAgent = { id: successor.sessionId, status: 'idle', session: { header: { cwd: workspace } } }
    const retireRequest = await runtime.requestStaffing(founder, { action: 'retire', employeeId: hr.id, workProfile: 'Retire the superseded HR lead.' })
    const retireClaim = await runtime.claimStaffingAssessment(hrAgent, retireRequest.id)
    const retireRecommendation = await runtime.submitStaffingAssessment(hrAgent, {
      requestId: retireRequest.id, attemptId: retireClaim.attemptId, difficulty: 'low', rationale: 'Succession is complete.',
    })
    await runtime.resolveApproval(founder, { approvalId: retireRecommendation.approvalId!, decision: 'approved', humanStatement: 'I approve retirement of the former HR lead.' }, 'ui')
    await runtime.removeEmployee(founder, hr.id, 'Succession completed.', retireRecommendation.approvalId!, retireRequest.id)
    successionState = (await store.readActive(workspace))!
    assert.equal(successionState.employees.find((employee) => employee.id === hr.id)?.status, 'retired')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
