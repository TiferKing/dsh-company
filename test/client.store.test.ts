/// <reference lib="dom" />

import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanyUiController } from '../src/client/store.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

async function waitFor(predicate: () => boolean, timeoutMs = 2_000): Promise<void> {
  const deadline = Date.now() + timeoutMs
  while (!predicate()) {
    if (Date.now() >= deadline) throw new Error('timed out waiting for condition')
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

function abortableNever(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(signal.reason), { once: true })
  })
}

test('polls one current session, posts revision-bound actions, and retains stale data', async () => {
  let current = snapshotFixture(1)
  let failNextState = false
  const actionBodies: unknown[] = []
  const calls: string[] = []
  const fetcher: typeof fetch = async (input, init) => {
    const url = String(input)
    calls.push(url)
    if (url === '/plugins/dsh-company/action') {
      actionBodies.push(JSON.parse(String(init?.body)) as unknown)
      current = snapshotFixture(2)
      return jsonResponse({ ok: true, revision: 2, snapshot: current })
    }
    if (failNextState) {
      failNextState = false
      return jsonResponse({ error: 'Host restarting' }, 503)
    }
    return jsonResponse(current)
  }

  const controller = new CompanyUiController({
    fetch: fetcher,
    openPollMs: 60_000,
    closedPollMs: 60_000,
  })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('test')

  assert.equal(controller.getSnapshot().snapshot?.revision, 1)
  assert.equal(calls[0], '/plugins/dsh-company/state?sessionId=founder-session&archived=0')

  const succeeded = await controller.performAction('pause', { reason: 'Human pause' })
  assert.equal(succeeded, true)
  assert.equal(controller.getSnapshot().snapshot?.revision, 2)
  assert.deepEqual(actionBodies[0], {
    sessionId: 'founder-session',
    companyId: 'company-1',
    expectedRevision: 1,
    action: 'pause',
    payload: { reason: 'Human pause' },
  })

  failNextState = true
  await controller.refresh('transient-error')
  assert.equal(controller.getSnapshot().snapshot?.revision, 2)
  assert.equal(controller.getSnapshot().stale, true)
  assert.equal(controller.getSnapshot().networkError, 'Host restarting')
  controller.dispose()
})

test('reuses Host ETags and accepts 304 without reparsing a full snapshot', async () => {
  let calls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1
    if (calls === 1) return new Response(JSON.stringify(snapshotFixture(1)), { status: 200, headers: { 'content-type': 'application/json', etag: '"company-r1"' } })
    assert.equal(new Headers(init?.headers).get('if-none-match'), '"company-r1"')
    return new Response(null, { status: 304, headers: { etag: '"company-r1"' } })
  }
  const controller = new CompanyUiController({ fetch: fetcher, openPollMs: 60_000, closedPollMs: 60_000 })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('etag-first')
  await controller.refresh('etag-second')
  assert.equal(controller.getSnapshot().snapshot?.revision, 1)
  assert.equal(controller.getSnapshot().stale, false)
  controller.dispose()
})

test('switching back to a session fetches a representation before sending a validator', async () => {
  const fetcher: typeof fetch = async (_input, init) => {
    const etag = '"company-r1"'
    return new Headers(init?.headers).has('if-none-match')
      ? new Response(null, { status: 304, headers: { etag } })
      : new Response(JSON.stringify(snapshotFixture(1)), { status: 200, headers: { etag } })
  }
  const controller = new CompanyUiController({ fetch: fetcher, closedPollMs: 60_000 })
  try {
    for (const session of ['first-session', 'second-session', 'first-session']) {
      controller.setCurrentSession(session)
      await controller.refresh('session-switch')
      assert.equal(controller.getSnapshot().snapshot?.revision, 1)
      assert.equal(controller.getSnapshot().networkError, undefined)
    }
  } finally {
    controller.dispose()
  }
})

test('invalid representations cannot poison subsequent conditional requests', async () => {
  let calls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1
    if (calls === 1) return new Response(JSON.stringify({ schema_version: -1 }), { status: 200, headers: { etag: '"invalid"' } })
    assert.equal(new Headers(init?.headers).has('if-none-match'), false)
    return jsonResponse(snapshotFixture(2))
  }
  const controller = new CompanyUiController({ fetch: fetcher, closedPollMs: 60_000 })
  try {
    controller.setCurrentSession('founder-session')
    await controller.refresh('invalid-response')
    assert.match(controller.getSnapshot().networkError ?? '', /schema_version/)
    await controller.refresh('retry')
    assert.equal(controller.getSnapshot().snapshot?.revision, 2)
    assert.equal(controller.getSnapshot().networkError, undefined)
  } finally {
    controller.dispose()
  }
})

