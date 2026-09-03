import assert from 'node:assert/strict'
import test from 'node:test'
import { assertCompanyState } from '../src/schemas.js'
import { companyState } from './fixtures.js'

test('durable nested records are closed and route fallback is validated', () => {
  const unknown = companyState()
  ;(unknown.employees[0]!.llm as unknown as Record<string, unknown>).unexpected = true
  assert.throws(() => assertCompanyState(unknown), /unknown field\(s\): unexpected/)

  const malformed = companyState()
  ;(malformed.employees[0]!.llm as unknown as Record<string, unknown>).fallback = {
    provider: 'mock-fallback',
  }
  assert.throws(() => assertCompanyState(malformed), /fallback\.model/)
})
