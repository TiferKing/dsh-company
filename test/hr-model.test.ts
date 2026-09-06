import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { CompanyStore } from '../src/state.js'
import { resolveConfig } from '../src/schemas.js'
import { executeUiAction, parseActionRequest } from '../src/http.js'
import type { BootstrapInput } from '../src/types.js'

const routes = [
  { provider: 'founder-provider', model: 'founder-model' },
  { provider: 'founder-provider', model: 'another-model' },
  { provider: 'hr-provider', model: 'hr-model' },
  { provider: 'hr-provider', model: 'hr-backup' },
]
const proposal: BootstrapInput = {
  name: 'Model Choice Co', mission: 'Deliver a bounded product.', charter: 'Humans approve model selection.',
  totalBudgetMicros: 1_000_000, hrBudgetMicros: 1_000, currency: 'CNY',
  firstProduct: { name: 'Tool', summary: 'A bounded tool.', productRoot: 'tool', successCriteria: ['Pass'], budgetMicros: 1_000_000 },
  modelPrices: routes.map((route) => ({ ...route, inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 })),
}

async function harness() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-hr-model-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const started: any[] = []
  const founder: any = {
    id: 'founder-session', options: routes[0], steer: () => undefined,
    session: {
      header: { cwd: workspace, delegationDepth: 0 },
      requestHeader: () => ({ config: { ...routes[0], reasoningEffort: 'high' } }),
      deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
    },
  }
  const ctx: any = {
    agents: { get: (id: unknown) => String(id) === founder.id ? founder : undefined },
    llm: {
      listProviders: () => [{ id: 'founder-provider' }, { id: 'hr-provider' }],
      listModels: async () => [], // Explicit routes need not be advertised.
      resolveModelInfo: async (provider: string, model: string) => {
        if (!routes.some((route) => route.provider === provider && route.model === model)) throw new Error('unknown model route')
        return { provider, id: model, name: `Name of ${model}`, context: { contextWindow: model === 'hr-backup' ? 200 : 100 },
          reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'medium', name: 'Medium' }], defaultEffort: 'medium' } }
      },
      resolveCallConfig: async (selection: any) => {
        if (!routes.some((route) => route.provider === selection.provider && route.model === selection.model)) throw new Error('unknown model route')
        return selection
      },
    },
    subagents: {
      registerContinuableSetup: () => () => undefined,
      getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }),
      startContinuable: async (spec: any) => { started.push(spec); return { childId: spec.childId, messageId: `welcome-${started.length}` } },
      interrupt: () => undefined,
    },
    logger: { warn: () => undefined },
  }
  const config = resolveConfig({ stateRoot: join(base, 'state'), fallback: routes[3] })
  const store = new CompanyStore(config)
  const runtime = new CompanyRuntime(ctx, config, store)
  return { ctx, founder, store, runtime, workspace, started,
    state: async () => (await store.readActive(workspace))!, cleanup: () => rm(base, { recursive: true, force: true }) }
}

for (const [label, selection, expected, effort] of [
  ['explicit independent model', { hrProvider: 'hr-provider', hrModel: 'hr-model', hrReasoningEffort: 'medium' }, routes[2], 'medium'],
  ['model ID within Founder provider', { hrModel: 'another-model' }, routes[1], undefined],
  ['inherited Founder model', {}, routes[0], 'high'],
] as const) {
  test(`initial HR starts with its saved ${label}, including unadvertised paid routes`, async () => {
    const h = await harness()
    try {
      await h.runtime.bootstrap(h.founder, { ...proposal, ...selection })
      const state = await h.state()
      const hr = state.employees[0]!
      assert.equal(hr.llm.provider, expected!.provider)
      assert.equal(hr.llm.model, expected!.model)
      assert.equal(hr.llm.reasoningEffort, effort)
      for (const route of [expected!, routes[3]!]) {
        const metadata = state.modelCatalog.models.find((model) => model.provider === route.provider && model.model === route.model)!
        assert.equal(metadata.advertised, false)
        assert.equal(metadata.available, true)
        assert.ok(metadata.contextWindow! > 0)
        assert.deepEqual(metadata.reasoningEfforts?.map((option) => option.id), ['high', 'medium'])
      }
      h.founder.session.requestHeader = () => ({ config: { provider: 'changed-founder', model: 'changed-model' } })
      const operating = await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
      assert.equal(operating.phase, 'operating')
      assert.equal(operating.employees[0]!.budgetMicros, proposal.hrBudgetMicros)
      assert.deepEqual(h.started[0].request.agentOptions, expected, 'startup must not re-inherit a newer Founder route')
    } finally { await h.cleanup() }
  })
}

