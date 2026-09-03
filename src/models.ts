import type { Context } from '@deepseek-ai/cordis'
import type { DiscoveredModelCapability, ModelCatalogState, ModelPrice3 } from './types.js'

const MAX_ERRORS = 64
const MAX_ERROR_CHARS = 2048

export async function probeRegisteredModels(
  ctx: Context,
  previous: ModelCatalogState,
  signal?: AbortSignal,
  now = Date.now(),
): Promise<ModelCatalogState> {
  const providers = ctx.llm.listProviders()
  const models: DiscoveredModelCapability[] = []
  const errors: Array<{ provider: string; message: string }> = []
  const seen = new Set<string>()

  const results = await Promise.allSettled(providers.map(async (provider) => {
    const advertised = await ctx.llm.listModels(provider.id)
    const rows: DiscoveredModelCapability[] = []
    for (const model of advertised) {
      if (signal?.aborted) throw signal.reason ?? new Error('model probe aborted')
      let resolved
      try {
        resolved = await ctx.llm.resolveModelInfo(provider.id, model.id, signal)
      } catch (error) {
        errors.push({ provider: provider.id, message: boundedError(`${model.id}: ${String(error)}`) })
      }
      const info = resolved ?? model
      rows.push({
        provider: provider.id,
        model: model.id,
        name: info.name,
        ...(info.description === undefined ? {} : { description: info.description }),
        ...(info.inputModalities === undefined ? {} : { inputModalities: [...info.inputModalities] }),
        ...(resolved?.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
        ...(resolved?.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: resolved.defaultMaxTokens }),
        ...(resolved?.reasoning === undefined ? {} : {
          reasoningEfforts: resolved.reasoning.efforts.map((effort) => ({
            id: String(effort.id),
            name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }),
          })),
          ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: String(resolved.reasoning.defaultEffort) }),
        }),
        advertised: true,
        available: resolved !== undefined,
      })
    }
    return rows
  }))

  for (let index = 0; index < results.length; index += 1) {
    const provider = providers[index]!
    const result = results[index]!
    if (result.status === 'rejected') {
      if (signal?.aborted) throw signal.reason ?? result.reason
      errors.push({ provider: provider.id, message: boundedError(result.reason) })
      continue
    }
    for (const model of result.value) {
      const key = `${model.provider}\u0000${model.model}`
      if (seen.has(key)) continue
      seen.add(key)
      models.push(model)
    }
  }

  // Preserve exact active employee routes even when an adapter's catalog omits them.
  for (const previousModel of previous.models) {
    const key = `${previousModel.provider}\u0000${previousModel.model}`
    if (seen.has(key)) continue
    if (!providers.some((provider) => provider.id === previousModel.provider)) {
      models.push({ ...structuredClone(previousModel), advertised: false, available: false })
      seen.add(key)
      continue
    }
    try {
      const resolved = await ctx.llm.resolveModelInfo(previousModel.provider, previousModel.model, signal)
      models.push({
        provider: resolved.provider,
        model: resolved.id,
        name: resolved.name,
        ...(resolved.description === undefined ? {} : { description: resolved.description }),
        ...(resolved.inputModalities === undefined ? {} : { inputModalities: [...resolved.inputModalities] }),
        ...(resolved.context?.contextWindow === undefined ? {} : { contextWindow: resolved.context.contextWindow }),
        ...(resolved.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: resolved.defaultMaxTokens }),
        ...(resolved.reasoning === undefined ? {} : {
          reasoningEfforts: resolved.reasoning.efforts.map((effort) => ({ id: String(effort.id), name: effort.name,
            ...(effort.description === undefined ? {} : { description: effort.description }) })),
          ...(resolved.reasoning.defaultEffort === undefined ? {} : { defaultReasoningEffort: String(resolved.reasoning.defaultEffort) }),
        }),
        advertised: false,
        available: true,
      })
      seen.add(key)
    } catch (error) {
      errors.push({ provider: previousModel.provider, message: boundedError(`${previousModel.model}: ${String(error)}`) })
      models.push({ ...structuredClone(previousModel), advertised: false, available: false })
      seen.add(key)
    }
  }

  return {
    stale: false,
    generation: previous.generation + 1,
    probedAt: now,
    models,
    errors: errors.slice(0, MAX_ERRORS),
  }
}

/** Preserve the independent price matrix while discovery updates model identity/capabilities. */
export function mergeDiscoveredPriceRows(
  existing: readonly ModelPrice3[],
  _catalog: ModelCatalogState,
  _pricingRevision: number,
  _now: number,
): ModelPrice3[] {
  // Catalog-only routes remain visible through ModelCatalogState. Persisting an
  // all-blank exact price row would make identity and pricing inseparable and
  // could shadow a complete provider wildcard.
  return existing.map((price) => structuredClone(price))
}

export function invalidateModelCatalog(catalog: ModelCatalogState, now = Date.now()): void {
  catalog.stale = true
  catalog.invalidatedAt = now
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return value.length <= MAX_ERROR_CHARS ? value : `${value.slice(0, MAX_ERROR_CHARS - 1)}…`
}
