import assert from 'node:assert/strict'
import test from 'node:test'
import { Config } from '../src/index.js'
import { resolveConfig } from '../src/schemas.js'

test('Cordis config accepts omitted optional route collections', () => {
  const parsed = Config({})
  assert.equal(parsed.allowedRoutes, undefined)
  assert.equal(parsed.fallback, undefined)
  assert.equal(parsed.memberMaxDepth, 1)

  const resolved = resolveConfig(parsed)
  assert.equal(resolved.allowedRoutes, undefined)
  assert.equal(resolved.fallback, undefined)
  assert.equal(resolved.memberMaxDepth, 1)
})

test('Cordis config preserves explicit allowed and fallback routes', () => {
  const parsed = Config({
    allowedRoutes: [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }],
    fallback: { provider: 'deepseek-official', model: 'deepseek-v4-flash' },
  })
  assert.deepEqual(parsed.allowedRoutes, [{ provider: 'deepseek-official', model: 'deepseek-v4-flash' }])
  assert.deepEqual(parsed.fallback, { provider: 'deepseek-official', model: 'deepseek-v4-flash' })
})

test('Cordis config still rejects incomplete explicit fallback routes', () => {
  assert.throws(
    () => Config({ fallback: { provider: 'deepseek-official' } as never }),
    /fallback/,
  )
})

test('legacy memberMaxDepth zero normalizes to the direct-employee ceiling', () => {
  assert.equal(Config({ memberMaxDepth: 0 }).memberMaxDepth, 0)
  assert.equal(resolveConfig({ memberMaxDepth: 0 }).memberMaxDepth, 1)
})

test('employee capacity defaults to unlimited while finite legacy ceilings remain explicit', () => {
  assert.equal(Config({}).maxEmployees, 'unlimited')
  assert.equal(resolveConfig().maxEmployees, 'unlimited')
  for (const limit of [8, 33, 1000, Number.MAX_SAFE_INTEGER, 'unlimited'] as const) {
    assert.equal(resolveConfig(Config({ maxEmployees: limit })).maxEmployees, limit)
  }
  for (const invalid of [0, -1, 1.5, Infinity, NaN, Number.MAX_SAFE_INTEGER + 1, '32', 'infinite']) {
    assert.throws(() => resolveConfig({ maxEmployees: invalid as never }), /maxEmployees/)
  }
})

test('execution policy defaults upgrade old configs and validate independent resource thresholds', () => {
  const config = resolveConfig(Config({ maxEmployees: 8 }))
  assert.equal(config.executionMode, 'adaptive')
  assert.equal(config.maxConcurrentEmployees, 8)
  assert.equal(config.executionMemoryHighWatermark, 0.8)
  assert.equal(config.executionLagHighWatermarkMs, 200)
  assert.equal(config.executionMaxPendingWrites, 32)
  assert.equal(config.executionRetryMs, 1000)
  assert.equal(resolveConfig({ executionMode: 'fixed', maxConcurrentEmployees: 64 }).maxConcurrentEmployees, 64)
  assert.equal(resolveConfig({ executionMode: 'unlimited' }).executionMode, 'unlimited')
  for (const [field, invalid] of Object.entries({ executionMode: 'other', maxConcurrentEmployees: 0,
    executionMemoryHighWatermark: 1, executionLagHighWatermarkMs: -1, executionMaxPendingWrites: 0, executionRetryMs: 0 })) {
    assert.throws(() => resolveConfig({ [field]: invalid } as never), new RegExp(field))
  }
})
