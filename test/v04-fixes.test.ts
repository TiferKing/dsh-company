import assert from 'node:assert/strict'
import { mkdtemp, mkdir, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installCompanyAccounting } from '../src/accounting.js'
import { createApproval, pricingDigest, resolveApproval } from '../src/approvals.js'
import { reserveMoneyTurn } from '../src/money.js'
import { installCompanyScheduler } from '../src/scheduler.js'
import { normalizeModelPrices, resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import type { CompanyMessage } from '../src/types.js'
import { companyState } from './fixtures.js'

test('server-side model price normalization rejects partial three-rate triples', () => {
  assert.throws(
    () => normalizeModelPrices([{ provider: 'p', model: 'm', inputCacheMissMicrosPerMillion: 1 }], 'manual', 1, Date.now()),
    /all three rates or none/,
  )
})

test('pricing_change approval is digest/revision fenced and applies exactly once', () => {
  const state = companyState()
  const config = resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' })
  const payload = {
    currency: 'USD',
    expectedCurrency: 'USD',
    expectedPricingRevision: 1,
    expectedDigest: pricingDigest(state),
    prices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 2, inputCacheHitMicrosPerMillion: 3, outputMicrosPerMillion: 4 }],
  }
  const approval = createApproval(state, 'founder', { kind: 'pricing_change', summary: 'Reprice the mock route', payload })
  const applied = resolveApproval(state, config, {
    approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Approved this bounded reprice.',
  })
  assert.equal(applied.applied, true)
  assert.equal(applied.stale, false)
  assert.equal(state.moneyBudget.pricingRevision, 2)
  assert.equal(state.moneyBudget.prices[0]?.outputMicrosPerMillion, 4)
  assert.notEqual(approval.consumedAt, undefined)
  assert.throws(
    () => resolveApproval(state, config, { approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Again' }),
    /already approved/,
  )

  const staleState = companyState()
  const staleApproval = createApproval(staleState, 'founder', {
    kind: 'pricing_change',
    summary: 'Stale reprice',
    payload: {
      currency: 'USD',
      expectedCurrency: 'USD',
      expectedPricingRevision: 1,
      expectedDigest: pricingDigest(staleState),
      prices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 9, inputCacheHitMicrosPerMillion: 9, outputMicrosPerMillion: 9 }],
    },
  })
  staleState.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 8, inputCacheHitMicrosPerMillion: 8, outputMicrosPerMillion: 8, source: 'manual', revision: 2, updatedAt: Date.now() }]
  staleState.moneyBudget.pricingRevision = 2
  const stale = resolveApproval(staleState, config, {
    approvalId: staleApproval.id, decision: 'approved', source: 'tool', humanStatement: 'Approve anyway',
  })
  assert.equal(stale.applied, false)
  assert.equal(stale.stale, true)
  assert.equal(staleApproval.status, 'cancelled')
})

test('pricing_change currency is immutable after recorded usage', () => {
  const state = companyState()
  const config = resolveConfig({ stateRoot: '/tmp/dsh-company-test-state' })
  state.moneyBudget.usage.push({
    id: 'employee-session:1', sessionId: 'employee-session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1',
    provider: 'mock', model: 'mock-model', inputTokens: 1, outputTokens: 1, cacheReadTokens: 0, cacheWriteTokens: 0,
    reasoningTokens: 0, inputCacheMissTokens: 1, inputCacheHitTokens: 0, totalTokens: 2, costMicros: 0, priced: true,
    currency: 'USD', pricingRevision: 1, at: Date.now(),
  })
  state.moneyBudget.spentMicros = 0
  const approval = createApproval(state, 'founder', {
    kind: 'pricing_change',
    summary: 'Relabel currency',
    payload: {
      currency: 'CNY',
      expectedCurrency: 'USD',
      expectedPricingRevision: 1,
      expectedDigest: pricingDigest(state),
      prices: [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 2, inputCacheHitMicrosPerMillion: 3, outputMicrosPerMillion: 4 }],
    },
  })
  assert.throws(
    () => resolveApproval(state, config, { approvalId: approval.id, decision: 'approved', source: 'tool', humanStatement: 'Relabel it' }),
    /currency is immutable/,
  )
})

