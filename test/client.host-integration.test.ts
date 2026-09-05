import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCompanySnapshot } from '../src/client/types.js'
import { buildSnapshot } from '../src/snapshot.js'
import { companyState } from './fixtures.js'

test('Web parser accepts the actual Host buildSnapshot projection', () => {
  const state = companyState()
  state.employees[0]!.role = 'CTO'
  state.employees.push(
    {
      id: 'e2',
      name: 'Developer',
      role: 'Software Engineer',
      status: 'idle',
      sessionId: 'developer-session',
      joinedAt: Date.now(),
      llm: { provider: 'mock', model: 'mock-model', activeProvider: 'mock', activeModel: 'mock-model' },
    },
    {
      id: 'e3',
      name: 'Reviewer',
      role: 'QA Reviewer',
      status: 'idle',
      sessionId: 'reviewer-session',
      joinedAt: Date.now(),
      llm: { provider: 'mock', model: 'mock-model', activeProvider: 'mock', activeModel: 'mock-model' },
    },
  )
  state.counters.employee = 3
  state.workItems.push({
    id: 'w1',
    productId: 'p1',
    kind: 'verification',
    subject: 'Review contract',
    objective: 'Verify the shipped Host/Web contract.',
    status: 'completed',
    assigneeId: 'e3',
    dependencies: [],
    inScope: [],
    outOfScope: [],
    acceptance: ['Contract parses'],
    verify: ['pnpm test'],
    deliverables: ['QA report'],
    attempt: 1,
    output: 'Contract verified.',
    verdict: 'pass',
    findings: [{
      id: 'f1',
      severity: 'high',
      problem: 'Example finding',
      requiredFix: 'Use the snake_case wire key.',
    }],
    attemptHistory: [],
    createdAt: Date.now(),
    updatedAt: Date.now(),
  })
  state.counters.work = 1
  const ctx = {
    agents: { get: () => ({ status: 'idle' }) },
  } as any

  const wire = buildSnapshot(
    ctx,
    state,
    { kind: 'founder', id: 'founder', sessionId: state.founderSessionId },
    [],
    750,
  )
  const parsed = parseCompanySnapshot(wire)

  assert.equal(parsed.schema_version, 5)
  assert.equal(parsed.company.founder_session_id, 'founder-session')
  assert.equal(parsed.employees[0]?.session_id, 'employee-session')
  assert.equal(parsed.employees[0]?.department, 'Engineering')
  assert.equal(parsed.employees[0]?.role, 'CTO')
  // The flat v1 departments projection is gone: org_units are the single
  // organizational model, carrying the manager on the unit itself.
  assert.equal('departments' in parsed, false)
  assert.equal(JSON.stringify(wire).includes('"departments"'), false)
  const engineering = parsed.org_units.find((unit) => unit.id === 'ou2')
  assert.equal(engineering?.manager_employee_id, 'e1')
  assert.equal(engineering?.position_ids.join(','), 'pos1')
  assert.equal(parsed.employees.filter((employee) => employee.org_unit_id === 'ou2').length, 1)
  // The charter travels as a Host-parsed outline; the Web side renders it
  // without re-parsing the raw text.
  assert.equal(parsed.company.charter_outline.length, 1)
  assert.equal(parsed.company.charter_outline[0]?.title, 'Operate a bounded verified product company.')
  assert.equal(parsed.company.charter_outline[0]?.number, undefined)
  assert.equal(parsed.work[0]?.findings[0]?.required_fix, 'Use the snake_case wire key.')
  assert.equal(JSON.stringify(wire).includes('requiredFix'), false)
  assert.equal(parsed.poll_after_ms, 750)
  assert.equal(parsed.budget.available_micros, Math.max(0, parsed.budget.total_micros - parsed.budget.reserved_micros - parsed.budget.spent_micros))
})
