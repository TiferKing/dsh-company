import assert from 'node:assert/strict'
import test from 'node:test'
import { registerCompanyTools } from '../src/tools.js'
import { buildSnapshot } from '../src/snapshot.js'
import type { SnapshotQuery } from '../src/types.js'
import { companyState } from './fixtures.js'
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

test('formation and employee budget tools convert independent currency ceilings without fallback', async () => {
  const tools: any[] = []
  let bootstrap: any
  let edit: any
  let budget: any
  registerCompanyTools({ tools: { register: (tool: any) => { tools.push(tool); return () => undefined } } } as any, {
    bootstrap: async (_agent: unknown, input: unknown) => { bootstrap = input; return { companyId: 'c1', phase: 'staged', revision: 1 } },
    editFormation: async (_agent: unknown, input: unknown) => { edit = input; return { id: 'c1', phase: 'staged', revision: 2, formation: { status: 'draft' } } },
    requestBudgetChange: async (_agent: unknown, input: unknown) => { budget = input; return [] },
  } as any)
  const formation = tools.find((tool) => tool.name === 'company_bootstrap')!
  assert.ok(formation.parameters.required.includes('hr_budget'))
  const args = {
    name: 'C', mission: 'Build.', charter: 'Humans approve.', total_budget: 300, currency: 'CNY', hr_budget: 10.000001,
    hr_provider: 'hr-provider', hr_model: 'hr-model', hr_reasoning_effort: 'high',
    first_product: { name: 'P', summary: 'Build.', product_root: 'p', success_criteria: ['Pass'], product_budget: 250 },
  }
  await formation.execute(args, { agent: {} })
  assert.equal(bootstrap.hrBudgetMicros, 10_000_001)
  assert.equal(bootstrap.totalBudgetMicros, 300_000_000)
  assert.equal(bootstrap.hrProvider, 'hr-provider')
  assert.equal(bootstrap.hrModel, 'hr-model')
  assert.equal(bootstrap.hrReasoningEffort, 'high')
  await assert.rejects(() => formation.execute({ ...args, hr_budget: undefined }, { agent: {} }), /hr_budget/)
  const editor = tools.find((tool) => tool.name === 'company_edit_formation')!
  await editor.execute({ hr_budget: 0 }, { agent: {} })
  assert.deepEqual(edit, { hrBudgetMicros: 0 })
  await editor.execute({ total_budget: 200 }, { agent: {} })
  assert.deepEqual(edit, { totalBudgetMicros: 200_000_000 })
  await editor.execute({ hr_provider: 'other-provider', hr_model: 'other-model', hr_reasoning_effort: 'default' }, { agent: {} })
  assert.deepEqual(edit, { hrProvider: 'other-provider', hrModel: 'other-model', hrReasoningEffort: 'default' })
  await tools.find((tool) => tool.name === 'company_request_budget_change')!.execute({ employee_budgets: [{ employee_id: 'e1', budget: 0.1 }] }, { agent: {} })
  assert.deepEqual(budget, { employeeBudgets: [{ employeeId: 'e1', budgetMicros: 100_000 }] })
})

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

test('company_status paginates full employee/org/position directories before projection and counts every employee', async () => {
  const state = companyState()
  state.limits.maxEmployees = 'unlimited'
  const employee = state.employees[0]!
  state.employees = Array.from({ length: 300 }, (_, index) => ({ ...employee, id: `e${index + 1}`,
    sessionId: `session-${index + 1}`, name: `Worker ${index + 1}`, status: index % 2 === 0 ? 'idle' as const : 'paused' as const }))
  const unit = state.orgUnits[1]!
  state.orgUnits.push(...Array.from({ length: 100 }, (_, index) => ({ ...unit, id: `ou${index + 3}`, name: `Department ${index}` })))
  const position = state.positions[0]!
  state.positions.push(...Array.from({ length: 100 }, (_, index) => ({ ...position, id: `pos${index + 2}`, title: `Position ${index}` })))
  const tools: any[] = []
  const queries: SnapshotQuery[] = []
  registerCompanyTools({ tools: { register: (tool: any) => { tools.push(tool); return () => undefined } } } as any, {
    status: async (_caller: unknown, _archived: boolean, query: SnapshotQuery) => {
      queries.push(query)
      return buildSnapshot({ agents: { get: () => undefined } } as any, state,
        { kind: 'founder', id: 'founder', sessionId: 'founder-session' }, [], undefined, query)
    },
  } as any)
  const tool = tools.find((candidate) => candidate.name === 'company_status')!
  const page = await tool.execute({ section: 'employees', offset: 120, limit: 2, status: 'idle' }, { agent: {} })
  assert.equal(queries[0]!.employeeOffset, 120)
  assert.equal(queries[0]!.employeeExactStatus, 'idle')
  assert.equal(page.total, 300)
  assert.equal(page.filtered_total, 150)
  assert.deepEqual(page.items.map((row: any) => row.id), ['e241', 'e243'])
  assert.equal(page.next_offset, 122)
  const exact = await tool.execute({ section: 'employees', id: 'e299' }, { agent: {} })
  assert.deepEqual(exact.items.map((row: any) => row.id), ['e299'])
  const org = await tool.execute({ section: 'org_units', id: 'ou102' }, { agent: {} })
  assert.equal(org.total, 102)
  assert.equal(org.items[0].id, 'ou102')
  const positions = await tool.execute({ section: 'positions', offset: 90, limit: 2 }, { agent: {} })
  assert.equal(positions.total, 101)
  assert.deepEqual(positions.items.map((row: any) => row.id), ['pos91', 'pos92'])
  const overview = await tool.execute({}, { agent: {} })
  assert.equal(queries.at(-1)!.employeeLimit, 1, 'overview only needs one projected employee, with independent full counts')
  assert.equal(overview.counts.employees.idle, 150)
  assert.equal(overview.counts.employees.paused, 150)
})