test('repulls authoritative state after a revision conflict', async () => {
  let revision = 1
  const fetcher: typeof fetch = async (input) => {
    if (String(input) === '/plugins/dsh-company/action') {
      revision = 2
      return jsonResponse({ ok: false, code: 'conflict', message: 'stale revision', revision }, 409)
    }
    return jsonResponse(snapshotFixture(revision))
  }

  const controller = new CompanyUiController({ fetch: fetcher })
  controller.setCurrentSession('founder-session')
  await controller.refresh('initial')
  assert.equal(await controller.performAction('pause', { reason: 'Pause' }), false)
  assert.equal(controller.getSnapshot().snapshot?.revision, 2)
  assert.equal(controller.getSnapshot().actionError, 'stale revision')
  controller.dispose()
})

test('a read started during a mutation cannot overwrite the successful action result', async () => {
  let reads = 0
  let finishAction: ((value: unknown) => void) | undefined
  let finishOldRead: ((value: Response) => void) | undefined
  const controller = new CompanyUiController({
    closedPollMs: 60_000,
    fetch: async () => {
      reads += 1
      if (reads === 2) return new Promise<Response>((resolve) => { finishOldRead = resolve })
      return jsonResponse(snapshotFixture(reads === 1 ? 1 : 2))
    },
    actionTransport: async () => new Promise<unknown>((resolve) => { finishAction = resolve }),
  })
  try {
    controller.setCurrentSession('founder-session')
    await controller.refresh('initial')
    const action = controller.performAction('pause', { reason: 'Pause' })
    const oldRead = controller.refresh('manual-during-action')
    assert.ok(finishAction)
    assert.ok(finishOldRead)
    finishAction(snapshotFixture(2))
    await waitFor(() => reads === 3 || controller.getSnapshot().snapshot?.revision === 2)
    finishOldRead(jsonResponse(snapshotFixture(1)))
    await oldRead
    assert.equal(await action, true)
    assert.equal(reads, 3, 'the action must start a fresh read after it completes')
    assert.equal(controller.getSnapshot().snapshot?.revision, 2)
  } finally {
    controller.dispose()
  }
})

test('does not let an old action refresh publish across a session generation', async () => {
  let stateCalls = 0
  let resolveOldRefresh: ((response: Response) => void) | undefined
  const fetcher: typeof fetch = async (input) => {
    if (String(input) === '/plugins/dsh-company/action') {
      return jsonResponse({ ok: true, revision: 2, snapshot: snapshotFixture(2) })
    }
    stateCalls += 1
    if (stateCalls === 2) {
      return new Promise<Response>((resolve) => {
        resolveOldRefresh = resolve
      })
    }
    return jsonResponse(snapshotFixture(stateCalls))
  }

  const controller = new CompanyUiController({ fetch: fetcher })
  controller.setCurrentSession('first-session')
  await controller.refresh('initial')
  const action = controller.performAction('pause', { reason: 'Pause' })
  for (let index = 0; index < 20 && resolveOldRefresh === undefined; index += 1) {
    await Promise.resolve()
  }
  assert.notEqual(resolveOldRefresh, undefined)

  controller.setCurrentSession('second-session')
  await controller.refresh('new-session')
  resolveOldRefresh?.(jsonResponse(snapshotFixture(2)))

  assert.equal(await action, false)
  assert.equal(controller.getSnapshot().sessionId, 'second-session')
  assert.equal(controller.getSnapshot().snapshot?.revision, 3)
  controller.dispose()
})

test('falls back to an immutable archived snapshot after active state is absent', async () => {
  const archived = snapshotFixture(7)
  ;(archived.company as Record<string, unknown>).phase = 'archived'
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    return url.endsWith('archived=0')
      ? jsonResponse({ ok: false, code: 'company_not_found', message: 'no company exists for this workspace' }, 404)
      : jsonResponse(archived)
  }

  const controller = new CompanyUiController({ fetch: fetcher })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('test')

  assert.equal(controller.getSnapshot().archived, true)
  assert.equal(controller.getSnapshot().snapshot?.company.phase, 'archived')
  assert.deepEqual(calls, [
    '/plugins/dsh-company/state?sessionId=founder-session&archived=0',
    '/plugins/dsh-company/state?sessionId=founder-session&archived=1',
  ])
  controller.dispose()
})

test('connection reset aborts an in-flight action, clears busy state, and restores polling', async () => {
  let revision = 1
  const fetcher: typeof fetch = async () => jsonResponse(snapshotFixture(revision))
  const controller = new CompanyUiController({
    fetch: fetcher,
    closedPollMs: 60_000,
    actionTransport: async (_request, signal) => abortableNever(signal),
  })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('initial')

  const action = controller.performAction('pause', { reason: 'Pause' })
  await waitFor(() => controller.getSnapshot().action === 'pause')
  revision = 2
  controller.connectionReset()
  await waitFor(() => controller.getSnapshot().snapshot?.revision === 2)

  assert.equal(await action, false)
  assert.equal(controller.getSnapshot().action, undefined)
  assert.equal(controller.getSnapshot().actionError, undefined)
  assert.notEqual((controller as unknown as { timer?: unknown }).timer, undefined, 'reset refresh must arm polling again')
  controller.dispose()
})

