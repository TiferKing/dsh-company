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
