import assert from 'node:assert/strict'
import { execFile } from 'node:child_process'
import { appendFile, mkdir, mkdtemp, readFile, readdir, rename, rm, stat, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import test from 'node:test'
import { promisify } from 'node:util'
import { recordMoneyUsage } from '../src/money.js'
import { resolveConfig } from '../src/schemas.js'
import { CompanyStore } from '../src/state.js'
import { prepareStoredState, type StoredCompanyState } from '../src/state-history.js'
import type { CompanyState } from '../src/types.js'
import { companyState } from './fixtures.js'

const options = { actor: 'scheduler', type: 'test.storage', summary: 'Persist storage regression' }

function usage(state: CompanyState, seq: number): void {
  recordMoneyUsage(state, {
    sessionId: 'employee-session', eventSeq: seq, turn: 1, step: seq,
    employeeId: 'e1', provider: 'mock', model: 'mock-model',
    usage: { inputTokens: 10, outputTokens: 2 }, at: state.createdAt, allowUnpriced: true,
  })
}

async function fixture(rows = 0) {
  const base = await mkdtemp(join(tmpdir(), 'dsh-company-history-'))
  const workspace = join(base, 'workspace')
  await mkdir(workspace)
  const config = resolveConfig({ stateRoot: join(base, 'state') })
  const store = new CompanyStore(config)
  const paths = await store.pathsForCwd(workspace)
  const initial = companyState({ workspaceHash: paths.workspace.sha256 })
  for (let seq = 1; seq <= rows; seq += 1) usage(initial, seq)
  await store.createStaged(workspace, initial)
  return { base, workspace, config, store, paths, initial,
    disk: async () => JSON.parse(await readFile(paths.stateFile, 'utf8')) as StoredCompanyState,
    cleanup: () => rm(base, { recursive: true, force: true }) }
}

test('usage history appends only new facts while the hot aggregate stays bounded', async () => {
  const f = await fixture(1_000)
  try {
    const before = await f.disk()
    const usageFile = join(f.paths.activeDir, 'history', before._storage!.usage.file)
    const prefix = await readFile(usageFile, 'utf8')
    const beforeStat = await stat(usageFile)
    assert.deepEqual(before.moneyBudget.usage, [])
    assert.equal(before._storage?.usage.rows, 1_000)
    await f.store.transact(f.workspace, options, (state) => { state.mission = 'No usage change' })
    assert.equal((await stat(usageFile)).mtimeMs, beforeStat.mtimeMs, 'non-accounting writes do not rewrite usage')
    await f.store.transact(f.workspace, options, (state) => { usage(state, 1_001) })
    const after = await f.disk()
    assert.equal(after._storage?.usage.file, before._storage?.usage.file)
    const suffix = (await readFile(usageFile, 'utf8')).slice(prefix.length)
    assert.equal(suffix.trim().split('\n').length, 1)
    assert.match(suffix, /employee-session:1001/)
    assert.equal((await readFile(usageFile, 'utf8')).slice(0, prefix.length), prefix)
    assert.ok((await stat(f.paths.stateFile)).size < 20_000, 'hot JSON contains no historical usage rows')
    const fresh = new CompanyStore(f.config)
    assert.equal((await fresh.readActive(f.workspace))?.moneyBudget.usage.length, 1_001)
    await fresh.transact(f.workspace, options, (state) => { usage(state, 1_001) })
    assert.equal((await f.store.readActive(f.workspace))?.moneyBudget.usage.length, 1_001, 'persisted usage ids remain idempotent')
  } finally { await f.cleanup() }
})

test('cached views are immutable, stable across reads, and mutable APIs remain isolated', async () => {
  const f = await fixture(2)
  try {
    const first = await f.store.readActiveView(f.workspace)
    assert.equal(await f.store.readActiveView(f.workspace), first)
    assert.equal(f.store.readActiveViewSync(f.workspace), first)
    assert.ok(Object.isFrozen(first?.moneyBudget.usage[0]))
    assert.throws(() => { first!.employees[0]!.name = 'Corrupt cache' }, TypeError)
    const mutable = await f.store.readActive(f.workspace)
    mutable!.moneyBudget.usage.length = 0
    const sync = f.store.readActiveSync(f.workspace)
    sync!.mission = 'Mutable private copy'
    assert.equal((await f.store.readActiveView(f.workspace))?.moneyBudget.usage.length, 2)
    assert.equal((await f.store.readActiveView(f.workspace))?.mission, first?.mission)
    const committed = await f.store.transact(f.workspace, options, (state) => { state.mission = 'Committed'; return state.employees[0]! })
    committed.result.name = 'Mutated result reference'
    committed.state.mission = 'Mutated return copy'
    assert.equal((await f.store.readActiveView(f.workspace))?.mission, 'Committed')
    assert.equal((await f.store.readActiveView(f.workspace))?.employees[0]?.name, 'Engineer')
    assert.notEqual(await f.store.readActiveView(f.workspace), first)
    const cold = new CompanyStore(f.config)
    const concurrent = await Promise.all(Array.from({ length: 20 }, () => cold.readActiveView(f.workspace)))
    assert.ok(concurrent.every((state) => state === concurrent[0]), 'concurrent cold reads share one validated immutable snapshot')
  } finally { await f.cleanup() }
})

test('another process invalidates a warm cache and participates in the same revision lock', async () => {
  const f = await fixture(3)
  try {
    await f.store.readActiveView(f.workspace)
    const code = `import { CompanyStore } from './src/state.ts'; import { resolveConfig } from './src/schemas.ts';
      const store = new CompanyStore(resolveConfig({ stateRoot: process.env.TEST_COMPANY_STATE_ROOT }));
      await store.transact(process.env.TEST_COMPANY_WORKSPACE, { actor: 'scheduler', type: 'test.child', summary: 'External commit' }, state => { state.mission = 'Changed by another process' });`
    await promisify(execFile)(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code], {
      cwd: process.cwd(), env: { ...process.env, TEST_COMPANY_STATE_ROOT: f.config.stateRoot, TEST_COMPANY_WORKSPACE: f.workspace },
    })
    const current = await f.store.readActiveView(f.workspace)
    assert.equal(current?.mission, 'Changed by another process')
    assert.equal(current?.revision, 2)
    await f.store.transact(f.workspace, { ...options, expectedRevision: 2 }, (state) => { usage(state, 4) })
    const other = new CompanyStore(f.config)
    assert.equal(other.readActiveSync(f.workspace)?.moneyBudget.usage.length, 4)
  } finally { await f.cleanup() }
})

