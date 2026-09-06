import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { installCompanyScheduler } from '../src/scheduler.js'
import { releaseEmployeeMoneyReservations } from '../src/money.js'

async function buildHarness(): Promise<{
  ctx: any; runtime: CompanyRuntime; store: CompanyStore; workspace: string; config: ReturnType<typeof resolveConfig>
  founder: any; steered: string[]; sessions: Map<string, any>; agentOf(id: string): any; cleanup: () => Promise<void>
}> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-tickets-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const steered: string[] = []
  const sessions = new Map<string, any>()
  const founder = {
    id: 'founder-session',
    options: { provider: 'mock', model: 'mock-model' },
    steer(message: { content: Array<{ text: string }> }) { steered.push(message.content[0]?.text ?? '') },
    session: {
      header: { cwd: workspace, delegationDepth: 0 },
      requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
      deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
    },
  }
  sessions.set('founder-session', founder)
  const ctx = {
    agents: { get(id: unknown) { return sessions.get(String(id)) } },
    llm: {
      resolveCallConfig: async (selection: any) => selection,
      listProviders: () => [{ id: 'mock', name: 'Mock' }],
      listModels: async () => [{ id: 'mock-model', name: 'Mock model' }],
      resolveModelInfo: async () => ({ provider: 'mock', id: 'mock-model', name: 'Mock model', context: { contextWindow: 128_000 } }),
    },
    subagents: {
      registerContinuableSetup: () => () => undefined,
      getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }),
      startContinuable: async (spec: any) => ({ childId: spec.childId, messageId: `message-${spec.childId}` }),
      followup: async () => 'message-followup',
      interrupt: () => undefined,
    },
    logger: { warn: () => undefined },
    on: () => () => undefined,
  } as any
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const runtime = new CompanyRuntime(ctx, config, store)
  const agentOf = (id: string): any => {
    const existing = sessions.get(id)
    if (existing !== undefined) return existing
    const agent = { id, status: 'idle', session: { header: { cwd: workspace } } }
    sessions.set(id, agent)
    return agent
  }
  return { ctx, runtime, store, workspace, config, founder, steered, sessions, agentOf, cleanup: () => rm(base, { recursive: true, force: true }) }
}

async function hireEngineer(harness: Awaited<ReturnType<typeof buildHarness>>): Promise<{ engineer: { id: string; sessionId?: string }; engineerAgent: any }> {
  const hr = (await harness.store.readActive(harness.workspace))!.employees[0]!
  const request = await harness.runtime.requestStaffing(harness.founder, { action: 'hire', candidateName: 'Engineer', workProfile: 'Fix reported issues.' })
  const claim = await harness.runtime.claimStaffingAssessment(harness.agentOf(hr.sessionId!), request.id)
  const recommendation = await harness.runtime.submitStaffingAssessment(harness.agentOf(hr.sessionId!), {
    requestId: request.id, attemptId: claim.attemptId, difficulty: 'low', provider: 'mock', model: 'mock-model',
    budgetMicros: 100_000, rationale: 'General repair route.', orgPath: ['Tool'], positionTitle: 'Support Engineer', responsibilities: ['Fix reported issues'],
  })
  await harness.runtime.resolveApproval(harness.founder, {
    approvalId: recommendation.approvalId!, decision: 'approved', humanStatement: 'I approve this hire.',
  }, 'ui')
  const engineer = await harness.runtime.addEmployee(harness.founder, { name: 'Engineer', role: 'Support Engineer', staffingRequestId: request.id, approvalId: recommendation.approvalId! })
  return { engineer, engineerAgent: harness.agentOf(engineer.sessionId!) }
}

