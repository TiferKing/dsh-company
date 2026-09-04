/** Browser-safe wire contract for the dsh-company HTTP snapshot. */

import { DEPARTMENT_LOAD_BANDS, type DepartmentLoadBand } from './load.js'
export { DEPARTMENT_LOAD_BANDS, departmentLoadPresentation } from './load.js'
export type { DepartmentLoadBand, DepartmentLoadTone } from './load.js'

export const COMPANY_PHASES = [
  'staged',
  'provisioning',
  'provisioning_failed',
  'operating',
  'paused',
  'halted',
  'closing',
  'archived',
] as const

export type CompanyPhase = (typeof COMPANY_PHASES)[number]

export const EMPLOYEE_STATUSES = [
  'planned',
  'provisioning',
  'idle',
  'working',
  'paused',
  'failed',
  'retired',
] as const

export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export const PRODUCT_STATUSES = [
  'proposed',
  'approved',
  'active',
  'paused',
  'validating',
  'released',
  'retired',
  'cancelled',
] as const

export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

export const WORK_KINDS = [
  'discovery',
  'design',
  'implementation',
  'verification',
  'review',
  'repair',
  'integration',
  'release',
  'operations',
] as const

export type WorkKind = (typeof WORK_KINDS)[number]

export const WORK_STATUSES = [
  'pending',
  'claimed',
  'in_progress',
  'completed',
  'failed',
  'cancelled',
] as const

export type WorkStatus = (typeof WORK_STATUSES)[number]

export const APPROVAL_KINDS = [
  'bootstrap',
  'budget_change',
  'pricing_change',
  'governance_change',
  'temporary_authorization',
  'organization_change',
  'product_scope',
  'model_route',
  'release',
  'external_effect',
  'forced_archive',
] as const

export type ApprovalKind = (typeof APPROVAL_KINDS)[number]
export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'
export type RiskLevel = 'low' | 'medium' | 'high'

export interface SafeModelRoute {
  provider: string
  model: string
  reasoning_effort?: string
  fallback?: { provider: string; model: string }
  fallback_active?: boolean
  active_provider?: string
  active_model?: string
}

export interface SafeEmployeeActivity {
  state: 'idle' | 'running' | 'ready' | 'cold' | 'unavailable' | 'retired'
  work_id?: string
  subject?: string
  updated_at?: number
}

export interface SafeEmployeeView {
  id: string
  name: string
  role: string
  department?: string
  org_unit_id?: string
  position_id?: string
  is_hr?: boolean
  status: EmployeeStatus
  session_id?: string
  joined_at?: number
  retired_at?: number
  failure?: string
  llm?: SafeModelRoute
  activity?: SafeEmployeeActivity
  budget_micros?: number
  spent_micros?: number
  reserved_micros?: number
  available_micros?: number
  token_usage?: {
    input: number
    output: number
    cache_read: number
    cache_write: number
    reasoning: number
    total: number
    cost_micros: number
    currency: string
    priced_calls: number
    unpriced_calls: number
  }
  operational_block?: { kind: string; code: string; message: string; at: number }
}

export interface SafeDepartmentLoadView {
  band: DepartmentLoadBand
  people: number
  open_work: number
  effective_sum: number
  average: number
  max_effective: number
}

/** One node of the Host-parsed charter outline; the Web side renders it verbatim. */
export interface SafeCharterClauseView {
  number?: string
  title: string
  body: string[]
  children: SafeCharterClauseView[]
}

export interface SafeOrgUnitView {
  id: string
  name: string
  kind: 'company' | 'division' | 'department' | 'team'
  parent_id?: string
  description?: string
  manager_employee_id?: string
  child_ids: string[]
  position_ids: string[]
  load: SafeDepartmentLoadView
}

export interface SafePositionView {
  id: string
  title: string
  org_unit_id: string
  reports_to_position_id?: string
  responsibilities: string[]
  employee_ids: string[]
}

export type TicketStatus = 'filed' | 'triaged' | 'dispatched' | 'resolved' | 'closed'
export type TicketSeverity = 'low' | 'medium' | 'high' | 'urgent'

export interface SafeTicketView {
  id: string
  product_id: string
  title: string
  description: string
  reported_by: 'web-console'
  reported_at: number
  status: TicketStatus
  severity?: TicketSeverity
  work_item_id?: string
  assignee_id?: string
  resolved_at?: number
  reply?: string
  closed_at?: number
}

export interface SafeStaffingRequestView {
  id: string
  action: 'hire' | 'adjust' | 'retire'
  status: 'pending' | 'in_review' | 'recommended' | 'approved' | 'rejected' | 'applied'
  candidate_name?: string
  employee_id?: string
  work_profile: string
  hr_employee_id: string
  recommendation?: Record<string, unknown>
  approval_id?: string
  created_at: number
  updated_at: number
}

export interface SafeProductView {
  id: string
  name: string
  summary: string
  status: ProductStatus
  product_root: string
  success_criteria: string[]
  budget_credits: number
  token_budget: number
  token_used: number
  cost_micros: number
  budget_micros?: number
  spent_micros?: number
  reserved_micros?: number
  available_micros?: number
  completed_work?: number
  total_work?: number
  created_at?: number
  updated_at?: number
  release_approval_id?: string
}

export interface SafeReviewFinding {
  id: string
  severity: 'low' | 'medium' | 'high' | 'blocker'
  file?: string
  line?: number
  problem: string
  required_fix: string
}

export interface SafeWorkEvidence {
  changed_paths: string[]
  acceptance_results: string[]
  commands_run: string[]
  deliverables: string[]
}

export interface SafeWorkView {
  id: string
  product_id: string
  kind: WorkKind
  subject: string
  objective?: string
  status: WorkStatus
  assignee_id?: string
  ticket_id?: string
  dependencies: string[]
  approval_dependencies: string[]
  blocked: boolean
  blocked_reasons: string[]
  attempt?: number
  output_summary?: string
  verdict?: 'pass' | 'needs_revision' | 'reject'
  findings: SafeReviewFinding[]
  evidence?: SafeWorkEvidence
  created_at?: number
  updated_at?: number
}

export type ModelPriceSource = 'manual' | 'catalog' | 'legacy'

export interface SafeModelPriceView {
  provider: string
  model: string
  priced: boolean
  source: ModelPriceSource
  revision: number
  updated_at: number
  input_cache_miss_micros_per_million?: number
  input_cache_hit_micros_per_million?: number
  output_micros_per_million?: number
}

export interface SafeMoneyUsageView {
  id: string
  employee_id: string
  work_id?: string
  product_id?: string
  provider: string
  model: string
  input_tokens: number
  output_tokens: number
  cache_read_tokens: number
  cache_write_tokens: number
  reasoning_tokens: number
  input_cache_miss_tokens: number
  input_cache_hit_tokens: number
  total_tokens: number
  cost_micros: number
  priced: boolean
  pricing_revision: number
  matched_price_key?: string
  authorization_id?: string
  at: number
}

