import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { executeUiAction, isRemoteUiRequest } from '../src/http.js'
import { CompanyRuntime, RevisionConflictError } from '../src/runtime.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'

test('remote sockets are classified independently of the transport gate', () => {
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' } }), false)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '::1' } }), false)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '::ffff:127.0.0.1' } }), false)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '192.168.1.5' } }), true)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '203.0.113.5, 127.0.0.1' } }), true)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { forwarded: 'for="[::1]";proto=http' } }), false)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.0.0.1, 203.0.113.5' } }), true, 'a forged loopback first hop cannot hide the actual remote client appended by a proxy')
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': ['127.0.0.1', '203.0.113.5'] } }), true)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { forwarded: 'for=127.0.0.1;proto=http, for=203.0.113.5' } }), true)
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: '127.0.0.1' }, headers: { 'x-forwarded-for': '127.attacker.example' } }), true, 'a loopback-looking hostname is not a loopback IP')
  assert.equal(isRemoteUiRequest({ socket: { remoteAddress: undefined } }), true)
})

async function buildHarness(): Promise<{ ctx: any; runtime: CompanyRuntime; store: CompanyStore; workspace: string; founder: any; steered: Array<{ content: Array<{ type: string; text: string }> }>; cleanup: () => Promise<void> }> {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-web-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const steered: Array<{ content: Array<{ type: string; text: string }> }> = []
  const founder = {
    id: 'founder-session',
    options: { provider: 'mock', model: 'mock-model' },
    steer(message: { content: Array<{ type: string; text: string }> }) { steered.push(message) },
    session: {
      header: { cwd: workspace, delegationDepth: 0 },
      requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
      deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
    },
  }
  const ctx = {
    agents: {
      get(id: unknown) {
        return String(id) === 'founder-session' ? founder : undefined
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
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const runtime = new CompanyRuntime(ctx, config, store)
  return { ctx, runtime, store, workspace, founder, steered, cleanup: () => rm(base, { recursive: true, force: true }) }
}

test('web mutations execute and persist for loopback pages, fail closed for anything else', async () => {
  const harness = await buildHarness()
  try {
    const staged = await harness.runtime.bootstrap(harness.founder, {
      name: 'Draft Co', mission: 'Build one bounded tool.', charter: '1. Original clause.',
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
      totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY', draftedBy: 'ai',
    })

    // Remote clients never mutate, regardless of payload quality.
    await assert.rejects(
      () => executeUiAction(harness.ctx, harness.runtime, {
        sessionId: 'founder-session', companyId: staged.companyId, expectedRevision: 1,
        action: 'edit_formation', payload: { charter: 'remote edit' },
      }, { remote: true }),
      /web mutations require a loopback same-origin page/i,
    )

    // Unknown sessions cannot borrow identity.
    await assert.rejects(
      () => executeUiAction(harness.ctx, harness.runtime, {
        sessionId: 'no-such-session', companyId: staged.companyId, expectedRevision: 1,
        action: 'edit_formation', payload: { charter: 'x' },
      }, { remote: false }),
      /does not identify an exact live agent/i,
    )

    // A loopback page acts as the exact founder participant: the edit
    // persists to disk and the response carries the editable founder view.
    const charter = '1. 创始人拥有最高决策权。\n2. 财务透明。\n  2.1 超支需先获批准。'
    const snapshot = await executeUiAction(harness.ctx, harness.runtime, {
      sessionId: 'founder-session', companyId: staged.companyId, expectedRevision: 1,
      action: 'edit_formation', payload: { charter },
    }, { remote: false })
    assert.equal(snapshot.viewer.role, 'founder')
    assert.equal(snapshot.viewer.permissions.length > 0, true)
    assert.equal(snapshot.company.charter, charter)
    assert.equal(snapshot.company.charter_outline[1]?.children.length, 1, 'host re-parses the edited outline')
    assert.equal(snapshot.revision, 2)

    const persisted = await harness.store.readActive(harness.workspace)
    assert.equal(persisted?.formation.charter, charter, 'web edit lands in the durable state file')

    // Successful console decisions steer the founder conversation so the
    // agent learns the human acted and can continue operating the company.
    assert.equal(harness.steered.length, 1, 'one steer per successful web action')
    const steeredText = harness.steered[0]!.content[0]!.text
    assert.match(steeredText, /dsh-company console decision \(authoritative record/)
    assert.match(steeredText, /Action: edit_formation — edited formation fields: charter/)
    assert.match(steeredText, /revision 2/)

    // The revision fence still applies to web callers.
    await assert.rejects(
      () => executeUiAction(harness.ctx, harness.runtime, {
        sessionId: 'founder-session', companyId: staged.companyId, expectedRevision: 1,
        action: 'edit_formation', payload: { slogan: 'stale write' },
      }, { remote: false }),
      (error: unknown) => error instanceof RevisionConflictError,
    )
    assert.equal(harness.steered.length, 1, 'failed actions never steer the conversation')
  } finally {
    await harness.cleanup()
  }
})


test('Web temporary authorization follows request → approval → atomic grant', async () => {
  const harness = await buildHarness()
  try {
    await harness.runtime.bootstrap(harness.founder, {
      name: 'Approval Co', mission: 'Test authorization governance.', charter: '1. Human approval is required.',
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
      totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY', draftedBy: 'ai',
      modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
    })
    await harness.runtime.approveBootstrap(harness.founder, 'Approved and start.', { source: 'ui' })
    let state = (await harness.store.readActive(harness.workspace))!
    const requested = await executeUiAction(harness.ctx, harness.runtime, {
      sessionId: 'founder-session', companyId: state.id, expectedRevision: state.revision,
      action: 'grant_temporary_authorization',
      payload: { employee_id: 'e1', reason: 'Bounded unknown-cost investigation.', expires_at: Date.now() + 60_000 },
    }, { remote: false })
    assert.equal(requested.temporary_authorizations.length, 0, 'confirmation alone cannot bypass typed approval')
    const approval = requested.approvals.find((candidate) => candidate.kind === 'temporary_authorization' && candidate.status === 'pending')
    assert.ok(approval)

    const granted = await executeUiAction(harness.ctx, harness.runtime, {
      sessionId: 'founder-session', companyId: state.id, expectedRevision: requested.revision,
      action: 'resolve_approval', payload: { approval_id: approval.id, decision: 'approved', human_statement: 'I approve this bounded temporary authorization.' },
    }, { remote: false })
    assert.equal(granted.temporary_authorizations.length, 1)
    state = (await harness.store.readActive(harness.workspace))!
    assert.equal(state.temporaryAuthorizations[0]?.approvalId, approval.id)
    assert.notEqual(state.approvals.find((candidate) => candidate.id === approval.id)?.consumedAt, undefined)
  } finally {
    await harness.cleanup()
  }
})

test('web budget/pricing requests work without any founder chat anchor', async () => {
  const harness = await buildHarness()
  try {
    await harness.runtime.bootstrap(harness.founder, {
      name: 'Draft Co', mission: 'Build one bounded tool.', charter: '1. Original clause.',
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
      totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY', draftedBy: 'ai',
      modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
    })
    await harness.runtime.approveBootstrap(harness.founder, 'Approved and start.', { source: 'ui' })
    // A console click is the human decision: no chat user message exists at all.
    harness.founder.session.deriveMessages = () => []
    const approvals = await executeUiAction(harness.ctx, harness.runtime, {
      sessionId: 'founder-session', companyId: (await harness.store.readActive(harness.workspace))!.id, expectedRevision: 4,
      action: 'request_budget_change',
      payload: { model_prices: [{ provider: 'mock', model: 'mock-model', input_cache_miss_per_million: '0.28', input_cache_hit_per_million: '0.028', output_per_million: '0.42' }] },
    }, { remote: false })
    const pending = approvals.approvals.filter((approval) => approval.status === 'pending')
    assert.equal(pending.length, 1, 'pricing_change approval opened from the console')
    assert.equal(approvals.approvals[0]?.kind, 'pricing_change')
    assert.equal(harness.steered.length >= 1, true, 'founder is steered about the request')
  } finally {
    await harness.cleanup()
  }
})
