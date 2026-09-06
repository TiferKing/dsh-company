import assert from 'node:assert/strict'
import test from 'node:test'
import { departmentLoadPresentation } from '../src/client/load.js'
import { COMPANY_STYLES } from '../src/client/styles.js'
import { enablePreset, modelPricePreset } from '../src/client/model-presets.js'
import { decimalMoneyToMicros, decimalMoneyToUnits, formationHrModelChoices, governanceDraftProblem, mergeModelPriceDrafts, modelPriceDraftPayload, OverviewView, type OverviewViewProps } from '../src/client/views/OverviewView.js'
import { budgetDraftPayload } from '../src/client/views/AuditView.js'
import { parseCompanySnapshot } from '../src/client/types.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'
import React from 'react'
import { AuditView, type AuditViewProps } from '../src/client/views/AuditView.js'
import { en, type CompanyTranslate } from '../src/client/locales.js'

test('overview reveals live employees five at a time without search, filters or paging controls', () => {
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const slots: any[] = []
  let cursor = 0
  let effects: Array<() => void> = []
  const dispatcher = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useId() { return `overview-${cursor++}` },
    useEffect(effect: () => void, dependencies: unknown[]) {
      const index = cursor++
      if (slots[index] === undefined || dependencies.some((value, at) => !Object.is(value, slots[index][at]))) effects.push(effect)
      slots[index] = dependencies
    },
  }
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const employee = snapshot.employees[0]!
  snapshot.employees = [{ ...employee, id: 'hr', name: 'People Lead', is_hr: true, status: 'idle', activity: { state: 'idle' } }]
  snapshot.activity_employees = Array.from({ length: 12 }, (_, index) => ({ ...employee, id: `live-${index + 1}`, name: `Live employee ${index + 1}` }))
  // Persisted working flags and a retired employee's stale activity cannot
  // inflate the activity count or occupy one of the five visible slots.
  snapshot.activity_employees.unshift(...(['idle', 'ready', 'cold', 'unavailable'] as const).map((state) => ({ ...employee, id: `not-live-${state}`, activity: { state } })))
  snapshot.activity_employees.push({ ...employee, id: 'retired', status: 'retired' })
  const requestedLimits: number[] = []
  const translate: CompanyTranslate = (key, params = {}) => Object.entries(params).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), en[key])
  const props: OverviewViewProps = { snapshot, t: translate, locale: 'en', onLoadMoreActivity: (limit) => requestedLimits.push(limit) }
  const render = () => {
    const previousDispatcher = internals.ReactCurrentDispatcher.current
    const previousReact = (globalThis as any).React
    cursor = 0; effects = []
    internals.ReactCurrentDispatcher.current = dispatcher
    ;(globalThis as any).React = React
    try {
      const tree = OverviewView(props)
      for (const effect of effects) effect()
      return tree
    } finally { internals.ReactCurrentDispatcher.current = previousDispatcher; (globalThis as any).React = previousReact }
  }
  const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
  const activityElements = (tree: any): any[] => elements(elements(tree).find((element) => element.type === 'aside').props.children[0])
  const visibleIds = (tree: any): string[] => activityElements(tree).filter((element) => element.type === 'li').map((element) => element.key)
  const more = (tree: any): any => activityElements(tree).find((element) => element.type === 'button')
  let tree = render()
  assert.deepEqual(visibleIds(tree), ['live-1', 'live-2', 'live-3', 'live-4', 'live-5'])
  assert.equal(activityElements(tree).find((element) => element.props.className === 'dsh-company-section__count').props.children, 12)
  assert.equal(activityElements(tree).some((element) => element.type === 'input' || element.type === 'select' || element.type === 'nav'), false)
  assert.equal(more(tree).props.children, en['overview.loadMoreActivity'])
  more(tree).props.onClick()
  tree = render()
  assert.deepEqual(visibleIds(tree), Array.from({ length: 10 }, (_, index) => `live-${index + 1}`))
  props.activityLoading = true
  tree = render()
  assert.equal(more(tree).props.disabled, true, 'another load cannot start while the current request is pending')
  props.activityLoading = false
  tree = render()
  more(tree).props.onClick()
  tree = render()
  assert.deepEqual(visibleIds(tree), Array.from({ length: 12 }, (_, index) => `live-${index + 1}`))
  assert.equal(more(tree), undefined, 'the button disappears after all running employees are shown')
  assert.deepEqual(requestedLimits, [10, 15])
})