test('invalid or unpriced explicit HR models never silently substitute the Founder route', async () => {
  const h = await harness()
  try {
    await assert.rejects(() => h.runtime.bootstrap(h.founder, { ...proposal, hrProvider: 'hr-provider', hrModel: 'missing-model' }), /unknown model route/)
    assert.equal(await h.store.readActive(h.workspace), undefined)
    await h.runtime.bootstrap(h.founder, {
      ...proposal, hrProvider: 'hr-provider', hrModel: 'hr-model',
      modelPrices: proposal.modelPrices!.filter((price) => price.model !== 'hr-model'),
    })
    await assert.rejects(() => h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' }), /hr-provider\/hr-model.*price/)
    assert.equal(h.started.length, 0)
    assert.equal((await h.state()).employees[0]!.llm.model, 'hr-model')
  } finally { await h.cleanup() }
})

test('formation Web model selection refreshes primary and fallback metadata without changing the HR ceiling', async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, proposal)
    // A newly configured fallback also needs discovery during the edit.
    h.runtime.config.fallback = routes[1]
    const before = await h.state()
    await executeUiAction(h.ctx, h.runtime, parseActionRequest({
      sessionId: h.founder.id, companyId: before.id, expectedRevision: before.revision,
      action: 'edit_formation', payload: { hr_provider: 'hr-provider', hr_model: 'hr-model' },
    }), { remote: false })
    const saved = await h.state()
    assert.equal(saved.employees[0]!.llm.model, 'hr-model')
    assert.equal(saved.employees[0]!.llm.reasoningEffort, undefined)
    assert.equal(saved.employees[0]!.budgetMicros, before.employees[0]!.budgetMicros)
    for (const route of [routes[2]!, routes[1]!]) {
      const metadata = saved.modelCatalog.models.find((model) => model.provider === route.provider && model.model === route.model)!
      assert.equal(metadata.available, true)
      assert.equal(metadata.contextWindow, 100)
    }
    const operating = await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
    assert.equal(operating.phase, 'operating')
    assert.deepEqual(h.started[0].request.agentOptions, routes[2])
  } finally { await h.cleanup() }
})

test('editing HR reasoning after fallback preserves the currently effective model', async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, { ...proposal, hrProvider: 'hr-provider', hrModel: 'hr-model' })
    await h.store.transact(h.workspace, { actor: 'test', type: 'test.fallback', summary: 'Simulate a failed startup on fallback' }, (state) => {
      state.phase = 'provisioning_failed'
      Object.assign(state.employees[0]!.llm, { fallbackActive: true, activeProvider: 'hr-provider', activeModel: 'hr-backup' })
    })
    const edited = await h.runtime.editFormation(h.founder, { hrReasoningEffort: 'high' })
    assert.equal(edited.employees[0]!.llm.provider, 'hr-provider')
    assert.equal(edited.employees[0]!.llm.model, 'hr-backup')
    assert.equal(edited.employees[0]!.llm.reasoningEffort, 'high')
    assert.equal(edited.employees[0]!.budgetMicros, proposal.hrBudgetMicros)
  } finally { await h.cleanup() }
})
