import assert from 'node:assert/strict'
import { readFile, stat } from 'node:fs/promises'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { join } from 'node:path'

const root = fileURLToPath(new URL('../', import.meta.url))
const read = (path) => readFile(join(root, path), 'utf8')
const exists = async (path) => {
  const value = await stat(join(root, path))
  assert.equal(value.isFile(), true, `${path} must be a file`)
}

const manifest = JSON.parse(await read('package.json'))
assert.equal(manifest.name, 'dsh-company')
assert.equal(manifest.version, '0.17.3')
assert.equal(manifest.type, 'module')
assert.equal(manifest.main, 'lib/index.js')
assert.equal(manifest.exports?.['./client']?.default, './lib/client.js')
assert.equal(manifest.dsh?.bundle?.patch, './cordis.patch.yml')
assert.equal(manifest.dsh?.client?.platform, 'web')
assert.deepEqual(manifest.dsh?.client?.inject, [
  '@deepseek-ai/dsh-client-runtime',
  '@deepseek-ai/dsh-client-locale',
  '@deepseek-ai/dsh-client-ui-layout',
  '@deepseek-ai/dsh-client-ui-conversation',
])
for (const unused of [
  '@deepseek-ai/dsh-client-ui-model-selection',
  '@deepseek-ai/dsh-client-ui-primitives',
  '@deepseek-ai/dsh-client-ui-slots',
]) {
  assert.equal(manifest.peerDependencies?.[unused], undefined, `${unused} must not be a peer`)
  assert.equal(manifest.devDependencies?.[unused], undefined, `${unused} must not be an unused build dependency`)
}
for (const entry of manifest.files ?? []) {
  assert.doesNotMatch(entry, /^(?:\.tmp|\.pnpm-cache|\.pnpm-store|node_modules)(?:\/|$)/)
}
assert.equal(manifest.files.includes('scripts/verify-package.mjs'), false, 'repository-only verifier must not be shipped without src/')

for (const file of [
  'lib/index.js',
  'lib/client.js',
  'lib/types/index.d.ts',
  'lib/types/client/index.d.ts',
  'cordis.patch.yml',
  'README.md',
  'README.en.md',
  'LICENSE',
  'docs/architecture.md',
]) await exists(file)
for (const map of ['lib/index.js.map', 'lib/client.js.map', 'lib/types/index.d.ts.map', 'lib/types/client/index.d.ts.map']) {
  await assert.rejects(stat(join(root, map)), /ENOENT/, `${map} must not inflate the production package`)
}

const patch = await read('cordis.patch.yml')
assert.match(patch, /^- insert:\s*$/m)
assert.match(patch, /^\s+- id: dsh-company\s*$/m)
assert.match(patch, /^\s+name: dsh-company\s*$/m)
assert.match(patch, /^\s+defaultCurrency: [A-Z][A-Z0-9_-]{2,11}\s*$/m)
assert.match(patch, /^\s+maxMoneyBudgetMicros: \d+\s*$/m)
assert.match(patch, /^\s+modelPrices: \[\]\s*$/m)
assert.match(patch, /^\s+maxTemporaryAuthorizationMs: \d+\s*$/m)

const client = await read('lib/client.js')
assert.doesNotMatch(client, /company-ui-action|session\.command/)
assert.match(client, /^window\.__ModuleLoader__\.load\(\{/)
assert.match(client, /\bid:\s*["']dsh-company["']/)
assert.match(client, /return module\.exports;/)
assert.doesNotMatch(client, /^\s*(?:import|export)\s/m)
const required = [...client.matchAll(/\brequire\(["']([^"']+)["']\)/g)].map((match) => match[1])
assert.deepEqual([...new Set(required)].sort(), ['react', 'react/jsx-runtime'])

let registration
const previousWindow = globalThis.window
globalThis.window = {
  __ModuleLoader__: {
    load(value) {
      registration = value
    },
  },
}
try {
  await import(`${pathToFileURL(join(root, 'lib/client.js')).href}?verify=${Date.now()}`)
} finally {
  if (previousWindow === undefined) delete globalThis.window
  else globalThis.window = previousWindow
}
assert.equal(registration?.id, 'dsh-company')
assert.equal(typeof registration?.factory, 'function')
const clientPlugin = registration.factory(createRequire(import.meta.url))
assert.equal(typeof clientPlugin.apply, 'function')
assert.deepEqual(clientPlugin.inject, ['slots', 'sessions', 'locale'])

const hostSource = await read('lib/index.js')
assert.doesNotMatch(hostSource, /company-ui-action|authenticated_command_required/)
assert.match(hostSource, /web_mutations_require_loopback/)
assert.match(hostSource, /remote_ui_denied/)
assert.match(hostSource, /executeUiAction/)
assert.match(hostSource, /webPublicStatus/)
await assert.rejects(stat(join(root, 'lib/types/command.d.ts')), /ENOENT/)
const host = await import(`${pathToFileURL(join(root, 'lib/index.js')).href}?verify=${Date.now()}`)
assert.equal(host.name, 'dsh-company')
assert.equal(typeof host.apply, 'function')
assert.deepEqual(host.inject, ['tools', 'llm', 'subagents', 'systemPrompt', 'agents'])

const readme = await read('README.md')
const architecture = await read('docs/architecture.md')
const toolsSource = await read('src/tools.ts')
assert.match(toolsSource, /\btotal_budget\b/)
assert.match(toolsSource, /\bproduct_budget\b/)
assert.match(toolsSource, /\bemployee_budget\b/)
assert.match(toolsSource, /input_cache_miss_per_million/)
assert.doesNotMatch(toolsSource, /\bbudget_micros\b|\btotal_budget_micros\b|allowance_micros|max_uses/)
assert.doesNotMatch(toolsSource, /input_cache_miss_micros_per_million/)
for (const document of [readme, architecture]) {
  assert.match(document, /\/plugins\/dsh-company\/state/)
  assert.match(document, /snake_case/)
  assert.match(document, /token/i)
  assert.match(document, /HR/i)
  assert.match(document, /货币|monetary/i)
  assert.match(document, /审计|audit/i)
  assert.match(document, /模型|model/i)
}
assert.doesNotMatch(architecture, /shared camelCase snapshot|\/plugins\/dsh-company\/snapshot/)

console.log(JSON.stringify({
  package: `${manifest.name}@${manifest.version}`,
  host: 'esm-ok',
  client: 'rc.2-cjs-factory-ok',
  clientRequires: [...new Set(required)].sort(),
  shipFiles: manifest.files,
}))