test('an in-flight page response cannot retarget or discard an employee budget draft', async () => {
  // Exercise the component's handlers and hook lifecycle without adding a DOM
  // dependency. The dispatcher is restored immediately after each render.
  const internals = (React as any).__SECRET_INTERNALS_DO_NOT_USE_OR_YOU_WILL_BE_FIRED
  const slots: any[] = []
  let cursor = 0
  let effects: Array<() => void> = []
  const dispatcher = {
    useState(initial: any) {
      const index = cursor++
      if (!(index in slots)) slots[index] = typeof initial === 'function' ? initial() : initial
      return [slots[index], (value: any) => { slots[index] = typeof value === 'function' ? value(slots[index]) : value }]
    },
    useRef(initial: any) { const index = cursor++; return slots[index] ??= { current: initial } },
    useMemo(factory: () => any) { cursor++; return factory() },
    useEffect(effect: () => void, dependencies: unknown[]) {
      const index = cursor++
      if (slots[index] === undefined || dependencies.some((value, at) => !Object.is(value, slots[index][at]))) effects.push(effect)
      slots[index] = dependencies
    },
  }
  const translate: CompanyTranslate = (key, params = {}) => Object.entries(params).reduce((value, [name, replacement]) => value.replaceAll(`{${name}}`, String(replacement)), en[key])
  const first = parseCompanySnapshot(snapshotFixture(1))
  first.employees[0]!.budget_micros = 10_000_000
  const second = structuredClone(first)
  second.revision = 2
  second.employees = [{ ...first.employees[0]!, id: 'later-page-employee', name: 'Later page employee' }]
  const requests: Array<{ payload: Record<string, unknown>; revision: number }> = []
  const props: AuditViewProps = { snapshot: first, t: translate, locale: 'en', canManageBudget: true, onRequestBudgetChange: async (payload, revision) => { requests.push({ payload, revision }); return true } }
  const render = () => {
    const previousDispatcher = internals.ReactCurrentDispatcher.current
    const previousReact = (globalThis as any).React
    cursor = 0; effects = []
    internals.ReactCurrentDispatcher.current = dispatcher
    ;(globalThis as any).React = React
    try {
      const tree = AuditView(props)
      for (const effect of effects) effect()
      return tree
    } finally { internals.ReactCurrentDispatcher.current = previousDispatcher; (globalThis as any).React = previousReact }
  }
  const elements = (node: any): any[] => Array.isArray(node) ? node.flatMap(elements) : React.isValidElement(node) ? [node, ...elements((node.props as any).children)] : []
  let tree = render()
  const employeeLabel = elements(tree).find((element) => element.type === 'label' && element.key === first.employees[0]!.id)
  const input = elements(employeeLabel).find((element) => element.type === 'input')
  input.props.onChange({ currentTarget: { value: '12' } })
  tree = render()
  props.snapshot = second
  tree = render()
  const labels = elements(tree).filter((element) => element.type === 'label')
  assert.ok(labels.some((element) => element.key === first.employees[0]!.id))
  assert.equal(labels.some((element) => element.key === 'later-page-employee'), false)
  const submit = elements(tree).find((element) => element.type === 'button' && element.props.children === en['audit.requestBudgetChange'])
  submit.props.onClick()
  await Promise.resolve()
  assert.equal(requests[0]!.revision, 1)
  assert.deepEqual(requests[0]!.payload, { employee_budgets: [{ employee_id: first.employees[0]!.id, budget: '12' }] })
  tree = render()
  assert.ok(elements(tree).some((element) => element.type === 'label' && element.key === 'later-page-employee'))
})

test('model price presets apply only to recognized direct providers', () => {
  assert.deepEqual(modelPricePreset('deepseek-official', 'deepseek-v4-flash', 'USD'), { miss: '0.44', hit: '0.014', output: '1.32' })
  assert.equal(modelPricePreset('opencode-go', 'deepseek-v4-pro', 'USD'), undefined, 'subscription routes must not inherit direct API pricing')
  assert.equal(modelPricePreset('whatever-relay', 'gpt-5.1', 'USD'), undefined)
  assert.deepEqual(modelPricePreset('bigmodel', 'glm-4.6', 'CNY'), { miss: '2', hit: '0.2', output: '8' })
  // Dated snapshot suffixes fall back to the most specific base model.
  assert.deepEqual(modelPricePreset('deepseek-official', 'deepseek-v4-flash-0731', 'USD'), { miss: '0.44', hit: '0.014', output: '1.32' })
  assert.deepEqual(modelPricePreset('openai', 'gpt-4o-2024-08-06', 'USD'), { miss: '2.5', hit: '1.25', output: '10' })
  // The most specific entry wins over its prefix family.
  assert.deepEqual(modelPricePreset('openai', 'gpt-4o-mini', 'USD'), { miss: '0.15', hit: '0.075', output: '0.6' })
  // Currency still gates the lookup.
  assert.equal(modelPricePreset('openai', 'gpt-5.1', 'CNY'), undefined)
  assert.deepEqual(modelPricePreset('bigmodel', 'glm-4.6', 'USD'), { miss: '0.6', hit: '0.11', output: '2.2' }, 'international USD list exists for glm-4.6')
  assert.equal(modelPricePreset('mock', 'mock-model', 'USD'), undefined)
  assert.deepEqual(modelPricePreset('deepseek-official', 'deepseek-chat', 'CNY'), { miss: '2', hit: '0.2', output: '3' })
})

