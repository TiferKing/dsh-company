import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { FOUNDER_ONLY_TOOLS } from '../src/employees.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'

test('employees are hard-denied from spawning their own subagents', () => {
  assert.ok((FOUNDER_ONLY_TOOLS as readonly string[]).includes('subagent'), 'native subagent tool denied')
  assert.ok((FOUNDER_ONLY_TOOLS as readonly string[]).includes('subagent_fork'))
  assert.ok((FOUNDER_ONLY_TOOLS as readonly string[]).includes('ralph'))
  assert.ok((FOUNDER_ONLY_TOOLS as readonly string[]).includes('workflow'))
  assert.ok((FOUNDER_ONLY_TOOLS as readonly string[]).includes('agent_teams_create'))
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
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000, tokenBudget: 500_000 },
      totalBudgetMicros: 1_000_000, totalTokenBudget: 1_000_000, currency: 'CNY',
      modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
      draftedBy: 'ai',
    })
    let staged = await store.readActive(workspace)
    assert.equal(staged?.formation.status, 'draft')
    assert.equal(staged?.formation.charter, multilineCharter, 'multi-line charters are stored verbatim')
    assert.equal(staged?.employees.length, 1)
    assert.equal(staged?.employees[0]?.isHr, true)
    assert.equal(staged?.products[0]?.name, 'Tool')

    staged = await runtime.editFormation(founder, {
      name: 'Approved Draft Co', charter: 'Edited charter; humans approve staffing.',
      firstProduct: { name: 'Tool v1', tokenBudget: 600_000 }, totalTokenBudget: 1_200_000,
    })
    assert.equal(staged.name, 'Approved Draft Co')
    assert.equal(staged.formation.draftedBy, 'user')
    assert.equal(staged.products[0]?.name, 'Tool v1')

    await assert.rejects(() => runtime.addEmployee(founder, { name: 'Bypass', role: 'Engineer' }), /requires a completed HR staffing recommendation/)

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
      requestId: request.id, attemptId: claim.attemptId, difficulty: 'low', provider: 'mock', model: 'unpriced-model',
      rationale: 'Should be rejected.', orgPath: ['Product'], positionTitle: 'Engineer', responsibilities: ['Build'],
    }), /enabled \(three-rate priced\) on the recruiting page/)
    const recommendation = await runtime.submitStaffingAssessment(hrAgent, {
      requestId: request.id, attemptId: claim.attemptId, difficulty: 'high', provider: 'mock', model: 'mock-model',
      reasoningEffort: 'default', rationale: 'Implementation needs a strong coding route.',
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
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
