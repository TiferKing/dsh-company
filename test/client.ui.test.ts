import assert from 'node:assert/strict'
import test from 'node:test'
import { departmentLoadPresentation } from '../src/client/load.js'
import { COMPANY_STYLES } from '../src/client/styles.js'
import { enablePreset, modelPricePreset } from '../src/client/model-presets.js'
import { decimalMoneyToMicros, decimalMoneyToUnits, governanceDraftProblem, mergeModelPriceDrafts, modelPriceDraftPayload } from '../src/client/views/OverviewView.js'

test('model price presets match the model id only, ignoring the route provider', () => {
  // Arbitrary provider prefixes resolve the same model preset.
  assert.deepEqual(modelPricePreset('deepseek-official', 'deepseek-v4-flash', 'USD'), { miss: '0.44', hit: '0.014', output: '1.32' })
  assert.deepEqual(modelPricePreset('opencode-go', 'deepseek-v4-pro', 'USD'), { miss: '1.32', hit: '0.044', output: '3.96' })
  assert.deepEqual(modelPricePreset('whatever-relay', 'gpt-5.1', 'USD'), { miss: '1.25', hit: '0.125', output: '10' })
  assert.deepEqual(modelPricePreset('zai-coding-cn', 'glm-4.6', 'CNY'), { miss: '2', hit: '0.2', output: '8' })
  // Dated snapshot suffixes fall back to the most specific base model.
  assert.deepEqual(modelPricePreset('deepseek-official', 'deepseek-v4-flash-0731', 'USD'), { miss: '0.44', hit: '0.014', output: '1.32' })
  assert.deepEqual(modelPricePreset('openai', 'gpt-4o-2024-08-06', 'USD'), { miss: '2.5', hit: '1.25', output: '10' })
  // The most specific entry wins over its prefix family.
  assert.deepEqual(modelPricePreset('openai', 'gpt-4o-mini', 'USD'), { miss: '0.15', hit: '0.075', output: '0.6' })
  // Currency still gates the lookup.
  assert.equal(modelPricePreset('openai', 'gpt-5.1', 'CNY'), undefined)
  assert.deepEqual(modelPricePreset('zai-coding-cn', 'glm-4.6', 'USD'), { miss: '0.6', hit: '0.11', output: '2.2' }, 'international USD list exists for glm-4.6')
  assert.equal(modelPricePreset('mock', 'mock-model', 'USD'), undefined)
  assert.deepEqual(modelPricePreset('deepseek-official', 'deepseek-chat', 'CNY'), { miss: '2', hit: '0.2', output: '3' })
})

test('enabling prefills preset rates only while the fields are still empty', () => {
  assert.deepEqual(enablePreset('openai', 'gpt-5.2', 'USD', { miss: '', hit: '', output: '' }), { miss: '1.75', hit: '0.175', output: '14' })
  assert.equal(enablePreset('openai', 'gpt-5.2', 'USD', { miss: '9', hit: '', output: '' }), undefined, 'typed values win over presets')
  assert.equal(enablePreset('openai', 'gpt-5.2', 'CNY', { miss: '', hit: '', output: '' }), undefined)
})

test('department load presentation maps stable Host keys to exact non-color-only copy', () => {
  assert.deepEqual(departmentLoadPresentation('very_idle', 'zh'), { label: '非常空闲', tone: 'neutral' })
  assert.deepEqual(departmentLoadPresentation('normal', 'zh'), { label: '正常运转', tone: 'success' })
  assert.deepEqual(departmentLoadPresentation('busy', 'zh'), { label: '较为繁忙', tone: 'warning' })
  assert.deepEqual(departmentLoadPresentation('pressure', 'zh'), { label: '压力巨大', tone: 'danger' })
  assert.equal(departmentLoadPresentation('pressure', 'en').label, 'Under severe pressure')
})

