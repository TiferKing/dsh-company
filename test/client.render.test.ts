import assert from 'node:assert/strict'
import test from 'node:test'
import React, { createElement } from 'react'
import { renderToStaticMarkup } from 'react-dom/server'
import { CompanyActions } from '../src/client/CompanyDrawer.js'
import { en, zh, type CompanyTranslate } from '../src/client/locales.js'
import { parseCompanySnapshot } from '../src/client/types.js'
import { parseCharterClauses } from '../src/charter.js'
import { OverviewView } from '../src/client/views/OverviewView.js'
import { OrganizationView } from '../src/client/views/OrganizationView.js'
import { ProductsView } from '../src/client/views/ProductsView.js'
import { WorkView } from '../src/client/views/WorkView.js'
import { RecruitingView } from '../src/client/views/RecruitingView.js'
import { TicketsView } from '../src/client/views/TicketsView.js'
import { AuditView } from '../src/client/views/AuditView.js'
import { ApprovalsView } from '../src/client/views/ApprovalsView.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'
import { buildSnapshot } from '../src/snapshot.js'
import { companyState } from './fixtures.js'
import { loadOrganizationSnapshot } from '../src/client/directory-snapshot.js'

// tsx loads this test under the Host tsconfig (classic JSX fallback) while the
// production client build uses react-jsx through tsconfig.client.json.
;(globalThis as typeof globalThis & { React: typeof React }).React = React

const t: CompanyTranslate = (key, params = {}) => {
  let value: string = en[key]
  for (const [name, replacement] of Object.entries(params)) {
    value = value.replaceAll(`{${name}}`, String(replacement))
  }
  return value
}