export interface SafeProviderModelAggregate {
  provider: string
  model: string
  calls: number
  input_cache_miss_tokens: number
  input_cache_hit_tokens: number
  output_tokens: number
  reasoning_tokens: number
  total_tokens: number
  cost_micros: number
  priced_calls: number
  unpriced_calls: number
}

export interface SafeMoneyUsageDetail {
  total: number
  offset: number
  limit: number
  returned: number
  truncated: boolean
  items: SafeMoneyUsageView[]
}

export interface SafeBudgetView {
  unit: 'micro-currency'
  currency: string
  total_micros: number
  reserved_micros: number
  spent_micros: number
  available_micros: number
  warning: boolean
  warning_at_micros?: number
  pricing_revision: number
  migration_required: boolean
  prices: SafeModelPriceView[]
  provider_model_aggregates: SafeProviderModelAggregate[]
  usage_detail: SafeMoneyUsageDetail
}

export interface SafeModelCatalogView {
  stale: boolean
  generation: number
  probed_at?: number
  invalidated_at?: number
  models: Array<{
    provider: string
    model: string
    name: string
    description?: string
    input_modalities?: string[]
    context_window?: number
    default_max_tokens?: number
    reasoning_efforts?: Array<{ id: string; name: string; description?: string }>
    default_reasoning_effort?: string
    advertised: boolean
    available: boolean
  }>
  errors: Array<{ provider: string; message: string }>
}

export type TemporaryAuthorizationStatus = 'scheduled' | 'active' | 'expired' | 'revoked'

export interface SafeTemporaryAuthorizationUseView {
  id: string
  at: number
  work_id: string
  approval_ids: string[]
  bypassed: Array<'company_budget' | 'product_budget' | 'employee_budget' | 'approval_dependency'>
  amount_micros?: number
  usage_id?: string
  unknown_cost?: boolean
}

export interface SafeTemporaryAuthorizationView {
  id: string
  employee_id: string
  reason: string
  authorized_by: 'founder'
  starts_at: number
  expires_at: number
  status: TemporaryAuthorizationStatus
  uses: SafeTemporaryAuthorizationUseView[]
  created_at: number
  revoked_at?: number
  revocation_reason?: string
}

export interface SafeApprovalResolution {
  decision: 'approved' | 'rejected'
  source: 'ui' | 'tool'
  human_statement?: string
  note?: string
}

export interface SafeApprovalView {
  detail?: string
  id: string
  kind: ApprovalKind
  status: ApprovalStatus
  requested_by: string
  summary: string
  payload_summary?: string
  risk: RiskLevel
  requested_at: number
  expires_at?: number
  resolved_at?: number
  resolution?: SafeApprovalResolution
}

export interface SafeMessageView {
  id: string
  from: string
  to?: string
  content: string
  created_at: number
  attempts?: number
  delivery_state: 'queued' | 'reserved' | 'accepted' | 'read' | 'held_budget' | 'dead'
  read_at?: number
}

export interface CompanySnapshot {
  schema_version: 4
  revision: number
  viewer: {
    role: 'founder' | 'employee'
    participant_id: string
    permissions: string[]
  }
  company: {
    id: string
    name: string
    slogan: string
    mission: string
    charter: string
    charter_outline: SafeCharterClauseView[]
    governance_revision: number
    formation_status: 'draft' | 'approved'
    phase: CompanyPhase
    health: { status: 'healthy' | 'degraded' | 'manual_pause' | 'halted'; reason?: string; detail?: string; detectedAt?: number; resumable: boolean }
    updated_at: number
    founder_session_id?: string
    plan_review_state?: 'awaiting_review' | 'awaiting_feedback'
  }
  org_units: SafeOrgUnitView[]
  positions: SafePositionView[]
  staffing_requests: SafeStaffingRequestView[]
  employees: SafeEmployeeView[]
  products: SafeProductView[]
  work: SafeWorkView[]
  tickets: SafeTicketView[]
  budget: SafeBudgetView
  model_catalog: SafeModelCatalogView
  temporary_authorizations: SafeTemporaryAuthorizationView[]
  approvals: SafeApprovalView[]
  inbox: SafeMessageView[]
  warnings: string[]
  poll_after_ms?: number
}

export type CompanyAction =
  | 'approve_bootstrap'
  | 'edit_formation'
  | 'file_ticket'
  | 'resolve_approval'
  | 'reprobe_models'
  | 'request_governance_change'
  | 'request_budget_change'
  | 'grant_temporary_authorization'
  | 'revoke_temporary_authorization'
  | 'pause'
  | 'resume'
  | 'archive'
  | 'discard_staged'

export interface CompanyActionRequest {
  sessionId: string
  companyId: string
  expectedRevision: number
  action: CompanyAction
  payload: unknown
}

export class SnapshotValidationError extends Error {
  override readonly name = 'SnapshotValidationError'
}

type JsonRecord = Record<string, unknown>

const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'] as const
const RISKS = ['low', 'medium', 'high'] as const
const ACTIVITY_STATES = ['idle', 'running', 'ready', 'cold', 'unavailable', 'retired'] as const
const ORG_UNIT_KINDS = ['company', 'division', 'department', 'team'] as const
const STAFFING_ACTIONS = ['hire', 'adjust', 'retire'] as const
const STAFFING_STATUSES = ['pending', 'in_review', 'recommended', 'approved', 'rejected', 'applied'] as const
const MESSAGE_STATES = ['queued', 'reserved', 'accepted', 'read', 'held_budget', 'dead'] as const
const VERDICTS = ['pass', 'needs_revision', 'reject'] as const
const FINDING_SEVERITIES = ['low', 'medium', 'high', 'blocker'] as const
const MODEL_PRICE_SOURCES = ['manual', 'catalog', 'legacy'] as const
const AUTHORIZATION_STATUSES = ['scheduled', 'active', 'expired', 'revoked'] as const
const AUTHORIZATION_BYPASSES = ['company_budget', 'product_budget', 'employee_budget', 'approval_dependency'] as const

function fail(path: string, expected: string): never {
  throw new SnapshotValidationError(`${path} must be ${expected}`)
}

function record(value: unknown, path: string): JsonRecord {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) fail(path, 'an object')
  return value as JsonRecord
}

function array(value: unknown, path: string, maximum = 2_000): unknown[] {
  if (!Array.isArray(value)) fail(path, 'an array')
  if (value.length > maximum) fail(path, `an array with at most ${maximum} entries`)
  return value
}

function string(value: unknown, path: string, maximum = 200_000): string {
  if (typeof value !== 'string') fail(path, 'a string')
  if (value.length > maximum) fail(path, `a string no longer than ${maximum} characters`)
  return value
}

function nonBlankString(value: unknown, path: string, maximum = 16_384): string {
  const result = string(value, path, maximum)
  if (result.trim().length === 0) fail(path, 'a non-blank string')
  return result
}

