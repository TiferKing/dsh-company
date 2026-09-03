import assert from 'node:assert/strict'
import { mkdtemp, mkdir, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { installCompanyScheduler } from '../src/scheduler.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { companyState } from './fixtures.js'

test('a disappeared continuable can cold-recover the same open attempt repeatedly', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-scheduler-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  try {
    const founder = { id: 'founder-session', session: { header: { cwd: workspace } } } as any
    let followups = 0
    let employeeLive: { status: string } | undefined
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
    state.employees[0]!.status = 'working'
    state.workItems.push({
      id: 'w1',
      productId: 'p1',
      kind: 'design',
      subject: 'Recover design',
      objective: 'Keep the same attempt capability across cold recovery.',
      status: 'in_progress',
      assigneeId: 'e1',
      dependencies: [],
      inScope: [],
      outOfScope: [],
      acceptance: ['Same capability retained'],
      verify: [],
      deliverables: [],
      attempt: 1,
      attemptId: '550e8400-e29b-41d4-a716-446655440000',
      attemptHistory: [],
      createdAt: Date.now(),
      updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)

    const scheduler = installCompanyScheduler(ctx, config, store)
    await scheduler.kick(workspace, founder)
    employeeLive = undefined // simulate the accepted activation disappearing before the next drive
    await scheduler.kick(workspace, founder)

    const saved = await store.readActive(workspace)
    assert.equal(followups, 2)
    assert.equal(saved?.workItems[0]?.attemptId, '550e8400-e29b-41d4-a716-446655440000')
    assert.equal(saved?.workItems[0]?.status, 'in_progress')
    assert.equal(saved?.tokenBudget.usedTokens, 0)
    assert.equal(saved?.tokenBudget.reservedTokens, 128_000, 'accepted turn entitlement stays reserved until idle')
    await scheduler.dispose?.()
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