test('Host directory pages assemble into the original collapsed organization tree with all employees', async () => {
  const state = companyState()
  state.employees = Array.from({ length: 300 }, (_, index) => ({ ...structuredClone(state.employees[0]!), id: `e${index + 1}`, name: `Engineer ${index + 1}`, sessionId: `session-${index + 1}` }))
  state.staffingRequests.push({ id: 'sr1', action: 'hire', status: 'pending', requestedBy: 'founder', candidateName: 'New reviewer', workProfile: 'Review designs', hrEmployeeId: 'e1', createdAt: 1, updatedAt: 1 })
  const ctx = { agents: { get: () => undefined } } as any
  const actor = { kind: 'founder', id: 'founder', sessionId: 'founder-session' } as const
  const wire = buildSnapshot(ctx, state, actor, [])
  wire.execution = { mode: 'adaptive', running: 9, limit: 10, waiting: 5, reason: 'memory' }
  const snapshot = await loadOrganizationSnapshot(parseCompanySnapshot(wire), async (query) => parseCompanySnapshot(buildSnapshot(ctx, state, actor, [], undefined, query)))
  assert.ok(snapshot.directory, 'exercise the real Host projection rather than a legacy fixture without directory metadata')
  const org = renderToStaticMarkup(createElement(OrganizationView, { snapshot, t, locale: 'en', navigateToSession: async () => undefined }))
  assert.match(org, /role="tree"/)
  assert.match(org, /aria-level="1" aria-expanded="false"/)
  assert.doesNotMatch(org, /Engineer 101/)
  assert.doesNotMatch(org, /Search employee name|Employee scope|Previous|Next|Organization units are paged/)
  assert.match(org, /New reviewer/)
  assert.match(org, /300/)
  const expanded = renderToStaticMarkup(createElement(OrganizationView, { snapshot, t, locale: 'en', navigateToSession: async () => undefined, initialExpanded: true }))
  assert.match(expanded, /aria-level="2" aria-expanded="true"/)
  assert.match(expanded, /dsh-company-org-node__people-list/)
  assert.match(expanded, /Engineer 1<\//)
  assert.match(expanded, /Engineer 101/)
  assert.match(expanded, /Engineer 300/)
  const overview = renderToStaticMarkup(createElement(OverviewView, { snapshot, t, locale: 'en' }))
  assert.match(overview, /Host company employees running 9/)
  assert.match(overview, /Waiting for memory pressure to decrease/)
  const auditSnapshot = parseCompanySnapshot(buildSnapshot(ctx, state, actor, [], undefined, { employeeOffset: 100 }))
  const audit = renderToStaticMarkup(createElement(AuditView, { snapshot: auditSnapshot, t, locale: 'en', canManageBudget: true, onDirectoryQuery: () => undefined }))
  assert.match(audit, /Engineer 101/)
  assert.doesNotMatch(audit, /Engineer 1<\//)
})

test('all seven company views render the safe Host projection', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const views = [
    createElement(OverviewView, { snapshot, t, locale: 'en' }),
    createElement(OrganizationView, {
      snapshot,
      t,
      locale: 'en',
      navigateToSession: async () => undefined,
      initialExpanded: true,
    }),
    createElement(ProductsView, { snapshot, t, locale: 'en' }),
    createElement(WorkView, { snapshot, t }),
    createElement(RecruitingView, {
      snapshot,
      t,
      locale: 'en',
      busy: false,
      canManage: true,
      onRequestModelPrices: async () => true,
      onReprobe: async () => true,
      onOpenApprovals: () => undefined,
    }),
    createElement(AuditView, { snapshot, t, locale: 'en' }),
    createElement(ApprovalsView, {
      snapshot,
      t,
      locale: 'en',
      busy: false,
      onDecision: () => undefined,
    }),
  ]

  const output = views.map((view) => renderToStaticMarkup(view)).join('\n')
  assert.match(output, /Bounded decisions, verified outcomes/)
  assert.match(output, /Software Engineer/)
  assert.match(output, /deepseek\/deepseek-chat/)
  assert.match(output, /Implement the widget/)
  assert.match(output, /Host computes money/)
  assert.match(output, /Product Division/)
  assert.match(output, /Engineering/)
  assert.match(output, /Token analytics: 175 tokens/)
  assert.match(output, /Publish a release candidate/)
  assert.doesNotMatch(output, /must-be-dropped/)
  assert.doesNotMatch(output, /attempt_id/)
})

test('overview counts only live running employees after a reload', () => {
  for (const activity of ['idle', 'ready', 'cold', 'unavailable'] as const) {
    const snapshot = parseCompanySnapshot(snapshotFixture())
    snapshot.employees[0]!.activity = { state: activity }
    const output = renderToStaticMarkup(createElement(OverviewView, { snapshot, t, locale: 'en' }))
    assert.match(output, /No employee is currently executing company work/, activity)
    assert.match(output, /Active employees<\/span><\/div><strong class="dsh-company-stat__value">0<\/strong>/)
    assert.doesNotMatch(output, />Working<\/span>/)
  }

  const snapshot = parseCompanySnapshot(snapshotFixture())
  snapshot.employees[0]!.status = 'idle'
  const output = renderToStaticMarkup(createElement(OverviewView, { snapshot, t, locale: 'en' }))
  assert.match(output, /Active employees<\/span><\/div><strong class="dsh-company-stat__value">1<\/strong>/)
  assert.match(output, /<span class="dsh-company-status" data-tone="active">Running<\/span>/)
  assert.doesNotMatch(output, />Idle<\/span>/, 'a delayed lifecycle update must not relabel a live running turn')

  snapshot.employees = Array.from({ length: 12 }, (_, index) => ({ ...snapshot.employees[0]!, id: `legacy-${index}`, name: `Legacy employee ${index}` }))
  snapshot.activity_employees = snapshot.employees.slice(0, 5)
  const legacy = renderToStaticMarkup(createElement(OverviewView, { snapshot, t, locale: 'en' }))
  assert.match(legacy, /Active employees<\/span><\/div><strong class="dsh-company-stat__value">12<\/strong>/)
  assert.match(legacy, /Load more/)
  assert.doesNotMatch(legacy, /Legacy employee 5/)
})

test('organization shows live activity without overriding paused or failed lifecycle states', () => {
  const cases = [
    { status: 'working', activity: 'ready', label: 'Ready to continue', tone: 'neutral' },
    { status: 'working', activity: 'idle', label: 'Idle', tone: 'success' },
    { status: 'idle', activity: 'running', label: 'Running', tone: 'active' },
    { status: 'paused', activity: 'running', label: 'Paused', tone: 'warning' },
    { status: 'failed', activity: 'idle', label: 'Failed', tone: 'danger' },
    { status: 'retired', activity: 'running', label: 'Retired', tone: 'neutral' },
  ] as const
  for (const row of cases) {
    const snapshot = parseCompanySnapshot(snapshotFixture())
    snapshot.employees[0]!.status = row.status
    snapshot.employees[0]!.activity = { state: row.activity }
    const output = renderToStaticMarkup(createElement(OrganizationView, {
      snapshot, t, locale: 'en', navigateToSession: async () => undefined, initialExpanded: true,
    }))
    assert.match(output, new RegExp(`<span class="dsh-company-status" data-tone="${row.tone}">${row.label}</span>`), `${row.status}/${row.activity}`)
    assert.doesNotMatch(output, />Working<\/span>/)
  }
})

test('approval cards show content up front with scope summary and details collapsed', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const output = renderToStaticMarkup(createElement(ApprovalsView, {
    snapshot, t, locale: 'en', busy: false, onDecision: () => undefined,
  }))
  assert.match(output, /Approval content/)
  assert.match(output, /Publish the built widget bundle to the sandbox registry/)
  assert.match(output, /early users can try it/)
  assert.match(output, /Scope summary/)
  assert.match(output, /Detailed info/)
  assert.match(output, /<details class="dsh-company-approval__fold">/)
  assert.doesNotMatch(output, /<details class="dsh-company-approval__fold" open>/, 'folds start collapsed')
})

