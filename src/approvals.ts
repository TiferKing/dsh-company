import type {
  ApprovalKind,
  ApprovalRequest,
  CompanyState,
  JsonValue,
  ResolvedCompanyConfig,
} from './types.js'
import { normalizeMultilineString } from './paths.js'
import { adjustMoneyBudgetTotal, pricingMatrixDigest, replaceModelPrices, resolveRateSnapshot } from './money.js'
import { validateApprovalPayload, isRecord, normalizeEmployeeLimit, normalizeCurrency, normalizeModelPrices } from './schemas.js'
import type { ModelPriceInput } from './types.js'

export interface ApprovalResolutionInput {
  approvalId: string
  decision: 'approved' | 'rejected'
  source: 'ui' | 'tool'
  humanStatement?: string
  note?: string
}

export function createApproval(
  state: CompanyState,
  requestedBy: 'founder' | string,
  input: {
    kind: ApprovalKind
    summary: string
    detail?: string
    payload: JsonValue
    risk?: 'low' | 'medium' | 'high'
    expiresAt?: number
    requestedFromUserMessageId?: string
  },
): ApprovalRequest {
  expirePendingApprovals(state)
  const pending = state.approvals.filter((approval) => approval.status === 'pending').length
  if (pending >= state.limits.maxPendingApprovals) throw new Error(`pending approval cap ${state.limits.maxPendingApprovals} reached`)
  const summary = input.summary.normalize('NFC').trim()
  if (summary === '' || summary.length > 4096) throw new Error('approval summary must contain 1..4096 characters')
  const detail = input.detail === undefined ? undefined : normalizeMultilineString(input.detail, 'approval detail', 4096)
  validateApprovalPayload(input.kind, input.payload)
  if (input.expiresAt !== undefined && (!Number.isSafeInteger(input.expiresAt) || input.expiresAt <= Date.now())) {
    throw new Error('approval expires_at must be a future Unix epoch millisecond timestamp')
  }
  const payload = structuredClone(input.payload)
  if (input.kind === 'budget_change' && isRecord(payload) && Array.isArray(payload.employeeAllocations)) {
    const employeeIds = new Set<unknown>()
    for (const allocation of payload.employeeAllocations) {
      if (!isRecord(allocation)) throw new Error('employee allocation must be an object')
      if (employeeIds.has(allocation.id)) throw new Error(`budget_change.employeeAllocations contains duplicate employee id ${String(allocation.id)}`)
      employeeIds.add(allocation.id)
      const employee = state.employees.find((candidate) => candidate.id === allocation.id && candidate.status !== 'retired')
      if (employee === undefined) throw new Error(`employee allocation ${String(allocation.id)} must target an active employee`)
      const expectedBudgetMicros = employee.budgetMicros ?? 0
      if (allocation.expectedBudgetMicros !== undefined && allocation.expectedBudgetMicros !== expectedBudgetMicros) {
        throw new Error(`employee ${employee.id} monetary ceiling changed; request a new budget approval`)
      }
      allocation.expectedBudgetMicros = expectedBudgetMicros
    }
  }
  state.counters.approval += 1
  const approval: ApprovalRequest = {
    id: `a${state.counters.approval}`,
    kind: input.kind,
    status: 'pending',
    requestedBy,
    summary,
    ...(detail === undefined ? {} : { detail }),
    payload,
    risk: input.risk ?? defaultRisk(input.kind),
    requestedAt: Date.now(),
    ...(input.requestedFromUserMessageId === undefined ? {} : { requestedFromUserMessageId: input.requestedFromUserMessageId }),
    ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
  }
  state.approvals.push(approval)
  return approval
}

export function expirePendingApprovals(state: CompanyState, now = Date.now()): number {
  let expired = 0
  for (const approval of state.approvals) {
    if (approval.status !== 'pending' || approval.expiresAt === undefined || approval.expiresAt > now) continue
    approval.status = 'expired'
    approval.resolvedAt = now
    if (approval.kind === 'organization_change' && isRecord(approval.payload) && typeof approval.payload.staffingRequestId === 'string') {
      const staffingRequestId = approval.payload.staffingRequestId
      const request = state.staffingRequests.find((candidate) => candidate.id === staffingRequestId && candidate.approvalId === approval.id)
      if (request !== undefined && request.status === 'recommended') {
        request.status = 'rejected'
        request.updatedAt = now
      }
    }
    expired += 1
  }
  return expired
}

