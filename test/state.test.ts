import assert from 'node:assert/strict'
import { mkdtemp, readFile, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore, RevisionConflictError } from '../src/state.js'
import { companyState } from './fixtures.js'

test('store no-clobber create and revision-fenced mutation', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-store-'))
  const workspace = join(base, 'workspace')
  const stateRoot = join(base, 'state')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot }))
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256, phase: 'staged', approvedAt: undefined })
    await store.createStaged(workspace, state)
    await assert.rejects(() => store.createStaged(workspace, state), /active company already exists/)

    const updated = await store.transact(workspace, {
      expectedRevision: 1,
      actor: 'founder',
      type: 'test.update',
      summary: 'Update mission',
    }, (fresh) => { fresh.mission = 'Updated mission' })
    assert.equal(updated.state.revision, 2)
    assert.equal(updated.state.counters.event, 1)
    await assert.rejects(() => store.transact(workspace, {
      expectedRevision: 1,
      actor: 'founder',
      type: 'test.stale',
      summary: 'stale',
    }, () => undefined), RevisionConflictError)
    const stored = JSON.parse(await readFile(paths.stateFile, 'utf8')) as { revision: number }
    assert.equal(stored.revision, 2)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('archive revokes open capabilities and reconciles prepared credits', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-archive-'))
  const workspace = join(base, 'workspace')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot: join(base, 'state') }))
    const paths = await store.pathsForCwd(workspace)
    const state = companyState({ workspaceHash: paths.workspace.sha256 })
    state.workItems.push({
      id: 'w1', productId: 'p1', kind: 'implementation', subject: 'Open', objective: 'Open work', status: 'in_progress', assigneeId: 'e1',
      dependencies: [], inScope: ['product'], outOfScope: [], acceptance: ['Done'], verify: [], deliverables: [], attempt: 1,
      attemptId: '550e8400-e29b-41d4-a716-446655440000', attemptHistory: [], createdAt: Date.now(), updatedAt: Date.now(),
    })
    state.counters.work = 1
    await store.createStaged(workspace, state)
    const archived = await store.archive(workspace)
    assert.equal(archived.phase, 'archived')
    assert.equal(archived.workItems[0]?.status, 'cancelled')
    assert.equal(archived.workItems[0]?.attemptId, undefined)
    assert.equal(archived.workItems[0]?.attemptHistory[0]?.status, 'cancelled')
    assert.equal(await store.readActive(workspace), undefined)
    assert.equal((await store.readArchived(workspace))[0]?.id, state.id)
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})

test('mailbox mutation is durable and recipient-scoped', async () => {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-mail-'))
  const workspace = join(base, 'workspace')
  const { mkdir } = await import('node:fs/promises')
  await mkdir(workspace)
  try {
    const store = new CompanyStore(resolveConfig({ stateRoot: join(base, 'state') }))
    const paths = await store.pathsForCwd(workspace)
    await store.createStaged(workspace, companyState({ workspaceHash: paths.workspace.sha256 }))
    await store.transact(workspace, { actor: 'founder', type: 'message.test', summary: 'mail' }, async (_state, io) => {
      await io.writeMailbox('e1', [{
        id: '550e8400-e29b-41d4-a716-446655440000', from: 'founder', to: 'e1', content: 'hello', createdAt: Date.now(), deliveryState: 'queued',
      }])
    })
    assert.equal((await store.readMailbox(workspace, 'e1'))[0]?.content, 'hello')
    assert.deepEqual(await store.readMailbox(workspace, 'founder'), [])
  } finally {
    await rm(base, { recursive: true, force: true })
  }
})