test('tickets page renders status groups, the founder filing form, and closed replies', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const founder = renderToStaticMarkup(createElement(TicketsView, {
    snapshot, t, locale: 'en', busy: false, canFile: true, onFileTicket: async () => true,
  }))
  assert.match(founder, /Product tickets/)
  assert.match(founder, /Awaiting triage/)
  assert.match(founder, /登录后白屏/)
  assert.match(founder, /File a ticket/)
  assert.match(founder, /Closed/)
  assert.match(founder, /已修复并于 v1\.1 发布。|Fixed and shipped/) // closed reply text from fixture
  const readonly = renderToStaticMarkup(createElement(TicketsView, { snapshot, t, locale: 'en' }))
  assert.doesNotMatch(readonly, /Submit and notify the founder/)
})

test('recruiting page switches default off with Disabled rows; enabled rows carry three-rate inputs', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const output = renderToStaticMarkup(createElement(RecruitingView, {
    snapshot, t, locale: 'en', busy: false, canManage: true,
    onRequestModelPrices: async () => true, onReprobe: async () => true, onOpenApprovals: () => undefined,
  }))
  // Both catalog routes render a switch.
  assert.match(output, /role="switch"/)
  // The priced deepseek route is enabled by default with visible inputs.
  assert.match(output, /deepseek\/deepseek-chat/)
  assert.match(output, /Input cache miss/)
  // The unpriced mock route stays off, shows 未启用 and hides its matrix.
  assert.match(output, /mock\/mock-model/)
  assert.match(output, /Disabled/)
  assert.match(output, /1\/3 enabled/)
  // The unpriced openai row advertises its preset; mock/mock-model has none.
  assert.match(output, /Preset price 1.25 \/ 0.125 \/ 10/)
  assert.doesNotMatch(output, /Preset price[\s\S]*mock\/mock-model/)
})

test('audit page no longer hosts the price matrix', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const output = renderToStaticMarkup(createElement(AuditView, { snapshot, t, locale: 'en' }))
  assert.doesNotMatch(output, /Current model prices/)
  assert.doesNotMatch(output, /role="switch"/)
})

test('formation and audit render the independent HR limit and exclude retired employee budget controls', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const hr = { ...snapshot.employees[0]!, id: 'hr', name: 'People Lead', is_hr: true, budget_micros: 2_500_000 }
  snapshot.employees.push(hr, { ...hr, id: 'retired', name: 'Former HR', status: 'retired' })
  const formation = renderToStaticMarkup(createElement(OverviewView, {
    snapshot, t, locale: 'en', canEditFormation: true, onEditFormation: async () => true,
  }))
  assert.match(formation, /HR spending limit<\/span><input[^>]*required=""[^>]*value="2\.5"/)
  const audit = renderToStaticMarkup(createElement(AuditView, {
    snapshot, t, locale: 'en', canManageBudget: true, onRequestBudgetChange: async () => true,
  }))
  assert.match(audit, /Employee spending limits/)
  assert.match(audit, /People Lead · HR<\/span><input[^>]*value="2\.5"/)
  assert.doesNotMatch(audit, /Former HR/)
})

