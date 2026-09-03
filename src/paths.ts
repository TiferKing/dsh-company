import { createHash } from 'node:crypto'
import { existsSync, lstatSync, realpathSync } from 'node:fs'
import { lstat, mkdir, realpath } from 'node:fs/promises'
import { homedir } from 'node:os'
import { isAbsolute, join, normalize, posix, relative, resolve, sep } from 'node:path'
import { dshHomeDisplay, expandHomePath, resolveDshHome } from '@deepseek-ai/dsh-home-paths'
import type { ResolvedCompanyConfig, WorkspaceIdentity, WorkspacePaths } from './types.js'

export const STATE_SCHEMA_DIR = 'v1'

export function resolveStateRoot(configured?: string): { path: string; display: string } {
  if (configured !== undefined) {
    const trimmed = configured.trim()
    if (trimmed === '') throw new Error('stateRoot must not be empty')
    const expanded = expandHomePath(trimmed)
    const absolute = resolve(expanded)
    return { path: absolute, display: '$DSH_HOME/dsh-company (configured override)' }
  }
  const home = resolveDshHome()
  return {
    path: join(home, 'dsh-company'),
    display: `${dshHomeDisplay(home)}/dsh-company`,
  }
}

export async function canonicalWorkspace(cwd: string | undefined): Promise<WorkspaceIdentity> {
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('dsh-company requires a calling session with an absolute workspace cwd')
  }
  if (!isAbsolute(cwd)) throw new Error(`workspace cwd must be absolute: ${cwd}`)
  const canonicalPath = await realpath(cwd)
  const sha256 = createHash('sha256').update(canonicalPath).digest('hex')
  return { schemaVersion: 1, canonicalPath, sha256, key: sha256.slice(0, 24) }
}

export function canonicalWorkspaceSync(cwd: string | undefined): WorkspaceIdentity {
  if (cwd === undefined || cwd.trim() === '') {
    throw new Error('dsh-company requires a calling session with an absolute workspace cwd')
  }
  if (!isAbsolute(cwd)) throw new Error(`workspace cwd must be absolute: ${cwd}`)
  const canonicalPath = realpathSync(cwd)
  const sha256 = createHash('sha256').update(canonicalPath).digest('hex')
  return { schemaVersion: 1, canonicalPath, sha256, key: sha256.slice(0, 24) }
}

export function workspacePaths(stateRoot: string, workspace: WorkspaceIdentity): WorkspacePaths {
  const root = join(stateRoot, STATE_SCHEMA_DIR, 'workspaces', workspace.key)
  const activeDir = join(root, 'active')
  return {
    workspace,
    root,
    identityFile: join(root, 'identity.json'),
    activeDir,
    stateFile: join(activeDir, 'company.json'),
    auditFile: join(activeDir, 'events.jsonl'),
    mailboxDir: join(activeDir, 'mailboxes'),
    archiveDir: join(root, 'archive'),
    retiredSessionsFile: join(root, 'retired-sessions.json'),
  }
}

export async function ensurePrivateRoot(path: string): Promise<void> {
  await assertNotSymlink(path, 'state root')
  await mkdir(path, { recursive: true, mode: 0o700 })
  await assertNotSymlink(path, 'state root')
}

