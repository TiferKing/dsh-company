import { randomUUID } from 'node:crypto'
import { matchesGlob } from 'node:path'
import { assertAcyclic } from './schemas.js'
import { normalizeWorkspaceRelative } from './paths.js'
import { resolveAuthorizationAdmission } from './authorizations.js'
import type {
  CompanyState,
  ReviewFinding,
  UpdateWorkInput,
  WorkItem,
  WorkStatus,
} from './types.js'

const OPEN = new Set<WorkStatus>(['claimed', 'in_progress'])
const TERMINAL = new Set<WorkStatus>(['completed', 'failed', 'cancelled'])
const FILE_MUTATING_KINDS = new Set(['implementation', 'repair', 'integration', 'release', 'operations'])

function hasRequiredProtectedApproval(state: CompanyState, work: WorkItem): boolean {
  const dependencies = (work.approvalDependencies ?? []).map((approvalId) => state.approvals.find((candidate) => candidate.id === approvalId))
  if (work.kind === 'release') return dependencies.some((approval) => approval?.status === 'approved'
    && approval.kind === 'release'
    && typeof approval.payload === 'object' && approval.payload !== null && !Array.isArray(approval.payload)
    && approval.payload.productId === work.productId)
  if (work.kind === 'operations') return dependencies.some((approval) => approval?.status === 'approved' && approval.kind === 'external_effect')
  return true
}

export function workBlockedReasons(state: CompanyState, work: WorkItem, employeeId?: string, now = Date.now()): string[] {
  const reasons: string[] = []
  if (state.phase !== 'operating') reasons.push(`company_${state.phase}`)
  if (work.status === 'pending' && work.attempt >= state.limits.maxAttemptsPerWork) reasons.push('attempts_exhausted')
  const product = state.products.find((candidate) => candidate.id === work.productId)
  if (product === undefined) reasons.push('unknown_product')
  else if (product.status !== 'active' && product.status !== 'approved' && product.status !== 'validating') reasons.push(`product_${product.status}`)
  for (const dependencyId of work.dependencies) {
    const dependency = state.workItems.find((candidate) => candidate.id === dependencyId)
    if (dependency?.status !== 'completed') reasons.push(`dependency:${dependencyId}:${dependency?.status ?? 'missing'}`)
  }
  const authorization = employeeId === undefined ? undefined : resolveAuthorizationAdmission(state, employeeId, work, now)
  for (const approvalId of work.approvalDependencies ?? []) {
    const approval = state.approvals.find((candidate) => candidate.id === approvalId)
    if (approval?.status === 'approved') continue
    if (authorization?.bypassedApprovalIds.includes(approvalId) === true) continue
    reasons.push(`approval:${approvalId}:${approval?.status ?? 'missing'}`)
  }
  // Ticket-linked repair work waits for an explicit dispatch decision before
  // admission; only dispatched (or already resolved) tickets may be claimed.
  if (work.ticketId !== undefined) {
    const ticket = state.tickets.find((candidate) => candidate.id === work.ticketId)
    if (ticket !== undefined && ticket.status !== 'dispatched' && ticket.status !== 'resolved') {
      reasons.push(`ticket_awaiting_dispatch:${work.ticketId}`)
    }
  }
  if (work.kind === 'release' && !hasRequiredProtectedApproval(state, work)) reasons.push('release_approval_required')
  if (work.kind === 'operations' && !hasRequiredProtectedApproval(state, work)) reasons.push('operations_approval_required')
  if (state.workItems.filter((candidate) => OPEN.has(candidate.status)).length >= state.limits.maxOpenWorkItems) reasons.push('open_work_cap')
  if (work.assigneeId !== undefined && work.assigneeId !== 'founder') {
    const employee = state.employees.find((candidate) => candidate.id === work.assigneeId)
    if (employee === undefined || employee.status === 'retired' || employee.status === 'failed' || employee.status === 'paused') reasons.push('assignee_unavailable')
  }
  if ((work.eligibleEmployeeIds?.length ?? 0) > 0) {
    const available = state.employees.some((employee) => work.eligibleEmployeeIds?.includes(employee.id) === true && !['retired', 'failed', 'paused'].includes(employee.status))
    if (!available) reasons.push('no_eligible_employee')
  }
  return [...new Set(reasons)]
}

