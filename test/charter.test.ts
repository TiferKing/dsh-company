import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCharterClauses } from '../src/charter.js'

/** Compact outline projection: number, title, body lines, nested child titles. */
function outline(clauses: ReturnType<typeof parseCharterClauses>): unknown {
  return clauses.map((clause) => ({
    number: clause.number,
    title: clause.title,
    body: clause.body,
    children: outline(clause.children),
  }))
}

test('charter parser keeps prose paragraphs as clause bodies instead of sibling cards', () => {
  const tree = parseCharterClauses('1. 总则\n本章程规定公司治理的基本原则。\n2. 财务\n预算变更需人工批准。')
  assert.deepEqual(outline(tree), [
    { number: '1', title: '总则', body: ['本章程规定公司治理的基本原则。'], children: [] },
    { number: '2', title: '财务', body: ['预算变更需人工批准。'], children: [] },
  ])
})

test('charter parser derives level from the marker alone, ignoring leading indentation', () => {
  const tree = parseCharterClauses('1. 总则\n    1.1 原则一\n2. 附则')
  assert.deepEqual(outline(tree), [
    { number: '1', title: '总则', body: [], children: [{ number: '1.1', title: '原则一', body: [], children: [] }] },
    { number: '2', title: '附则', body: [], children: [] },
  ])
})

test('charter parser nests bullets under the latest numbered or header clause', () => {
  const tree = parseCharterClauses('1. 安全\n  - 边界执行\n  - 显式审批\n2. 证据')
  assert.deepEqual(outline(tree), [
    { number: '1', title: '安全', body: [], children: [
      { number: undefined, title: '边界执行', body: [], children: [] },
      { number: undefined, title: '显式审批', body: [], children: [] },
    ] },
    { number: '2', title: '证据', body: [], children: [] },
  ])
  const headers = parseCharterClauses('# 总则\n- 要点一\n## 细则\n- 要点二')
  assert.deepEqual(outline(headers), [
    { number: undefined, title: '总则', body: [], children: [
      { number: undefined, title: '要点一', body: [], children: [] },
      { number: undefined, title: '细则', body: [], children: [{ number: undefined, title: '要点二', body: [], children: [] }] },
    ] },
  ])
})

test('charter parser strips paired bold wrapping and keeps standalone bold lines as body', () => {
  const tree = parseCharterClauses('# 总则\n**核心理念**\n交付优先。')
  assert.deepEqual(outline(tree), [
    { number: undefined, title: '总则', body: ['核心理念', '交付优先。'], children: [] },
  ])
})

test('charter parser degrades pure prose to preamble cards and never invents nesting', () => {
  const tree = parseCharterClauses('本公司以交付经核验的软件产品为唯一目标。\n创始人保留全部治理权限。')
  assert.deepEqual(outline(tree), [
    { number: undefined, title: '本公司以交付经核验的软件产品为唯一目标。', body: [], children: [] },
    { number: undefined, title: '创始人保留全部治理权限。', body: [], children: [] },
  ])
})

test('charter parser clamps pathological marker depth to a bounded outline', () => {
  const tree = parseCharterClauses('1. a\n1.1.1.1.1.1.1.1.1.1 deep\n2. b')
  let node: ReturnType<typeof parseCharterClauses>[number] | undefined = tree[0]
  let depth = 1
  while (node !== undefined && node.children.length > 0) { node = node.children[0]; depth += 1 }
  assert.ok(depth <= 9, `clamped depth ${depth} stays within host bounds`)
  assert.equal(tree[1]?.title, 'b')
})