export function resolveApproval(
  state: CompanyState,
  config: ResolvedCompanyConfig,
  input: ApprovalResolutionInput,
): { approval: ApprovalRequest; applied: boolean; stale: boolean } {
  const approval = requireApproval(state, input.approvalId)
  if (approval.status !== 'pending') throw new Error(`approval ${approval.id} is already ${approval.status}; terminal approvals are immutable`)
  if (approval.expiresAt !== undefined && approval.expiresAt <= Date.now()) {
    expirePendingApprovals(state)
    return { approval, applied: false, stale: false }
  }
  const statement = input.humanStatement?.trim()
  if (input.source === 'tool' && (statement === undefined || statement === '')) {
    throw new Error('tool-based approval resolution requires the human_statement from the current user turn')
  }
  if (input.decision === 'rejected') {
    approval.status = 'rejected'
    approval.resolvedAt = Date.now()
    approval.resolution = {
      decision: 'rejected',
      source: input.source,
      ...(statement === undefined ? {} : { humanStatement: bound(statement, 4096) }),
      ...(input.note?.trim() ? { note: bound(input.note.trim(), 4096) } : {}),
    }
    return { approval, applied: false, stale: false }
  }
  const staleReason = approvalPreconditionError(state, approval)
  if (staleReason !== undefined) {
    approval.status = 'cancelled'
    approval.resolvedAt = Date.now()
    approval.resolution = {
      decision: 'rejected',
      source: input.source,
      humanStatement: statement === undefined ? 'Approval cancelled because its state precondition became stale.' : bound(statement, 4096),
      note: bound(`Stale precondition: ${staleReason}`, 4096),
    }
    return { approval, applied: false, stale: true }
  }
  const applied = applyApprovedPayload(state, config, approval)
  approval.status = 'approved'
  approval.resolvedAt = Date.now()
  approval.resolution = {
    decision: 'approved',
    source: input.source,
    ...(statement === undefined ? {} : { humanStatement: bound(statement, 4096) }),
    ...(input.note?.trim() ? { note: bound(input.note.trim(), 4096) } : {}),
  }
  return { approval, applied, stale: false }
}

export function requireApproved(
  state: CompanyState,
  approvalId: string | undefined,
  kind: ApprovalKind,
  predicate?: (payload: JsonValue) => boolean,
): ApprovalRequest {
  if (approvalId === undefined) throw new Error(`${kind} approval_id is required`)
  const approval = requireApproval(state, approvalId)
  if (approval.kind !== kind || approval.status !== 'approved') throw new Error(`approval ${approvalId} is not an approved ${kind} request`)
  if (approval.consumedAt !== undefined) throw new Error(`approval ${approvalId} has already been consumed`)
  if (predicate !== undefined && !predicate(approval.payload)) throw new Error(`approval ${approvalId} payload does not authorize this exact change`)
  return approval
}

export function consumeApproval(approval: ApprovalRequest): void {
  if (approval.status !== 'approved') throw new Error(`cannot consume non-approved request ${approval.id}`)
  if (approval.consumedAt !== undefined) throw new Error(`approval ${approval.id} has already been consumed`)
  approval.consumedAt = Date.now()
}

export function requireApproval(state: CompanyState, approvalId: string): ApprovalRequest {
  const approval = state.approvals.find((candidate) => candidate.id === approvalId)
  if (approval === undefined) throw new Error(`unknown approval ${approvalId}`)
  return approval
}

