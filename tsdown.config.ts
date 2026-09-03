import { defineConfig } from 'tsdown'

const PLUGIN_ID = 'dsh-company'
const CLIENT_EXTERNALS = ['react', 'react/jsx-runtime']

const host = {
  entry: { index: 'src/index.ts' },
  outDir: 'lib',
  format: ['esm'] as const,
  platform: 'node' as const,
  target: 'es2022',
  clean: false,
  dts: false,
  sourcemap: true,
  tsconfig: 'tsconfig.json',
  deps: {
    neverBundle: [/^@deepseek-ai\//, /^react(?:\/|$)/],
  },
  outputOptions: {
    entryFileNames: 'index.js',
  },
}

/**
 * DSH Web consumes lazy CommonJS factories, not browser ESM. Keep React in the
 * shell's static module table and bundle every package-local client module into
 * this one factory so synchronous require() has no undeclared graph edges.
 */
const client = {
  entry: { client: 'src/client/index.tsx' },
  outDir: 'lib',
  format: ['cjs'] as const,
  platform: 'browser' as const,
  target: 'es2022',
  clean: false,
  dts: false,
  sourcemap: true,
  tsconfig: 'tsconfig.client.json',
  checks: { legacyCjs: false },
  deps: {
    neverBundle: CLIENT_EXTERNALS,
    alwaysBundle: (id: string) => !CLIENT_EXTERNALS.includes(id),
  },
  define: {
    'process.env.NODE_ENV': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env.MODE': JSON.stringify(process.env.NODE_ENV ?? 'production'),
    'import.meta.env': JSON.stringify({ MODE: process.env.NODE_ENV ?? 'production' }),
  },
  outputOptions: {
    entryFileNames: 'client.js',
    banner: `window.__ModuleLoader__.load({ id: ${JSON.stringify(PLUGIN_ID)}, factory: (require) => {`,
    intro: 'var module = { exports: {} }; var exports = module.exports;',
    footer: 'return module.exports; } });',
  },
}

export default defineConfig([host, client])