function integer(value: unknown, path: string): number {
  if (!Number.isSafeInteger(value) || (value as number) < 0) fail(path, 'a non-negative safe integer')
  return value as number
}

function nonNegativeNumber(value: unknown, path: string): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) fail(path, 'a finite non-negative number')
  return value
}

function boolean(value: unknown, path: string): boolean {
  if (typeof value !== 'boolean') fail(path, 'a boolean')
  return value
}

function enumValue<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] {
  if (typeof value !== 'string' || !values.includes(value)) {
    fail(path, `one of ${values.join(', ')}`)
  }
  return value as Values[number]
}

function optionalString(value: unknown, path: string, maximum = 16_384): string | undefined {
  return value === undefined ? undefined : string(value, path, maximum)
}

function optionalInteger(value: unknown, path: string): number | undefined {
  return value === undefined ? undefined : integer(value, path)
}

function optionalBoolean(value: unknown, path: string): boolean | undefined {
  return value === undefined ? undefined : boolean(value, path)
}

function strings(value: unknown, path: string, maximum = 2_000): string[] {
  return array(value, path, maximum).map((item, index) => string(item, `${path}[${index}]`, 16_384))
}

function optionalEnum<const Values extends readonly string[]>(
  value: unknown,
  values: Values,
  path: string,
): Values[number] | undefined {
  return value === undefined ? undefined : enumValue(value, values, path)
}

type CompactObject<T extends object> = {
  [Key in keyof T as undefined extends T[Key] ? never : Key]: T[Key]
} & {
  [Key in keyof T as undefined extends T[Key] ? Key : never]?: Exclude<T[Key], undefined>
}

function compactOptional<T extends object>(value: T): CompactObject<T> {
  return Object.fromEntries(
    Object.entries(value).filter(([, item]) => item !== undefined),
  ) as CompactObject<T>
}

function uniqueIds<T extends { id: string }>(items: T[], path: string): T[] {
  const seen = new Set<string>()
  for (const item of items) {
    if (seen.has(item.id)) fail(path, 'an array with unique ids')
    seen.add(item.id)
  }
  return items
}

function parseModelRoute(value: unknown, path: string): SafeModelRoute {
  const input = record(value, path)
  let fallback: SafeModelRoute['fallback']
  if (input.fallback !== undefined) {
    const rawFallback = record(input.fallback, `${path}.fallback`)
    fallback = {
      provider: nonBlankString(rawFallback.provider, `${path}.fallback.provider`, 256),
      model: nonBlankString(rawFallback.model, `${path}.fallback.model`, 512),
    }
  }
  return compactOptional({
    provider: nonBlankString(input.provider, `${path}.provider`, 256),
    model: nonBlankString(input.model, `${path}.model`, 512),
    reasoning_effort: optionalString(input.reasoning_effort, `${path}.reasoning_effort`, 128),
    fallback,
    fallback_active: optionalBoolean(input.fallback_active, `${path}.fallback_active`),
    active_provider: optionalString(input.active_provider, `${path}.active_provider`, 256),
    active_model: optionalString(input.active_model, `${path}.active_model`, 512),
  })
}

function parseActivity(value: unknown, path: string): SafeEmployeeActivity {
  const input = record(value, path)
  return compactOptional({
    state: enumValue(input.state, ACTIVITY_STATES, `${path}.state`),
    work_id: optionalString(input.work_id, `${path}.work_id`, 128),
    subject: optionalString(input.subject, `${path}.subject`, 16_384),
    updated_at: optionalInteger(input.updated_at, `${path}.updated_at`),
  })
}

function parseEmployeeTokenUsage(value: unknown, path: string): NonNullable<SafeEmployeeView['token_usage']> {
  const input = record(value, path)
  return {
    input: integer(input.input, `${path}.input`), output: integer(input.output, `${path}.output`),
    cache_read: integer(input.cache_read, `${path}.cache_read`), cache_write: integer(input.cache_write, `${path}.cache_write`),
    reasoning: integer(input.reasoning, `${path}.reasoning`), total: integer(input.total, `${path}.total`),
    cost_micros: integer(input.cost_micros, `${path}.cost_micros`), currency: nonBlankString(input.currency, `${path}.currency`, 16),
    priced_calls: integer(input.priced_calls, `${path}.priced_calls`),
    unpriced_calls: integer(input.unpriced_calls, `${path}.unpriced_calls`),
  }
}

function parseOperationalBlock(value: unknown, path: string): NonNullable<SafeEmployeeView['operational_block']> {
  const input = record(value, path)
  return {
    kind: nonBlankString(input.kind, `${path}.kind`, 128), code: nonBlankString(input.code, `${path}.code`, 128),
    message: nonBlankString(input.message, `${path}.message`, 4_096), at: integer(input.at, `${path}.at`),
  }
}

function parseEmployee(value: unknown, path: string): SafeEmployeeView {
  const input = record(value, path)
  const flatRoute = input.provider === undefined && input.model === undefined
    ? undefined
    : parseModelRoute({
      provider: input.provider,
      model: input.model,
      reasoning_effort: input.reasoning_effort,
    }, `${path}.llm`)
  const activity = typeof input.activity === 'string'
    ? { state: enumValue(input.activity, ACTIVITY_STATES, `${path}.activity`) }
    : input.activity === undefined
      ? undefined
      : parseActivity(input.activity, `${path}.activity`)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    name: nonBlankString(input.name, `${path}.name`, 512),
    role: nonBlankString(input.role, `${path}.role`, 1_024),
    department: optionalString(input.department, `${path}.department`, 512),
    org_unit_id: optionalString(input.org_unit_id, `${path}.org_unit_id`, 128),
    position_id: optionalString(input.position_id, `${path}.position_id`, 128),
    is_hr: optionalBoolean(input.is_hr, `${path}.is_hr`),
    status: enumValue(input.status, EMPLOYEE_STATUSES, `${path}.status`),
    session_id: optionalString(input.session_id, `${path}.session_id`, 256),
    joined_at: optionalInteger(input.joined_at, `${path}.joined_at`),
    retired_at: optionalInteger(input.retired_at, `${path}.retired_at`),
    failure: optionalString(input.failure, `${path}.failure`, 16_384),
    llm: input.llm === undefined ? flatRoute : parseModelRoute(input.llm, `${path}.llm`),
    activity,
    budget_micros: optionalInteger(input.budget_micros, `${path}.budget_micros`),
    spent_micros: optionalInteger(input.spent_micros, `${path}.spent_micros`),
    reserved_micros: optionalInteger(input.reserved_micros, `${path}.reserved_micros`),
    available_micros: optionalInteger(input.available_micros, `${path}.available_micros`),
    token_usage: input.token_usage === undefined ? undefined : parseEmployeeTokenUsage(input.token_usage, `${path}.token_usage`),
    operational_block: input.operational_block === undefined ? undefined : parseOperationalBlock(input.operational_block, `${path}.operational_block`),
  })
}