test('formation offers discovered HR routes and preserves editable custom model ids', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const hr = { ...snapshot.employees[0]!, id: 'hr', name: 'People Lead', is_hr: true, budget_micros: 2_500_000 }
  snapshot.employees.push(hr)
  const render = (): string => renderToStaticMarkup(createElement(OverviewView, {
    snapshot, t, locale: 'en', canEditFormation: true, onEditFormation: async () => true,
  }))
  const catalog = render()
  assert.match(catalog, /Choose the initial HR model/)
  assert.match(catalog, /<option[^>]*selected="">DeepSeek Chat · deepseek\/deepseek-chat<\/option>/)
  assert.match(catalog, /<option[^>]*>Mock Model · mock\/mock-model<\/option>/)
  assert.match(catalog, /Changing the model resets reasoning effort to default/)
  hr.llm = { provider: 'custom-provider', model: 'family/custom-id', reasoning_effort: 'high' }
  const custom = render()
  assert.match(custom, /<option value="" disabled="" selected="">Custom model \(enter below\)<\/option>/)
  assert.match(custom, /Model provider<\/span><input value="custom-provider"/)
  assert.match(custom, /Model ID<\/span><input value="family\/custom-id"/)
  assert.match(custom, /HR spending limit<\/span><input[^>]*value="2\.5"/)
  assert.match(custom, /Reasoning effort \(default or an exact ID\)<\/span><input value="high"/, 'rendering a custom route preserves its saved reasoning effort')
})

test('Audit labels bounded details while charting Host lifetime aggregates', () => {
  const wire = snapshotFixture()
  const budget = wire.budget as Record<string, unknown>
  budget.spent_micros = 9_000_000
  budget.available_micros = 8_000_000
  const aggregates = budget.provider_model_aggregates as Array<Record<string, unknown>>
  aggregates[0]!.cost_micros = 9_000_000
  const detail = budget.usage_detail as Record<string, unknown>
  detail.total = 237
  detail.truncated = true
  const output = renderToStaticMarkup(createElement(AuditView, { snapshot: parseCompanySnapshot(wire), t, locale: 'en' }))
  assert.match(output, /Lifetime model cost[\s\S]*?USD.?9\.00/)
  assert.match(output, /Showing 1 of 237 \(latest 1\)/)
  assert.match(output, /detail window is truncated/)
})

test('Audit never renders authorized unpriced usage as zero or free', () => {
  const wire = snapshotFixture()
  const detail = (wire.budget as Record<string, unknown>).usage_detail as Record<string, unknown>
  const item = (detail.items as Array<Record<string, unknown>>)[0]!
  item.priced = false
  item.cost_micros = 0
  item.authorization_id = 'ta1'
  delete item.matched_price_key
  const output = renderToStaticMarkup(createElement(AuditView, { snapshot: parseCompanySnapshot(wire), t, locale: 'en' }))
  assert.match(output, /Unknown cost \(authorized use, not zero cost\)/)
  assert.doesNotMatch(output, /deepseek\/deepseek-chat · \$0\.00/)
})

test('Audit lifetime aggregates qualify mixed known and unknown costs and retain all-unpriced route evidence', () => {
  const mixedWire = snapshotFixture()
  const mixedAggregate = (((mixedWire.budget as Record<string, unknown>).provider_model_aggregates as Array<Record<string, unknown>>)[0])!
  Object.assign(mixedAggregate, { calls: 2, priced_calls: 1, unpriced_calls: 1, cost_micros: 1_000_000 })
  const mixed = renderToStaticMarkup(createElement(AuditView, { snapshot: parseCompanySnapshot(mixedWire), t, locale: 'en' }))
  assert.match(mixed, /Known-cost subtotal: USD.?1\.00 \+ Unknown cost \(authorized use, not zero cost\)/)

  const unknownWire = snapshotFixture()
  const unknownAggregate = (((unknownWire.budget as Record<string, unknown>).provider_model_aggregates as Array<Record<string, unknown>>)[0])!
  Object.assign(unknownAggregate, { calls: 1, priced_calls: 0, unpriced_calls: 1, cost_micros: 0 })
  const budget = unknownWire.budget as Record<string, unknown>
  budget.spent_micros = 0
  budget.available_micros = 17_000_000
  const unknown = renderToStaticMarkup(createElement(AuditView, { snapshot: parseCompanySnapshot(unknownWire), t, locale: 'en' }))
  assert.match(unknown, /deepseek\/deepseek-chat · 1 calls/)
  assert.match(unknown, /Unknown cost \(authorized use, not zero cost\)/)
  assert.doesNotMatch(unknown, /deepseek\/deepseek-chat[^<]*\$0\.00/)
})