test('legacy inline usage reads without mutation and migrates on the next committed write', async () => {
  const f = await fixture(5)
  try {
    await writeFile(f.paths.stateFile, JSON.stringify(f.initial))
    const oldDisk = await readFile(f.paths.stateFile, 'utf8')
    const reader = new CompanyStore(f.config)
    assert.equal((await reader.readActive(f.workspace))?.moneyBudget.usage.length, 5)
    assert.equal(await readFile(f.paths.stateFile, 'utf8'), oldDisk, 'read alone does not rewrite legacy data')
    await reader.transact(f.workspace, options, (state) => { usage(state, 6) })
    assert.equal((await f.disk())._storage?.usage.rows, 6)
    assert.deepEqual((await f.store.readActive(f.workspace))?.moneyBudget.usage.slice(0, 5), f.initial.moneyBudget.usage)
  } finally { await f.cleanup() }
})

for (const crash of ['before-history', 'partial-history', 'after-state'] as const) {
  test(`v2 WAL recovers usage, mailbox and audit exactly once (${crash})`, async () => {
    const f = await fixture(3)
    try {
      const base = { state: (await f.store.readActive(f.workspace))!, stored: await f.disk() }
      const target = structuredClone(base.state)
      usage(target, 4)
      target.revision += 1
      target.counters.event += 1
      target.mission = 'Recovered split transaction'
      const auditLine = JSON.stringify({ schemaVersion: 1, id: 1, at: target.updatedAt, revision: 2, actor: 'scheduler', type: 'test.recover', summary: 'Committed history' })
      const prepared = prepareStoredState(target, base, { before: '', line: auditLine })
      const journal = JSON.stringify({ schemaVersion: 2, workspaceHash: f.paths.workspace.sha256, baseRevision: 1,
        state: prepared.stored, history: prepared.appends, auditContent: `${auditLine}\n`,
        mailboxes: [{ participantId: 'e1', messages: [{ id: '550e8400-e29b-41d4-a716-446655440010', from: 'founder', to: 'e1', content: 'recovered mail', createdAt: target.updatedAt, deliveryState: 'queued' }] }],
      })
      await writeFile(f.paths.transactionFile, journal)
      if (crash === 'partial-history') {
        const append = prepared.appends.find((entry) => entry.file.startsWith('usage-'))!
        await appendFile(join(f.paths.activeDir, 'history', append.file), append.content.slice(0, 12))
      }
      if (crash === 'after-state') {
        for (const append of prepared.appends) await appendFile(join(f.paths.activeDir, 'history', append.file), append.content)
        await writeFile(f.paths.stateFile, JSON.stringify(prepared.stored))
      }
      const cold = new CompanyStore(f.config)
      assert.equal(cold.readActiveSync(f.workspace)?.moneyBudget.usage.length, 4, 'sync WAL view overlays an unwritten or torn suffix')
      assert.equal((await cold.readActive(f.workspace))?.mission, target.mission)
      assert.equal((await cold.readMailbox(f.workspace, 'e1'))[0]?.content, 'recovered mail')
      assert.match(await readFile(f.paths.auditFile, 'utf8'), /test.recover/)
      await assert.rejects(readFile(f.paths.transactionFile), /ENOENT/)
      await writeFile(f.paths.transactionFile, journal)
      assert.equal((await new CompanyStore(f.config).readActive(f.workspace))?.moneyBudget.usage.length, 4)
      const disk = await f.disk()
      const log = await readFile(join(f.paths.activeDir, 'history', disk._storage!.usage.file), 'utf8')
      assert.equal(log.trim().split('\n').length, 4)
      const audit = await readFile(join(f.paths.activeDir, 'history', disk._storage!.audit!.file), 'utf8')
      assert.equal(audit.trim().split('\n').length, 1)
    } finally { await f.cleanup() }
  })
}

