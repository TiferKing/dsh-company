import { randomUUID } from 'node:crypto'
import type {
  ApprovalKind,
  CompanyState,
  GrantTemporaryAuthorizationInput,
  TemporaryAuthorization,
  TemporaryAuthorizationStatus,
  WorkItem,
  WorkKind,
} from './types.js'

/** Ordinary internal work eligible for the narrowly bounded approval-dependency waiver. */
export const TEMP_AUTH_INTERNAL_WORK_KINDS = new Set<WorkKind>([
  'discovery',
  'design',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
])

/** The only approval kinds a temporary authorization may waive. Future kinds fail closed. */
export const TEMP_AUTH_WAIVABLE_APPROVAL_KINDS = new Set<ApprovalKind>([
  'product_scope',
  'model_route',
])

export interface AuthorizationAdmission {
  authorization: TemporaryAuthorization
  bypassedApprovalIds: string[]
}

export function temporaryAuthorizationStatus(
  authorization: TemporaryAuthorization,
  now: number,
): TemporaryAuthorizationStatus {
  if (authorization.revokedAt !== undefined) return 'revoked'
  if (now < authorization.startsAt) return 'scheduled'
  if (authorization.expiresAt <= now) return 'expired'
  return 'active'
}

export function isTemporaryAuthorizationActive(authorization: TemporaryAuthorization, now: number): boolean {
  return authorization.startsAt <= now && now < authorization.expiresAt && authorization.revokedAt === undefined
}

export function createTemporaryAuthorization(
  state: CompanyState,
  input: GrantTemporaryAuthorizationInput,
  limits: { maxMs: number },
  now: number,
): TemporaryAuthorization {
  const employee = state.employees.find((candidate) => candidate.id === input.employeeId)
  if (employee === undefined || employee.status === 'retired') throw new Error(`unknown or retired employee ${input.employeeId}`)
  const reason = input.reason.normalize('NFC').trim()
  if (reason.length < 1 || reason.length > 4096) throw new Error('temporary authorization reason must contain 1..4096 characters')
  const startsAt = input.startsAt ?? now
  assertTimestamp(startsAt, 'startsAt')
  assertTimestamp(input.expiresAt, 'expiresAt')
  if (input.expiresAt <= startsAt) throw new Error('temporary authorization expiresAt must be after startsAt')
  if (input.expiresAt - startsAt > limits.maxMs) throw new Error(`temporary authorization duration exceeds ${limits.maxMs}ms`)
  if (state.temporaryAuthorizations.some((candidate) => candidate.employeeId === input.employeeId
    && candidate.revokedAt === undefined
    && candidate.startsAt < input.expiresAt
    && startsAt < candidate.expiresAt)) {
    throw new Error(`employee ${input.employeeId} already has an overlapping temporary authorization`)
  }
  state.counters.authorization += 1
  const authorization: TemporaryAuthorization = {
    id: `ta${state.counters.authorization}`,
    employeeId: input.employeeId,
    reason,
    approvalId: input.approvalId,
    authorizedBy: 'founder',
    startsAt,
    expiresAt: input.expiresAt,
    createdAt: now,
    uses: [],
  }
  state.temporaryAuthorizations.push(authorization)
  return authorization
}

export function revokeTemporaryAuthorization(
  state: CompanyState,
  authorizationId: string,
  reason: string,
  now: number,
): TemporaryAuthorization {
  const authorization = requireTemporaryAuthorization(state, authorizationId)
  if (authorization.revokedAt !== undefined) throw new Error(`temporary authorization ${authorizationId} is already revoked`)
  const normalized = reason.normalize('NFC').trim()
  if (normalized.length < 1 || normalized.length > 4096) throw new Error('revocation reason must contain 1..4096 characters')
  authorization.revokedAt = now
  authorization.revokedBy = 'founder'
  authorization.revocationReason = normalized
  return authorization
}

export function resolveAuthorizationAdmission(
  state: CompanyState,
  employeeId: string,
  work: WorkItem,
  now: number,
): AuthorizationAdmission | undefined {
  if (!TEMP_AUTH_INTERNAL_WORK_KINDS.has(work.kind)) return undefined
  const authorization = state.temporaryAuthorizations.find((candidate) => candidate.employeeId === employeeId && isTemporaryAuthorizationActive(candidate, now))
  if (authorization === undefined) return undefined
  return {
    authorization,
    bypassedApprovalIds: waivableApprovalDependencies(state, work, now),
  }
}

export function waivableApprovalDependencies(state: CompanyState, work: WorkItem, now = Date.now()): string[] {
  if (!TEMP_AUTH_INTERNAL_WORK_KINDS.has(work.kind)) return []
  return (work.approvalDependencies ?? []).filter((approvalId) => {
    const approval = state.approvals.find((candidate) => candidate.id === approvalId)
    // A temporary grant may relax a still-pending internal dependency, but it
    // must never override an explicit rejection, expiry, or cancellation.
    return approval !== undefined && approval.status === 'pending'
      && (approval.expiresAt === undefined || now < approval.expiresAt)
      && TEMP_AUTH_WAIVABLE_APPROVAL_KINDS.has(approval.kind)
  })
}

export function consumeTemporaryAuthorization(
  authorization: TemporaryAuthorization,
  input: {
    employeeId: string
    workId: string
    bypassed: Array<'company_budget' | 'product_budget' | 'employee_budget' | 'approval_dependency'>
    approvalIds?: string[]
    amountMicros?: number
    usageId?: string
    unknownCost?: boolean
  },
  now: number,
): void {
  if (!isTemporaryAuthorizationActive(authorization, now)) throw new Error(`temporary authorization ${authorization.id} is not active`)
  if (authorization.employeeId !== input.employeeId) throw new Error(`temporary authorization ${authorization.id} employee scope mismatch`)
  if (!Number.isSafeInteger(input.amountMicros ?? 0) || (input.amountMicros ?? 0) < 0) throw new Error('temporary authorization amountMicros must be a non-negative safe integer')
  const bypassed = [...new Set(input.bypassed)]
  if (bypassed.length === 0) return
  authorization.uses.push({
    id: randomUUID(),
    at: now,
    workId: input.workId,
    employeeId: input.employeeId,
    bypassed,
    ...(input.approvalIds === undefined || input.approvalIds.length === 0 ? {} : { approvalIds: [...new Set(input.approvalIds)] }),
    ...(input.amountMicros === undefined ? {} : { amountMicros: input.amountMicros }),
    ...(input.usageId === undefined ? {} : { usageId: input.usageId }),
    ...(input.unknownCost === undefined ? {} : { unknownCost: input.unknownCost }),
  })
}

export function requireTemporaryAuthorization(state: CompanyState, id: string): TemporaryAuthorization {
  const authorization = state.temporaryAuthorizations.find((candidate) => candidate.id === id)
  if (authorization === undefined) throw new Error(`unknown temporary authorization ${id}`)
  return authorization
}

function assertTimestamp(value: number, label: string): void {
  if (!Number.isSafeInteger(value) || value < 0) throw new Error(`${label} must be a non-negative Unix epoch millisecond timestamp`)
}