test('Audit labels a nonzero empty detail page without an inverted range', () => {
  const wire = snapshotFixture()
  const detail = (wire.budget as Record<string, unknown>).usage_detail as Record<string, unknown>
  Object.assign(detail, { total: 10, offset: 10, returned: 0, truncated: true, items: [] })
  const output = renderToStaticMarkup(createElement(AuditView, { snapshot: parseCompanySnapshot(wire), t, locale: 'en' }))
  assert.match(output, /Showing 0 of 10 \(empty page at offset 10\)/)
  assert.doesNotMatch(output, /11–10/)
})

test('Organization visibly qualifies an employee whose recorded tokens have unknown monetary cost', () => {
  const wire = snapshotFixture()
  const employee = (wire.employees as Array<Record<string, unknown>>)[0]!
  const usage = employee.token_usage as Record<string, unknown>
  Object.assign(usage, { cost_micros: 0, priced_calls: 0, unpriced_calls: 1 })
  Object.assign(employee, { spent_micros: 0 })
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(wire), t, locale: 'en', navigateToSession: async () => undefined, initialExpanded: true, initialDetailUnitId: 'ou3',
  }))
  assert.match(output, /Unknown cost \(authorized use, not zero cost\)/)
})

test('Organization tree starts collapsed with per-row band and people summaries', () => {
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(snapshotFixture()), t, locale: 'en', navigateToSession: async () => undefined,
  }))
  assert.match(output, /Bounded Labs/)
  assert.match(output, /Operating normally/)
  assert.match(output, /1 person/)
  assert.doesNotMatch(output, /Product Division/)
  assert.doesNotMatch(output, /Software Engineer/)
})

test('Expanded organization units reveal direct members inline in the tree', () => {
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(snapshotFixture()), t, locale: 'en', navigateToSession: async () => undefined,
    initialExpanded: true,
  }))
  // The engineer is a direct member of the Engineering department and shows
  // up as soon as the tree expands, without opening any detail panel.
  assert.match(output, /dsh-company-org-node__people-list/)
  assert.match(output, /Software Engineer/)
  // The manager projected on the unit is surfaced on its row.
  assert.match(output, /Lead: Engineer/)
})

test('Overview keeps slogan, detailed mission, and hierarchical charter distinct and exposes responsive formation fieldsets', () => {
  const operatingWire = snapshotFixture()
  const company = operatingWire.company as Record<string, unknown>
  const charterText = '1. Safety\n  1.1 Bounded execution\n  1.2 Explicit approvals\n2. Evidence'
  Object.assign(company, {
    slogan: 'Short promise.',
    mission: 'Long detailed mission with measurable outcomes.',
    charter: charterText,
    charter_outline: parseCharterClauses(charterText),
  })
  const operating = parseCompanySnapshot(operatingWire)
  const collapsed = renderToStaticMarkup(createElement(OverviewView, { snapshot: operating, t, locale: 'en' }))
  assert.match(collapsed, /Short promise\./)
  assert.match(collapsed, /Long detailed mission with measurable outcomes\./)
  // Collapsed default: one row per root clause, sub-clauses hidden.
  assert.match(collapsed, /1\. Safety/)
  assert.match(collapsed, /dsh-company-charter-list/)
  assert.doesNotMatch(collapsed, /1\.1 Bounded execution/)
  const expanded = renderToStaticMarkup(createElement(OverviewView, {
    snapshot: operating, t, locale: 'en', initialExpandedClauses: ['0'],
  }))
  // The tree renders the Host-parsed outline clauses (with their numbers).
  assert.match(expanded, /1\.1 Bounded execution/)
  assert.match(expanded, /1\.2 Explicit approvals/)
  assert.match(expanded, /aria-expanded="true"/)

  const stagedWire = snapshotFixture()
  ;(stagedWire.company as Record<string, unknown>).phase = 'staged'
  const staged = renderToStaticMarkup(createElement(OverviewView, {
    snapshot: parseCompanySnapshot(stagedWire), t, locale: 'en', canEditFormation: true, onEditFormation: async () => true,
  }))
  assert.match(staged, /Company identity and governance/)
  assert.match(staged, /First product/)
  assert.match(staged, /Monetary budget and model prices/)
  assert.match(staged, /Input cache miss/)
  assert.match(staged, /Input cache hit/)
  assert.match(staged, /Output/)
  assert.match(staged, /USD \/ million tokens/)
})

