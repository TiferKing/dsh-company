/**
 * Curated three-rate price presets (per 1M tokens, native currency) for
 * common OpenAI / DeepSeek / Zhipu BigModel models.
 *
 * Presets are PREFILL SUGGESTIONS, never automatic enabling: a route stays
 * disabled until the founder switches it on; switching on fills these values
 * only when the rate fields are still empty, and everything stays editable.
 *
 * Matching is by MODEL ID ONLY — the provider/route prefix is ignored, so
 * `deepseek-official/deepseek-v4-flash`, `opencode-go/deepseek-v4-flash`, …
 * all resolve the same `deepseek-v4-flash` preset. A dated snapshot suffix
 * also matches its base model (`deepseek-v4-flash-0731` → `deepseek-v4-flash`).
 *
 * Figures cross-checked 2026-08 against:
 *  - OpenAI:    https://developers.openai.com/api/docs/pricing
 *  - DeepSeek:  https://api-docs.deepseek.com/quick_start/pricing/
 *               (peak rates; off-peak is half — budgeting worst-case)
 *  - BigModel:  https://bigmodel.cn/pricing
 * Verify before relying on them for real budgets; providers change prices.
 */

export interface ModelPricePreset {
  /** Native billing currency of the provider's official price list. */
  currency: string
  /** Input price per 1M tokens, cache MISS (standard input). */
  miss: string
  /** Input price per 1M tokens, cache HIT. */
  hit: string
  /** Output price per 1M tokens. */
  output: string
}

/** Flat model-id-keyed table; the route provider is deliberately ignored. */
const PRESETS: Record<string, ModelPricePreset> = {
  // ---- OpenAI (USD, standard) ----
  'gpt-5.2': { currency: 'USD', miss: '1.75', hit: '0.175', output: '14' },
  'gpt-5.1': { currency: 'USD', miss: '1.25', hit: '0.125', output: '10' },
  'gpt-5.1-chat-latest': { currency: 'USD', miss: '1.25', hit: '0.125', output: '10' },
  'gpt-5': { currency: 'USD', miss: '1.25', hit: '0.125', output: '10' },
  'gpt-5-mini': { currency: 'USD', miss: '0.25', hit: '0.025', output: '2' },
  'gpt-5-nano': { currency: 'USD', miss: '0.05', hit: '0.005', output: '0.4' },
  'gpt-4.1': { currency: 'USD', miss: '2', hit: '0.5', output: '8' },
  'gpt-4.1-mini': { currency: 'USD', miss: '0.4', hit: '0.1', output: '1.6' },
  'gpt-4.1-nano': { currency: 'USD', miss: '0.1', hit: '0.025', output: '0.4' },
  'gpt-4o': { currency: 'USD', miss: '2.5', hit: '1.25', output: '10' },
  'gpt-4o-mini': { currency: 'USD', miss: '0.15', hit: '0.075', output: '0.6' },
  'o3': { currency: 'USD', miss: '2', hit: '0.5', output: '8' },
  'o4-mini': { currency: 'USD', miss: '1.1', hit: '0.275', output: '4.4' },

  // ---- DeepSeek (USD, peak rates; off-peak is half) ----
  'deepseek-v4-flash': { currency: 'USD', miss: '0.44', hit: '0.014', output: '1.32' },
  'deepseek-v4-flash-vision-exp': { currency: 'USD', miss: '0.44', hit: '0.014', output: '1.32' },
  'deepseek-v4-pro': { currency: 'USD', miss: '1.32', hit: '0.044', output: '3.96' },
  // V3.2 generation; `deepseek-chat` is the stable alias of the current chat model.
  'deepseek-chat': { currency: 'USD', miss: '0.28', hit: '0.028', output: '0.42' },
  'deepseek-v3.2': { currency: 'USD', miss: '0.28', hit: '0.028', output: '0.42' },
  'deepseek-reasoner': { currency: 'USD', miss: '0.55', hit: '0.14', output: '2.19' },

  // ---- DeepSeek (CNY official RMB list) ----
  'deepseek-chat@cny': { currency: 'CNY', miss: '2', hit: '0.2', output: '3' },
  'deepseek-v3.2@cny': { currency: 'CNY', miss: '2', hit: '0.2', output: '3' },
  'deepseek-reasoner@cny': { currency: 'CNY', miss: '4', hit: '1', output: '16' },

  // ---- Zhipu BigModel (CNY domestic) ----
  'glm-4.6': { currency: 'CNY', miss: '2', hit: '0.2', output: '8' },
  'glm-4.5': { currency: 'CNY', miss: '2', hit: '0.2', output: '8' },
  'glm-4.5-air': { currency: 'CNY', miss: '0.8', hit: '0.16', output: '2' },
  // International (z.ai) USD list prices.
  'glm-4.6@usd': { currency: 'USD', miss: '0.6', hit: '0.11', output: '2.2' },
}

/** Model keys sorted longest-first so dated snapshots resolve the most specific base. */
const PRESET_KEYS = Object.keys(PRESETS)
  .filter((key) => !key.includes('@'))
  .sort((left, right) => right.length - left.length)

function lookup(model: string, currency: string): ModelPricePreset | undefined {
  const wanted = currency.trim().toUpperCase()
  const suffix = wanted.toLowerCase()
  // Currency-localized variant first (deepseek-chat@cny), then the base row.
  const localized = PRESETS[`${model}@${suffix}`]
  if (localized !== undefined) return localized.currency.toUpperCase() === wanted ? localized : undefined
  const base = PRESETS[model]
  if (base !== undefined) return base.currency.toUpperCase() === wanted ? base : undefined
  // Dated-snapshot suffix match: prefer the longest base key (`gpt-4o-mini`
  // before `gpt-4o`; `deepseek-v4-flash-0731` → `deepseek-v4-flash`).
  for (const key of PRESET_KEYS) {
    if (!model.startsWith(`${key}-`)) continue
    const entry = PRESETS[`${key}@${suffix}`] ?? PRESETS[key]
    if (entry !== undefined && entry.currency.toUpperCase() === wanted) return entry
    return undefined
  }
  return undefined
}

/**
 * The preset for one route in one company currency, or undefined. The
 * provider prefix is intentionally ignored: presets key on the model id
 * alone, so any route serving the same model resolves the same price.
 */
export function modelPricePreset(
  _provider: string,
  model: string,
  currency: string,
): Pick<ModelPricePreset, 'miss' | 'hit' | 'output'> | undefined {
  const normalized = model.trim().toLowerCase()
  if (normalized === '') return undefined
  const entry = lookup(normalized, currency)
  return entry === undefined ? undefined : { miss: entry.miss, hit: entry.hit, output: entry.output }
}

/**
 * Rates to fill when a route is switched on: the preset for this route and
 * currency, but only while the draft fields are still empty so enabling never
 * overwrites values the founder already typed.
 */
export function enablePreset(
  provider: string,
  model: string,
  currency: string,
  current: { miss: string; hit: string; output: string },
): { miss: string; hit: string; output: string } | undefined {
  if (current.miss.trim() !== '' || current.hit.trim() !== '' || current.output.trim() !== '') return undefined
  return modelPricePreset(provider, model, currency)
}

/** Compact display form, e.g. `2 / 0.2 / 8`. */
export function formatModelPricePreset(preset: Pick<ModelPricePreset, 'miss' | 'hit' | 'output'>): string {
  return `${preset.miss} / ${preset.hit} / ${preset.output}`
}