function parseDepartmentLoad(value: unknown, path: string): SafeDepartmentLoadView {
  const input = record(value, path)
  const people = integer(input.people, `${path}.people`)
  const openWork = integer(input.open_work, `${path}.open_work`)
  const effectiveSum = integer(input.effective_sum, `${path}.effective_sum`)
  const average = nonNegativeNumber(input.average, `${path}.average`)
  const maxEffective = integer(input.max_effective, `${path}.max_effective`)
  if (people === 0 && (openWork !== 0 || effectiveSum !== 0 || average !== 0 || maxEffective !== 0)) {
    fail(path, 'zeroed load evidence when people is zero')
  }
  if (people > 0 && (average !== effectiveSum / people || openWork > effectiveSum || maxEffective > effectiveSum || maxEffective < average)) {
    fail(path, 'internally consistent Host load evidence')
  }
  const expectedBand: DepartmentLoadBand = people === 0 || effectiveSum === 0
    ? 'very_idle'
    : maxEffective >= 4 || effectiveSum > 3 * people
      ? 'pressure'
      : maxEffective >= 2 || effectiveSum > people
        ? 'busy'
        : 'normal'
  const band = enumValue(input.band, DEPARTMENT_LOAD_BANDS, `${path}.band`)
  if (band !== expectedBand) fail(`${path}.band`, `Host-derived ${expectedBand} for the supplied evidence`)
  return {
    band,
    people,
    open_work: openWork,
    effective_sum: effectiveSum,
    average,
    max_effective: maxEffective,
  }
}

function parseOrgUnit(value: unknown, path: string): SafeOrgUnitView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128), name: nonBlankString(input.name, `${path}.name`, 512),
    kind: enumValue(input.kind, ORG_UNIT_KINDS, `${path}.kind`), parent_id: optionalString(input.parent_id, `${path}.parent_id`, 128),
    description: optionalString(input.description, `${path}.description`, 16_384),
    manager_employee_id: optionalString(input.manager_employee_id, `${path}.manager_employee_id`, 128),
    child_ids: strings(input.child_ids ?? [], `${path}.child_ids`, 128),
    position_ids: strings(input.position_ids ?? [], `${path}.position_ids`, 256),
    load: parseDepartmentLoad(input.load, `${path}.load`),
  })
}

function parsePosition(value: unknown, path: string): SafePositionView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128), title: nonBlankString(input.title, `${path}.title`, 512),
    org_unit_id: nonBlankString(input.org_unit_id, `${path}.org_unit_id`, 128),
    reports_to_position_id: optionalString(input.reports_to_position_id, `${path}.reports_to_position_id`, 128),
    responsibilities: strings(input.responsibilities ?? [], `${path}.responsibilities`, 256),
    employee_ids: strings(input.employee_ids ?? [], `${path}.employee_ids`, 64),
  })
}

function parseStaffingRequest(value: unknown, path: string): SafeStaffingRequestView {
  const input = record(value, path)
  const recommendation = input.recommendation === undefined ? undefined : record(input.recommendation, `${path}.recommendation`)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128), action: enumValue(input.action, STAFFING_ACTIONS, `${path}.action`),
    status: enumValue(input.status, STAFFING_STATUSES, `${path}.status`),
    candidate_name: optionalString(input.candidate_name, `${path}.candidate_name`, 512),
    employee_id: optionalString(input.employee_id, `${path}.employee_id`, 128),
    work_profile: nonBlankString(input.work_profile, `${path}.work_profile`, 16_384),
    hr_employee_id: nonBlankString(input.hr_employee_id, `${path}.hr_employee_id`, 128),
    recommendation: recommendation === undefined ? undefined : structuredClone(recommendation),
    approval_id: optionalString(input.approval_id, `${path}.approval_id`, 128),
    created_at: integer(input.created_at, `${path}.created_at`), updated_at: integer(input.updated_at, `${path}.updated_at`),
  })
}

function parseProduct(value: unknown, path: string): SafeProductView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    name: nonBlankString(input.name, `${path}.name`, 512),
    summary: string(input.summary, `${path}.summary`, 65_536),
    status: enumValue(input.status, PRODUCT_STATUSES, `${path}.status`),
    product_root: string(input.product_root, `${path}.product_root`, 4_096),
    success_criteria: strings(input.success_criteria, `${path}.success_criteria`, 256),
    budget_credits: integer(input.budget_credits, `${path}.budget_credits`),
    token_budget: integer(input.token_budget, `${path}.token_budget`),
    token_used: integer(input.token_used, `${path}.token_used`),
    cost_micros: integer(input.cost_micros, `${path}.cost_micros`),
    budget_micros: optionalInteger(input.budget_micros, `${path}.budget_micros`),
    spent_micros: optionalInteger(input.spent_micros, `${path}.spent_micros`),
    reserved_micros: optionalInteger(input.reserved_micros, `${path}.reserved_micros`),
    available_micros: optionalInteger(input.available_micros, `${path}.available_micros`),
    completed_work: optionalInteger(input.completed_work, `${path}.completed_work`),
    total_work: optionalInteger(input.total_work, `${path}.total_work`),
    created_at: optionalInteger(input.created_at, `${path}.created_at`),
    updated_at: optionalInteger(input.updated_at, `${path}.updated_at`),
    release_approval_id: optionalString(input.release_approval_id, `${path}.release_approval_id`, 128),
  })
}

function parseFinding(value: unknown, path: string): SafeReviewFinding {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    severity: enumValue(input.severity, FINDING_SEVERITIES, `${path}.severity`),
    file: optionalString(input.file, `${path}.file`, 4_096),
    line: optionalInteger(input.line, `${path}.line`),
    problem: nonBlankString(input.problem, `${path}.problem`, 16_384),
    required_fix: nonBlankString(input.required_fix ?? input.requiredFix, `${path}.required_fix`, 16_384),
  })
}

function parseEvidence(value: unknown, path: string): SafeWorkEvidence {
  const input = record(value, path)
  return {
    changed_paths: strings(input.changed_paths ?? [], `${path}.changed_paths`, 1_000),
    acceptance_results: strings(input.acceptance_results ?? [], `${path}.acceptance_results`, 1_000),
    commands_run: strings(input.commands_run ?? [], `${path}.commands_run`, 1_000),
    deliverables: strings(input.deliverables ?? [], `${path}.deliverables`, 1_000),
  }
}

