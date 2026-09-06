import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { CompanyRuntime } from '../src/runtime.js'
import { CompanyStore } from '../src/state.js'
import { resolveConfig } from '../src/schemas.js'
import { reserveMoneyTurn } from '../src/money.js'
import { executeUiAction, parseActionRequest } from '../src/http.js'
import type { BootstrapInput } from '../src/types.js'

const proposal: BootstrapInput = {
  name: 'Independent HR Co', mission: 'Deliver a bounded product.', charter: 'Humans approve spending ceilings.',
  totalBudgetMicros: 1_000_000, hrBudgetMicros: 100_000, currency: 'CNY',
  firstProduct: { name: 'Tool', summary: 'A bounded tool.', productRoot: 'tool', successCriteria: ['Tests pass'], budgetMicros: 1_000_000 },
  modelPrices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0 }],
}

async function harness() {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-hr-budget-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  let starts = 0
  const founder: any = {
    id: 'founder-session', options: { provider: 'mock', model: 'mock-model' }, steer: () => undefined,
    session: {
      header: { cwd: workspace, delegationDepth: 0 },
      requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }),
      deriveMessages: () => [{ id: 'user-1', role: 'user', source: { kind: 'user' } }],
    },
  }
  const ctx: any = {
    agents: { get: (id: unknown) => String(id) === founder.id ? founder : undefined },
    llm: { resolveCallConfig: async (selection: unknown) => selection },
    subagents: {
      registerContinuableSetup: () => () => undefined,
      getProvider: () => ({ prepareContinuable: () => undefined, capabilities: { persona: true, toolFilter: true, depthLimit: true } }),
      startContinuable: async (spec: any) => { starts += 1; return { childId: spec.childId, messageId: `welcome-${starts}` } },
      interrupt: () => undefined,
    },
    logger: { warn: () => undefined },
  }
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const runtime = new CompanyRuntime(ctx, config, store)
  return {
    ctx, founder, store, runtime, workspace, starts: () => starts,
    state: async () => (await store.readActive(workspace))!,
    cleanup: () => rm(base, { recursive: true, force: true }),
  }
}

test('bootstrap requires an explicit bounded HR ceiling and does not allocate it twice', async () => {
  const h = await harness()
  try {
    for (const invalid of [undefined, -1, 0.5, 1_000_001, Number.MAX_SAFE_INTEGER + 1]) {
      await assert.rejects(() => h.runtime.bootstrap(h.founder, { ...proposal, hrBudgetMicros: invalid } as BootstrapInput), /hr_budget_micros/)
      assert.equal(await h.store.readActive(h.workspace), undefined)
    }
    await h.runtime.bootstrap(h.founder, proposal)
    const state = await h.state()
    assert.equal(state.employees[0]!.budgetMicros, 100_000)
    assert.equal(state.moneyBudget.totalMicros, 1_000_000)
    assert.equal(state.products[0]!.budgetMicros, 1_000_000, 'product and HR ceilings overlap')
    assert.equal(state.moneyBudget.spentMicros, 0)
    assert.equal(state.moneyBudget.reservedMicros, 0)
    assert.equal(h.starts(), 0)
  } finally { await h.cleanup() }
})

test('formation edits preserve HR authority and validate simultaneous budget changes atomically', async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, proposal)
    let state = await h.runtime.editFormation(h.founder, { totalBudgetMicros: 2_000_000 })
    assert.equal(state.employees[0]!.budgetMicros, 100_000)
    const before = state.revision
    await assert.rejects(() => h.runtime.editFormation(h.founder, {
      totalBudgetMicros: 50_000, firstProduct: { budgetMicros: 50_000 },
    }), /explicitly adjust hr_budget/)
    assert.equal((await h.state()).revision, before, 'a rejected edit has no partial effects')
    state = await h.runtime.editFormation(h.founder, {
      totalBudgetMicros: 50_000, hrBudgetMicros: 10_000, firstProduct: { budgetMicros: 50_000 },
    })
    assert.equal(state.moneyBudget.totalMicros, 50_000)
    assert.equal(state.employees[0]!.budgetMicros, 10_000)
    state = await h.runtime.editFormation(h.founder, { totalBudgetMicros: 2_000_000, hrBudgetMicros: 1_500_000 })
    assert.equal(state.employees[0]!.budgetMicros, 1_500_000, 'increasing both fields uses the final company ceiling')
    state = await h.runtime.editFormation(h.founder, { hrBudgetMicros: 0 })
    assert.equal(state.employees[0]!.budgetMicros, 0, 'zero is an explicit ceiling, never a fallback to total')
    const operating = await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
    assert.equal(operating.phase, 'operating')
    assert.equal(operating.employees[0]!.budgetMicros, 0, 'free models can start with a zero HR ceiling')
  } finally { await h.cleanup() }
})