test('Organization lifecycle-separates retired employees without counting them as active workload', () => {
  const wire = snapshotFixture()
  const employee = structuredClone((wire.employees as Array<Record<string, unknown>>)[0]!)
  Object.assign(employee, { id: 'former', name: 'Former Engineer', status: 'retired', activity: 'retired', session_id: 'former-session', joined_at: 1_710_000_000_000, retired_at: 1_719_000_000_000 })
  ;(wire.employees as Array<Record<string, unknown>>).push(employee)
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(wire), t, locale: 'en', navigateToSession: async () => undefined, initialExpanded: true,
  }))
  const formerSection = output.match(/<details\b[^>]*\bdsh-company-former\b[^>]*>[\s\S]*?<\/details>/)?.[0]
  assert.ok(formerSection)
  assert.doesNotMatch(formerSection.split('>')[0]!, /\bopen(?:\s|=|$)/, 'former employees start collapsed even when the organization tree is expanded')
  assert.match(formerSection, /Former employees/)
  assert.match(formerSection, /Former Engineer/)
  assert.equal(zh['organization.former'], '已离职员工')
})

test('organization tree fallback message is shown when no org units exist', () => {
  const wire = snapshotFixture()
  ;(wire.org_units as Array<Record<string, unknown>>).length = 0
  ;(wire.positions as Array<Record<string, unknown>>).length = 0
  for (const employee of wire.employees as Array<Record<string, unknown>>) {
    employee.org_unit_id = undefined
    employee.position_id = undefined
  }
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(wire), t, locale: 'en', navigateToSession: async () => undefined,
  }))
  assert.match(output, /No organizational units exist yet\./)
})

test('organization unit detail stays anchored above its subtree, never below it', () => {
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(snapshotFixture()), t, locale: 'en', navigateToSession: async () => undefined,
    initialExpanded: true, initialDetailUnitId: 'ou1',
  }))
  assert.match(output, /dsh-company-org-node__detail/)
  // The root unit's detail panel must precede its child-unit group in DOM
  // order so the connected card reads as anchored to its own row.
  assert.ok(
    output.indexOf('dsh-company-org-node__detail') < output.indexOf('role="group"'),
    'detail panel must render before the child-unit group',
  )
})

test('collapsed organization branches keep an explicit aria-expanded=false', () => {
  const output = renderToStaticMarkup(createElement(OrganizationView, {
    snapshot: parseCompanySnapshot(snapshotFixture()), t, locale: 'en', navigateToSession: async () => undefined,
  }))
  // The root company unit is a collapsed branch: assistive tech must be able
  // to tell it is expandable, so aria-expanded is present and false.
  assert.match(output, /aria-level="1" aria-expanded="false"/)
  assert.doesNotMatch(output, /aria-expanded="true"/)
})

test('partially blocked operating company exposes manual resume control', () => {
  const output = renderToStaticMarkup(createElement(CompanyActions, {
    phase: 'operating', founder: true, archived: false, hasOperationalBlocks: true,
    permissions: ['company.resume'], busy: false, t, controller: {} as never, ask: () => undefined,
  }))
  assert.match(output, /Resume/)
})

test('halted company exposes manual resume control', () => {
  const output = renderToStaticMarkup(createElement(CompanyActions, {
    phase: 'halted', founder: true, archived: false, permissions: ['company.resume'], busy: false, t,
    controller: {} as never, ask: () => undefined,
  }))
  assert.match(output, /Resume/)
})

test('failed provisioning keeps the approval action available for retry', () => {
  const output = renderToStaticMarkup(createElement(CompanyActions, {
    phase: 'provisioning_failed',
    founder: true,
    archived: false,
    permissions: ['bootstrap.approve'],
    busy: false,
    t,
    controller: {} as never,
    ask: () => undefined,
  }))

  assert.match(output, /Approve &amp; Start/)
  assert.doesNotMatch(output, /Discard plan/)
})
