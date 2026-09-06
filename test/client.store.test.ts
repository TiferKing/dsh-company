/// <reference lib="dom" />

import assert from 'node:assert/strict'
import test from 'node:test'
import { CompanyUiController } from '../src/client/store.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'
import { buildSnapshot } from '../src/snapshot.js'
import { companyState } from './fixtures.js'
import type { SnapshotQuery } from '../src/types.js'

test('organization restores every page and overview loads running employees independently of audit filters', async () => {
  const state = companyState()
  state.employees = Array.from({ length: 125 }, (_, index) => ({ ...structuredClone(state.employees[0]!), id: `e${index}`, name: `Employee ${index}`, sessionId: `session-${index}` }))
  const calls: SnapshotQuery[] = []
  let fail = false
  const controller = new CompanyUiController({ closedPollMs: 60_000, fetch: async (input) => {
    if (fail) return jsonResponse({ error: 'offline' }, 503)
    const query: Record<string, string | number> = {}
    for (const [key, value] of new URL(String(input), 'http://localhost').searchParams) {
      if (key === 'sessionId' || key === 'archived') continue
      query[key] = key.endsWith('Offset') || key.endsWith('Limit') ? Number(value) : value
    }
    calls.push(query as SnapshotQuery)
    const wire = buildSnapshot({ agents: { get: (id: string) => Number(id.split('-')[1]) >= 110 ? { status: 'running' } : undefined } } as any, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [], undefined, query as SnapshotQuery)
    return jsonResponse(wire)
  } })
  try {
    controller.setCurrentSession('founder-session')
    await controller.refresh()
    controller.setDirectoryQuery({ employeeSearch: 'Employee 1', employeeOffset: 10, employeeStatus: 'retired' })
    await controller.refresh()
    controller.setDirectoryView('organization')
    await controller.refresh()
    assert.equal(controller.getSnapshot().directoryView, 'organization')
    assert.equal(controller.getSnapshot().snapshot?.employees.length, 125)
    assert.equal(controller.getSnapshot().snapshot?.employees.at(-1)?.id, 'e124')
    assert.equal(calls.at(-1)?.employeeSearch, undefined)
    await controller.refresh('poll')
    assert.equal(controller.getSnapshot().snapshot?.employees.length, 125, 'polling must not replace the tree with its first page')

    controller.setDirectoryView('overview')
    await controller.refresh()
    assert.equal(controller.getSnapshot().snapshot?.employees[0]?.id, 'e0', 'activity filtering must preserve the primary employee page')
    assert.deepEqual(controller.getSnapshot().snapshot?.activity_employees?.map((employee) => employee.id), ['e110', 'e111', 'e112', 'e113', 'e114'])
    assert.equal(controller.getSnapshot().snapshot?.directory?.summary.running_employees, 15)
    controller.loadMoreActivity(10)
    await controller.refresh()
    assert.equal(controller.getSnapshot().snapshot?.activity_employees?.length, 10)
    assert.equal(controller.getSnapshot().snapshot?.activity_employees?.[0]?.id, 'e110')
    fail = true
    controller.loadMoreActivity(15)
    await controller.refresh()
    assert.equal(controller.getSnapshot().snapshot?.activity_employees?.length, 10, 'a failed load keeps the visible prefix')
    assert.equal(controller.getSnapshot().loading, false)
    fail = false
    await controller.refresh('retry')
    assert.equal(controller.getSnapshot().snapshot?.activity_employees?.length, 15)

    controller.setDirectoryView('page')
    await controller.refresh()
    assert.equal(calls.at(-1)?.employeeSearch, 'Employee 1', 'audit retains its own filters')
    controller.setDirectoryView('overview')
    await controller.refresh()
    assert.equal(controller.getSnapshot().snapshot?.activity_employees?.length, 5)
  } finally { controller.dispose() }
})

function jsonResponse(value: unknown, status = 200): Response {
  return new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  })
}

test('overview preserves the idle initial HR for formation editing', async () => {
  const state = companyState()
  state.employees[0]!.isHr = true
  const controller = new CompanyUiController({ closedPollMs: 60_000, fetch: async (input) => {
    const running = new URL(String(input), 'http://localhost').searchParams.get('employeeStatus') === 'running'
    return jsonResponse(buildSnapshot({ agents: { get: () => undefined } } as any, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [], undefined, running ? { employeeStatus: 'running', employeeLimit: 5 } : {}))
  } })
  try {
    controller.setCurrentSession('founder-session')
    await controller.refresh()
    for (const phase of ['staged', 'provisioning_failed'] as const) {
      state.phase = phase
      controller.setDirectoryView('overview')
      await controller.refresh()
      const hr = controller.getSnapshot().snapshot?.employees.find((employee) => employee.is_hr)
      assert.equal(hr?.name, state.employees[0]!.name)
      assert.equal(hr?.budget_micros, state.employees[0]!.budgetMicros)
      assert.equal(hr?.llm?.model, state.employees[0]!.llm.model)
    }
  } finally { controller.dispose() }
})

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

test('directory navigation sends server filters, invalidates page validators and rejects late pages', async () => {
  let resolveOldPage!: (response: Response) => void
  const calls: Array<{ query: URLSearchParams; validator: string | null }> = []
  const fetcher: typeof fetch = async (input, init) => {
    const query = new URL(String(input), 'http://localhost').searchParams
    calls.push({ query, validator: new Headers(init?.headers).get('if-none-match') })
    if (query.get('employeeOffset') === '50') return new Promise<Response>((resolve) => { resolveOldPage = resolve })
    const fixture = snapshotFixture(query.get('employeeOffset') === '100' ? 3 : 1)
    return new Response(JSON.stringify(fixture), { headers: { 'content-type': 'application/json', etag: '"page"' } })
  }
  const controller = new CompanyUiController({ fetch: fetcher, openPollMs: 60_000, closedPollMs: 60_000 })
  try {
    controller.setCurrentSession('founder-session')
    await controller.refresh()
    controller.setDirectoryQuery({ employeeOffset: 50, employeeSearch: 'Engineer', employeeStatus: 'active' })
    assert.equal(calls.at(-1)!.validator, null)
    assert.equal(calls.at(-1)!.query.get('employeeSearch'), 'Engineer')
    assert.equal(calls.at(-1)!.query.get('employeeStatus'), 'active')
    controller.setDirectoryQuery({ employeeOffset: 100 })
    await controller.refresh()
    assert.equal(controller.getSnapshot().snapshot?.revision, 3)
    resolveOldPage(jsonResponse(snapshotFixture(2)))
    await new Promise((resolve) => setTimeout(resolve, 0))
    assert.equal(controller.getSnapshot().snapshot?.revision, 3)
    await controller.refresh()
    assert.equal(calls.at(-1)!.validator, '"page"')
    controller.setCurrentSession('another-session')
    await controller.refresh()
    assert.equal(calls.at(-1)!.query.has('employeeOffset'), false)
  } finally { controller.dispose() }
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
