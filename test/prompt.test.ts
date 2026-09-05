import assert from 'node:assert/strict'
import test from 'node:test'
import { employeePersona } from '../src/employees.js'
import { installCompanyPrompt } from '../src/prompt.js'
import { companyState } from './fixtures.js'

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