test('uncommitted torn suffix is ignored, but missing committed history is rejected', async () => {
  const f = await fixture(2)
  try {
    const disk = await f.disk()
    const file = join(f.paths.activeDir, 'history', disk._storage!.usage.file)
    await appendFile(file, '{"id":"torn')
    assert.equal((await new CompanyStore(f.config).readActive(f.workspace))?.moneyBudget.usage.length, 2)
    await f.store.transact(f.workspace, options, (state) => { usage(state, 3) })
    assert.equal((await readFile(file, 'utf8')).trim().split('\n').length, 3, 'next append replaces only the uncommitted suffix')
    await rm(file)
    await assert.rejects(new CompanyStore(f.config).readActive(f.workspace), /history is missing/)
    assert.throws(() => new CompanyStore(f.config).readActiveSync(f.workspace), /history is missing/)
  } finally { await f.cleanup() }
})

test('ordinary history write failure rolls back mailbox and audit without committing usage', async () => {
  const f = await fixture()
  try {
    const disk = await f.disk()
    await mkdir(join(f.paths.activeDir, 'history', disk._storage!.usage.file), { recursive: true })
    await assert.rejects(f.store.transact(f.workspace, options, async (state, io) => {
      usage(state, 1)
      state.mission = 'Must not commit'
      await io.writeMailbox('e1', [{ id: '550e8400-e29b-41d4-a716-446655440010', from: 'founder', to: 'e1', content: 'Must not commit', createdAt: state.updatedAt, deliveryState: 'queued' }])
    }), /EISDIR/)
    assert.equal((await f.store.readActive(f.workspace))?.revision, 1)
    assert.deepEqual(await f.store.readMailbox(f.workspace, 'e1'), [])
    assert.equal(await readFile(f.paths.auditFile, 'utf8'), '')
    await assert.rejects(readFile(f.paths.transactionFile), /ENOENT/)
  } finally { await f.cleanup() }
})