function approvalPreconditionError(state: CompanyState, approval: ApprovalRequest): string | undefined {
  if (!isRecord(approval.payload)) return 'payload is not an object'
  switch (approval.kind) {
    case 'bootstrap':
      if (state.phase !== 'staged' && state.phase !== 'provisioning_failed') return `company phase is ${state.phase}`
      if (approval.payload.companyId !== state.id) return 'company id changed'
      return undefined
    case 'budget_change':
      if (approval.payload.expectedTotalMicros !== state.moneyBudget.totalMicros) return 'money budget total changed'
      if (Array.isArray(approval.payload.employeeAllocations)) {
        const employeeIds = new Set<unknown>()
        for (const allocation of approval.payload.employeeAllocations) {
          if (!isRecord(allocation)) return 'employee allocation is not an object'
          if (employeeIds.has(allocation.id)) return `employee budget request contains duplicate employee id ${String(allocation.id)}; request a new budget approval`
          employeeIds.add(allocation.id)
          const employee = state.employees.find((candidate) => candidate.id === allocation.id && candidate.status !== 'retired')
          if (employee === undefined) return `employee ${String(allocation.id)} is no longer active`
          if (allocation.expectedBudgetMicros === undefined) return `employee ${employee.id} budget precondition is missing; request a new budget approval`
          if (allocation.expectedBudgetMicros !== (employee.budgetMicros ?? 0)) return `employee ${employee.id} monetary ceiling changed`
        }
      }
      return undefined
    case 'pricing_change':
      if (approval.payload.expectedCurrency !== state.moneyBudget.currency) return 'money budget currency changed'
      if (approval.payload.expectedPricingRevision !== state.moneyBudget.pricingRevision) return 'pricing revision changed'
      if (approval.payload.expectedDigest !== pricingDigest(state)) return 'pricing matrix changed'
      return undefined
    case 'governance_change':
      if (approval.payload.expectedGovernanceRevision !== state.governanceRevision) return 'governance revision changed'
      if (typeof approval.payload.maxEmployees === 'number' && approval.payload.maxEmployees < state.employees.filter((employee) => employee.status !== 'retired').length) {
        return 'requested employee ceiling is below current active headcount; retire employees and request a new approval'
      }
      return undefined
    case 'temporary_authorization':
      if (approval.payload.action === 'revoke') {
        const id = approval.payload.authorizationId
        if (typeof id !== 'string' || !state.temporaryAuthorizations.some((authorization) => authorization.id === id && authorization.revokedAt === undefined)) return 'authorization is no longer revocable'
      }
      return undefined
    case 'organization_change': {
      const staffingRequestId = approval.payload.staffingRequestId
      const request = typeof staffingRequestId === 'string' ? state.staffingRequests.find((candidate) => candidate.id === staffingRequestId) : undefined
      if (request === undefined || request.approvalId !== approval.id || request.status !== 'recommended') return 'staffing recommendation is no longer current'
      if (approval.payload.action === 'adjust' || approval.payload.action === 'retire' || approval.payload.action === 'remove') {
        const employeeId = approval.payload.employeeId
        if (typeof employeeId !== 'string' || !state.employees.some((employee) => employee.id === employeeId && employee.status !== 'retired')) return 'target employee is no longer active'
      }
      return undefined
    }
    case 'product_scope': {
      const productId = approval.payload.productId
      if (productId !== undefined && (typeof productId !== 'string' || !state.products.some((product) => product.id === productId))) return 'target product no longer exists'
      return undefined
    }
    case 'model_route': {
      const employeeId = approval.payload.employeeId
      if (typeof employeeId !== 'string' || !state.employees.some((employee) => employee.id === employeeId && employee.status !== 'retired')) return 'target employee is no longer active'
      return undefined
    }
    case 'release': {
      const productId = approval.payload.productId
      const product = typeof productId === 'string' ? state.products.find((candidate) => candidate.id === productId) : undefined
      if (product === undefined) return 'target product no longer exists'
      if (product.status !== 'validating' && product.status !== 'active') return `product phase is ${product.status}`
      return releaseGateError(state, product.id)
    }
    case 'external_effect':
    case 'forced_archive':
      return undefined
  }
}

