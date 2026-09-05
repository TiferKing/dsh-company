import assert from 'node:assert/strict'
import test from 'node:test'
import { parseCompanySnapshot, SnapshotValidationError } from '../src/client/types.js'
import { snapshotFixture } from './fixtures/company-snapshot.js'

test('parses the Host projection and normalizes presentation fields', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  assert.equal(snapshot.schema_version, 5)
  assert.equal(snapshot.employees[0]?.activity?.state, 'running')
  assert.deepEqual(snapshot.employees[0]?.llm, {
    provider: 'deepseek',
    model: 'deepseek-chat',
    reasoning_effort: 'high',
  })
  assert.equal(snapshot.work[0]?.output_summary, 'In progress.')
  assert.equal(snapshot.company.slogan, 'Bounded decisions, verified outcomes.')
  assert.equal(snapshot.org_units[0]?.load.band, 'normal')
  assert.equal(snapshot.budget.provider_model_aggregates[0]?.cost_micros, 42)
  assert.equal(snapshot.budget.usage_detail.returned, 1)
  assert.equal(snapshot.temporary_authorizations[0]?.id, 'auth-1')
  assert.deepEqual(snapshot.work[0]?.acceptance, ['Unit tests'])
  assert.deepEqual(snapshot.work[0]?.verify, ['pnpm test'])
  assert.deepEqual(snapshot.work[0]?.deliverables, ['src/widget.ts'])
  assert.deepEqual(snapshot.work[0]?.evidence, {
    changed_paths: ['src/widget.ts'],
    acceptance_results: ['Unit tests: pass'],
    commands_run: ['pnpm test'],
  })
  assert.match(snapshot.approvals[0]?.payload_summary ?? '', /\[redacted\]/)
  assert.equal('attempt_id' in (snapshot.work[0] ?? {}), false)
  assert.equal('attempt_id' in (snapshot.employees[0] ?? {}), false)
})

test('rejects unsupported schemas and inconsistent budgets', () => {
  const unsupported = snapshotFixture()
  unsupported.schema_version = 1
  assert.throws(() => parseCompanySnapshot(unsupported), SnapshotValidationError)

  const inconsistent = snapshotFixture()
  ;(inconsistent.budget as Record<string, unknown>).available_micros = 13
  assert.throws(
    () => parseCompanySnapshot(inconsistent),
    /equal to max\(0, total - reserved - spent\)/,
  )
})

test('rejects partial three-rate prices and inconsistent detail windows', () => {
  const partial = snapshotFixture()
  const prices = ((partial.budget as Record<string, unknown>).prices as Array<Record<string, unknown>>)
  delete prices[0]?.output_micros_per_million
  assert.throws(() => parseCompanySnapshot(partial), /complete three-rate price/)

  const inconsistent = snapshotFixture()
  const detail = ((inconsistent.budget as Record<string, unknown>).usage_detail as Record<string, unknown>)
  detail.returned = 0
  assert.throws(() => parseCompanySnapshot(inconsistent), /equal to items.length/)
})

test('parses employee-level temporary authorizations with work-specific use audit only', () => {
  const snapshot = parseCompanySnapshot(snapshotFixture())
  const authorization = snapshot.temporary_authorizations[0]
  assert.equal(authorization?.employee_id, 'engineer')
  assert.equal('work_id' in (authorization ?? {}), false)
  assert.equal('allowance_micros' in (authorization ?? {}), false)
  assert.equal('max_uses' in (authorization ?? {}), false)
  assert.equal(authorization?.uses[0]?.work_id, 'work-1')
})

test('accepts Host-owned workload bands but rejects inconsistent numeric evidence', () => {
  const changedPolicy = snapshotFixture()
  const units = changedPolicy.org_units as Array<Record<string, unknown>>
  ;(units[0]!.load as Record<string, unknown>).band = 'pressure'
  assert.equal(parseCompanySnapshot(changedPolicy).org_units[0]?.load.band, 'pressure')

  const wrongAverage = snapshotFixture()
  const wrongUnits = wrongAverage.org_units as Array<Record<string, unknown>>
  ;(wrongUnits[0]!.load as Record<string, unknown>).average = 0.5
  assert.throws(() => parseCompanySnapshot(wrongAverage), /internally consistent Host load evidence/)
})

test('accepts the action response envelope', () => {
  const wrapped = { ok: true, revision: 1, snapshot: snapshotFixture() }
  assert.equal(parseCompanySnapshot(wrapped).company.id, 'company-1')
})
