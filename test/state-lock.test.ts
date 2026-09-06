import assert from 'node:assert/strict'
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { unlinkSync, writeFileSync } from 'node:fs'
import { lstat, mkdtemp, readFile, readdir, readlink, rm, symlink, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { withFileLock as withLegacyFileLock } from '@deepseek-ai/dsh-atomic-write'
import { recoverAbandonedCompanyLock, withCompanyFileLock } from '../src/state-lock.js'

const linuxOnly = { skip: process.platform !== 'linux' }
const lockModule = new URL('../src/state-lock.ts', import.meta.url).href

async function fixture(t: { after: (cleanup: () => Promise<void>) => void }) {
  const dir = await mkdtemp(join(tmpdir(), 'dsh-company-lock-'))
  t.after(() => rm(dir, { recursive: true, force: true }))
  return { dir, file: join(dir, 'identity.json'), lock: join(dir, 'identity.json.lock') }
}

async function deadPid(): Promise<number> {
  const child = spawn(process.execPath, ['-e', 'process.exit(0)'], { stdio: 'ignore' })
  const pid = child.pid!
  await once(child, 'close')
  return pid
}

async function ownerContent(pid: number): Promise<string> {
  const scope = process.platform === 'linux'
    ? { platform: 'linux', bootId: (await readFile('/proc/sys/kernel/random/boot_id', 'utf8')).trim(), pidNamespace: await readlink('/proc/self/ns/pid') }
    : { platform: 'linux', bootId: '00000000-0000-0000-0000-000000000000', pidNamespace: 'pid:[1]' }
  return `${JSON.stringify({ version: 1, pid, scope })}\n`
}

async function startLockHolder(file: string) {
  const code = `import { withCompanyFileLock } from ${JSON.stringify(lockModule)};
    await withCompanyFileLock(process.argv[1], async () => {
      process.stdout.write('ready');
      await new Promise(() => { setInterval(() => {}, 1000) });
    });`
  const child = spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, file], { stdio: ['ignore', 'pipe', 'pipe'] })
  const closed = once(child, 'close')
  let stderr = ''
  child.stderr.on('data', (chunk) => { stderr += String(chunk) })
  await Promise.race([once(child.stdout, 'data'), closed.then(() => { throw new Error(`lock holder exited before ready: ${stderr}`) })])
  return { child, closed }
}

async function abandonedLock(file: string): Promise<{ pid: number; content: string }> {
  const { child, closed } = await startLockHolder(file)
  const content = await readFile(`${file}.lock`, 'utf8')
  child.kill('SIGKILL')
  await closed
  return { pid: child.pid!, content }
}

test('a writer quarantines a dead owner in the same boot and PID namespace without changing company data', linuxOnly, async (t) => {
  const { dir, file } = await fixture(t)
  await writeFile(file, '{"revision":7}')
  const { pid, content } = await abandonedLock(file)
  const metadata = JSON.parse(content)
  assert.equal(metadata.pid, pid)
  assert.equal(metadata.version, 1)
  assert.equal(metadata.scope.platform, 'linux')
  const recovered: number[] = []
  const value = await withCompanyFileLock(file, async () => readFile(file, 'utf8'), { waitMs: 1000, onRecovered: (owner) => recovered.push(owner) })
  assert.equal(value, '{"revision":7}')
  assert.deepEqual(recovered, [pid])
  const backups = (await readdir(dir)).filter((name) => name.startsWith('identity.json.lock.stale-'))
  assert.equal(backups.length, 1)
  assert.equal(await readFile(join(dir, backups[0]!), 'utf8'), content)
  assert.equal((await readdir(dir)).some((name) => name.includes('.recover-') || name === 'identity.json.lock'), false)
})

test('live owners, unknown owner checks and malformed locks are never recovered', async (t) => {
  const { file, lock } = await fixture(t)
  const ownContent = await ownerContent(process.pid)
  await writeFile(lock, ownContent)
  assert.equal(await recoverAbandonedCompanyLock(lock), undefined)
  assert.equal(await recoverAbandonedCompanyLock(lock, () => 'unknown'), undefined)
  for (const body of ['', '-1\n', '0\n', '9999999999\n', '42 extra\n', '1'.repeat(1025)]) {
    await writeFile(lock, body)
    assert.equal(await recoverAbandonedCompanyLock(lock, () => 'dead'), undefined)
    assert.equal(await readFile(lock, 'utf8'), body)
  }
  await writeFile(lock, ownContent)
  await assert.rejects(withCompanyFileLock(file, async () => assert.fail('live lock must stay exclusive'), { waitMs: 25 }), /timed out waiting/)
  assert.equal(await readFile(lock, 'utf8'), ownContent)
})

test('a symlink lock is not followed or quarantined', async (t) => {
  const { dir, lock } = await fixture(t)
  const target = join(dir, 'target')
  await writeFile(target, await ownerContent(await deadPid()))
  await symlink(target, lock)
  assert.equal(await recoverAbandonedCompanyLock(lock), undefined)
  assert.equal((await readdir(dir)).some((name) => name.includes('.stale-')), false)
  assert.ok((await readFile(target, 'utf8')).endsWith('\n'))
})

