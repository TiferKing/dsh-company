import assert from 'node:assert/strict'
import test from 'node:test'
import { registerCompanyTools } from '../src/tools.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'

test('registered tool schemas match the currency-only staffing contract', () => {
  const tools: Array<{ name: string; parameters: { properties?: Record<string, unknown> } }> = []
  const ctx = { tools: { register(tool: any) { tools.push(tool); return () => undefined } } } as any
  registerCompanyTools(ctx, {} as any)

  const staffing = tools.find((tool) => tool.name === 'company_submit_staffing_assessment')
  assert.ok(staffing, 'staffing assessment tool is registered')
  assert.ok(staffing.parameters.properties?.reasoning_effort, 'reasoning_effort is reachable through the closed tool schema')
  assert.ok(staffing.parameters.properties?.designate_as_hr, 'HR succession is an explicit, human-approved recommendation field')

  const serialized = JSON.stringify(tools.map((tool) => ({ name: tool.name, parameters: tool.parameters })))
  assert.doesNotMatch(serialized, /total_token_budget|token_budget|input_per_million|activation.?credit/i)
})

function companyStatusTool(snapshot: unknown): any {
  const tools: any[] = []
  registerCompanyTools({ tools: { register: (tool: any) => { tools.push(tool); return () => undefined } } } as any,
    { status: async () => snapshot } as any)
  return tools.find((tool) => tool.name === 'company_status')
}

test('company_status overview keeps financial authority, pending approvals and mailbox visible in large companies', async () => {
  const snapshot = snapshotFixture()
  const work = snapshot.work as Array<Record<string, unknown>>
  const template = work[0]!
  snapshot.work = Array.from({ length: 20 }, (_, index) => ({ ...template, id: `work-${index}`, output: 'evidence '.repeat(4_000) }))
  const tool = companyStatusTool(snapshot)
  const value = await tool.execute({}, { agent: {} })
  const text = tool.output.render({}, value)[0].text
  const rendered = JSON.parse(text)
  assert.equal(rendered.budget.total_micros, (snapshot.budget as Record<string, unknown>).total_micros)
  assert.equal(rendered.pending_approvals.length, 1)
  assert.equal(rendered.recent_inbox.length, (snapshot.inbox as unknown[]).length)
  assert.ok(rendered.query.sections.includes('work'))
  assert.ok(text.length < 20_000, 'large evidence cannot crowd core operating decisions out of the overview')
})

test('company_status detail pages preserve valid complete JSON, exact filtering, and continuation offsets', async () => {
  const snapshot = snapshotFixture()
  const template = (snapshot.work as Array<Record<string, unknown>>)[0]!
  const output = 'complete evidence '.repeat(2_000)
  snapshot.work = Array.from({ length: 7 }, (_, index) => ({ ...template, id: `work-${index}`, status: index === 6 ? 'failed' : 'completed', output }))
  const tool = companyStatusTool(snapshot)
  const query = { section: 'work', status: 'completed', offset: 2, limit: 2 }
  const value = await tool.execute(query, { agent: {} })
  const rendered = JSON.parse(tool.output.render(query, value)[0].text)
  assert.equal(rendered.filtered_total, 6)
  assert.equal(rendered.next_offset, 4)
  assert.deepEqual(rendered.items.map((row: any) => row.id), ['work-2', 'work-3'])
  assert.equal(rendered.items[1].output, output, 'long details must not be silently sliced mid-JSON')
  const exact = await tool.execute({ section: 'work', id: 'work-6' }, { agent: {} })
  assert.equal(exact.items.length, 1)
  assert.equal(exact.items[0].status, 'failed')
  assert.equal(exact.next_offset, null)
  await assert.rejects(() => tool.execute({ section: 'work', limit: 0 }, { agent: {} }), /limit/)
  await assert.rejects(() => tool.execute({ section: 'work', offset: -1 }, { agent: {} }), /offset/)
})

test('company_status paginates budget detail without hiding the original retained window', async () => {
  const snapshot = snapshotFixture()
  const tool = companyStatusTool(snapshot)
  const result = await tool.execute({ section: 'budget', limit: 1 }, { agent: {} })
  const original = snapshot.budget as Record<string, any>
  assert.equal(result.total_micros, original.total_micros)
  assert.equal(result.prices.items.length, 1)
  assert.equal(result.usage_detail.source_total, original.usage_detail.total)
  assert.equal(result.usage_detail.source_offset, original.usage_detail.offset)
  assert.deepEqual(result.usage_detail.items, original.usage_detail.items.slice(0, 1))
})