function applyApprovedPayload(state: CompanyState, config: ResolvedCompanyConfig, approval: ApprovalRequest): boolean {
  if (!isRecord(approval.payload)) throw new Error('approval payload must be an object')
  switch (approval.kind) {
    case 'budget_change': {
      const total = approval.payload.newTotalMicros as number
      if (total > config.maxMoneyBudgetMicros) throw new Error(`money budget exceeds configured maximum ${config.maxMoneyBudgetMicros}`)
      if (state.moneyBudget.migrationRequired === true && approval.payload.legacyTreatment !== 'accepted') {
        throw new Error('financial migration remediation must explicitly accept the preserved v0.2 ledger treatment')
      }
      applyMoneyAllocations(state, approval.payload.productAllocations, approval.payload.employeeAllocations)
      adjustMoneyBudgetTotal(state, total)
      if (approval.payload.legacyTreatment === 'accepted' && state.moneyBudget.legacyV02 !== undefined) {
        state.moneyBudget.legacyV02.treatment = 'accepted'
      }
      tryCompleteFinancialMigration(state)
      approval.consumedAt = Date.now()
      return true
    }
    case 'pricing_change': {
      const currency = normalizeCurrency(approval.payload.currency as string)
      if (currency !== state.moneyBudget.currency && (
        state.moneyBudget.usage.length > 0
        || state.moneyBudget.reservations.length > 0
        || state.moneyBudget.legacyV02 !== undefined
      )) {
        throw new Error('currency is immutable after any usage, reservation, or legacy ledger; establish a separately approved currency epoch')
      }
      state.moneyBudget.currency = currency
      const prices = normalizeModelPrices(approval.payload.prices as unknown as ModelPriceInput[], 'manual', state.moneyBudget.pricingRevision + 1, Date.now())
      replaceModelPrices(state, prices)
      tryCompleteFinancialMigration(state)
      approval.consumedAt = Date.now()
      return true
    }
    case 'governance_change': {
      // This branch only runs after the human decision and revision/headcount checks.
      if (approval.payload.maxEmployees !== undefined) state.limits.maxEmployees = normalizeEmployeeLimit(approval.payload.maxEmployees)
      if (approval.payload.slogan !== undefined) state.slogan = String(approval.payload.slogan).normalize('NFC').trim()
      if (approval.payload.mission !== undefined) state.mission = String(approval.payload.mission).normalize('NFC').trim()
      if (approval.payload.charter !== undefined) state.formation.charter = String(approval.payload.charter).normalize('NFC').trim()
      state.governanceRevision += 1
      state.formation.lastEditedAt = Date.now()
      const root = state.orgUnits.find((unit) => unit.parentId === undefined)
      if (root !== undefined) root.description = `${state.slogan}\n${state.mission}`.slice(0, 4096)
      approval.consumedAt = Date.now()
      return true
    }
    case 'release': {
      const productId = approval.payload.productId
      const product = typeof productId === 'string' ? state.products.find((candidate) => candidate.id === productId) : undefined
      if (product === undefined) throw new Error('release target product disappeared')
      product.releaseApprovalId = approval.id
      product.status = 'validating'
      product.updatedAt = Date.now()
      return true
    }
    case 'bootstrap':
    case 'temporary_authorization':
    case 'organization_change':
    case 'product_scope':
    case 'model_route':
    case 'external_effect':
    case 'forced_archive':
      // These approvals authorize a later exact transition. In particular,
      // product_scope must not mutate or consume a product while the human is
      // merely recording the authorization.
      return false
  }
}

export function pricingDigest(state: Pick<CompanyState, 'moneyBudget'>): string {
  return pricingMatrixDigest(state.moneyBudget)
}

function tryCompleteFinancialMigration(state: CompanyState): void {
  if (state.moneyBudget.migrationRequired !== true || state.moneyBudget.legacyV02?.treatment !== 'accepted') return
  if (state.moneyBudget.spentMicros + state.moneyBudget.reservedMicros > state.moneyBudget.totalMicros) return
  const allocated = state.products.filter((product) => !['cancelled', 'retired'].includes(product.status)).reduce((sum, product) => sum + (product.budgetMicros ?? 0), 0)
  if (allocated > state.moneyBudget.totalMicros) return
  if (state.employees.some((employee) => employee.status !== 'retired' && (employee.budgetMicros ?? 0) > state.moneyBudget.totalMicros)) return
  try {
    for (const employee of state.employees) {
      if (employee.status === 'retired' || employee.status === 'failed') continue
      resolveRateSnapshot(state, employee.llm.provider, employee.llm.model)
      if (employee.llm.fallback !== undefined) resolveRateSnapshot(state, employee.llm.fallback.provider, employee.llm.fallback.model)
    }
  } catch {
    return
  }
  state.moneyBudget.migrationRequired = false
}

