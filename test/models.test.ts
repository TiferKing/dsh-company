import assert from 'node:assert/strict'
import test from 'node:test'
import { probeRegisteredModels } from '../src/models.js'
import type { ModelCatalogState } from '../src/types.js'

function catalog(): ModelCatalogState {
  return { stale: true, generation: 3, models: [], errors: [] }
}

test('an already-cancelled model probe never queries providers or marks a catalog fresh', async () => {
  const reason = new Error('probe cancelled')
  const previous = catalog()
  const ctx = { llm: { listProviders: () => { throw new Error('must not be called') } } } as any
  await assert.rejects(() => probeRegisteredModels(ctx, previous, AbortSignal.abort(reason)), (error) => error === reason)
  assert.equal(previous.stale, true)
  assert.equal(previous.generation, 3)
})

for (const advertised of [true, false]) {
  test(`cancellation of the last ${advertised ? 'advertised' : 'previous unlisted'} model is never downgraded into a capability error`, async () => {
    const controller = new AbortController()
    const reason = new Error('stop exact-model probe')
    const previous = catalog()
    const metadata = { provider: 'mock', id: 'model', name: 'Model' }
    if (!advertised) previous.models.push({ provider: 'mock', model: 'model', name: 'Model', advertised: false, available: true })
    const ctx = { llm: {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => advertised ? [metadata] : [],
      resolveModelInfo: async () => { controller.abort(reason); throw reason },
    } } as any
    await assert.rejects(() => probeRegisteredModels(ctx, previous, controller.signal), (error) => error === reason)
    assert.equal(previous.stale, true)
    assert.equal(previous.generation, 3)
    assert.deepEqual(previous.errors, [])
  })
}

for (const operation of ['listModels', 'resolveModelInfo'] as const) {
  test(`cancels promptly when an adapter ignores cancellation during ${operation}`, { timeout: 1_000 }, async () => {
    const controller = new AbortController()
    const reason = new Error('stop unresponsive adapter')
    const never = (): Promise<never> => new Promise(() => undefined)
    const metadata = { provider: 'mock', id: 'model', name: 'Model' }
    const ctx = { llm: {
      listProviders: () => [{ id: 'mock' }],
      listModels: async () => [metadata],
      resolveModelInfo: async () => metadata,
      [operation]: never,
    } } as any
    const timer = setTimeout(() => controller.abort(reason), 10)
    try {
      await assert.rejects(() => probeRegisteredModels(ctx, catalog(), controller.signal), (error) => error === reason)
    } finally {
      clearTimeout(timer)
    }
  })
}