test('enabling prefills preset rates only while the fields are still empty', () => {
  assert.deepEqual(enablePreset('openai', 'gpt-5.2', 'USD', { miss: '', hit: '', output: '' }), { miss: '1.75', hit: '0.175', output: '14' })
  assert.equal(enablePreset('openai', 'gpt-5.2', 'USD', { miss: '9', hit: '', output: '' }), undefined, 'typed values win over presets')
  assert.equal(enablePreset('openai', 'gpt-5.2', 'CNY', { miss: '', hit: '', output: '' }), undefined)
})

test('department load presentation maps stable Host keys to exact non-color-only copy', () => {
  assert.deepEqual(departmentLoadPresentation('very_idle', 'zh'), { label: '非常空闲', tone: 'neutral' })
  assert.deepEqual(departmentLoadPresentation('normal', 'zh'), { label: '正常运转', tone: 'success' })
  assert.deepEqual(departmentLoadPresentation('busy', 'zh'), { label: '较为繁忙', tone: 'warning' })
  assert.deepEqual(departmentLoadPresentation('pressure', 'zh'), { label: '压力巨大', tone: 'danger' })
  assert.equal(departmentLoadPresentation('pressure', 'en').label, 'Under severe pressure')
})

test('money form conversion is exact, bounded, and distinguishes zero from blank', () => {
  assert.equal(decimalMoneyToMicros('0'), 0)
  assert.equal(decimalMoneyToMicros('12.345678'), 12_345_678)
  assert.equal(decimalMoneyToMicros(' 1.2 '), 1_200_000)
  assert.equal(decimalMoneyToMicros(''), undefined)
  assert.equal(decimalMoneyToMicros('1.0000001'), undefined)
  assert.equal(decimalMoneyToMicros('-1'), undefined)
  assert.equal(decimalMoneyToUnits('12.345678'), '12.345678')
})

test('HR model choices deduplicate exact provider/model pairs without conflating slash-containing ids', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const route = { name: 'Model', advertised: true, available: true }
  snapshot.model_catalog.models = [
    { ...route, provider: 'provider/model', model: 'id' },
    { ...route, provider: 'provider', model: 'model/id' },
    { ...route, provider: 'provider', model: 'model/id' },
  ]
  const choices = formationHrModelChoices(snapshot)
  assert.equal(choices.length, 2)
  assert.notEqual(choices[0]!.key, choices[1]!.key)
  assert.deepEqual(choices.map(({ key, ...model }) => model), [
    { provider: 'provider', model: 'model/id', name: 'Model' },
    { provider: 'provider/model', model: 'id', name: 'Model' },
  ])
  assert.equal(snapshot.model_catalog.models.length, 3, 'building model choices does not mutate the Host catalog')
})

test('employee-only budget requests keep HR independent and do not sum overlapping employee and product ceilings', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const hr = { ...snapshot.employees[0]!, id: 'hr', name: 'People Lead', is_hr: true, budget_micros: 20_000_000, spent_micros: 0, reserved_micros: 0 }
  snapshot.employees.push(hr, { ...hr, id: 'retired', status: 'retired', budget_micros: 100_000_000 })
  // Product 12 + engineer 8 + HR 10 exceeds the company 20 only if incorrectly added.
  assert.deepEqual(budgetDraftPayload(snapshot, '20', { 'product-1': '12' }, { engineer: '8', hr: '10' }), {
    ok: true, payload: { employee_budgets: [{ employee_id: 'hr', budget: '10' }] },
  })
  assert.deepEqual(budgetDraftPayload(snapshot, '20', { 'product-1': '12' }, { engineer: '8', hr: '0' }), {
    ok: true, payload: { employee_budgets: [{ employee_id: 'hr', budget: '0' }] },
  })
  assert.deepEqual(budgetDraftPayload(snapshot, '20', { 'product-1': '12' }, { engineer: '8', hr: '' }), {
    ok: false, reason: 'invalidMoney', name: 'People Lead',
  })
})