function applyMoneyAllocations(state: CompanyState, productRaw: JsonValue | undefined, employeeRaw: JsonValue | undefined): void {
  if (Array.isArray(productRaw)) {
    for (const allocation of productRaw) {
      if (!isRecord(allocation)) throw new Error('product allocation must be an object')
      const product = state.products.find((candidate) => candidate.id === allocation.id)
      if (product === undefined) throw new Error(`unknown product allocation ${String(allocation.id)}`)
      const budget = allocation.budgetMicros as number
      const spent = state.moneyBudget.usage.filter((entry) => entry.productId === product.id).reduce((sum, entry) => sum + entry.costMicros, 0)
      const reserved = state.moneyBudget.reservations.filter((entry) => entry.productId === product.id).reduce((sum, entry) => sum + entry.remainingMicros, 0)
      if (budget < spent + reserved) throw new Error(`product ${product.id} budget is below spent plus reserved micros`)
      product.budgetMicros = budget
      product.updatedAt = Date.now()
    }
  }
  if (Array.isArray(employeeRaw)) {
    for (const allocation of employeeRaw) {
      if (!isRecord(allocation)) throw new Error('employee allocation must be an object')
      const employee = state.employees.find((candidate) => candidate.id === allocation.id)
      if (employee === undefined || employee.status === 'retired') throw new Error(`employee allocation ${String(allocation.id)} must target an active employee`)
      const budget = allocation.budgetMicros as number
      const spent = state.moneyBudget.usage.filter((entry) => entry.employeeId === employee.id).reduce((sum, entry) => sum + entry.costMicros, 0)
      const reserved = state.moneyBudget.reservations.filter((entry) => entry.employeeId === employee.id).reduce((sum, entry) => sum + entry.remainingMicros, 0)
      if (budget < spent + reserved) throw new Error(`employee ${employee.id} budget is below spent plus reserved micros`)
      employee.budgetMicros = budget
    }
  }
}

function releaseGateError(state: CompanyState, productId: string): string | undefined {
  const work = state.workItems.filter((item) => item.productId === productId && item.status !== 'cancelled')
  const prerequisites = work.filter((item) => item.kind !== 'release' && item.kind !== 'operations')
  if (prerequisites.some((item) => item.status !== 'completed')) return 'product has unfinished pre-release work'
  const verifications = prerequisites.filter((item) => item.kind === 'verification' && item.status === 'completed')
  if (verifications.length === 0) return 'no completed verification work'
  const reviews = prerequisites.filter((item) => item.kind === 'review' && item.status === 'completed' && item.verdict === 'pass')
  if (reviews.length === 0) return 'no completed passing review work'
  for (const review of reviews) {
    const reviewed = review.reviewedWorkId === undefined ? undefined : state.workItems.find((item) => item.id === review.reviewedWorkId)
    if (reviewed !== undefined && reviewed.productId === productId && reviewed.status === 'completed'
      && reviewed.assigneeId !== undefined && review.assigneeId !== undefined && reviewed.assigneeId !== review.assigneeId) return undefined
  }
  return 'no independent passing review'
}

function defaultRisk(kind: ApprovalKind): 'low' | 'medium' | 'high' {
  switch (kind) {
    case 'bootstrap':
    case 'budget_change':
    case 'pricing_change':
    case 'governance_change':
    case 'temporary_authorization':
    case 'model_route':
    case 'release':
    case 'external_effect':
    case 'forced_archive':
      return 'high'
    case 'organization_change':
    case 'product_scope':
      return 'medium'
  }
}

function bound(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}