async function waitForAdmission(harness: Awaited<ReturnType<typeof buildHarness>>, workId: string): Promise<void> {
  for (let attempt = 0; attempt < 50; attempt += 1) {
    const state = await harness.store.readActive(harness.workspace)
    const work = state?.workItems.find((item) => item.id === workId)
    if (work !== undefined && work.status !== 'pending') return
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
  throw new Error(`work ${workId} was never admitted`)
}

test('a ticket travels file → triage → dispatch → resolve → close with steers and guardrails', async () => {
  const harness = await buildHarness()
  try {
    const scheduler = installCompanyScheduler(harness.ctx, harness.config, harness.store, harness.runtime)
    harness.runtime.attachScheduler(scheduler)
    await harness.runtime.bootstrap(harness.founder, {
      name: 'Draft Co', mission: 'Build one bounded tool.', charter: '1. Human approval governs.',
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
      totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY', draftedBy: 'ai',
      modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
    })
    await harness.runtime.approveBootstrap(harness.founder, 'Approved and start.', { source: 'ui' })
    const { engineer, engineerAgent } = await hireEngineer(harness)

    // The real Host's accounting releases the provisioning monetary
    // reservation when the fresh employee's first turn ends; the fake harness
    // has no session events, so release it explicitly before admission.
    await harness.store.transact(harness.workspace, { actor: 'scheduler', type: 'harness.reservation_released', summary: 'release monetary reservation' }, (state) => {
      releaseEmployeeMoneyReservations(state, engineer.id)
    })

    // File from the web console: one ticket + one linked, unassigned repair work item.
    const ticket = await harness.runtime.fileTicket(harness.founder, {
      productId: 'p1', title: '登录后白屏', description: '注册完成后偶发白屏，刷新恢复。\n复现步骤：…',
    })
    assert.equal(ticket.status, 'filed')
    assert.equal(ticket.workItemId, 'w1')
    let state = await harness.store.readActive(harness.workspace)
    const work = state?.workItems.find((item) => item.id === 'w1')
    assert.equal(work?.kind, 'repair')
    assert.equal(work?.assigneeId, undefined, 'decision path: filed work starts unassigned')
    assert.equal(work?.ticketId, 't1')

    // Triage permissions: a real non-support participant cannot triage; the founder can.
    const hr = (await harness.store.readActive(harness.workspace))!.employees[0]!
    const hrAgent = harness.agentOf(hr.sessionId!)
    await assert.rejects(() => harness.runtime.triageTicket(hrAgent, { ticketId: 't1', severity: 'high' }), /founder or the designated support engineer/)
    const triaged = await harness.runtime.triageTicket(harness.founder, { ticketId: 't1', severity: 'high' })
    assert.equal(triaged.status, 'triaged')
    assert.equal(triaged.severity, 'high')

    // Dispatch may never target the founder.
    await assert.rejects(() => harness.runtime.dispatchTicket(harness.founder, { ticketId: 't1', assigneeId: 'founder' }), /employee founder/)
    const dispatched = await harness.runtime.dispatchTicket(harness.founder, { ticketId: 't1', assigneeId: engineer.id, note: '请优先处理' })
    assert.equal(dispatched.status, 'dispatched')
    assert.equal(dispatched.assigneeId, engineer.id)
    state = await harness.store.readActive(harness.workspace)
    assert.equal(state?.workItems.find((item) => item.id === 'w1')?.assigneeId, engineer.id)

    // Closing before resolution is rejected.
    await assert.rejects(() => harness.runtime.closeTicket(harness.founder, { ticketId: 't1', reply: 'premature' }), /only resolved tickets may be closed/)

    // The scheduler admits the dispatched repair; the engineer completes it; the
    // ticket auto-resolves and the founder conversation is steered.
    await waitForAdmission(harness, 'w1')
    const claimed = await harness.runtime.claimWork(engineerAgent, 'w1')
    harness.steered.length = 0
    await harness.runtime.updateWork(engineerAgent, { workId: 'w1', attemptId: claimed.attemptId, status: 'in_progress' })
    await harness.runtime.updateWork(engineerAgent, {
      workId: 'w1', attemptId: claimed.attemptId, status: 'completed',
      output: 'Fixed the blank screen after login and covered it with a regression test.',
      changedPaths: ['tool/src/login.ts'], acceptanceResults: ['issue no longer reproduces'], commandsRun: ['pnpm test'],
    })
    state = await harness.store.readActive(harness.workspace)
    assert.equal(state?.tickets[0]?.status, 'resolved')
    assert.equal(state?.tickets[0]?.resolvedAt !== undefined, true)
    assert.equal(harness.steered.length, 1, 'resolution steers the founder conversation')
    assert.match(harness.steered[0]!, /ticket resolved/i)
    assert.match(harness.steered[0]!, /company_close_ticket/)

    // Close defaults the reply to the work output when omitted.
    const closed = await harness.runtime.closeTicket(harness.founder, { ticketId: 't1' })
    assert.equal(closed.status, 'closed')
    assert.equal(closed.reply, 'Fixed the blank screen after login and covered it with a regression test.')
    assert.equal(closed.closedAt !== undefined, true)

    // Accounting closes the completed turn's reservation in the real Host;
    // release it explicitly in the fake harness before the next admission.
    await harness.store.transact(harness.workspace, { actor: 'scheduler', type: 'harness.reservation_released', summary: 'release completed turn reservation' }, (state) => {
      releaseEmployeeMoneyReservations(state, engineer.id)
    })

    // A designated support engineer may triage without the founder; clearing
    // the designation revokes that power.
    const t2 = await harness.runtime.fileTicket(harness.founder, { productId: 'p1', title: 'second issue', description: '描述' })
    await harness.runtime.designateSupport(harness.founder, engineer.id)
    const triaged2 = await harness.runtime.triageTicket(engineerAgent, { ticketId: t2.id, severity: 'low' })
    assert.equal(triaged2.status, 'triaged')
    await assert.rejects(() => harness.runtime.designateSupport(harness.founder, 'no-such'), /unknown employee/)
    await harness.runtime.designateSupport(harness.founder, undefined)
    await assert.rejects(() => harness.runtime.triageTicket(engineerAgent, { ticketId: t2.id, severity: 'low' }), /founder or the designated support engineer/)

    // A failed repair returns the ticket to triaged with the severity kept.
    const t3 = await harness.runtime.fileTicket(harness.founder, { productId: 'p1', title: 'third issue', description: '描述' })
    await harness.runtime.triageTicket(harness.founder, { ticketId: t3.id, severity: 'urgent' })
    await harness.runtime.dispatchTicket(harness.founder, { ticketId: t3.id, assigneeId: engineer.id })
    await waitForAdmission(harness, t3.workItemId!)
    const claimed3 = await harness.runtime.claimWork(engineerAgent, t3.workItemId!)
    await harness.runtime.updateWork(engineerAgent, { workId: t3.workItemId!, attemptId: claimed3.attemptId, status: 'in_progress' })
    await harness.runtime.updateWork(engineerAgent, { workId: t3.workItemId!, attemptId: claimed3.attemptId, status: 'failed', output: 'Could not reproduce.' })
    state = await harness.store.readActive(harness.workspace)
    const failedTicket = state?.tickets.find((row) => row.id === t3.id)
    assert.equal(failedTicket?.status, 'triaged', 'failed repair returns to triaged')
    assert.equal(failedTicket?.severity, 'urgent')
    const retryWork = state?.workItems.find((item) => item.id === t3.workItemId)
    assert.deepEqual({ status: retryWork?.status, assignee: retryWork?.assigneeId, attempt: retryWork?.attempt }, { status: 'pending', assignee: undefined, attempt: 1 })
    await harness.runtime.dispatchTicket(harness.founder, { ticketId: t3.id, assigneeId: engineer.id, note: 'Retry with preserved attempt history' })
    await waitForAdmission(harness, t3.workItemId!)
    const retryClaim = await harness.runtime.claimWork(engineerAgent, t3.workItemId!)
    assert.equal(retryClaim.attempt, 2, 'a failed ticket repair can be dispatched as a new fenced attempt')
    await scheduler.dispose?.()
  } finally {
    await harness.cleanup()
  }
})

test('filing is bounded to operating companies and existing products', async () => {
  const harness = await buildHarness()
  try {
    await harness.runtime.bootstrap(harness.founder, {
      name: 'Draft Co', mission: 'Build one bounded tool.', charter: '1. Human approval governs.',
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
      totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY', draftedBy: 'ai',
      modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
    })
    await assert.rejects(() => harness.runtime.fileTicket(harness.founder, { productId: 'p1', title: 'x', description: 'y' }), /operating/)
    await harness.runtime.approveBootstrap(harness.founder, 'Approved and start.', { source: 'ui' })
    await assert.rejects(() => harness.runtime.fileTicket(harness.founder, { productId: 'p9', title: 'x', description: 'y' }), /unknown product/)
  } finally {
    await harness.cleanup()
  }
})
