import assert from 'node:assert/strict'
import test from 'node:test'
import { parseActionRequest } from '../src/http.js'

const envelope = {
  sessionId: 'founder-session',
  companyId: 'c_550e8400-e29b-41d4-a716-446655440000',
  expectedRevision: 7,
}

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
      name: 'Edited Company', charter: 'Edited charter', total_token_budget: 2_000_000, currency: 'CNY',
      first_product: { name: 'Edited Product', success_criteria: ['Pass'], token_budget: 1_000_000 },
      prices: [{ provider: 'mock', model: 'model', input_per_million: 1, cache_read_per_million: 0.1, cache_write_per_million: 1.2, output_per_million: 3 }],
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
