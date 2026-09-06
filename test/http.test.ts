import assert from 'node:assert/strict'
import test from 'node:test'
import { installCompanyRoutes, parseActionRequest } from '../src/http.js'
import { resolveConfig } from '../src/schemas.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'
import { buildSnapshot } from '../src/snapshot.js'
import { companyState } from './fixtures.js'

const envelope = {
  sessionId: 'founder-session',
  companyId: 'c_550e8400-e29b-41d4-a716-446655440000',
  expectedRevision: 7,
}

test('HTTP directory requests validate filters and return page-specific representations and validators', async () => {
  const state = companyState()
  const template = state.employees[0]!
  state.employees = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(template), id: `e${index + 1}`, name: `Engineer ${index + 1}`, sessionId: `session-${index + 1}` }))
  let handler!: (req: any, res: any) => Promise<void>
  const ctx = {
    inject: (_services: unknown, install: (ctx: any) => void) => install(ctx),
    effect: (setup: () => Generator) => { for (const _dispose of setup()) { /* install */ } },
    webServer: { register: (route: any) => { if (route.path.endsWith('/state')) handler = route.handler; return () => undefined } },
    agents: { get: () => ({ status: 'idle' }) },
  }
  installCompanyRoutes(ctx as any, { status: async (_agent: unknown, _archived: unknown, query: any) => buildSnapshot(ctx as any, state, { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [], undefined, query) } as any, resolveConfig({}))
  const get = async (query: string, etag?: string) => {
    let status = 0; let headers: Record<string, string> = {}; let body = ''
    await handler({ method: 'GET', url: `/plugins/dsh-company/state?sessionId=founder-session&${query}`, headers: etag === undefined ? {} : { 'if-none-match': etag }, socket: { remoteAddress: '127.0.0.1' } }, {
      writeHead: (code: number, values: Record<string, string>) => { status = code; headers = values }, end: (value?: string) => { body = value ?? '' },
    })
    return { status, headers, body: body === '' ? undefined : JSON.parse(body) }
  }
  const first = await get('employeeLimit=100')
  assert.equal(first.body.employees.length, 100)
  const second = await get('employeeLimit=100&employeeOffset=100', first.headers.etag)
  assert.equal(second.status, 200)
  assert.equal(second.body.employees[0].id, 'e101')
  assert.notEqual(second.headers.etag, first.headers.etag)
  assert.equal((await get('employeeLimit=100&employeeOffset=100', second.headers.etag)).status, 304)
  for (const query of ['employeeLimit=101', 'employeeOffset=-1', 'employeeOffset=1.5', 'employeeStatus=unknown', 'unknown=true']) assert.equal((await get(query)).status, 400, query)
})

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
      name: 'Edited Company', charter: 'Edited charter', total_budget: 2, hr_budget: 0.1, currency: 'CNY',
      first_product: { name: 'Edited Product', success_criteria: ['Pass'], product_budget: 1 },
      model_prices: [{ provider: 'mock', model: 'model', input_cache_miss_per_million: 1, input_cache_hit_per_million: 0.1, output_per_million: 3 }],
    },
  })
  assert.equal(parsed.action, 'edit_formation')
})

test('HR and employee budget inputs enforce currency precision and closed allocation rows', () => {
  for (const invalid of [-1, 0.0000001, '', null, Number.POSITIVE_INFINITY]) {
    assert.throws(() => parseActionRequest({ ...envelope, action: 'edit_formation', payload: { hr_budget: invalid } }), /hr_budget|JSON object/)
    assert.throws(() => parseActionRequest({ ...envelope, action: 'request_budget_change', payload: { employee_budgets: [{ employee_id: 'e1', budget: invalid }] } }), /budget|JSON object/)
  }
  for (const employee_budgets of [
    {}, [], [{ employee_id: 'e1' }], [{ employee_id: '', budget: 1 }],
    [{ employee_id: 'e1', budget: 1, expectedBudgetMicros: 5 }],
    [{ employee_id: 'e1', budget: 1 }, { employee_id: 'e1', budget: 2 }],
  ]) assert.throws(() => parseActionRequest({ ...envelope, action: 'request_budget_change', payload: { employee_budgets } }))
  const payload = { employee_budgets: [{ employee_id: 'e1', budget: 0 }] }
  assert.deepEqual(parseActionRequest({ ...envelope, action: 'request_budget_change', payload }).payload, payload)
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