export function canEmployeeOwn(state: CompanyState, work: WorkItem, employeeId: string): boolean {
  const employee = state.employees.find((candidate) => candidate.id === employeeId)
  if (employee === undefined || employee.status === 'retired' || employee.status === 'failed' || employee.status === 'paused') return false
  // HR governance employees never receive ordinary work — their sole channel
  // is staffing assessments and direct messages, both handled by the scheduler.
  if (employee.isHr === true) return false
  if (work.assigneeId !== undefined && work.assigneeId !== employeeId) return false
  if ((work.eligibleEmployeeIds?.length ?? 0) > 0 && work.eligibleEmployeeIds?.includes(employeeId) !== true) return false
  if ((work.eligibleOrgUnitIds?.length ?? 0) > 0) {
    if (employee.orgUnitId === undefined) return false
    const eligible = work.eligibleOrgUnitIds!.some((unitId) =>
      unitId === employee.orgUnitId || isDescendantOrgUnit(state, employee.orgUnitId!, unitId))
    if (!eligible) return false
  }
  if (work.kind === 'review' && work.reviewedWorkId !== undefined) {
    const reviewed = state.workItems.find((candidate) => candidate.id === work.reviewedWorkId)
    if (reviewed?.assigneeId === employeeId) return false
  }
  return true
}

/** True when unitId is a strict descendant of ancestorId in the org tree. */
export function isDescendantOrgUnit(state: Pick<CompanyState, 'orgUnits'>, unitId: string, ancestorId: string): boolean {
  let current = state.orgUnits.find((unit) => unit.id === unitId)
  const seen = new Set<string>()
  while (current !== undefined && current.parentId !== undefined) {
    if (seen.has(current.id)) return false
    seen.add(current.id)
    if (current.parentId === ancestorId) return true
    current = state.orgUnits.find((unit) => unit.id === current!.parentId)
  }
  return false
}

export function selectReadyWork(state: CompanyState, employeeId: string, now = Date.now()): WorkItem | undefined {
  if (state.phase !== 'operating') return undefined
  if (state.workItems.some((work) => work.assigneeId === employeeId && OPEN.has(work.status))) return undefined
  const candidates = state.workItems
    .filter((work) => work.status === 'pending' && work.reassigning !== true && workBlockedReasons(state, work, employeeId, now).length === 0 && canEmployeeOwn(state, work, employeeId))
    .sort(compareWork)
  return candidates.find((work) => work.assigneeId === employeeId)
    ?? candidates.find((work) => work.assigneeId === undefined)
}

export function beginWorkAttempt(state: CompanyState, work: WorkItem, assigneeId: string | 'founder', now = Date.now()): string {
  if (work.status !== 'pending' || work.reassigning === true) throw new Error(`work ${work.id} is not pending and claimable`)
  const blockers = workBlockedReasons(state, work, assigneeId === 'founder' ? undefined : assigneeId, now)
  if (blockers.length > 0) throw new Error(`work ${work.id} is blocked: ${blockers.join(', ')}`)
  if (work.attempt >= state.limits.maxAttemptsPerWork) throw new Error(`work ${work.id} exhausted ${state.limits.maxAttemptsPerWork} attempts`)
  if (assigneeId !== 'founder') {
    if (!canEmployeeOwn(state, work, assigneeId)) throw new Error(`employee ${assigneeId} is not eligible for work ${work.id}`)
    const open = state.workItems.find((candidate) => candidate.id !== work.id && candidate.assigneeId === assigneeId && OPEN.has(candidate.status))
    if (open !== undefined) throw new Error(`employee ${assigneeId} already owns open work ${open.id}`)
  } else {
    const founderOpen = state.workItems.find((candidate) => candidate.id !== work.id && candidate.assigneeId === 'founder' && OPEN.has(candidate.status))
    if (founderOpen !== undefined) throw new Error(`founder already owns open work ${founderOpen.id}`)
    if (work.assigneeId !== 'founder') throw new Error(`founder may claim only work explicitly reassigned to founder`)
  }
  work.attempt += 1
  work.attemptId = randomUUID()
  work.status = 'claimed'
  work.assigneeId = assigneeId
  work.handoffId = undefined
  work.reassigning = false
  work.deliveryAttempts = 0
  work.output = undefined
  work.verdict = undefined
  work.findings = undefined
  work.evidence = undefined
  work.updatedAt = now
  return work.attemptId
}

