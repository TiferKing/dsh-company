import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installCompanyAccounting } from '../src/accounting.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { releaseEmployeeMoneyReservations, reserveMoneyTurn } from '../src/money.js'
import { companyState } from './fixtures.js'
import { createTemporaryAuthorization, revokeTemporaryAuthorization } from '../src/authorizations.js'

test('Host request gate preserves per-turn entitlement and session usage is idempotent', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const employee = { id: 'employee-session', session: { id: 'employee-session', header: { cwd: workspace } } }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employee : undefined } },
      subagents: { interrupt: () => undefined },
      logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    await store.createStaged(workspace, state)
    const dispose = installCompanyAccounting(ctx, store, config)

    const onRequest = handlers.get('agent/request')!
    const firstConfig = await onRequest({ agent: employee, turn: 1, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model', maxTokens: 1_000 }))
    assert.equal(firstConfig.maxTokens, 1_000, 'a caller-set max_tokens passes through untouched')

    const onEvent = handlers.get('session/event')!
    const usageEvent = {
      type: 'assistant/message', seq: 9, time: Date.now(),
      data: { turn: 1, step: 1, usage: { inputTokens: 10, outputTokens: 20 } },
    }
    await onEvent(employee.session, usageEvent)
    await onEvent(employee.session, usageEvent)
    let saved = await store.readActive(workspace)
    assert.equal(saved?.tokenBudget.usedTokens, 30)
    assert.equal(saved?.tokenBudget.reservedTokens, 127_970, 'entitlement is context-window sized (128k) minus usage')
    assert.equal(saved?.tokenBudget.usage.length, 1)

    // Per-turn limits are post-hoc accounting only; the next call is never
    // truncated no matter how much entitlement remains.
    const secondConfig = await onRequest({ agent: employee, turn: 1, step: 2 }, async () => ({ provider: 'mock', model: 'mock-model', maxTokens: 1_000 }))
    assert.equal(secondConfig.maxTokens, 1_000, 'the reservation never clamps output')

    await store.transact(workspace, { actor: 'scheduler', type: 'test.release', summary: 'Release entitlement' }, (fresh) => {
      releaseEmployeeMoneyReservations(fresh, 'e1')
    })
    await assert.rejects(
      () => onRequest({ agent: employee, turn: 2, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model', maxTokens: 1_000 })),
      /was not captured by the reservation/,
    )
    saved = await store.readActive(workspace)
    assert.equal(saved?.tokenBudget.reservedTokens, 0)
    
    // An unset max_tokens is never injected: the harness/provider resolve the
    // model's real output capability (a money-derived bound can exceed what
    // the upstream accepts, e.g. Console Go's [1, 393216]).
    await store.transact(workspace, { actor: 'scheduler', type: 'test.reserve', summary: 'Re-reserve' }, (fresh) => {
      reserveMoneyTurn(fresh, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    })
    const bareConfig = await onRequest({ agent: employee, turn: 3, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model' }))
    assert.equal('maxTokens' in bareConfig, false, 'unset max_tokens stays unset')
    dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('prompt-inclusive headroom reserves context input plus output and settles the full factual usage', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-overrun-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const employee = { id: 'employee-session', session: { id: 'employee-session', header: { cwd: workspace } } }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employee : undefined } },
      subagents: { interrupt: () => undefined },
      logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.totalMicros = 190
    state.products[0]!.budgetMicros = 190
    state.employees[0]!.budgetMicros = 190
    state.modelCatalog.models[0]!.contextWindow = 90
    state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, source: 'manual', revision: 1, updatedAt: Date.now() }]
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    assert.equal(state.moneyBudget.reservedMicros, 180)
    await store.createStaged(workspace, state)
    const dispose = installCompanyAccounting(ctx, store, config)

    const onRequest = handlers.get('agent/request')!
    const call = await onRequest({ agent: employee, turn: 1, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model', maxTokens: 1_000 }))
    assert.equal(call.maxTokens, 1_000, 'the caller-set output max passes through; budgeting is purely post-hoc')
    const onEvent = handlers.get('session/event')!
    await onEvent(employee.session, {
      type: 'assistant/message', seq: 10, time: Date.now(),
      data: { turn: 1, step: 1, usage: { inputTokens: 90, outputTokens: 90 } },
    })

    const saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage[0]?.totalTokens, 180)
    assert.equal(saved?.moneyBudget.spentMicros, 180)
    assert.equal(saved?.phase, 'operating')
    assert.equal(saved?.health.status, 'healthy')
    assert.equal(saved?.moneyBudget.reservedMicros, 0)
    dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('authorized unknown-cost requests stay route-bound and stop immediately after revocation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-auth-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const employee = { id: 'employee-session', session: { id: 'employee-session', header: { cwd: workspace } } }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employee : undefined } },
      subagents: { interrupt: () => undefined },
      logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.prices = []
    const now = Date.now()
    const authorization = createTemporaryAuthorization(state, {
      employeeId: 'e1', reason: 'Test exact route and revocation fencing.', expiresAt: now + 60_000,
    }, { maxMs: 120_000 }, now)
    reserveMoneyTurn(state, {
      employeeId: 'e1', provider: 'unknown', model: 'approved-route',
      bypass: { authorizationId: authorization.id, bypassCompany: true, bypassProduct: true, bypassEmployee: true },
    }, now)
    await store.createStaged(workspace, state)
    const dispose = installCompanyAccounting(ctx, store, config)
    const onRequest = handlers.get('agent/request')!
    await assert.rejects(
      () => onRequest({ agent: employee, turn: 1, step: 1 }, async () => ({ provider: 'unknown', model: 'rogue-route', maxTokens: 10 })),
      /was not captured by the reservation/,
    )
    await store.transact(workspace, { actor: 'founder', type: 'test.revoke', summary: 'Revoke test grant' }, (fresh) => {
      revokeTemporaryAuthorization(fresh, authorization.id, 'Test revocation.', Date.now())
    })
    await assert.rejects(
      () => onRequest({ agent: employee, turn: 1, step: 2 }, async () => ({ provider: 'unknown', model: 'approved-route', maxTokens: 10 })),
      /is revoked; its reservation is no longer executable/,
    )
    dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
