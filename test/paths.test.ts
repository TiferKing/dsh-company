import assert from 'node:assert/strict'
import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import test from 'node:test'
import { canonicalWorkspace, normalizeMultilineString, normalizeString, normalizeWorkspaceRelative } from '../src/paths.js'

test('workspace identity is canonical and stable', async () => {
  const root = await mkdtemp(join(tmpdir(), 'dsh-company-path-'))
  try {
    const one = await canonicalWorkspace(root)
    const two = await canonicalWorkspace(root)
    assert.equal(one.sha256, two.sha256)
    assert.equal(one.key.length, 24)
    assert.equal(one.canonicalPath, root)
  } finally {
    await rm(root, { recursive: true, force: true })
  }
})

test('long-form documents keep line breaks while other control characters stay rejected', () => {
  const charter = '1. 创始人拥有最高决策权。\n2. 财务透明。\n  2.1 超支需先获批准。'
  assert.equal(normalizeMultilineString(charter, 'company charter', 32_768), charter)
  assert.equal(normalizeMultilineString(`\t${charter}\n`, 'company charter', 32_768), charter)
  assert.equal(normalizeMultilineString('ok\ttab', 'company charter', 32_768), 'ok\ttab')
  assert.throws(() => normalizeMultilineString('bad\x01escape', 'company charter', 32_768), /control characters other than line breaks/)
  assert.throws(() => normalizeMultilineString('bad\x7fdelete', 'company charter', 32_768), /control characters other than line breaks/)
  assert.throws(() => normalizeMultilineString(' ', 'company charter', 32_768), /must not be empty/)
  // Short identity fields remain strictly single-line.
  assert.throws(() => normalizeString('two\nlines', 'company slogan', 160), /must not contain control characters/)
})

test('workspace-relative paths reject traversal and Windows separators', () => {
  assert.equal(normalizeWorkspaceRelative('/workspace', 'src/**/*.ts', 'scope', { allowGlob: true }), 'src/**/*.ts')
  assert.throws(() => normalizeWorkspaceRelative('/workspace', '../secret', 'scope'), /parent-traversal|outside/)
  assert.throws(() => normalizeWorkspaceRelative('/workspace', 'src\\secret', 'scope'), /POSIX/)
  assert.throws(() => normalizeWorkspaceRelative('/workspace', '/etc/passwd', 'scope'), /workspace-relative/)
})