test('money form conversion is exact, bounded, and distinguishes zero from blank', () => {
  assert.equal(decimalMoneyToMicros('0'), 0)
  assert.equal(decimalMoneyToMicros('12.345678'), 12_345_678)
  assert.equal(decimalMoneyToMicros(' 1.2 '), 1_200_000)
  assert.equal(decimalMoneyToMicros(''), undefined)
  assert.equal(decimalMoneyToMicros('1.0000001'), undefined)
  assert.equal(decimalMoneyToMicros('-1'), undefined)
  assert.equal(decimalMoneyToUnits('12.345678'), '12.345678')
})

test('price draft payload keeps disabled rows rate-less and requires complete rates on enabled rows', () => {
  assert.deepEqual(modelPriceDraftPayload([
    { provider: 'mock', model: 'off', enabled: false, miss: '1', hit: '2', output: '3' },
    { provider: 'mock', model: 'free', enabled: true, miss: '0', hit: '0.000000', output: '0' },
  ]), [
    { provider: 'mock', model: 'off' },
    { provider: 'mock', model: 'free', input_cache_miss_per_million: '0', input_cache_hit_per_million: '0.000000', output_per_million: '0' },
  ])
  // An enabled row without complete rates blocks the whole payload.
  assert.equal(modelPriceDraftPayload([{ provider: 'mock', model: 'empty', enabled: true, miss: '', hit: '', output: '' }]), undefined)
  assert.equal(modelPriceDraftPayload([{ provider: 'mock', model: 'partial', enabled: true, miss: '1', hit: '', output: '' }]), undefined)
  assert.equal(modelPriceDraftPayload([{ provider: 'mock', model: 'invalid', enabled: true, miss: '1.0000001', hit: '0', output: '0' }]), undefined)
})

test('reprobe merges newly discovered routes without destroying dirty price fields', () => {
  const current = [{ provider: 'mock', model: 'existing', enabled: true, miss: 'dirty', hit: '2', output: '3', available: true }]
  const fresh = [
    { provider: 'mock', model: 'existing', enabled: false, miss: '1', hit: '1', output: '1', available: false },
    { provider: 'mock', model: 'new', enabled: false, miss: '', hit: '', output: '', available: true },
  ]
  assert.deepEqual(mergeModelPriceDrafts(current, fresh), [
    { provider: 'mock', model: 'existing', enabled: true, miss: 'dirty', hit: '2', output: '3', available: false },
    { provider: 'mock', model: 'new', enabled: false, miss: '', hit: '', output: '', available: true },
  ])
})

test('post-formation governance draft validation is local and field-specific', () => {
  assert.equal(governanceDraftProblem('', 'mission', 'charter'), 'slogan')
  assert.equal(governanceDraftProblem('x'.repeat(161), 'mission', 'charter'), 'slogan')
  assert.equal(governanceDraftProblem('slogan', ' ', 'charter'), 'mission')
  assert.equal(governanceDraftProblem('slogan', 'mission', '\n'), 'charter')
  assert.equal(governanceDraftProblem('slogan', 'mission', '1. Rule'), undefined)
})

test('responsive formation and confirmation CSS preserve mobile reachability and keyboard focus', () => {
  assert.match(COMPANY_STYLES, /@media \(max-width: 680px\)[\s\S]*?\.dsh-company-formation-grid\s*\{[\s\S]*?grid-template-columns:\s*1fr/)
  assert.match(COMPANY_STYLES, /@media \(max-width: 680px\)[\s\S]*?\.dsh-company-price__fields,[\s\S]*?grid-template-columns:\s*1fr/)
  assert.match(COMPANY_STYLES, /\.dsh-company-confirm-layer\s*\{[\s\S]*?overflow:\s*auto/)
  assert.match(COMPANY_STYLES, /\.dsh-company-confirm\s*\{[\s\S]*?max-height:[\s\S]*?overflow:\s*auto/)
  assert.match(COMPANY_STYLES, /\.dsh-company-governance-card__toggle:focus-visible/)
  assert.match(COMPANY_STYLES, /\.dsh-company-charter-item__row:focus-visible/)
  assert.match(COMPANY_STYLES, /\.dsh-company-price__body\[hidden\][\s\S]*?display:\s*none/)
})