function parseWork(value: unknown, path: string): SafeWorkView {
  const input = record(value, path)
  const blockedReasons = strings(input.blocked_reasons ?? [], `${path}.blocked_reasons`, 1_000)
  const hasFlatEvidence = input.acceptance !== undefined || input.verify !== undefined || input.deliverables !== undefined
  const evidence = input.evidence === undefined
    ? hasFlatEvidence
      ? {
          changed_paths: [],
          acceptance_results: strings(input.acceptance ?? [], `${path}.acceptance`, 1_000),
          commands_run: strings(input.verify ?? [], `${path}.verify`, 1_000),
          deliverables: strings(input.deliverables ?? [], `${path}.deliverables`, 1_000),
        }
      : undefined
    : parseEvidence(input.evidence, `${path}.evidence`)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    product_id: nonBlankString(input.product_id, `${path}.product_id`, 128),
    kind: enumValue(input.kind, WORK_KINDS, `${path}.kind`),
    subject: nonBlankString(input.subject, `${path}.subject`, 16_384),
    objective: optionalString(input.objective, `${path}.objective`, 65_536),
    status: enumValue(input.status, WORK_STATUSES, `${path}.status`),
    assignee_id: optionalString(input.assignee_id, `${path}.assignee_id`, 128),
    ticket_id: optionalString(input.ticket_id, `${path}.ticket_id`, 128),
    dependencies: strings(input.dependencies ?? [], `${path}.dependencies`, 1_000),
    approval_dependencies: strings(input.approval_dependencies ?? [], `${path}.approval_dependencies`, 1_000),
    blocked: input.blocked === undefined ? blockedReasons.length > 0 : boolean(input.blocked, `${path}.blocked`),
    blocked_reasons: blockedReasons,
    attempt: optionalInteger(input.attempt, `${path}.attempt`),
    output_summary: optionalString(input.output_summary ?? input.output, `${path}.output_summary`, 65_536),
    verdict: optionalEnum(input.verdict, VERDICTS, `${path}.verdict`),
    findings: array(input.findings ?? [], `${path}.findings`, 1_000).map((item, index) =>
      parseFinding(item, `${path}.findings[${index}]`),
    ),
    evidence,
    created_at: optionalInteger(input.created_at, `${path}.created_at`),
    updated_at: optionalInteger(input.updated_at, `${path}.updated_at`),
  })
}

function parseModelPrice(value: unknown, path: string): SafeModelPriceView {
  const input = record(value, path)
  const miss = optionalInteger(input.input_cache_miss_micros_per_million, `${path}.input_cache_miss_micros_per_million`)
  const hit = optionalInteger(input.input_cache_hit_micros_per_million, `${path}.input_cache_hit_micros_per_million`)
  const output = optionalInteger(input.output_micros_per_million, `${path}.output_micros_per_million`)
  const present = [miss, hit, output].filter((item) => item !== undefined).length
  const priced = boolean(input.priced, `${path}.priced`)
  if (present !== 0 && present !== 3) fail(path, 'a complete three-rate price or an unpriced row')
  if (priced !== (present === 3)) fail(`${path}.priced`, 'true exactly when all three rates are present')
  return compactOptional({
    provider: nonBlankString(input.provider, `${path}.provider`, 256),
    model: nonBlankString(input.model, `${path}.model`, 512),
    priced,
    source: enumValue(input.source, MODEL_PRICE_SOURCES, `${path}.source`),
    revision: integer(input.revision, `${path}.revision`),
    updated_at: integer(input.updated_at, `${path}.updated_at`),
    input_cache_miss_micros_per_million: miss,
    input_cache_hit_micros_per_million: hit,
    output_micros_per_million: output,
  })
}

function parseMoneyUsage(value: unknown, path: string): SafeMoneyUsageView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 1_024),
    employee_id: nonBlankString(input.employee_id, `${path}.employee_id`, 128),
    work_id: optionalString(input.work_id, `${path}.work_id`, 128),
    product_id: optionalString(input.product_id, `${path}.product_id`, 128),
    provider: nonBlankString(input.provider, `${path}.provider`, 256),
    model: nonBlankString(input.model, `${path}.model`, 512),
    input_tokens: integer(input.input_tokens, `${path}.input_tokens`),
    output_tokens: integer(input.output_tokens, `${path}.output_tokens`),
    cache_read_tokens: integer(input.cache_read_tokens, `${path}.cache_read_tokens`),
    cache_write_tokens: integer(input.cache_write_tokens, `${path}.cache_write_tokens`),
    reasoning_tokens: integer(input.reasoning_tokens, `${path}.reasoning_tokens`),
    input_cache_miss_tokens: integer(input.input_cache_miss_tokens, `${path}.input_cache_miss_tokens`),
    input_cache_hit_tokens: integer(input.input_cache_hit_tokens, `${path}.input_cache_hit_tokens`),
    total_tokens: integer(input.total_tokens, `${path}.total_tokens`),
    cost_micros: integer(input.cost_micros, `${path}.cost_micros`),
    priced: boolean(input.priced, `${path}.priced`),
    pricing_revision: integer(input.pricing_revision, `${path}.pricing_revision`),
    matched_price_key: optionalString(input.matched_price_key, `${path}.matched_price_key`, 1_024),
    authorization_id: optionalString(input.authorization_id, `${path}.authorization_id`, 128),
    at: integer(input.at, `${path}.at`),
  })
}

function parseProviderModelAggregate(value: unknown, path: string): SafeProviderModelAggregate {
  const input = record(value, path)
  return {
    provider: nonBlankString(input.provider, `${path}.provider`, 256),
    model: nonBlankString(input.model, `${path}.model`, 512),
    calls: integer(input.calls, `${path}.calls`),
    input_cache_miss_tokens: integer(input.input_cache_miss_tokens, `${path}.input_cache_miss_tokens`),
    input_cache_hit_tokens: integer(input.input_cache_hit_tokens, `${path}.input_cache_hit_tokens`),
    output_tokens: integer(input.output_tokens, `${path}.output_tokens`),
    reasoning_tokens: integer(input.reasoning_tokens, `${path}.reasoning_tokens`),
    total_tokens: integer(input.total_tokens, `${path}.total_tokens`),
    cost_micros: integer(input.cost_micros, `${path}.cost_micros`),
    priced_calls: integer(input.priced_calls, `${path}.priced_calls`),
    unpriced_calls: integer(input.unpriced_calls, `${path}.unpriced_calls`),
  }
}

function parseUsageDetail(value: unknown, path: string): SafeMoneyUsageDetail {
  const input = record(value, path)
  const items = uniqueIds(
    array(input.items ?? [], `${path}.items`, 2_000).map((item, index) => parseMoneyUsage(item, `${path}.items[${index}]`)),
    `${path}.items`,
  )
  const total = integer(input.total, `${path}.total`)
  const offset = integer(input.offset, `${path}.offset`)
  const limit = integer(input.limit, `${path}.limit`)
  const returned = integer(input.returned, `${path}.returned`)
  if (returned !== items.length) fail(`${path}.returned`, 'equal to items.length')
  if (offset + returned > total) fail(path, 'a window within total')
  return {
    total,
    offset,
    limit,
    returned,
    truncated: boolean(input.truncated, `${path}.truncated`),
    items,
  }
}