export async function assertNotSymlink(path: string, label: string): Promise<void> {
  try {
    if ((await lstat(path)).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
}

export function assertNotSymlinkSync(path: string, label: string): void {
  try {
    if (lstatSync(path).isSymbolicLink()) throw new Error(`${label} must not be a symbolic link: ${path}`)
  } catch (error) {
    if (isErrno(error, 'ENOENT')) return
    throw error
  }
}

export function normalizeWorkspaceRelative(
  workspace: string,
  input: string,
  label: string,
  options: { allowGlob?: boolean; allowRoot?: boolean } = {},
): string {
  const value = input.trim()
  if (value === '') throw new Error(`${label} must not be empty`)
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL`)
  if (value.includes('\\')) throw new Error(`${label} must use POSIX '/' separators`)
  if (posix.isAbsolute(value) || isAbsolute(value)) throw new Error(`${label} must be workspace-relative`)
  const parts = value.split('/')
  if (parts.some((part) => part === '' || part === '..')) {
    throw new Error(`${label} contains an empty or parent-traversal segment`)
  }
  if (parts.some((part) => part === '.') && !(options.allowRoot === true && value === '.')) {
    throw new Error(`${label} contains a current-directory segment`)
  }
  if (options.allowGlob !== true && /[*?[\]{}!]/.test(value)) {
    throw new Error(`${label} must not contain glob metacharacters`)
  }
  const normalized = posix.normalize(value)
  if (normalized === '.' && options.allowRoot !== true) throw new Error(`${label} must select a path below the workspace root`)
  const literalPrefix = normalized.split(/[*?[\]{}!]/, 1)[0] ?? normalized
  const candidate = resolve(workspace, literalPrefix === '' ? '.' : literalPrefix)
  const rel = relative(workspace, candidate)
  if (rel === '..' || rel.startsWith(`..${sep}`) || isAbsolute(rel)) {
    throw new Error(`${label} resolves outside the workspace`)
  }
  return normalized
}

export function normalizeString(value: string, label: string, maxChars: number, minChars = 1): string {
  const normalized = value.normalize('NFC').trim()
  if (normalized.length < minChars) throw new Error(`${label} must not be empty`)
  if (normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`)
  if (/\p{Cc}/u.test(normalized)) throw new Error(`${label} must not contain control characters`)
  return normalized
}

/** Long-form documents (charter, mission, summaries) legitimately span lines:
 * line breaks and tabs are permitted; every other control character is not. */
export function normalizeMultilineString(value: string, label: string, maxChars: number, minChars = 1): string {
  const normalized = value.normalize('NFC').trim()
  if (normalized.length < minChars) throw new Error(`${label} must not be empty`)
  if (normalized.length > maxChars) throw new Error(`${label} exceeds ${maxChars} characters`)
  if (/\p{Cc}/u.test(normalized.replace(/[\r\n\t]/gu, ''))) {
    throw new Error(`${label} must not contain control characters other than line breaks and tabs`)
  }
  return normalized
}

export function isStateRootInsideWorkspace(stateRoot: string, workspace: string): boolean {
  const rel = relative(workspace, stateRoot)
  return rel === '' || (!rel.startsWith(`..${sep}`) && rel !== '..' && !isAbsolute(rel))
}

export function isBroadWorkspace(workspace: string): boolean {
  const normalizedWorkspace = normalize(workspace)
  return normalizedWorkspace === normalize(homedir()) || normalizedWorkspace === resolve(sep)
}

export function effectiveLimits(saved: ResolvedCompanyConfig, state: { limits: Record<string, number> }): Record<string, number> {
  const configured: Record<string, number> = {
    maxEmployees: saved.maxEmployees,
    maxProducts: saved.maxProducts,
    maxWorkItems: saved.maxWorkItems,
    maxOpenWorkItems: saved.maxOpenWorkItems,
    maxAttemptsPerWork: saved.maxAttemptsPerWork,
    maxPendingApprovals: saved.maxPendingApprovals,
    maxMailboxMessages: saved.maxMailboxMessages,
    maxAuditBytes: saved.maxAuditBytes,
    maxMessageChars: saved.maxMessageChars,
    maxOutputChars: saved.maxOutputChars,
    memberMaxDepth: saved.memberMaxDepth,
  }
  const result: Record<string, number> = {}
  for (const [key, value] of Object.entries(configured)) {
    result[key] = Math.min(value, state.limits[key] ?? value)
  }
  return result
}

export function fileExists(path: string): boolean {
  return existsSync(path)
}

export function isErrno(error: unknown, code: string): error is NodeJS.ErrnoException {
  return error instanceof Error && 'code' in error && (error as NodeJS.ErrnoException).code === code
}