test('failed append after usage is written retries without duplicate usage or audit', async () => {
  const f = await fixture(1)
  try {
    await f.store.transact(f.workspace, options, () => undefined)
    const before = await f.disk()
    const auditFile = join(f.paths.activeDir, 'history', before._storage!.audit!.file)
    const auditBefore = await readFile(auditFile, 'utf8')
    const heldAudit = `${auditFile}.held`
    await rename(auditFile, heldAudit)
    await mkdir(auditFile)
    await assert.rejects(f.store.transact(f.workspace, { ...options, summary: 'Failed append' }, (state) => { usage(state, 2) }), /EISDIR/)
    assert.equal((await f.disk()).revision, before.revision)
    await rm(auditFile, { recursive: true })
    await rename(heldAudit, auditFile)
    await f.store.transact(f.workspace, { ...options, summary: 'Retried append' }, (state) => { usage(state, 2) })
    const after = await f.disk()
    assert.equal(after._storage!.usage.rows, 2)
    assert.equal((await new CompanyStore(f.config).readActive(f.workspace))!.moneyBudget.usage.length, 2)
    const audit = await readFile(auditFile, 'utf8')
    assert.ok(audit.startsWith(auditBefore))
    assert.equal(audit.trim().split('\n').length, 2)
    assert.doesNotMatch(audit, /Failed append/)
    assert.match(audit, /Retried append/)
  } finally { await f.cleanup() }
})

test('sync WAL views reject conflicting committed usage and ignore obsolete revisions', async () => {
  const f = await fixture(1)
  try {
    const base = { state: (await f.store.readActive(f.workspace))!, stored: await f.disk() }
    const result = await f.store.transact(f.workspace, options, (state) => { usage(state, 2) })
    const prepared = prepareStoredState(result.state, base)
    const journal = { schemaVersion: 2, workspaceHash: f.paths.workspace.sha256, baseRevision: base.state.revision,
      state: prepared.stored, history: prepared.appends, auditContent: await readFile(f.paths.auditFile, 'utf8'), mailboxes: [] }
    // Keep the exact committed audit reference, which prepareStoredState above
    // deliberately did not append while constructing this test journal.
    journal.state = await f.disk()
    const usageAppend = journal.history.find((entry) => entry.file.startsWith('usage-'))!
    usageAppend.content = usageAppend.content.replace('mock-model', 'fake-model')
    await writeFile(f.paths.transactionFile, JSON.stringify(journal))
    const reader = new CompanyStore(f.config)
    assert.throws(() => reader.readActiveSync(f.workspace), /conflicts with the already committed revision/)
    await assert.rejects(reader.readActive(f.workspace), /conflicts with the already committed revision/)
    const usageFile = join(f.paths.activeDir, 'history', journal.state._storage!.usage.file)
    assert.doesNotMatch(await readFile(usageFile, 'utf8'), /fake-model/)
    await rm(f.paths.transactionFile)
    usageAppend.content = usageAppend.content.replace('fake-model', 'mock-model')
    await f.store.transact(f.workspace, options, (state) => { state.mission = 'Newer committed revision' })
    await writeFile(f.paths.transactionFile, JSON.stringify(journal))
    assert.equal(reader.readActiveSync(f.workspace)?.mission, 'Newer committed revision')
    assert.equal((await reader.readActive(f.workspace))?.mission, 'Newer committed revision')
    await assert.rejects(readFile(f.paths.transactionFile), /ENOENT/)
  } finally { await f.cleanup() }
})

test('archive removes a cached active view and a new company cannot reuse it', async () => {
  const f = await fixture(2)
  try {
    const cached = await f.store.readActiveView(f.workspace)
    await f.store.archive(f.workspace)
    assert.equal(await f.store.readActiveView(f.workspace), undefined)
    assert.equal(f.store.readActiveViewSync(f.workspace), undefined)
    const next = companyState({ workspaceHash: f.paths.workspace.sha256, name: 'New company' })
    await f.store.createStaged(f.workspace, next)
    const current = await f.store.readActiveView(f.workspace)
    assert.notEqual(current, cached)
    assert.equal(current?.id, next.id)
    assert.equal(current?.moneyBudget.usage.length, 0)
    assert.equal((await f.store.readArchived(f.workspace))[0]?.moneyBudget.usage.length, 2)
  } finally { await f.cleanup() }
})