function parseBudget(value: unknown, path: string): SafeBudgetView {
  const input = record(value, path)
  const total = integer(input.total_micros, `${path}.total_micros`)
  const reserved = integer(input.reserved_micros, `${path}.reserved_micros`)
  const spent = integer(input.spent_micros, `${path}.spent_micros`)
  const available = integer(input.available_micros, `${path}.available_micros`)
  if (available !== Math.max(0, total - reserved - spent)) fail(`${path}.available_micros`, 'equal to max(0, total - reserved - spent)')
  return compactOptional({
    unit: enumValue(input.unit, ['micro-currency'] as const, `${path}.unit`),
    currency: nonBlankString(input.currency, `${path}.currency`, 16),
    total_micros: total,
    reserved_micros: reserved,
    spent_micros: spent,
    available_micros: available,
    warning: boolean(input.warning, `${path}.warning`),
    warning_at_micros: optionalInteger(input.warning_at_micros, `${path}.warning_at_micros`),
    pricing_revision: integer(input.pricing_revision, `${path}.pricing_revision`),
    migration_required: boolean(input.migration_required, `${path}.migration_required`),
    prices: array(input.prices ?? [], `${path}.prices`, 1_000).map((item, index) => parseModelPrice(item, `${path}.prices[${index}]`)),
    provider_model_aggregates: array(input.provider_model_aggregates ?? [], `${path}.provider_model_aggregates`, 1_000).map((item, index) => parseProviderModelAggregate(item, `${path}.provider_model_aggregates[${index}]`)),
    usage_detail: parseUsageDetail(input.usage_detail, `${path}.usage_detail`),
  })
}

function parseModelCatalog(value: unknown, path: string): SafeModelCatalogView {
  const input = record(value, path)
  const models = array(input.models ?? [], `${path}.models`, 4_000).map((value, index) => {
    const model = record(value, `${path}.models[${index}]`)
    const reasoningEfforts = model.reasoning_efforts === undefined ? undefined : array(model.reasoning_efforts, `${path}.models[${index}].reasoning_efforts`, 128).map((value, effortIndex) => {
      const effort = record(value, `${path}.models[${index}].reasoning_efforts[${effortIndex}]`)
      return compactOptional({
        id: nonBlankString(effort.id, `${path}.models[${index}].reasoning_efforts[${effortIndex}].id`, 128),
        name: nonBlankString(effort.name, `${path}.models[${index}].reasoning_efforts[${effortIndex}].name`, 256),
        description: optionalString(effort.description, `${path}.models[${index}].reasoning_efforts[${effortIndex}].description`, 4_096),
      })
    })
    return compactOptional({
      provider: nonBlankString(model.provider, `${path}.models[${index}].provider`, 256),
      model: nonBlankString(model.model, `${path}.models[${index}].model`, 512),
      name: nonBlankString(model.name, `${path}.models[${index}].name`, 512),
      description: optionalString(model.description, `${path}.models[${index}].description`, 8_192),
      input_modalities: model.input_modalities === undefined ? undefined : strings(model.input_modalities, `${path}.models[${index}].input_modalities`, 64),
      context_window: optionalInteger(model.context_window, `${path}.models[${index}].context_window`),
      default_max_tokens: optionalInteger(model.default_max_tokens, `${path}.models[${index}].default_max_tokens`),
      reasoning_efforts: reasoningEfforts,
      default_reasoning_effort: optionalString(model.default_reasoning_effort, `${path}.models[${index}].default_reasoning_effort`, 128),
      advertised: boolean(model.advertised, `${path}.models[${index}].advertised`),
      available: boolean(model.available, `${path}.models[${index}].available`),
    })
  })
  const errors = array(input.errors ?? [], `${path}.errors`, 256).map((value, index) => {
    const error = record(value, `${path}.errors[${index}]`)
    return {
      provider: nonBlankString(error.provider, `${path}.errors[${index}].provider`, 256),
      message: nonBlankString(error.message, `${path}.errors[${index}].message`, 4_096),
    }
  })
  return compactOptional({
    stale: boolean(input.stale, `${path}.stale`),
    generation: integer(input.generation, `${path}.generation`),
    probed_at: optionalInteger(input.probed_at, `${path}.probed_at`),
    invalidated_at: optionalInteger(input.invalidated_at, `${path}.invalidated_at`),
    models,
    errors,
  })
}

function parseTemporaryAuthorization(value: unknown, path: string): SafeTemporaryAuthorizationView {
  const input = record(value, path)
  const startsAt = integer(input.starts_at, `${path}.starts_at`)
  const expiresAt = integer(input.expires_at, `${path}.expires_at`)
  if (expiresAt <= startsAt) fail(`${path}.expires_at`, 'later than starts_at')
  const uses = uniqueIds(array(input.uses ?? [], `${path}.uses`, 2_000).map((value, index) => {
    const use = record(value, `${path}.uses[${index}]`)
    return compactOptional({
      id: nonBlankString(use.id, `${path}.uses[${index}].id`, 128),
      at: integer(use.at, `${path}.uses[${index}].at`),
      work_id: nonBlankString(use.work_id, `${path}.uses[${index}].work_id`, 128),
      approval_ids: strings(use.approval_ids ?? [], `${path}.uses[${index}].approval_ids`, 128),
      bypassed: array(use.bypassed ?? [], `${path}.uses[${index}].bypassed`, 4).map((item, bypassIndex) => enumValue(item, AUTHORIZATION_BYPASSES, `${path}.uses[${index}].bypassed[${bypassIndex}]`)),
      amount_micros: optionalInteger(use.amount_micros, `${path}.uses[${index}].amount_micros`),
      usage_id: optionalString(use.usage_id, `${path}.uses[${index}].usage_id`, 1_024),
      unknown_cost: use.unknown_cost === undefined ? undefined : boolean(use.unknown_cost, `${path}.uses[${index}].unknown_cost`),
    })
  }), `${path}.uses`)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    employee_id: nonBlankString(input.employee_id, `${path}.employee_id`, 128),
    reason: nonBlankString(input.reason, `${path}.reason`, 4_096),
    authorized_by: enumValue(input.authorized_by, ['founder'] as const, `${path}.authorized_by`),
    starts_at: startsAt,
    expires_at: expiresAt,
    status: enumValue(input.status, AUTHORIZATION_STATUSES, `${path}.status`),
    uses,
    created_at: integer(input.created_at, `${path}.created_at`),
    revoked_at: optionalInteger(input.revoked_at, `${path}.revoked_at`),
    revocation_reason: optionalString(input.revocation_reason, `${path}.revocation_reason`, 4_096),
  })
}

const SENSITIVE_KEY = /(?:api.?key|authorization|credential|password|secret|token|capability|attempt.?id|session.?id)/i

