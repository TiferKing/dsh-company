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
    now: () => 1_730_000_000_000,
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
      ? jsonResponse({ ok: false, code: 'invalid_transition', message: 'no company exists for this workspace' }, 422)
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
