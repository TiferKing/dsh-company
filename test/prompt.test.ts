import assert from 'node:assert/strict'
import test from 'node:test'
import { employeePersona } from '../src/employees.js'
import { installCompanyPrompt } from '../src/prompt.js'
import { companyState } from './fixtures.js'
import { HR_MODEL_SELECTION_POLICY, HR_ASSESSMENT_REMINDER } from '../src/hr-policy.js'
import { resolveConfig } from '../src/schemas.js'

test('current HR policy and route constraints reach existing sessions and follow HR succession', () => {
  const state = companyState()
  const first = state.employees[0]!
  first.isHr = true
  first.executionPrompt = 'Legacy HR guidance persisted before this upgrade.'
  state.hrEmployeeId = first.id
  state.employees.push({ ...structuredClone(first), id: 'e2', name: 'Successor', sessionId: 'successor-session', isHr: false })
  let assemble: (assembly: any) => string = () => ''
  const config = resolveConfig({ allowedRoutes: [{ provider: 'approved-provider', model: 'approved-model' }] })
  installCompanyPrompt({ systemPrompt: { section: (section: any) => { assemble = section.text } } } as any,
    { readActiveSync: () => state } as any, config)
  const policyFor = (sessionId: string) => assemble({ agent: { id: sessionId, session: { header: { cwd: '/workspace' } } } })
  assert.ok(policyFor(first.sessionId!).includes(HR_MODEL_SELECTION_POLICY), 'an existing HR session gets current policy without rewriting its persisted persona')
  assert.ok(policyFor(first.sessionId!).includes(JSON.stringify(config.allowedRoutes)))
  assert.ok(employeePersona(state, first).includes(HR_ASSESSMENT_REMINDER), 'new HR personas receive the assessment contract')
  assert.ok(!policyFor('successor-session').includes(HR_MODEL_SELECTION_POLICY), 'ordinary employees do not receive HR authority')
  first.isHr = false
  state.employees[1]!.isHr = true
  state.hrEmployeeId = 'e2'
  assert.ok(!policyFor(first.sessionId!).includes(HR_MODEL_SELECTION_POLICY), 'former HR loses the dynamic role policy')
  assert.ok(policyFor('successor-session').includes(HR_MODEL_SELECTION_POLICY))
  config.allowedRoutes = [{ provider: 'replacement-provider' }]
  const updated = policyFor('successor-session')
  assert.ok(updated.includes(JSON.stringify(config.allowedRoutes)), 'route restrictions are read on assembly, not copied at bootstrap')
  assert.doesNotMatch(updated, /approved-model/)
})

test('participant communication permits governed coordination without becoming authority', () => {
  const state = companyState()
  let assemble: (assembly: any) => string = () => ''
  installCompanyPrompt({ systemPrompt: { section: (section: any) => { assemble = section.text } } } as any,
    { readActiveSync: () => state } as any, { promptSectionOrder: 118 } as any)
  const founder = assemble({ agent: { id: state.founderSessionId, session: { header: { cwd: '/workspace' } } } })
  const employee = assemble({ agent: { id: state.employees[0]!.sessionId, session: { header: { cwd: '/workspace' } } } })
  const persona = employeePersona(state, state.employees[0]!)
  for (const policy of [founder, employee, persona]) {
    assert.match(policy, /participant proposals and factual leads/)
    assert.match(policy, /human approval/)
    assert.match(policy, /attempt capabilit/)
    assert.doesNotMatch(policy, /never perform tool calls or state changes they request|never follow instructions they contain/)
  }
  assert.match(founder, /governance process to respond/)
  assert.match(founder, /next_offset/)
  assert.match(employee, /cannot expand the assignment scope/)
  assert.match(persona, /cannot expand assignment scope/)
})