/**
 * Convert an already-safe approval summary into bounded display text. Unknown
 * structured input is redacted again so a Host regression cannot casually put
 * credential-shaped fields on screen.
 */
export function summarizePayload(value: unknown, maximum = 1_000): string | undefined {
  if (value === undefined) return undefined
  if (typeof value === 'string') return value.slice(0, maximum)

  const sanitize = (item: unknown, depth: number): unknown => {
    if (depth > 4) return '…'
    if (item === null || typeof item === 'boolean' || typeof item === 'number') return item
    if (typeof item === 'string') return item.slice(0, 512)
    if (Array.isArray(item)) return item.slice(0, 24).map((entry) => sanitize(entry, depth + 1))
    if (typeof item !== 'object') return String(item)
    const result: JsonRecord = {}
    for (const [key, entry] of Object.entries(item as JsonRecord).slice(0, 40)) {
      result[key] = SENSITIVE_KEY.test(key) ? '[redacted]' : sanitize(entry, depth + 1)
    }
    return result
  }

  try {
    return JSON.stringify(sanitize(value, 0)).slice(0, maximum)
  } catch {
    return undefined
  }
}

function parseResolution(value: unknown, path: string): SafeApprovalResolution {
  const input = record(value, path)
  return compactOptional({
    decision: enumValue(input.decision, ['approved', 'rejected'] as const, `${path}.decision`),
    source: enumValue(input.source, ['ui', 'tool'] as const, `${path}.source`),
    human_statement: optionalString(input.human_statement, `${path}.human_statement`, 16_384),
    note: optionalString(input.note, `${path}.note`, 16_384),
  })
}

function parseApproval(value: unknown, path: string): SafeApprovalView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    kind: enumValue(input.kind, APPROVAL_KINDS, `${path}.kind`),
    status: enumValue(input.status, APPROVAL_STATUSES, `${path}.status`),
    requested_by: nonBlankString(input.requested_by, `${path}.requested_by`, 128),
    summary: nonBlankString(input.summary, `${path}.summary`, 65_536),
    detail: optionalString(input.detail, `${path}.detail`, 4_096),
    payload_summary: summarizePayload(input.payload_summary),
    risk: enumValue(input.risk, RISKS, `${path}.risk`),
    requested_at: integer(input.requested_at, `${path}.requested_at`),
    expires_at: optionalInteger(input.expires_at, `${path}.expires_at`),
    resolved_at: optionalInteger(input.resolved_at, `${path}.resolved_at`),
    resolution: input.resolution === undefined ? undefined : parseResolution(input.resolution, `${path}.resolution`),
  })
}

function parseMessage(value: unknown, path: string): SafeMessageView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 256),
    from: nonBlankString(input.from, `${path}.from`, 128),
    to: optionalString(input.to, `${path}.to`, 128),
    content: string(input.content, `${path}.content`, 65_536),
    created_at: integer(input.created_at, `${path}.created_at`),
    delivery_state: enumValue(input.delivery_state, MESSAGE_STATES, `${path}.delivery_state`),
    read_at: optionalInteger(input.read_at, `${path}.read_at`),
  })
}

function unwrapSnapshot(value: unknown): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const input = value as JsonRecord
  if (input.schema_version !== undefined) return input
  if (input.snapshot !== undefined) return input.snapshot
  if (input.state !== undefined) return input.state
  if (input.value !== undefined) {
    const nested = input.value
    if (nested !== null && typeof nested === 'object' && !Array.isArray(nested)) {
      const nestedRecord = nested as JsonRecord
      return nestedRecord.snapshot ?? nestedRecord.state ?? nested
    }
  }
  return value
}

const TICKET_STATUSES = ['filed', 'triaged', 'dispatched', 'resolved', 'closed'] as const
const TICKET_SEVERITIES = ['low', 'medium', 'high', 'urgent'] as const

function parseTicket(value: unknown, path: string): SafeTicketView {
  const input = record(value, path)
  return compactOptional({
    id: nonBlankString(input.id, `${path}.id`, 128),
    product_id: nonBlankString(input.product_id, `${path}.product_id`, 128),
    title: string(input.title, `${path}.title`, 200),
    description: string(input.description, `${path}.description`, 16_384),
    reported_by: enumValue(input.reported_by, ['web-console'] as const, `${path}.reported_by`),
    reported_at: integer(input.reported_at, `${path}.reported_at`),
    status: enumValue(input.status, TICKET_STATUSES, `${path}.status`),
    severity: input.severity === undefined ? undefined : enumValue(input.severity, TICKET_SEVERITIES, `${path}.severity`),
    work_item_id: optionalString(input.work_item_id, `${path}.work_item_id`, 128),
    assignee_id: optionalString(input.assignee_id, `${path}.assignee_id`, 128),
    resolved_at: optionalInteger(input.resolved_at, `${path}.resolved_at`),
    reply: optionalString(input.reply, `${path}.reply`, 16_384),
    closed_at: optionalInteger(input.closed_at, `${path}.closed_at`),
  })
}

function parseHealth(value: unknown, path: string): CompanySnapshot['company']['health'] {
  const input = record(value, path)
  return compactOptional({
    status: enumValue(input.status, ['healthy', 'degraded', 'manual_pause', 'halted'] as const, `${path}.status`),
    reason: optionalString(input.reason, `${path}.reason`, 128), detail: optionalString(input.detail, `${path}.detail`, 4_096),
    detectedAt: optionalInteger(input.detectedAt, `${path}.detectedAt`), resumable: boolean(input.resumable, `${path}.resumable`),
  })
}

const MAX_CHARTER_CLAUSE_DEPTH = 8

function parseCharterClause(value: unknown, path: string, depth: number): SafeCharterClauseView {
  if (depth > MAX_CHARTER_CLAUSE_DEPTH) fail(path, `at most ${MAX_CHARTER_CLAUSE_DEPTH} nested clause levels`)
  const input = record(value, path)
  return compactOptional({
    number: optionalString(input.number, `${path}.number`, 64),
    title: string(input.title, `${path}.title`, 2_000),
    body: strings(input.body ?? [], `${path}.body`, 512),
    children: array(input.children ?? [], `${path}.children`, 256).map((child, index) =>
      parseCharterClause(child, `${path}.children[${index}]`, depth + 1),
    ),
  })
}

function parseCharterOutline(value: unknown, path: string): SafeCharterClauseView[] {
  return array(value, path, 512).map((clause, index) => parseCharterClause(clause, `${path}[${index}]`, 1))
}

