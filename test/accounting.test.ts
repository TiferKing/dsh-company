import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installCompanyAccounting } from '../src/accounting.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { releaseEmployeeMoneyReservations, reserveMoneyTurn } from '../src/money.js'
import { approvedTemporaryAuthorization, companyState } from './fixtures.js'
import { revokeTemporaryAuthorization } from '../src/authorizations.js'
import { createApproval } from '../src/approvals.js'
import type { CompanyState, WorkItem } from '../src/types.js'

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
    await handlers.get('session/flush')!(employee.session)
    let saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage[0]?.totalTokens, 30)
    assert.equal(saved?.moneyBudget.reservations[0]?.remainingTokens, 127_970, 'entitlement is context-window sized (128k) minus usage')
    assert.equal(saved?.moneyBudget.usage.length, 1)

    // Monetary admission may reject a new request, but an admitted request
    // never has its caller-selected output bound clamped by the reservation.
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
    assert.equal(saved?.moneyBudget.reservations.length, 0)

    // An unset max_tokens is never injected: the harness/provider resolve the
    // model's real output capability (a money-derived bound can exceed what
    // the upstream accepts, e.g. Console Go's [1, 393216]).
    await store.transact(workspace, { actor: 'scheduler', type: 'test.reserve', summary: 'Re-reserve' }, (fresh) => {
      reserveMoneyTurn(fresh, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    })
    const bareConfig = await onRequest({ agent: employee, turn: 3, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model' }))
    assert.equal('maxTokens' in bareConfig, false, 'unset max_tokens stays unset')
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('restored session history replays an uncommitted usage event before flush completes', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-replay-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const session = {
      id: 'employee-session', header: { cwd: workspace },
      events: [{ type: 'assistant/message', seq: 12, time: Date.now(), data: { turn: 2, step: 1, usage: { inputTokens: 4, outputTokens: 6 } } }],
    }
    const employee = { id: 'employee-session', session }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'employee-session' ? employee : undefined }, list: () => [] },
      subagents: { interrupt: () => undefined }, logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    await store.createStaged(workspace, state)
    const dispose = installCompanyAccounting(ctx, store, config)

    handlers.get('session/created')!(session)
    await handlers.get('session/flush')!(session)
    const saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage.find((entry) => entry.eventSeq === 12)?.totalTokens, 10)
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('accounting replay pre-deduplicates long history with one state read', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-dedup-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const now = Date.now()
    const events = Array.from({ length: 500 }, (_, index) => ({
      type: 'assistant/message', seq: index + 1, time: now + index,
      data: { turn: 1, step: index + 1, usage: { inputTokens: 1, outputTokens: 0 } },
    }))
    const session = { id: 'founder-session', header: { cwd: workspace }, events }
    const founder = { id: 'founder-session', options: { provider: 'mock', model: 'mock-model' }, session }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get: () => founder, list: () => [] }, subagents: { interrupt: () => undefined }, logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.usage = events.map((event) => ({
      id: `founder-session:${event.seq}`, sessionId: 'founder-session', eventSeq: event.seq,
      turn: 1, step: event.seq, employeeId: 'founder', provider: 'mock', model: 'mock-model',
      inputTokens: 1, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0,
      inputCacheMissTokens: 1, inputCacheHitTokens: 0, totalTokens: 1, costMicros: 0, priced: false,
      currency: 'USD', pricingRevision: 1, at: event.time,
    }))
    await store.createStaged(workspace, state)
    const originalRead = store.readActive.bind(store)
    let reads = 0
    ;(store as any).readActive = async (cwd: string | undefined) => { reads += 1; return originalRead(cwd) }
    const dispose = installCompanyAccounting(ctx, store, config)

    handlers.get('session/created')!(session)
    await handlers.get('session/flush')!(session)
    assert.equal(reads, 1, '500 already-accounted events must not launch 500 concurrent company.json parses')
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('missing historical employee reservation preserves tokens as unknown cost and pauses for review', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-reconcile-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const session = { id: 'employee-session', header: { cwd: workspace }, firstLiveSeq: 100, events: [] }
    const employee = { id: 'employee-session', session }
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'employee-session' ? employee : founder }, list: () => [] },
      subagents: { interrupt: () => undefined }, logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    await store.createStaged(workspace, companyState({ workspaceHash: paths.workspace.sha256 }))
    const dispose = installCompanyAccounting(ctx, store, config)
    handlers.get('session/event')!(session, { type: 'assistant/message', seq: 12, time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 3, outputTokens: 2 } } })
    await handlers.get('session/flush')!(session)

    const saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage[0]?.totalTokens, 5)
    assert.equal(saved?.moneyBudget.usage[0]?.priced, false)
    assert.equal(saved?.employees[0]?.status, 'paused')
    assert.equal(saved?.employees[0]?.operationalBlock?.code, 'COMPANY_ACCOUNTING_RECONCILIATION')
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('founder management calls are included in company spend without blocking conversation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-founder-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const session = { id: 'founder-session', header: { cwd: workspace }, events: [], requestHeader: () => ({ config: { provider: 'mock', model: 'mock-model' } }) }
    const founder = { id: 'founder-session', options: { provider: 'mock', model: 'mock-model' }, session }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get: () => founder, list: () => [] }, subagents: { interrupt: () => undefined }, logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 1_000_000, inputCacheHitMicrosPerMillion: 1_000_000, outputMicrosPerMillion: 1_000_000, source: 'manual', revision: 1, updatedAt: Date.now() }]
    await store.createStaged(workspace, state)
    const dispose = installCompanyAccounting(ctx, store, config)
    handlers.get('session/event')!(session, { type: 'assistant/message', seq: 20, time: Date.now(), data: { turn: 1, step: 1, usage: { inputTokens: 1, outputTokens: 1 } } })
    await handlers.get('session/flush')!(session)

    const saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage[0]?.employeeId, 'founder')
    assert.equal(saved?.moneyBudget.spentMicros, 2)
    await dispose()
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
    assert.equal(call.maxTokens, 1_000, 'the caller-set output max passes through monetary admission unchanged')
    const onEvent = handlers.get('session/event')!
    await onEvent(employee.session, {
      type: 'assistant/message', seq: 10, time: Date.now(),
      data: { turn: 1, step: 1, usage: { inputTokens: 90, outputTokens: 90 } },
    })
    await handlers.get('session/flush')!(employee.session)

    const saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage[0]?.totalTokens, 180)
    assert.equal(saved?.moneyBudget.spentMicros, 180)
    assert.equal(saved?.phase, 'operating')
    assert.equal(saved?.health.status, 'healthy')
    assert.equal(saved?.moneyBudget.reservedMicros, 0)
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('agent/request revalidates authorization and reservation after route resolution', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-fence-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const employee = { id: 'employee-session', session: { id: 'employee-session', header: { cwd: workspace } } }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get(id: unknown) { return String(id) === 'employee-session' ? employee : undefined } },
      subagents: { interrupt: () => undefined },
      logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.prices = []
    const now = Date.now()
    const authorization = approvedTemporaryAuthorization(state, {
      employeeId: 'e1', reason: 'Fence a provider request.', expiresAt: now + 60_000,
    }, { maxMs: 120_000 }, now)
    reserveMoneyTurn(state, {
      employeeId: 'e1', provider: 'unknown', model: 'approved-route',
      bypass: { authorizationId: authorization.id, bypassCompany: true, bypassProduct: true, bypassEmployee: true },
    }, now)
    await store.createStaged(workspace, state)
    const dispose = installCompanyAccounting(ctx, store, config)
    const onRequest = handlers.get('agent/request')!

    let releaseRoute!: () => void
    let routeStarted!: () => void
    const started = new Promise<void>((resolve) => { routeStarted = resolve })
    const routeGate = new Promise<void>((resolve) => { releaseRoute = resolve })
    const pending = onRequest({ agent: employee, turn: 1, step: 1 }, async () => {
      routeStarted()
      await routeGate
      return { provider: 'unknown', model: 'approved-route', maxTokens: 10 }
    })
    await started
    await store.transact(workspace, { actor: 'founder', type: 'test.revoke', summary: 'Revoke during route resolution' }, (fresh) => {
      revokeTemporaryAuthorization(fresh, authorization.id, 'Concurrent revocation.', Date.now())
    })
    releaseRoute()
    await assert.rejects(() => pending, /is revoked; its reservation is no longer executable/)

    await store.transact(workspace, { actor: 'founder', type: 'test.replace', summary: 'Replace reservation' }, (fresh) => {
      releaseEmployeeMoneyReservations(fresh, 'e1')
      fresh.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 0, inputCacheHitMicrosPerMillion: 0, outputMicrosPerMillion: 0, source: 'manual', revision: fresh.moneyBudget.pricingRevision, updatedAt: Date.now() }]
      reserveMoneyTurn(fresh, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    })
    let releaseSecond!: () => void
    let secondStarted!: () => void
    const secondReady = new Promise<void>((resolve) => { secondStarted = resolve })
    const secondGate = new Promise<void>((resolve) => { releaseSecond = resolve })
    const replaced = onRequest({ agent: employee, turn: 2, step: 1 }, async () => {
      secondStarted()
      await secondGate
      return { provider: 'mock', model: 'mock-model' }
    })
    await secondReady
    await store.transact(workspace, { actor: 'scheduler', type: 'test.swap', summary: 'Swap reservation during route resolution' }, (fresh) => {
      releaseEmployeeMoneyReservations(fresh, 'e1')
      reserveMoneyTurn(fresh, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
    })
    releaseSecond()
    await assert.rejects(() => replaced, /money reservation changed before provider request/)
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('non-company agent/request remains a transparent bypass', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-bypass-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const handlers = new Map<string, Function>()
    const outsider = { id: 'outsider', session: { header: { cwd: workspace } } }
    const ctx = {
      on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
      agents: { get: () => outsider }, subagents: { interrupt: () => undefined }, logger: { warn: () => undefined },
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const dispose = installCompanyAccounting(ctx, store, config)
    const call = await handlers.get('agent/request')!({ agent: outsider, turn: 1, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model', maxTokens: 7 }))
    assert.deepEqual(call, { provider: 'mock', model: 'mock-model', maxTokens: 7 })
    await dispose()
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
    const authorization = approvedTemporaryAuthorization(state, {
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
    await dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

async function accountingFixture(setup: (state: CompanyState) => void) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-attribution-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const handlers = new Map<string, Function>()
  const interrupted: string[] = []
  const warnings: string[] = []
  const founder = { id: 'founder-session', session: { header: { cwd: workspace } } }
  const employee = { id: 'employee-session', session: { id: 'employee-session', header: { cwd: workspace } } }
  const ctx = {
    on(name: string, handler: Function) { handlers.set(name, handler); return () => handlers.delete(name) },
    agents: { get(id: unknown) { return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employee : undefined } },
    subagents: { interrupt(id: unknown) { interrupted.push(String(id)) } },
    logger: { warn(message: string) { warnings.push(message) } },
  } as any
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const paths = await store.pathsForCwd(workspace)
  const state = companyState({ workspaceHash: paths.workspace.sha256 })
  setup(state)
  await store.createStaged(workspace, state)
  const dispose = installCompanyAccounting(ctx, store, config)
  return {
    store, workspace, state, interrupted, warnings,
    request: (beforeResolve?: () => Promise<void>) => handlers.get('agent/request')!({ agent: employee, turn: 1, step: 1 }, async () => {
      await beforeResolve?.()
      return { provider: 'mock', model: 'mock-model' }
    }),
    founderRequest: () => handlers.get('agent/request')!({ agent: founder, turn: 1, step: 1 }, async () => ({ provider: 'mock', model: 'mock-model' })),
    async usage(inputTokens: number, at = Date.now(), endTurnBeforeFlush = false) {
      handlers.get('session/event')!(employee.session, { type: 'assistant/message', seq: 99, time: at, data: { turn: 1, step: 1, usage: { inputTokens, outputTokens: 0 } } })
      if (endTurnBeforeFlush) handlers.get('session/event')!(employee.session, { type: 'turn/end', seq: 100, time: at, data: { turn: 1, reason: { kind: 'completed' } } })
      await handlers.get('session/flush')!(employee.session)
      return (await store.readActive(workspace))!
    },
    async close() { await dispose(); await rm(base, { recursive: true, force: true }) },
  }
}

function attributionWork(id: string, productId = 'p1'): WorkItem {
  return { id, productId, kind: 'implementation', subject: id, objective: 'Implement bounded work.', status: 'pending', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['verified'], verify: [], deliverables: [], attempt: 0, attemptHistory: [], createdAt: 1, updatedAt: 1 }
}

test('fresh request admission rejects a concurrent company pause even when its reservation survives', async () => {
  const fixture = await accountingFixture((state) => {
    state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  })
  try {
    await fixture.request()
    await assert.rejects(() => fixture.request(async () => {
      await fixture.store.transact(fixture.workspace, { actor: 'founder', type: 'test.pause', summary: 'Pause during route resolution while preserving reservation' }, (state) => {
        state.phase = 'paused'
        state.health = { status: 'manual_pause', reason: 'manual', resumable: true }
      })
    }), /company is paused/)
    assert.equal((await fixture.store.readActive(fixture.workspace))!.moneyBudget.reservations.length, 1)
    assert.deepEqual(await fixture.founderRequest(), { provider: 'mock', model: 'mock-model' })
    const saved = await fixture.usage(7)
    assert.equal(saved.phase, 'paused')
    assert.equal(saved.moneyBudget.spentMicros, 7, 'already admitted usage still settles after pause')
    assert.equal(fixture.warnings.length, 0)
  } finally { await fixture.close() }
})

test('an active reservation cannot bypass a non-operating company phase', async () => {
  const fixture = await accountingFixture((state) => { reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' }) })
  try {
    for (const phase of ['staged', 'paused', 'halted', 'provisioning_failed'] as const) {
      await fixture.store.transact(fixture.workspace, { actor: 'founder', type: 'test.phase', summary: `Set company ${phase}` }, (state) => {
        state.phase = phase
        state.health = { status: phase === 'paused' ? 'manual_pause' : phase === 'halted' ? 'halted' : 'healthy', resumable: true }
      })
      await assert.rejects(() => fixture.request(), new RegExp(`company is ${phase}`))
      assert.deepEqual(await fixture.founderRequest(), { provider: 'mock', model: 'mock-model' })
    }
  } finally { await fixture.close() }
})

test('paused, failed, retired, planned and operationally blocked employees cannot use retained reservations', async () => {
  const fixture = await accountingFixture((state) => { reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' }) })
  try {
    for (const status of ['paused', 'failed', 'retired', 'planned'] as const) {
      await fixture.store.transact(fixture.workspace, { actor: 'founder', type: 'test.employee', summary: `Set employee ${status}` }, (state) => { state.employees[0]!.status = status })
      await assert.rejects(() => fixture.request(), new RegExp(`employee e1 is ${status}`))
    }
    await fixture.store.transact(fixture.workspace, { actor: 'founder', type: 'test.block', summary: 'Retain an explicit operational block' }, (state) => {
      state.employees[0]!.status = 'idle'
      state.employees[0]!.operationalBlock = { kind: 'provider', code: 'AUTH', message: 'Credentials need repair.', at: Date.now() }
    })
    await assert.rejects(() => fixture.request(), /operationally blocked: AUTH/)
  } finally { await fixture.close() }
})

test('staffing and bootstrap welcome calls remain admissible through their actual provisioning transitions', async () => {
  const fixture = await accountingFixture((state) => {
    state.employees[0]!.status = 'provisioning'
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  })
  try {
    await fixture.request()
    await fixture.store.transact(fixture.workspace, { actor: 'founder', type: 'test.bootstrap', summary: 'Prepare bootstrap generation' }, (state) => {
      const approval = createApproval(state, 'founder', { kind: 'bootstrap', summary: 'Bootstrap', payload: { companyId: state.id, stagedRevision: state.revision } })
      approval.status = 'approved'
      approval.resolvedAt = Date.now()
      state.phase = 'provisioning'
      state.provisioning = { id: '12345678-1234-4234-8234-123456789abc', startedAt: Date.now(), approvalId: approval.id, employeeIds: ['e1'], reservationIds: [state.moneyBudget.reservations[0]!.id] }
    })
    await fixture.request()
    await fixture.store.transact(fixture.workspace, { actor: 'scheduler', type: 'test.durable', summary: 'Child is durable before operating commit' }, (state) => { state.employees[0]!.status = 'idle' })
    await fixture.request()
    await fixture.store.transact(fixture.workspace, { actor: 'scheduler', type: 'test.stale', summary: 'Retain a reservation outside the bootstrap generation' }, (state) => { state.provisioning!.reservationIds = ['22345678-1234-4234-8234-123456789abc'] })
    await assert.rejects(() => fixture.request(), /outside the current company provisioning generation/)
  } finally { await fixture.close() }
})

for (const endTurnBeforeFlush of [false, true]) {
  test(`late usage retains its captured work, product, authorization and price without consuming a replacement reservation${endTurnBeforeFlush ? ' after turn/end clears the route cache' : ''}`, async () => {
    const fixture = await accountingFixture((state) => {
      state.products[0]!.budgetMicros = 50_000_000
      state.products.push({ ...structuredClone(state.products[0]!), id: 'p2', name: 'Replacement product', productRoot: 'replacement' })
      state.counters.product = 2
      state.workItems.push(attributionWork('w1'), attributionWork('w2', 'p2'))
      state.counters.work = 2
      state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
      const now = Date.now()
      const authorization = approvedTemporaryAuthorization(state, { employeeId: 'e1', reason: 'Finish a bounded call.', expiresAt: now + 60_000 }, { maxMs: 60_000 }, now)
      reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1', bypass: { authorizationId: authorization.id, bypassCompany: true, bypassProduct: true, bypassEmployee: true } })
    })
    try {
      await fixture.request()
      const replacement = await fixture.store.transact(fixture.workspace, { actor: 'scheduler', type: 'test.replace', summary: 'Replace an in-flight reservation' }, (state) => {
        releaseEmployeeMoneyReservations(state, 'e1')
        state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 2_000_000
        reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w2' })
        return structuredClone(state.moneyBudget.reservations[0]!)
      })
      const saved = await fixture.usage(7, Date.now(), endTurnBeforeFlush)
      const entry = saved.moneyBudget.usage[0]!
      assert.equal(entry.costMicros, 7)
      assert.equal(entry.workId, 'w1')
      assert.equal(entry.productId, 'p1')
      assert.equal(entry.authorizationId, fixture.state.temporaryAuthorizations[0]!.id)
      assert.deepEqual(saved.moneyBudget.reservations[0], replacement.result)
      assert.equal(fixture.warnings.length, 0)
    } finally { await fixture.close() }
  })
}

test('retiring an employee while a provider call is running preserves its final factual usage', async () => {
  const fixture = await accountingFixture((state) => {
    state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model' })
  })
  try {
    await fixture.request()
    await fixture.store.transact(fixture.workspace, { actor: 'founder', type: 'test.retire', summary: 'Retire during a provider call' }, (state) => {
      releaseEmployeeMoneyReservations(state, 'e1')
      state.employees[0]!.status = 'retired'
    })
    const saved = await fixture.usage(7)
    assert.equal(saved.moneyBudget.spentMicros, 7)
    assert.equal(saved.moneyBudget.usage[0]!.employeeId, 'e1')
    assert.equal(saved.employees[0]!.status, 'retired')
    assert.equal(fixture.warnings.length, 0)
  } finally { await fixture.close() }
})

test('replay cannot assign an old event to a newer reservation and work item', async () => {
  const fixture = await accountingFixture((state) => {
    state.workItems.push(attributionWork('w1'))
    state.counters.work = 1
    state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
  })
  try {
    const saved = await fixture.usage(7, fixture.state.moneyBudget.reservations[0]!.createdAt - 1)
    assert.equal(saved.moneyBudget.usage[0]!.priced, false)
    assert.equal(saved.moneyBudget.usage[0]!.workId, undefined)
    assert.equal(saved.moneyBudget.usage[0]!.totalTokens, 7)
    assert.equal(saved.moneyBudget.reservations.length, 0)
    assert.equal(saved.employees[0]!.operationalBlock!.code, 'COMPANY_ACCOUNTING_RECONCILIATION')
  } finally { await fixture.close() }
})

test('replay preserves unknown cost when its fallback route cannot be established', async () => {
  const fixture = await accountingFixture((state) => {
    state.workItems.push(attributionWork('w1'))
    state.counters.work = 1
    state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
    state.moneyBudget.prices.push({ ...structuredClone(state.moneyBudget.prices[0]!), model: 'fallback', inputCacheMissMicrosPerMillion: 2_000_000 })
    state.modelCatalog.models.push({ ...structuredClone(state.modelCatalog.models[0]!), model: 'fallback' })
    reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', fallback: { provider: 'mock', model: 'fallback' }, workId: 'w1' })
  })
  try {
    const saved = await fixture.usage(7)
    assert.equal(saved.moneyBudget.usage[0]!.priced, false)
    assert.equal(saved.moneyBudget.usage[0]!.model, 'historical-unattributed-route')
    assert.equal(saved.moneyBudget.usage[0]!.workId, 'w1')
    assert.equal(saved.moneyBudget.usage[0]!.totalTokens, 7)
    assert.equal(saved.moneyBudget.spentMicros, 0)
    assert.equal(saved.moneyBudget.reservations.length, 0)
    assert.equal(saved.employees[0]!.operationalBlock!.code, 'COMPANY_ACCOUNTING_RECONCILIATION')
    assert.deepEqual(fixture.interrupted, ['employee-session'])
    assert.equal(fixture.warnings.length, 0)
  } finally { await fixture.close() }
})

test('an employee budget overrun interrupts its live agent and returns HR review delivery to the queue', async () => {
  const fixture = await accountingFixture((state) => {
    state.moneyBudget.totalMicros = 1_000
    state.products[0]!.budgetMicros = 1_000
    state.employees[0]!.budgetMicros = 10
    state.employees[0]!.status = 'working'
    state.modelCatalog.models[0]!.contextWindow = 5
    state.moneyBudget.prices[0]!.inputCacheMissMicrosPerMillion = 1_000_000
    state.moneyBudget.prices[0]!.outputMicrosPerMillion = 1_000_000
    const reservationId = reserveMoneyTurn(state, { employeeId: 'e1', provider: 'mock', model: 'mock-model', staffingRequestId: 'sr1' })
    state.staffingRequests.push({ id: 'sr1', action: 'hire', candidateName: 'Candidate', status: 'in_review', requestedBy: 'founder', workProfile: 'Implement work.', hrEmployeeId: 'e1', attemptId: '12345678-1234-4234-8234-123456789abc', reservationId, leaseAt: Date.now(), createdAt: 1, updatedAt: 1 })
    state.counters.staffing = 1
  })
  try {
    await fixture.request()
    const saved = await fixture.usage(11)
    assert.equal(saved.moneyBudget.spentMicros, 11)
    assert.equal(saved.phase, 'operating')
    assert.equal(saved.health.status, 'degraded')
    assert.equal(saved.employees[0]!.status, 'paused')
    assert.deepEqual(fixture.interrupted, ['employee-session'])
    assert.equal(saved.staffingRequests[0]!.status, 'pending')
    assert.equal(saved.staffingRequests[0]!.attemptId, undefined)
    assert.equal(saved.staffingRequests[0]!.reservationId, undefined)
    assert.equal(fixture.warnings.length, 0)
  } finally { await fixture.close() }
})