test('budget drafts validate final ceilings, committed spending, and active product allocations', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  assert.deepEqual(budgetDraftPayload(snapshot, '20', { 'product-1': '12' }, { engineer: '20.000001' }), {
    ok: false, reason: 'budgetAboveTotal', name: 'Engineer',
  })
  assert.deepEqual(budgetDraftPayload(snapshot, '20', { 'product-1': '12' }, { engineer: '1' }), {
    ok: false, reason: 'budgetBelowCommitted', name: 'Engineer',
  })
  assert.deepEqual(budgetDraftPayload(snapshot, '6', { 'product-1': '5' }, { engineer: '5' }), {
    ok: true, payload: { total_budget: '6', product_budgets: [{ product_id: 'product-1', product_budget: '5' }], employee_budgets: [{ employee_id: 'engineer', budget: '5' }] },
  })
  snapshot.products.push({ ...snapshot.products[0]!, id: 'product-2', status: 'retired', budget_micros: 100_000_000 })
  assert.equal(budgetDraftPayload(snapshot, '20', { 'product-1': '12' }, { engineer: '9' }).ok, true)
  snapshot.products[1]!.status = 'active'
  assert.deepEqual(budgetDraftPayload(snapshot, '20', { 'product-1': '12', 'product-2': '12' }, { engineer: '9' }), {
    ok: false, reason: 'productTotal',
  })
})

test('price draft payload keeps disabled rows rate-less and requires complete rates on enabled rows', () => {
  assert.deepEqual(modelPriceDraftPayload([
    { provider: 'mock', model: 'off', enabled: false, miss: '1', hit: '2', output: '3' },
    { provider: 'mock', model: 'free', enabled: true, miss: '0', hit: '0.000000', output: '0' },
  ]), [
    { provider: 'mock', model: 'off' },
    { provider: 'mock', model: 'free', input_cache_miss_per_million: '0', input_cache_hit_per_million: '0.000000', output_per_million: '0' },
  ])
  // An enabled row without complete rates blocks the whole payload.
  assert.equal(modelPriceDraftPayload([{ provider: 'mock', model: 'empty', enabled: true, miss: '', hit: '', output: '' }]), undefined)
  assert.equal(modelPriceDraftPayload([{ provider: 'mock', model: 'partial', enabled: true, miss: '1', hit: '', output: '' }]), undefined)
  assert.equal(modelPriceDraftPayload([{ provider: 'mock', model: 'invalid', enabled: true, miss: '1.0000001', hit: '0', output: '0' }]), undefined)
})

test('reprobe merges newly discovered routes without destroying dirty price fields', () => {
  const current = [{ provider: 'mock', model: 'existing', enabled: true, miss: 'dirty', hit: '2', output: '3', available: true }]
  const fresh = [
    { provider: 'mock', model: 'existing', enabled: false, miss: '1', hit: '1', output: '1', available: false },
    { provider: 'mock', model: 'new', enabled: false, miss: '', hit: '', output: '', available: true },
  ]
  assert.deepEqual(mergeModelPriceDrafts(current, fresh), [
    { provider: 'mock', model: 'existing', enabled: true, miss: 'dirty', hit: '2', output: '3', available: false },
    { provider: 'mock', model: 'new', enabled: false, miss: '', hit: '', output: '', available: true },
  ])
})

test('post-formation governance draft validation is local and field-specific', () => {
  assert.equal(governanceDraftProblem('', 'mission', 'charter'), 'slogan')
  assert.equal(governanceDraftProblem('x'.repeat(161), 'mission', 'charter'), 'slogan')
  assert.equal(governanceDraftProblem('slogan', ' ', 'charter'), 'mission')
  assert.equal(governanceDraftProblem('slogan', 'mission', '\n'), 'charter')
  assert.equal(governanceDraftProblem('slogan', 'mission', '1. Rule'), undefined)
})

test('responsive formation and confirmation CSS preserve mobile reachability and keyboard focus', () => {
  assert.match(COMPANY_STYLES, /@media \(max-width: 680px\)[\s\S]*?\.dsh-company-formation-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/)
  assert.match(COMPANY_STYLES, /@media \(max-width: 680px\)[\s\S]*?\.dsh-company-price__fields,[\s\S]*?grid-template-columns:\s*1fr/)
  assert.match(COMPANY_STYLES, /\.dsh-company-confirm-layer\s*\{[\s\S]*?overflow:\s*auto/)
  assert.match(COMPANY_STYLES, /\.dsh-company-confirm\s*\{[\s\S]*?max-height:[\s\S]*?overflow:\s*auto/)
  assert.match(COMPANY_STYLES, /\.dsh-company-governance-card__toggle:focus-visible/)
  assert.match(COMPANY_STYLES, /\.dsh-company-charter-item__row:focus-visible/)
  assert.match(COMPANY_STYLES, /\.dsh-company-price__body\[hidden\][\s\S]*?display:\s*none/)
})