test('history and transaction symlinks are refused before reading external content', async () => {
  const f = await fixture(1)
  try {
    const disk = await f.disk()
    const historyFile = join(f.paths.activeDir, 'history', disk._storage!.usage.file)
    const external = join(f.base, 'external.jsonl')
    await rename(historyFile, external)
    await symlink(external, historyFile)
    await assert.rejects(new CompanyStore(f.config).readActive(f.workspace), /must not be a symbolic link/)
    assert.throws(() => new CompanyStore(f.config).readActiveSync(f.workspace), /must not be a symbolic link/)
    await rm(historyFile)
    await rename(external, historyFile)
    await writeFile(external, 'untrusted journal')
    await symlink(external, f.paths.transactionFile)
    await assert.rejects(f.store.readActive(f.workspace), /must not be a symbolic link/)
    assert.throws(() => f.store.readActiveSync(f.workspace), /must not be a symbolic link/)
    assert.equal(await readFile(external, 'utf8'), 'untrusted journal')
  } finally { await f.cleanup() }
})

test('historical edits keep old generations, and archive retains full usage and audit beyond the hot tail cap', async () => {
  const f = await fixture(3)
  try {
    const before = await f.disk()
    const oldFile = join(f.paths.activeDir, 'history', before._storage!.usage.file)
    const oldContent = await readFile(oldFile, 'utf8')
    await f.store.transact(f.workspace, options, (state) => { state.moneyBudget.usage[0]!.model = 'corrected-attribution'; state.limits.maxAuditBytes = 512 })
    const changed = await f.disk()
    assert.notEqual(changed._storage?.usage.file, before._storage?.usage.file)
    assert.equal(await readFile(oldFile, 'utf8'), oldContent)
    for (let index = 0; index < 5; index += 1) await f.store.transact(f.workspace, { ...options, summary: `Audit ${index} ${'detail '.repeat(200)}` }, () => undefined)
    await f.store.archive(f.workspace)
    const archived = (await f.store.readArchived(f.workspace))[0]!
    assert.equal(archived.moneyBudget.usage.length, 3)
    assert.equal(archived.moneyBudget.usage[0]?.model, 'corrected-attribution')
    const archiveDir = join(f.paths.archiveDir, archived.id)
    const disk = JSON.parse(await readFile(join(archiveDir, 'company.json'), 'utf8')) as StoredCompanyState
    const audit = await readFile(join(archiveDir, 'history', disk._storage!.audit!.file), 'utf8')
    assert.equal(audit.trim().split('\n').length, 7, 'complete audit survives a bounded UI tail and archive')
    assert.match(audit, new RegExp('detail '.repeat(150)), 'full history retains summaries too large for the hot tail')
    assert.ok((await stat(join(archiveDir, basename(f.paths.auditFile)))).size <= 512)
    assert.equal(await readFile(join(archiveDir, 'history', before._storage!.usage.file), 'utf8'), oldContent)
    assert.ok((await readdir(join(archiveDir, 'history'))).length >= 3)
  } finally { await f.cleanup() }
})

test('write pressure reports queued and active mutations and drains after failures', async () => {
  const f = await fixture()
  try {
    let release!: () => void
    let started!: () => void
    const entered = new Promise<void>((resolve) => { started = resolve })
    const gate = new Promise<void>((resolve) => { release = resolve })
    const first = f.store.transact(f.workspace, options, async () => { started(); await gate })
    await entered
    const second = f.store.transact(f.workspace, options, () => { throw new Error('Expected failure') })
    const failed = assert.rejects(second, /Expected failure/)
    for (let attempts = 0; attempts < 100 && f.store.getPressure().pendingWrites === 0; attempts += 1) await new Promise((resolve) => setTimeout(resolve, 1))
    assert.equal(f.store.getPressure().activeWrites, 1)
    assert.equal(f.store.getPressure().pendingWrites, 1)
    release()
    await first
    await failed
    assert.equal(f.store.getPressure().activeWrites, 0)
    assert.equal(f.store.getPressure().pendingWrites, 0)
    assert.ok(f.store.getPressure().lastWriteMs >= 0)
  } finally { await f.cleanup() }
})
