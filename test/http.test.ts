import assert from 'node:assert/strict'
import test from 'node:test'
import { installCompanyRoutes, parseActionRequest } from '../src/http.js'
import { resolveConfig } from '../src/schemas.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'

const envelope = {
  sessionId: 'founder-session',
  companyId: 'c_550e8400-e29b-41d4-a716-446655440000',
  expectedRevision: 7,
}

test('snapshot ETags change with live activity even at the same durable revision', async () => {
  const handlers = new Map<string, (req: any, res: any) => Promise<void>>()
  const snapshot = snapshotFixture(7)
  const ctx = {
    inject: (_services: unknown, install: (ctx: any) => void) => install(ctx),
    effect: (setup: () => Generator) => { for (const _dispose of setup()) { /* install routes */ } },
    webServer: { register: (route: { path: string; handler: (req: any, res: any) => Promise<void> }) => {
      handlers.set(route.path, route.handler)
      return () => undefined
    } },
    agents: { get: () => ({}) },
  }
  installCompanyRoutes(ctx as any, { status: async () => snapshot } as any, resolveConfig({}))
  const handler = handlers.get('/plugins/dsh-company/state')!
  const get = async (etag?: string) => {
    let status = 0
    let headers: Record<string, string> = {}
    await handler({
      method: 'GET', url: '/plugins/dsh-company/state?sessionId=founder-session',
      headers: etag === undefined ? {} : { 'if-none-match': etag }, socket: { remoteAddress: '127.0.0.1' },
    }, {
      writeHead: (code: number, values: Record<string, string>) => { status = code; headers = values },
      end: () => undefined,
    })
    return { status, etag: headers.etag }
  }
  const first = await get()
  assert.equal(first.status, 200)
  assert.equal((await get(first.etag)).status, 304, 'unchanged projections retain cache reuse')
  ;(snapshot.employees as Array<Record<string, unknown>>)[0]!.activity = 'idle'
  const changed = await get(first.etag)
  assert.equal(changed.status, 200, 'live transitions must not be hidden by the revision validator')
  assert.notEqual(changed.etag, first.etag)
})

test('Host accepts the revision-fenced action envelope and preserves human evidence', () => {
  const parsed = parseActionRequest({
    ...envelope,
    action: 'resolve_approval',
    payload: {
      approval_id: 'a1',
      decision: 'approved',
      human_statement: 'I reviewed and approve this request.',
      note: 'Proceed within the approved scope.',
    },
  })

  assert.equal(parsed.action, 'resolve_approval')
  assert.deepEqual(parsed.payload, {
    approval_id: 'a1',
    decision: 'approved',
    human_statement: 'I reviewed and approve this request.',
    note: 'Proceed within the approved scope.',
  })
})

test('Host accepts a closed revision-fenced formation edit payload', () => {
  const parsed = parseActionRequest({
    ...envelope,
    action: 'edit_formation',
    payload: {
      name: 'Edited Company', charter: 'Edited charter', total_budget: 2, currency: 'CNY',
      first_product: { name: 'Edited Product', success_criteria: ['Pass'], product_budget: 1 },
      model_prices: [{ provider: 'mock', model: 'model', input_cache_miss_per_million: 1, input_cache_hit_per_million: 0.1, output_per_million: 3 }],
    },
  })
  assert.equal(parsed.action, 'edit_formation')
})

test('file_ticket payloads are closed and require non-blank fields', () => {
  const parsed = parseActionRequest({
    ...envelope,
    action: 'file_ticket',
    payload: { product_id: 'p1', title: '登录后白屏', description: '注册完成后偶发白屏。\n复现步骤：…' },
  })
  assert.equal(parsed.action, 'file_ticket')
  assert.throws(() => parseActionRequest({
    ...envelope,
    action: 'file_ticket',
    payload: { product_id: 'p1', title: 'x', description: ' ', extra: true },
  }), /unknown field\(s\): extra/)
  assert.throws(() => parseActionRequest({
    ...envelope,
    action: 'file_ticket',
    payload: { product_id: 'p1', title: '', description: 'y' },
  }), /file_ticket title is required/)
})

test('Host closes both the action envelope and each action payload', () => {
  assert.throws(() => parseActionRequest({
    ...envelope,
    action: 'pause',
    payload: { reason: 'Pause', extra: true },
  }), /unknown field\(s\): extra/)

  assert.throws(() => parseActionRequest({
    ...envelope,
    action: 'pause',
    payload: { reason: 'Pause' },
    actor: 'founder',
  }), /unknown field\(s\): actor/)

  assert.throws(() => parseActionRequest({
    ...envelope,
    action: 'archive',
    payload: { approvalId: 'a1', reason: 'Archive' },
  }), /unknown field\(s\): approvalId/)
})
