import assert from 'node:assert/strict'
import test from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import { apply } from '../src/client/index.js'
import { CompanyButton } from '../src/client/CompanyButton.js'
import { CompanyDrawer } from '../src/client/CompanyDrawer.js'
import { CompanyUiController } from '../src/client/store.js'
import { en, type CompanyTranslate } from '../src/client/locales.js'
import type { CompanyClientInjected, LocaleLike } from '../src/client/contracts.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'

;(globalThis as typeof globalThis & { React: typeof React }).React = React

const sessionId = 'founder-session' as SessionId
const localeState = { active: 'en', revision: 0 } as const
const locale: LocaleLike = { getSnapshot: () => localeState, subscribe: () => () => undefined }
const t: CompanyTranslate = (key, params = {}) => Object.entries(params).reduce(
  (value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), en[key],
)
const json = (body: unknown, status = 200): Response => new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } })
const absent = (): Response => json({ code: 'company_not_found', message: 'no company exists for this workspace' }, 404)

function injected(controller: CompanyUiController): CompanyClientInjected {
  return { controller, locale, t, navigateToSession: async () => undefined }
}

function button(controller: CompanyUiController, target = sessionId): string {
  return renderToStaticMarkup(createElement(CompanyButton, { ...injected(controller), sessionId: target }))
}

test('cold-start loading and timeout keep an entry that opens visible retry diagnostics', async () => {
  let recovered = false
  const controller = new CompanyUiController({
    fetch: async () => recovered ? json(snapshotFixture()) : new Promise<Response>(() => undefined),
    requestTimeoutMs: 10,
    closedPollMs: 60_000,
  })
  try {
    controller.setCurrentSession(sessionId)
    assert.match(button(controller), /<button/)
    assert.match(button(controller), /Connecting/)
    await controller.refresh()
    assert.match(button(controller), /Connection issue/)
    assert.equal(controller.getSnapshot().companyAbsent, false)
    assert.match(controller.getSnapshot().networkError ?? '', /timed out/)

    controller.open(sessionId)
    const drawer = renderToStaticMarkup(createElement(CompanyDrawer, {
      ...injected(controller),
      useSessions: (selector) => selector({ current: sessionId } as SessionListState),
    }))
    assert.match(drawer, /role="dialog"/)
    assert.match(drawer, /timed out/)
    assert.match(drawer, /aria-label="Refresh"/)
    assert.doesNotMatch(drawer, /There is no company for this session/)
    await controller.refresh()

    recovered = true
    await controller.refresh()
    assert.equal(controller.getSnapshot().networkError, undefined)
    assert.match(button(controller), /Bounded Labs/)
    assert.doesNotMatch(button(controller), /Connection issue/)
  } finally { controller.dispose() }
})

test('only confirmed company absence hides the entry, without flashing on discovery polls', async () => {
  let reads = 0
  let finishRead: ((response: Response) => void) | undefined
  const controller = new CompanyUiController({
    fetch: async () => {
      reads += 1
      return reads === 3 ? new Promise<Response>((resolve) => { finishRead = resolve }) : absent()
    },
    closedPollMs: 60_000,
  })
  try {
    controller.setCurrentSession(sessionId)
    await controller.refresh()
    assert.equal(reads, 2, 'both active and archived company lookups are absent')
    assert.equal(controller.getSnapshot().companyAbsent, true)
    assert.equal(button(controller), '')
    const pending = controller.refresh()
    assert.equal(controller.getSnapshot().loading, true)
    assert.equal(button(controller), '', 'known absence should not flash a button at every poll')
    finishRead!(json(snapshotFixture()))
    await pending
    assert.equal(controller.getSnapshot().companyAbsent, false)
    assert.match(button(controller), /<button/)
    assert.equal(button(controller, 'other-session' as SessionId), '', 'a stale session header must not borrow current data')
  } finally { controller.dispose() }
})

test('cold session, unavailable route and malformed snapshot remain diagnosable and recover after reset', async () => {
  for (const failure of [
    () => json({ error: 'session_not_found', message: 'sessionId does not identify an exact live agent' }, 404),
    () => json({ message: 'Host restarting' }, 503),
    () => json({ schema_version: -1 }),
  ]) {
    let recovered = false
    const controller = new CompanyUiController({ fetch: async () => recovered ? json(snapshotFixture()) : failure(), closedPollMs: 60_000 })
    try {
      controller.setCurrentSession(sessionId)
      await controller.refresh()
      assert.match(button(controller), /Connection issue/)
      assert.equal(controller.getSnapshot().companyAbsent, false)
      recovered = true
      controller.connectionReset()
      await controller.refresh()
      assert.ok(controller.getSnapshot().snapshot)
      assert.match(button(controller), /<button/)
    } finally { controller.dispose() }
  }
})

test('plugin session discovery starts without mounting either React slot and unsubscribes on disposal', async () => {
  const originalFetch = globalThis.fetch
  const listeners = new Set<() => void>()
  const effects = new Map<string, () => (() => void) | void>()
  const slots: Array<{ id: string; inject(): CompanyClientInjected }> = []
  let current: SessionId | undefined = sessionId
  const requests: string[] = []
  globalThis.fetch = async (input) => { requests.push(String(input)); return json(snapshotFixture()) }
  const ctx = {
    effect: (effect: () => (() => void) | void, label: string) => { effects.set(label, effect) },
    on: () => undefined,
    locale: { ...locale, bind: () => t },
    sessions: {
      list: {
        getSnapshot: () => ({ current }),
        subscribe: (listener: () => void) => { listeners.add(listener); return () => { listeners.delete(listener) } },
      },
    },
    slots: {
      inject: (_name: string, register: () => void) => register(),
      register: (registration: { id: string; inject(): CompanyClientInjected }) => { slots.push(registration) },
    },
  }
  let disposeDiscovery: (() => void) | void = undefined
  let controller: CompanyUiController | undefined
  try {
    apply(ctx as any)
    controller = slots.find((slot) => slot.id === 'dsh-company-card')!.inject().controller
    disposeDiscovery = effects.get('dsh-company: current session discovery')!()
    await controller.refresh()
    assert.equal(controller.getSnapshot().sessionId, sessionId)
    assert.equal(requests.length, 1, 'discovery fetches before any React slot is mounted')
    current = 'next-session' as SessionId
    for (const listener of listeners) listener()
    await controller.refresh()
    assert.equal(controller.getSnapshot().sessionId, current)
    assert.match(requests.at(-1)!, /sessionId=next-session/)
    current = undefined
    for (const listener of listeners) listener()
    assert.equal(controller.getSnapshot().sessionId, undefined)
    assert.equal(controller.getSnapshot().snapshot, undefined)
    disposeDiscovery!()
    disposeDiscovery = undefined
    assert.equal(listeners.size, 0)
  } finally {
    disposeDiscovery?.()
    controller?.dispose()
    globalThis.fetch = originalFetch
  }
})
