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
      firstProduct: { name: 'Tool', summary: 'One tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000, tokenBudget: 500_000 },
      totalBudgetMicros: 1_000_000, totalTokenBudget: 1_000_000, currency: 'CNY', draftedBy: 'ai',
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