test('a changed lock is rechecked before quarantine and operation failures are not retried', linuxOnly, async (t) => {
  const { dir, file, lock } = await fixture(t)
  const pid = await deadPid()
  const content = await ownerContent(pid)
  const replacement = await ownerContent(process.pid)
  await writeFile(lock, content)
  let probes = 0
  assert.equal(await recoverAbandonedCompanyLock(lock, () => ++probes === 1 ? 'dead' : 'alive'), undefined)
  assert.equal(await readFile(lock, 'utf8'), content)
  // A second recovery candidate must be checked after taking the claim; the
  // old observation must not authorize moving a replacement writer's inode.
  let replaced = false
  await recoverAbandonedCompanyLock(lock, () => {
    if (!replaced) {
      unlinkSync(lock)
      writeFileSync(lock, replacement)
      replaced = true
    }
    return 'dead'
  })
  assert.equal(await readFile(lock, 'utf8'), replacement)
  assert.equal((await readdir(dir)).filter((name) => name.includes('.stale-')).length, 0)
  await rm(lock)
  let calls = 0
  await assert.rejects(withCompanyFileLock(file, async () => { calls++; throw new Error('atomic-write: timed out waiting for the writer lock inside operation') }), /inside operation/)
  assert.equal(calls, 1)
})

test('parallel processes reclaim once and preserve exclusive writer sections', linuxOnly, async (t) => {
  const { dir, file } = await fixture(t)
  await writeFile(file, '0')
  await abandonedLock(file)
  const code = `import { withCompanyFileLock } from ${JSON.stringify(lockModule)};
    import { readFile, writeFile } from 'node:fs/promises';
    const file = process.argv[1];
    for (let i = 0; i < 4; i++) await withCompanyFileLock(file, async () => {
      const before = Number(await readFile(file, 'utf8'));
      await new Promise(resolve => setTimeout(resolve, 10));
      await writeFile(file, String(before + 1));
    }, { waitMs: 10000 });`
  const children = Array.from({ length: 4 }, () => spawn(process.execPath, ['--import', 'tsx', '--input-type=module', '-e', code, file], { stdio: ['ignore', 'ignore', 'pipe'] }))
  await Promise.all(children.map(async (child) => {
    let stderr = ''
    child.stderr!.on('data', (chunk) => { stderr += String(chunk) })
    const [code] = await once(child, 'close')
    assert.equal(code, 0, stderr)
  }))
  assert.equal(await readFile(file, 'utf8'), '16')
  assert.equal((await readdir(dir)).filter((name) => name.includes('.stale-')).length, 1)
})

test('a process that exits while another writer waits is recovered on the next acquisition retry', linuxOnly, async (t) => {
  const { dir, file } = await fixture(t)
  const { child, closed } = await startLockHolder(file)
  t.after(async () => { child.kill() })
  const result = withCompanyFileLock(file, async () => 'acquired', { waitMs: 3000 })
  const timer = setTimeout(() => child.kill('SIGKILL'), 80)
  t.after(async () => { clearTimeout(timer) })
  assert.equal(await result, 'acquired')
  await closed
  assert.equal((await readdir(dir)).filter((name) => name.includes('.stale-')).length, 1)
})

test('an existing recovery claim fails closed instead of recursively removing recovery locks', linuxOnly, async (t) => {
  const { lock } = await fixture(t)
  const content = await ownerContent(await deadPid())
  await writeFile(lock, content)
  const info = await lstat(lock, { bigint: true })
  const fingerprint = `${info.dev}:${info.ino}:${info.size}:${info.mtimeNs}:${info.ctimeNs}`
  const key = createHash('sha256').update(fingerprint).update('\0').update(content).digest('hex').slice(0, 24)
  const claim = `${lock}.recover-${key}`
  await writeFile(claim, content)
  assert.equal(await recoverAbandonedCompanyLock(lock), undefined)
  assert.equal(await readFile(lock, 'utf8'), content)
  assert.equal(await readFile(claim, 'utf8'), content)
})

test('legacy PID locks, foreign scopes and tampered metadata never authorize automatic recovery', async (t) => {
  const { dir, lock } = await fixture(t)
  const pid = await deadPid()
  const owner = JSON.parse(await ownerContent(pid))
  const bodies = [
    `${pid}\n`,
    JSON.stringify({ ...owner, scope: { ...owner.scope, bootId: '11111111-1111-1111-1111-111111111111' } }),
    JSON.stringify({ ...owner, scope: { ...owner.scope, pidNamespace: 'pid:[99999999999999999]' } }),
    JSON.stringify({ ...owner, scope: { ...owner.scope, platform: 'win32' } }),
    JSON.stringify({ ...owner, scope: undefined }),
    JSON.stringify({ ...owner, version: 2 }),
    JSON.stringify({ ...owner, pid: String(pid) }),
    JSON.stringify({ ...owner, unexpected: true }),
    JSON.stringify({ ...owner, scope: { ...owner.scope, unexpected: true } }),
  ]
  for (const body of bodies) {
    await writeFile(lock, body)
    let probed = false
    assert.equal(await recoverAbandonedCompanyLock(lock, () => { probed = true; return 'dead' }), undefined)
    assert.equal(probed, false, 'out-of-scope locks must not be checked against the local PID table')
    assert.equal(await readFile(lock, 'utf8'), body)
  }
  assert.deepEqual(await readdir(dir), ['identity.json.lock'])
})

test('metadata locks remain mutually exclusive with the unmodified Host lock protocol', async (t) => {
  const { file } = await fixture(t)
  let entered!: () => void
  let release!: () => void
  const enteredPromise = new Promise<void>((resolve) => { entered = resolve })
  const releasePromise = new Promise<void>((resolve) => { release = resolve })
  const order: string[] = []
  const upgraded = withCompanyFileLock(file, async () => {
    order.push('upgraded-enter')
    entered()
    await releasePromise
    order.push('upgraded-exit')
  })
  await enteredPromise
  const legacy = withLegacyFileLock(file, async () => { order.push('legacy-enter') }, { waitMs: 1000 })
  await new Promise((resolve) => setTimeout(resolve, 30))
  assert.deepEqual(order, ['upgraded-enter'])
  release()
  await Promise.all([upgraded, legacy])
  assert.deepEqual(order, ['upgraded-enter', 'upgraded-exit', 'legacy-enter'])
})