test('GET timeout preserves the last snapshot as stale and completes loading', async () => {
  let calls = 0
  const fetcher: typeof fetch = async (_input, init) => {
    calls += 1
    if (calls === 1) return jsonResponse(snapshotFixture(1))
    void init
    return new Promise<Response>(() => undefined)
  }
  const controller = new CompanyUiController({
    fetch: fetcher,
    requestTimeoutMs: 20,
    closedPollMs: 60_000,
  })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('initial')
  await controller.refresh('timeout')

  assert.equal(controller.getSnapshot().snapshot?.revision, 1)
  assert.equal(controller.getSnapshot().stale, true)
  assert.equal(controller.getSnapshot().loading, false)
  assert.match(controller.getSnapshot().networkError ?? '', /timed out/)
  controller.dispose()
})

test('POST timeout clears busy state and permits a retry with an expected revision override', async () => {
  let current = snapshotFixture(1)
  let attempts = 0
  const requests: unknown[] = []
  const controller = new CompanyUiController({
    fetch: async () => jsonResponse(current),
    actionTimeoutMs: 20,
    closedPollMs: 60_000,
    actionTransport: async (request, signal) => {
      attempts += 1
      requests.push(request)
      if (attempts === 1) {
        void signal
        return new Promise<never>(() => undefined)
      }
      current = snapshotFixture(2)
      return current
    },
  })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('initial')

  assert.equal(await controller.performAction('pause', { reason: 'First attempt' }), false)
  assert.equal(controller.getSnapshot().action, undefined)
  assert.match(controller.getSnapshot().actionError ?? '', /timed out/)
  assert.equal(await controller.performAction('pause', { reason: 'Retry' }, 7), true)
  assert.equal((requests[1] as { expectedRevision: number }).expectedRevision, 7)
  assert.equal(controller.getSnapshot().snapshot?.revision, 2)
  controller.dispose()
})

test('session_not_found does not fall back to archive and retains stale data', async () => {
  let fail = false
  const calls: string[] = []
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    calls.push(url)
    return fail
      ? jsonResponse({ ok: false, code: 'not_found', message: 'sessionId does not identify an exact live agent' }, 404)
      : jsonResponse(snapshotFixture(1))
  }
  const controller = new CompanyUiController({ fetch: fetcher, closedPollMs: 60_000 })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('initial')
  fail = true
  await controller.refresh('missing-session')

  assert.equal(calls.some((url) => url.endsWith('archived=1')), false)
  assert.equal(controller.getSnapshot().snapshot?.revision, 1)
  assert.equal(controller.getSnapshot().stale, true)
  assert.match(controller.getSnapshot().networkError ?? '', /exact live agent/)
  controller.dispose()
})

test('a closed live company always polls at closedPollMs', async () => {
  let calls = 0
  const controller = new CompanyUiController({
    fetch: async () => {
      calls += 1
      return jsonResponse(snapshotFixture(calls))
    },
    openPollMs: 60_000,
    closedPollMs: 500,
  })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('initial')

  await waitFor(() => calls >= 2, 1_100)
  assert.equal(controller.getSnapshot().snapshot?.revision, 2)
  controller.dispose()
})

test('an archived snapshot polls slowly and discovers a new active company', async () => {
  const archived = snapshotFixture(7)
  ;(archived.company as Record<string, unknown>).phase = 'archived'
  let activeAvailable = false
  const fetcher: typeof fetch = async (input) => {
    const url = String(input)
    if (url.endsWith('archived=1')) return jsonResponse(archived)
    return activeAvailable
      ? jsonResponse(snapshotFixture(8))
      : jsonResponse({ ok: false, code: 'company_not_found', message: 'no company exists for this workspace' }, 404)
  }
  const controller = new CompanyUiController({ fetch: fetcher, openPollMs: 60_000, closedPollMs: 500 })
  controller.setVisible(false)
  controller.setCurrentSession('founder-session')
  controller.setVisible(true)
  await controller.refresh('initial')
  assert.equal(controller.getSnapshot().archived, true)
  controller.open('founder-session')
  await controller.refresh('opened-archive')

  activeAvailable = true
  await waitFor(() => controller.getSnapshot().snapshot?.revision === 8, 1_100)
  assert.equal(controller.getSnapshot().archived, false)
  controller.dispose()
})