export function updateWork(
  state: CompanyState,
  workspace: string,
  actorId: string | 'founder',
  input: UpdateWorkInput,
): WorkItem {
  const work = requireWork(state, input.workId)
  if (work.attemptId === undefined || work.attemptId !== input.attemptId) throw new StaleAttemptError(work.id)
  if (work.assigneeId !== actorId) throw new Error(`work ${work.id} is owned by ${work.assigneeId ?? 'nobody'}, not ${actorId}`)
  if (TERMINAL.has(work.status)) throw new Error(`terminal work ${work.id} is immutable`)
  const next = input.status ?? work.status
  if (work.status === 'claimed' && next !== 'claimed' && next !== 'in_progress' && next !== 'failed' && next !== 'cancelled') {
    throw new Error('claimed work must enter in_progress before completion')
  }
  if (work.status === 'in_progress' && !['in_progress', 'completed', 'failed', 'cancelled'].includes(next)) {
    throw new Error(`work cannot move from in_progress to ${next}`)
  }
  const output = input.output === undefined ? work.output : bound(input.output.trim(), state.limits.maxOutputChars)
  if ((next === 'completed' || next === 'failed' || next === 'cancelled') && (output === undefined || output === '')) {
    throw new Error(`terminal work update ${next} requires non-empty output`)
  }
  // Updates are patches: evidence and review results may be reported over
  // several progress calls before the terminal status is submitted.
  const changedPaths = input.changedPaths?.map((path, index) => normalizeWorkspaceRelative(workspace, path, `changed_paths[${index}]`, { allowGlob: false })) ?? work.evidence?.changedPaths
  const acceptanceResults = input.acceptanceResults === undefined ? work.evidence?.acceptanceResults : normalizeEvidence(input.acceptanceResults, 'acceptance_results')
  const commandsRun = input.commandsRun === undefined ? work.evidence?.commandsRun : normalizeEvidence(input.commandsRun, 'commands_run')
  const verdict = input.verdict ?? work.verdict
  const findings = input.findings === undefined ? work.findings : normalizeFindings(input.findings)
  if (next === 'completed') validateCompletion(state, work, actorId, {
    output,
    verdict,
    findings,
    changedPaths,
    acceptanceResults,
    commandsRun,
  })
  if (work.kind === 'review' && (verdict === 'needs_revision' || verdict === 'reject')) {
    if ((findings?.length ?? 0) === 0) throw new Error(`${verdict} review requires findings`)
    if (next === 'completed') throw new Error(`${verdict} review must fail rather than complete`)
  }
  work.status = next
  work.output = output
  if (verdict !== undefined) work.verdict = verdict
  if (findings !== undefined) work.findings = findings
  work.evidence = {
    ...(changedPaths === undefined ? {} : { changedPaths }),
    ...(acceptanceResults === undefined ? {} : { acceptanceResults }),
    ...(commandsRun === undefined ? {} : { commandsRun }),
  }
  work.updatedAt = Date.now()
  if (next === 'failed' || next === 'cancelled') {
    work.attemptHistory.push({
      attempt: work.attempt,
      ...(work.assigneeId === undefined ? {} : { assigneeId: work.assigneeId }),
      status: next,
      ...(output === undefined ? {} : { output }),
      closedAt: Date.now(),
    })
    work.attemptId = undefined
    work.reservationId = undefined
    work.leaseAt = undefined
  }
  if (next === 'completed') {
    work.attemptId = undefined
    work.reservationId = undefined
    work.leaseAt = undefined
  }
  return work
}

export function invalidateAttempt(work: WorkItem, nextAssignee: string | 'founder', reason: string): string {
  if (work.status === 'completed') throw new Error('completed work is immutable')
  if (reason.trim() === '') throw new Error('reassignment reason must not be empty')
  if (OPEN.has(work.status)) {
    work.attemptHistory.push({
      attempt: work.attempt,
      ...(work.assigneeId === undefined ? {} : { assigneeId: work.assigneeId }),
      status: 'cancelled',
      output: bound(`Reassigned: ${reason.trim()}`, 4096),
      closedAt: Date.now(),
    })
  }
  work.attemptId = undefined
  work.reservationId = undefined
  work.leaseAt = undefined
  work.handoffId = randomUUID()
  work.reassigning = true
  work.deliveryAttempts = 0
  work.status = 'pending'
  work.assigneeId = nextAssignee
  work.output = undefined
  work.verdict = undefined
  work.findings = undefined
  work.evidence = undefined
  work.updatedAt = Date.now()
  return work.handoffId
}

export function finishHandoff(work: WorkItem, handoffId: string): void {
  if (work.handoffId !== handoffId) throw new Error(`work ${work.id} handoff was superseded`)
  work.handoffId = undefined
  work.reassigning = false
  work.updatedAt = Date.now()
}