test('paid HR startup cannot consume company funds beyond its independent ceiling', async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, { ...proposal, hrBudgetMicros: 0 })
    await h.store.transact(h.workspace, { actor: 'test', type: 'test.priced', summary: 'Set priced model context' }, (state) => {
      state.modelCatalog.stale = false
      state.modelCatalog.models[0]!.available = true
      state.modelCatalog.models[0]!.contextWindow = 100
      Object.assign(state.moneyBudget.prices[0]!, { inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 })
    })
    const revision = (await h.state()).revision
    await assert.rejects(() => h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' }), /Initial HR cannot start: employee money budget/)
    assert.equal(h.starts(), 0)
    assert.equal((await h.state()).revision, revision)
    assert.equal((await h.state()).moneyBudget.reservedMicros, 0, 'the admission probe cannot spend or reserve real funds')
    await h.runtime.editFormation(h.founder, { hrBudgetMicros: 200 })
    const operating = await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
    assert.equal(operating.phase, 'operating')
    assert.equal(operating.employees[0]!.budgetMicros, 200)
  } finally { await h.cleanup() }
})

test('formation cannot reduce HR below existing reservations', async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, proposal)
    await h.store.transact(h.workspace, { actor: 'test', type: 'test.reserved', summary: 'Reserve an HR call' }, (state) => {
      state.modelCatalog.stale = false
      state.modelCatalog.models[0]!.available = true
      state.modelCatalog.models[0]!.contextWindow = 100
      Object.assign(state.moneyBudget.prices[0]!, { inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000 })
      reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    })
    const before = await h.state()
    assert.equal(before.moneyBudget.reservedMicros, 200)
    await assert.rejects(() => h.runtime.editFormation(h.founder, { hrBudgetMicros: 199 }), /spent plus reserved/)
    assert.equal((await h.state()).revision, before.revision)
    const state = await h.runtime.editFormation(h.founder, { hrBudgetMicros: 200 })
    assert.equal(state.employees[0]!.budgetMicros, 200)
  } finally { await h.cleanup() }
})

test('web budget flow edits HR in ordinary currency units and approves employee-only changes', async () => {
  const h = await harness()
  try {
    await h.runtime.bootstrap(h.founder, proposal)
    const act = async (action: string, payload: Record<string, unknown>) => {
      const current = await h.state()
      return executeUiAction(h.ctx, h.runtime, parseActionRequest({
        sessionId: h.founder.id, companyId: current.id, expectedRevision: current.revision, action, payload,
      }), { remote: false })
    }
    await act('edit_formation', { hr_budget: 0.025001 })
    assert.equal((await h.state()).employees[0]!.budgetMicros, 25_001)
    await h.runtime.approveBootstrap(h.founder, 'Approve and start.', { source: 'ui' })
    const sessionId = (await h.state()).employees[0]!.sessionId
    h.founder.session.deriveMessages = () => []
    await act('request_budget_change', { employee_budgets: [{ employee_id: 'e1', budget: 0.01 }] })
    const pending = (await h.state()).approvals.find((approval) => approval.kind === 'budget_change' && approval.status === 'pending')!
    assert.deepEqual((pending.payload as any).employeeAllocations, [{ id: 'e1', budgetMicros: 10_000, expectedBudgetMicros: 25_001 }])
    assert.equal((await h.state()).employees[0]!.budgetMicros, 25_001, 'request alone cannot change spending authority')
    await act('resolve_approval', { approval_id: pending.id, decision: 'approved' })
    const saved = await h.state()
    assert.equal(saved.employees[0]!.budgetMicros, 10_000)
    assert.equal(saved.moneyBudget.totalMicros, proposal.totalBudgetMicros)
    assert.equal(saved.employees[0]!.sessionId, sessionId, 'budget-only approval preserves the live HR identity')
  } finally { await h.cleanup() }
})