/** Validate and copy a Host snapshot, dropping every unknown field. */
export function parseCompanySnapshot(value: unknown): CompanySnapshot {
  const input = record(unwrapSnapshot(value), 'snapshot')
  if (input.schema_version !== 4) fail('snapshot.schema_version', '4')

  const viewer = record(input.viewer, 'snapshot.viewer')
  const company = record(input.company, 'snapshot.company')
  const budget = parseBudget(input.budget, 'snapshot.budget')
  const employees = uniqueIds(
    array(input.employees, 'snapshot.employees', 32).map((item, index) =>
      parseEmployee(item, `snapshot.employees[${index}]`),
    ),
    'snapshot.employees',
  )
  const orgUnits = uniqueIds(
    array(input.org_units ?? [], 'snapshot.org_units', 256).map((item, index) => parseOrgUnit(item, `snapshot.org_units[${index}]`)),
    'snapshot.org_units',
  )
  const positions = uniqueIds(
    array(input.positions ?? [], 'snapshot.positions', 1_000).map((item, index) => parsePosition(item, `snapshot.positions[${index}]`)),
    'snapshot.positions',
  )
  const staffingRequests = uniqueIds(
    array(input.staffing_requests ?? [], 'snapshot.staffing_requests', 1_000).map((item, index) => parseStaffingRequest(item, `snapshot.staffing_requests[${index}]`)),
    'snapshot.staffing_requests',
  )
  const products = uniqueIds(
    array(input.products, 'snapshot.products', 64).map((item, index) =>
      parseProduct(item, `snapshot.products[${index}]`),
    ),
    'snapshot.products',
  )
  const work = uniqueIds(
    array(input.work, 'snapshot.work', 1_000).map((item, index) =>
      parseWork(item, `snapshot.work[${index}]`),
    ),
    'snapshot.work',
  )
  const tickets = uniqueIds(
    array(input.tickets ?? [], 'snapshot.tickets', 512).map((item, index) => parseTicket(item, `snapshot.tickets[${index}]`)),
    'snapshot.tickets',
  )
  const modelCatalog = parseModelCatalog(input.model_catalog, 'snapshot.model_catalog')
  const temporaryAuthorizations = uniqueIds(
    array(input.temporary_authorizations ?? [], 'snapshot.temporary_authorizations', 2_000).map((item, index) =>
      parseTemporaryAuthorization(item, `snapshot.temporary_authorizations[${index}]`),
    ),
    'snapshot.temporary_authorizations',
  )
  const approvals = uniqueIds(
    array(input.approvals, 'snapshot.approvals', 2_000).map((item, index) =>
      parseApproval(item, `snapshot.approvals[${index}]`),
    ),
    'snapshot.approvals',
  )
  const inbox = uniqueIds(
    array(input.inbox, 'snapshot.inbox', 2_000).map((item, index) =>
      parseMessage(item, `snapshot.inbox[${index}]`),
    ),
    'snapshot.inbox',
  )

  const employeeIds = new Set(employees.map((employee) => employee.id))
  const productIds = new Set(products.map((product) => product.id))
  const workIds = new Set(work.map((item) => item.id))
  const orgUnitIds = new Set(orgUnits.map((unit) => unit.id))
  const positionIds = new Set(positions.map((position) => position.id))
  for (const unit of orgUnits) {
    if (unit.parent_id !== undefined && !orgUnitIds.has(unit.parent_id)) fail(`snapshot.org_units.${unit.id}.parent_id`, 'a known org unit id')
    if (unit.child_ids.some((id) => !orgUnitIds.has(id))) fail(`snapshot.org_units.${unit.id}.child_ids`, 'known org unit ids')
    if (unit.position_ids.some((id) => !positionIds.has(id))) fail(`snapshot.org_units.${unit.id}.position_ids`, 'known position ids')
  }
  for (const position of positions) {
    if (!orgUnitIds.has(position.org_unit_id)) fail(`snapshot.positions.${position.id}.org_unit_id`, 'a known org unit id')
    if (position.employee_ids.some((id) => !employeeIds.has(id))) fail(`snapshot.positions.${position.id}.employee_ids`, 'known employee ids')
  }
  for (const item of work) {
    if (!productIds.has(item.product_id)) fail(`snapshot.work.${item.id}.product_id`, 'a known product id')
    if (item.dependencies.some((id) => !workIds.has(id))) {
      fail(`snapshot.work.${item.id}.dependencies`, 'known work ids')
    }
  }
  for (const authorization of temporaryAuthorizations) {
    if (!employeeIds.has(authorization.employee_id)) fail(`snapshot.temporary_authorizations.${authorization.id}.employee_id`, 'a known employee id')
    if (authorization.uses.some((use) => !workIds.has(use.work_id))) fail(`snapshot.temporary_authorizations.${authorization.id}.uses`, 'known work ids')
  }

  return compactOptional({
    schema_version: 4 as const,
    revision: integer(input.revision, 'snapshot.revision'),
    viewer: {
      role: enumValue(viewer.role, ['founder', 'employee'] as const, 'snapshot.viewer.role'),
      participant_id: nonBlankString(viewer.participant_id, 'snapshot.viewer.participant_id', 128),
      permissions: strings(viewer.permissions, 'snapshot.viewer.permissions', 256),
    },
    company: compactOptional({
      id: nonBlankString(company.id, 'snapshot.company.id', 256),
      name: nonBlankString(company.name, 'snapshot.company.name', 512),
      slogan: nonBlankString(company.slogan, 'snapshot.company.slogan', 1_024),
      mission: string(company.mission, 'snapshot.company.mission', 65_536),
      charter: string(company.charter, 'snapshot.company.charter', 65_536),
      charter_outline: parseCharterOutline(company.charter_outline, 'snapshot.company.charter_outline'),
      governance_revision: integer(company.governance_revision, 'snapshot.company.governance_revision'),
      formation_status: enumValue(company.formation_status, ['draft', 'approved'] as const, 'snapshot.company.formation_status'),
      phase: enumValue(company.phase, COMPANY_PHASES, 'snapshot.company.phase'),
      health: parseHealth(company.health, 'snapshot.company.health'),
      updated_at: integer(company.updated_at, 'snapshot.company.updated_at'),
      founder_session_id: optionalString(company.founder_session_id, 'snapshot.company.founder_session_id', 256),
      plan_review_state: optionalEnum(
        company.plan_review_state,
        ['awaiting_review', 'awaiting_feedback'] as const,
        'snapshot.company.plan_review_state',
      ),
    }),
    org_units: orgUnits,
    positions,
    staffing_requests: staffingRequests,
    employees,
    products,
    work,
    tickets,
    budget,
    model_catalog: modelCatalog,
    temporary_authorizations: temporaryAuthorizations,
    approvals,
    inbox,
    warnings: strings(input.warnings, 'snapshot.warnings', 1_000),
    poll_after_ms: optionalInteger(input.poll_after_ms, 'snapshot.poll_after_ms'),
  })
}

export function isCompanyLive(snapshot: CompanySnapshot): boolean {
  if (['provisioning', 'operating', 'closing'].includes(snapshot.company.phase)) return true
  if (snapshot.employees.some((employee) => employee.status === 'working')) return true
  return snapshot.work.some((item) => item.status === 'claimed' || item.status === 'in_progress')
}