test('archive releases money reservations and consumes the forced-archive approval atomically', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-archive-money-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot: join(base, 'state') }))
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.moneyBudget.prices = [{ provider: 'mock', model: 'mock-model', inputCacheMissMicrosPerMillion: 10, inputCacheHitMicrosPerMillion: 10, outputMicrosPerMillion: 10, source: 'manual', revision: 1, updatedAt: Date.now() }]
    const approval = createApproval(state, 'founder', { kind: 'forced_archive', summary: 'Force archive with open work', payload: { reason: 'Cleanup with unfinished work' } })
    approval.status = 'approved'
    approval.resolvedAt = Date.now()
    await store.createStaged(workspace, state)
    await store.transact(workspace, { actor: 'scheduler', type: 'test.dispatch', summary: 'Open work with a money reservation' }, (fresh) => {
      fresh.workItems.push({
        id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Open', objective: 'Open work', status: 'claimed', assigneeId: 'e1',
        dependencies: [], inScope: ['product'], outOfScope: [], acceptance: ['Done'], verify: [], deliverables: [], attempt: 1,
        attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
      })
      fresh.counters.work = 1
      const reservationId = reserveMoneyTurn(fresh, { employeeId: 'e1', provider: 'mock', model: 'mock-model', workId: 'w1' })
      fresh.workItems[0]!.reservationId = reservationId
    })
    const before = await store.readActive(workspace)
    assert.equal(before?.moneyBudget.reservations.length, 1)
    assert.ok((before?.moneyBudget.reservedMicros ?? 0) > 0)

    const archived = await store.archive(workspace, undefined, approval.id)
    assert.equal(archived.moneyBudget.reservations.length, 0)
    assert.equal(archived.moneyBudget.reservedMicros, 0)
    assert.equal(archived.tokenBudget.reservations.length, 0)
    assert.equal(archived.tokenBudget.reservedTokens, 0)
    assert.equal(archived.workItems[0]?.status, 'cancelled')
    assert.equal(archived.workItems[0]?.reservationId, undefined)
    assert.notEqual(archived.approvals[0]?.consumedAt, undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('a failed archive burns neither the approval nor the reservation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-archive-fail-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot: join(base, 'state') }))
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    const approval = createApproval(state, 'founder', { kind: 'forced_archive', summary: 'Force archive', payload: { reason: 'Cleanup' } })
    approval.status = 'approved'
    approval.resolvedAt = Date.now()
    await store.createStaged(workspace, state)
    await assert.rejects(() => store.archive(workspace, undefined, 'a-does-not-exist'), /unknown approval/)
    const still = await store.readActive(workspace)
    assert.equal(still?.phase, 'operating')
    assert.equal(still?.approvals[0]?.consumedAt, undefined)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('mailbox writes are staged and discarded when the mutation fails', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-mail-stage-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot: join(base, 'state') }))
    const paths = await store.pathsForCwd(workspace)
    await store.createStaged(workspace, companyState({ workspaceHash: paths.workspace.sha256 }))
    const message: CompanyMessage = { id: '550e8400-e29b-41d4-a716-446655440000', from: 'founder', to: 'e1', content: 'hello', createdAt: Date.now(), deliveryState: 'queued' }
    await assert.rejects(() => store.transact(workspace, { actor: 'founder', type: 'test.fail', summary: 'boom' }, async (_state, io) => {
      await io.writeMailbox('e1', [message])
      throw new Error('intentional failure')
    }), /intentional failure/)
    assert.deepEqual(await store.readMailbox(workspace, 'e1'), [], 'failed mutation must not persist mailbox writes')

    await store.transact(workspace, { actor: 'founder', type: 'test.rw', summary: 'read-your-writes' }, async (_state, io) => {
      await io.writeMailbox('e1', [message])
      const read = await io.readMailbox('e1')
      assert.equal(read[0]?.content, 'hello', 'staged mailbox writes are visible to the same mutation')
    })
    assert.equal((await store.readMailbox(workspace, 'e1'))[0]?.content, 'hello')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('audit rows commit with the mutation and a failed mutation appends nothing', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-audit-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot: join(base, 'state') }))
    const paths = await store.pathsForCwd(workspace)
    await store.createStaged(workspace, companyState({ workspaceHash: paths.workspace.sha256 }))
    const auditLines = async () => (await readFile(paths.auditFile, 'utf8')).split('\n').filter((line) => line.trim() !== '')
    await store.transact(workspace, { actor: 'founder', type: 'test.update', summary: 'Committed mutation' }, (fresh) => { fresh.mission = 'Updated' })
    assert.equal((await auditLines()).length, 1)
    assert.match((await auditLines())[0] ?? '', /test\.update/)
    await assert.rejects(() => store.transact(workspace, { actor: 'founder', type: 'test.fail', summary: 'Failed mutation' }, () => {
      throw new Error('intentional failure')
    }), /intentional failure/)
    assert.equal((await auditLines()).length, 1, 'failed mutation must not append an audit row')
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('an idle employee with open work is re-driven with the same attempt', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-idle-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } } as any
    let followups = 0
    let employeeLive: { status: string } | undefined = { status: 'idle' }
    const ctx = {
      agents: {
        get(id: unknown) {
          return String(id) === 'founder-session' ? founder : String(id) === 'employee-session' ? employeeLive : undefined
        },
      },
      subagents: {
        followup: async () => {
          followups += 1
          employeeLive = { status: 'running' }
          return `message-${followups}`
        },
      },
      logger: { warn: () => undefined },
      on: () => () => undefined,
    } as any
    const config = resolveConfig({ stateRoot: join(base, 'state') })
    const store = new CompanyStore(config)
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.employees[0]!.status = 'idle'
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'design', subject: 'Continue design', objective: 'Ended without a terminal update',
      status: 'claimed', assigneeId: 'e1', dependencies: [], inScope: [], outOfScope: [], acceptance: ['Same capability'],
      verify: [], deliverables: [], attempt: 1, attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [],
      createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    let saved = await store.readActive(workspace)
    assert.equal(followups, 1)
    assert.equal(saved?.workItems[0]?.attemptId, '550e8400-e29b-41d4-a716-446655440000', 'same attempt capability is re-delivered')
    assert.equal(saved?.workItems[0]?.status, 'claimed')
    assert.equal(saved?.moneyBudget.reservations.length, 1, 'recovery re-reserves a turn')

    // Simulate the idle event releasing the reservation, then the employee
    // ending its turn again without a terminal update: it must be re-driven.
    await store.transact(workspace, { actor: 'scheduler', type: 'test.idle', summary: 'idle event' }, (fresh) => {
      fresh.moneyBudget.reservations = []
      fresh.moneyBudget.reservedMicros = 0
      fresh.tokenBudget.reservations = []
      fresh.tokenBudget.reservedTokens = 0
      fresh.employees[0]!.status = 'idle'
    })
    employeeLive = { status: 'idle' }
    await scheduler.kick(workspace, founder)
    saved = await store.readActive(workspace)
    assert.equal(followups, 2)
    assert.equal(saved?.workItems[0]?.attemptId, '550e8400-e29b-41d4-a716-446655440000')
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('factual usage beyond the reservation is persisted first and then halts the company', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-accounting-halt-'))
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
    const onEvent = handlers.get('session/event')!
    await onEvent(employee.session, {
      type: 'assistant/message', seq: 11, time: Date.now(),
      data: { turn: 1, step: 1, usage: { inputTokens: 90, outputTokens: 105 } },
    })
    const saved = await store.readActive(workspace)
    assert.equal(saved?.moneyBudget.usage.length, 1, 'overrun usage is preserved, never discarded')
    assert.equal(saved?.moneyBudget.spentMicros, 195)
    assert.equal(saved?.phase, 'halted')
    assert.equal(saved?.health.reason, 'money_budget')
    assert.equal(saved?.moneyBudget.reservedMicros, 0)
    assert.equal(saved?.moneyBudget.reservations.length, 0)
    assert.equal(saved?.employees[0]?.status, 'paused')
    assert.notEqual(saved?.employees[0]?.operationalBlock, undefined)
    dispose()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