export function validateDependencyReplacement(state: CompanyState, workId: string, dependencies: string[]): void {
  const unique = [...new Set(dependencies)]
  if (unique.length !== dependencies.length) throw new Error('work dependencies must be unique')
  if (unique.includes(workId)) throw new Error('work cannot depend on itself')
  for (const dependency of unique) if (!state.workItems.some((work) => work.id === dependency)) throw new Error(`unknown work dependency ${dependency}`)
  const graph = state.workItems.map((work) => ({ id: work.id, dependencies: work.id === workId ? unique : work.dependencies }))
  assertAcyclic(graph)
}

export function isOpenStatus(status: WorkStatus): boolean {
  return OPEN.has(status)
}

export function requireWork(state: CompanyState, workId: string): WorkItem {
  const work = state.workItems.find((candidate) => candidate.id === workId)
  if (work === undefined) throw new Error(`unknown work item ${workId}`)
  return work
}

function validateCompletion(
  state: CompanyState,
  work: WorkItem,
  actorId: string | 'founder',
  evidence: {
    output?: string
    verdict?: 'pass' | 'needs_revision' | 'reject'
    findings?: ReviewFinding[]
    changedPaths?: string[]
    acceptanceResults?: string[]
    commandsRun?: string[]
  },
): void {
  if (evidence.output === undefined || evidence.output === '') throw new Error('completed work requires output')
  if (work.kind === 'review') {
    if (work.reviewedWorkId === undefined) throw new Error('review work requires reviewedWorkId')
    const reviewed = requireWork(state, work.reviewedWorkId)
    if (reviewed.assigneeId === actorId) throw new Error('an employee may not review its own work')
    if (evidence.verdict !== 'pass') throw new Error('review work may complete only with verdict=pass')
  }
  if (FILE_MUTATING_KINDS.has(work.kind)) {
    if ((evidence.changedPaths?.length ?? 0) === 0) throw new Error(`${work.kind} completion requires changed_paths evidence`)
    if ((evidence.acceptanceResults?.length ?? 0) === 0) throw new Error(`${work.kind} completion requires acceptance_results evidence`)
    for (const changed of evidence.changedPaths ?? []) {
      if (!work.inScope.some((scope) => matchesScope(scope, changed))) throw new Error(`changed path ${changed} is outside work in_scope`)
      if (work.outOfScope.some((scope) => matchesScope(scope, changed))) throw new Error(`changed path ${changed} is explicitly out_of_scope`)
    }
  }
  if (!hasRequiredProtectedApproval(state, work)) throw new Error(`${work.kind} completion requires a matching approved request`)
}

function matchesScope(scope: string, changed: string): boolean {
  if (!/[*?[\]{}!]/.test(scope)) return changed === scope || changed.startsWith(`${scope.replace(/\/$/, '')}/`)
  return matchesGlob(changed, scope)
}

function normalizeFindings(findings: ReviewFinding[]): ReviewFinding[] {
  return findings.map((finding, index) => {
    if (!['low', 'medium', 'high', 'blocker'].includes(finding.severity)) throw new Error(`findings[${index}].severity is invalid`)
    if (finding.problem.trim() === '' || finding.requiredFix.trim() === '') throw new Error(`findings[${index}] requires problem and required_fix`)
    if (finding.line !== undefined && (!Number.isSafeInteger(finding.line) || finding.line < 1)) throw new Error(`findings[${index}].line is invalid`)
    return {
      id: finding.id.trim() === '' ? randomUUID() : finding.id.trim(),
      severity: finding.severity,
      ...(finding.file === undefined ? {} : { file: finding.file.trim() }),
      ...(finding.line === undefined ? {} : { line: finding.line }),
      problem: bound(finding.problem.trim(), 8192),
      requiredFix: bound(finding.requiredFix.trim(), 8192),
    }
  })
}

function normalizeEvidence(items: string[], label: string): string[] {
  if (items.length === 0) throw new Error(`${label} must not be empty when provided`)
  return items.map((item, index) => {
    const trimmed = item.trim()
    if (trimmed === '') throw new Error(`${label}[${index}] must not be empty`)
    return bound(trimmed, 8192)
  })
}

function compareWork(a: WorkItem, b: WorkItem): number {
  return a.createdAt - b.createdAt || numericId(a.id) - numericId(b.id)
}

function numericId(id: string): number {
  return Number(id.slice(1))
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}

export class StaleAttemptError extends Error {
  constructor(workId: string) {
    super(`stale attempt capability for work ${workId}; stop work because it was reassigned or closed`)
    this.name = 'StaleAttemptError'
  }
}
