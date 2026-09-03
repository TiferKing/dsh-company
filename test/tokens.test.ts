import assert from 'node:assert/strict'
import test from 'node:test'
import { normalizeTokenPrices } from '../src/schemas.js'
import { employeeTokenTotals, recordTokenUsage } from '../src/tokens.js'
import { companyState } from './fixtures.js'

test('token usage excludes reasoning from total double-counting and uses the reasoning output rate', () => {
  const state = companyState()
  state.tokenBudget.prices = normalizeTokenPrices([{
    provider: 'priced', model: 'model', inputPerMillion: 2, cacheReadPerMillion: 3,
    cacheWritePerMillion: 4, outputPerMillion: 5, reasoningPerMillion: 7,
  }])
  const first = recordTokenUsage(state, {
    sessionId: 'session', eventSeq: 7, turn: 1, step: 1, employeeId: 'e1',
    provider: 'priced', model: 'model',
    usage: { inputTokens: 100_000, outputTokens: 200_000, cacheReadTokens: 300_000, cacheWriteTokens: 400_000, reasoningTokens: 50_000 },
    at: 1,
  })
  assert.equal(first?.totalTokens, 1_000_000, 'reasoning tokens are already a subset of output tokens')
  assert.equal(first?.costMicros, 3_800_000)
  assert.equal(state.tokenBudget.usedTokens, 1_000_000)
  assert.equal(state.tokenBudget.totalCostMicros, 3_800_000)

  const duplicate = recordTokenUsage(state, {
    sessionId: 'session', eventSeq: 7, turn: 1, step: 1, employeeId: 'e1',
    provider: 'priced', model: 'model',
    usage: { inputTokens: 999, outputTokens: 999 }, at: 2,
  })
  assert.equal(duplicate, undefined)
  assert.equal(state.tokenBudget.usage.length, 1)
  assert.deepEqual(employeeTokenTotals(state, 'e1'), {
    inputTokens: 100_000, outputTokens: 200_000, cacheReadTokens: 300_000, cacheWriteTokens: 400_000,
    reasoningTokens: 50_000, totalTokens: 1_000_000, costMicros: 3_800_000,
  })
})

test('unpriced routes count tokens without inventing money', () => {
  const state = companyState()
  const entry = recordTokenUsage(state, {
    sessionId: 'session', eventSeq: 1, turn: 1, step: 1, employeeId: 'e1',
    provider: 'unknown', model: 'unknown', usage: { inputTokens: 10, outputTokens: 20 }, at: 1,
  })
  assert.equal(entry?.totalTokens, 30)
  assert.equal(entry?.priced, false)
  assert.equal(entry?.costMicros, 0)
})
