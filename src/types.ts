/** Shared durable and wire contracts for dsh-company. */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export const COMPANY_STATE_SCHEMA_VERSION = 2 as const
export const COMPANY_SNAPSHOT_SCHEMA_VERSION = 5 as const

export const COMPANY_PHASES = ['staged', 'provisioning', 'provisioning_failed', 'operating', 'paused', 'halted', 'archived'] as const
export type CompanyPhase = (typeof COMPANY_PHASES)[number]

/** A saved finite ceiling remains binding until an explicit human-approved change. */
export type EmployeeLimit = number | 'unlimited'
export type ExecutionMode = 'adaptive' | 'fixed' | 'unlimited'

export interface CompanyConfig {
  stateRoot?: string
  subagentProvider?: string
  memberMaxDepth?: number
  maxEmployees?: EmployeeLimit
  executionMode?: ExecutionMode
  maxConcurrentEmployees?: number
  executionMemoryHighWatermark?: number
  executionLagHighWatermarkMs?: number
  executionMaxPendingWrites?: number
  executionRetryMs?: number
  maxProducts?: number
  maxWorkItems?: number
  maxOpenWorkItems?: number
  maxAttemptsPerWork?: number
  maxPendingApprovals?: number
  maxMailboxMessages?: number
  maxAuditBytes?: number
  maxMessageChars?: number
  maxOutputChars?: number
  defaultCurrency?: string
  /** Currency-first defaults, stored as integer micro-currency units. */
  maxMoneyBudgetMicros?: number
  modelPrices?: ModelPriceInput[]
  maxTemporaryAuthorizationMs?: number
  allowedRoutes?: Array<{ provider: string; model?: string }>
  fallback?: { provider: string; model: string }
  promptSectionOrder?: number
  uiPollMs?: number
  allowRemoteUi?: boolean
}

export interface ResolvedCompanyConfig {
  stateRoot: string
  stateRootDisplay: string
  subagentProvider: string
  memberMaxDepth: number
  maxEmployees: EmployeeLimit
  executionMode: ExecutionMode
  maxConcurrentEmployees: number
  executionMemoryHighWatermark: number
  executionLagHighWatermarkMs: number
  executionMaxPendingWrites: number
  executionRetryMs: number
  maxProducts: number
  maxWorkItems: number
  maxOpenWorkItems: number
  maxAttemptsPerWork: number
  maxPendingApprovals: number
  maxMailboxMessages: number
  maxAuditBytes: number
  maxMessageChars: number
  maxOutputChars: number
  defaultCurrency: string
  maxMoneyBudgetMicros: number
  modelPrices: ModelPrice3[]
  maxTemporaryAuthorizationMs: number
  allowedRoutes?: Array<{ provider: string; model?: string }>
  fallback?: { provider: string; model: string }
  promptSectionOrder: number
  uiPollMs: number
  allowRemoteUi: boolean
}

export interface LimitsSnapshot {
  maxEmployees: EmployeeLimit
  maxProducts: number
  maxWorkItems: number
  maxOpenWorkItems: number
  maxAttemptsPerWork: number
  maxPendingApprovals: number
  maxMailboxMessages: number
  maxAuditBytes: number
  maxMessageChars: number
  maxOutputChars: number
  memberMaxDepth: number
}

export type ModelPriceSource = 'manual' | 'catalog' | 'legacy'

/** Human/API price input. All three rates must be present together; omission means unpriced. */
export interface ModelPriceInput {
  provider: string
  model: string
  inputCacheMissMicrosPerMillion?: number
  inputCacheHitMicrosPerMillion?: number
  outputMicrosPerMillion?: number
}

/** Prospective three-rate price row. Missing all rates is an explicit unpriced row, never free. */
export interface ModelPrice3 extends ModelPriceInput {
  source: ModelPriceSource
  revision: number
  updatedAt: number
}

export interface MoneyRateSnapshot {
  provider: string
  model: string
  matchedProvider: string
  matchedModel: string
  currency: string
  pricingRevision: number
  pricingDigest: string
  inputCacheMissMicrosPerMillion: number
  inputCacheHitMicrosPerMillion: number
  outputMicrosPerMillion: number
}

export interface MoneyUsageEntry {
  id: string
  sessionId: string
  eventSeq: number
  turn: number
  step: number
  employeeId: string
  workId?: string
  productId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  inputCacheMissTokens: number
  inputCacheHitTokens: number
  totalTokens: number
  costMicros: number
  priced: boolean
  currency: string
  pricingRevision: number
  matchedPriceKey?: string
  rates?: MoneyRateSnapshot
  authorizationId?: string
  pricingProvenance?: 'legacy_recorded_event' | 'legacy_recorded_total'
  at: number
}

export interface MoneyReservation {
  id: string
  employeeId: string
  workId?: string
  productId?: string
  messageId?: string
  staffingRequestId?: string
  limitTokens: number
  remainingTokens: number
  reservedMicros: number
  remainingMicros: number
  /** Worst-case monetary headroom retained before each provider call, including prompt/context input. */
  callHeadroomMicros?: number
  /** Conservative composite used only for money-bound entitlement. */
  rates?: MoneyRateSnapshot
  /** Exact primary/fallback route membership, including authorized unpriced routes. */
  routes?: Array<{ provider: string; model: string }>
  /** Exact priced primary/fallback call-time price snapshots. */
  routeRates?: MoneyRateSnapshot[]
  authorizationId?: string
  /** True only for an authorized reservation that may use an unpriced route. */
  unknownCost?: boolean
  createdAt: number
}

export interface LegacyV02Finance {
  totalTokens: number
  usedTokens: number
  reservedTokens: number
  totalCostMicros: number
  /** Preserved source rows from the retired four-rate token ledger. */
  prices: Array<{
    provider: string
    model: string
    inputMicrosPerMillion: number
    cacheReadMicrosPerMillion: number
    cacheWriteMicrosPerMillion: number
    outputMicrosPerMillion: number
    reasoningMicrosPerMillion?: number
  }>
  treatment: 'unverified' | 'accepted'
}

export interface MoneyBudget {
  unit: 'micro-currency'
  currency: string
  totalMicros: number
  reservedMicros: number
  spentMicros: number
  warningAtMicros?: number
  pricingRevision: number
  prices: ModelPrice3[]
  usage: MoneyUsageEntry[]
  reservations: MoneyReservation[]
  migrationRequired?: boolean
  legacyV02?: LegacyV02Finance
}

export interface DiscoveredModelCapability {
  provider: string
  model: string
  name: string
  description?: string
  inputModalities?: string[]
  contextWindow?: number
  defaultMaxTokens?: number
  reasoningEfforts?: Array<{ id: string; name: string; description?: string }>
  defaultReasoningEffort?: string
  advertised: boolean
  /** False when a prior exact route is absent or fails resolution during reprobe. */
  available: boolean
}

export interface ModelCatalogState {
  stale: boolean
  generation: number
  probedAt?: number
  invalidatedAt?: number
  models: DiscoveredModelCapability[]
  errors: Array<{ provider: string; message: string }>
}

export type TemporaryAuthorizationStatus = 'scheduled' | 'active' | 'expired' | 'revoked'

export interface TemporaryAuthorizationUse {
  id: string
  at: number
  workId: string
  employeeId: string
  bypassed: Array<'company_budget' | 'product_budget' | 'employee_budget' | 'approval_dependency'>
  approvalIds?: string[]
  amountMicros?: number
  usageId?: string
  unknownCost?: boolean
}

export interface TemporaryAuthorization {
  id: string
  employeeId: string
  reason: string
  approvalId: string
  authorizedBy: 'founder'
  startsAt: number
  expiresAt: number
  createdAt: number
  revokedAt?: number
  revokedBy?: 'founder'
  revocationReason?: string
  uses: TemporaryAuthorizationUse[]
}

export type OperationalBlockKind = 'network' | 'quota' | 'rate_limit' | 'money_budget' | 'unpriced_model' | 'session_unrecoverable' | 'provider' | 'unknown'

export interface OperationalBlock {
  kind: OperationalBlockKind
  code: string
  message: string
  at: number
}

export interface CompanyHealth {
  status: 'healthy' | 'degraded' | 'manual_pause' | 'halted'
  reason?: OperationalBlockKind | 'manual' | 'financial_migration' | 'needs_budget_review'
  detail?: string
  detectedAt?: number
  resumable: boolean
}

export type OrgUnitKind = 'company' | 'division' | 'department' | 'team'

export interface OrgUnit {
  id: string
  name: string
  kind: OrgUnitKind
  parentId?: string
  description?: string
  managerEmployeeId?: string
  createdAt: number
}

export interface Position {
  id: string
  title: string
  orgUnitId: string
  reportsToPositionId?: string
  responsibilities: string[]
  createdAt: number
}

export interface FormationPlan {
  status: 'draft' | 'approved'
  charter: string
  firstProductId?: string
  draftedBy: 'ai' | 'user'
  lastEditedAt: number
  approvedAt?: number
}

export const STAFFING_ACTIONS = ['hire', 'adjust', 'retire'] as const
export type StaffingAction = (typeof STAFFING_ACTIONS)[number]
export const STAFFING_STATUSES = ['pending', 'in_review', 'recommended', 'approved', 'rejected', 'applied'] as const
export type StaffingStatus = (typeof STAFFING_STATUSES)[number]

export interface StaffingRecommendation {
  difficulty: 'low' | 'medium' | 'high' | 'critical'
  provider: string
  model: string
  reasoningEffort?: string
  budgetMicros?: number
  rationale: string
  orgPath: string[]
  positionTitle: string
  responsibilities: string[]
  /** Human-approved transfer of the singleton HR governance authority. */
  designateAsHr?: boolean
  assessedAt: number
}

export interface StaffingRequest {
  id: string
  action: StaffingAction
  status: StaffingStatus
  requestedBy: 'founder' | string
  candidateName?: string
  employeeId?: string
  workProfile: string
  constraints?: string
  hrEmployeeId: string
  attemptId?: string
  reviewDeliveryAttempts?: number
  recommendation?: StaffingRecommendation
  approvalId?: string
  lastDeliveredAt?: number
  reservationId?: string
  leaseAt?: number
  createdAt: number
  updatedAt: number
}

export const EMPLOYEE_STATUSES = ['planned', 'provisioning', 'idle', 'working', 'paused', 'failed', 'retired'] as const
export type EmployeeStatus = (typeof EMPLOYEE_STATUSES)[number]

export interface EmployeeLlmSelection {
  provider: string
  model: string
  reasoningEffort?: string
  fallback?: { provider: string; model: string }
  fallbackActive?: boolean
  activeProvider?: string
  activeModel?: string
}

export interface Employee {
  id: string
  name: string
  /** Staffed position/title for this employee. */
  role: string
  orgUnitId?: string
  positionId?: string
  isHr?: boolean
  /** Employee-wide monetary ceiling; migration fills zero for legacy rows. */
  budgetMicros?: number
  operationalBlock?: OperationalBlock
  status: EmployeeStatus
  sessionId?: string
  joinedAt?: number
  retiredAt?: number
  failure?: string
  llm: EmployeeLlmSelection
  executionPrompt?: string
}

export const PRODUCT_STATUSES = ['proposed', 'approved', 'active', 'paused', 'validating', 'released', 'retired', 'cancelled'] as const
export type ProductStatus = (typeof PRODUCT_STATUSES)[number]

export interface Product {
  id: string
  name: string
  summary: string
  status: ProductStatus
  productRoot: string
  successCriteria: string[]
  budgetMicros: number
  createdAt: number
  updatedAt: number
  releaseApprovalId?: string
}

export const WORK_KINDS = ['discovery', 'design', 'implementation', 'verification', 'review', 'repair', 'integration', 'release', 'operations'] as const
export type WorkKind = (typeof WORK_KINDS)[number]

export const WORK_STATUSES = ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'] as const
export type WorkStatus = (typeof WORK_STATUSES)[number]

export interface ReviewFinding {
  id: string
  severity: 'low' | 'medium' | 'high' | 'blocker'
  file?: string
  line?: number
  problem: string
  requiredFix: string
}

export interface WorkAttemptSummary {
  attempt: number
  assigneeId?: string | 'founder'
  status: 'failed' | 'cancelled'
  output?: string
  closedAt: number
}

export interface WorkEvidence {
  changedPaths?: string[]
  acceptanceResults?: string[]
  commandsRun?: string[]
}

export interface WorkItem {
  id: string
  productId: string
  kind: WorkKind
  subject: string
  objective: string
  status: WorkStatus
  assigneeId?: string | 'founder'
  eligibleEmployeeIds?: string[]
  /** Org units (incl. descendants) whose members may claim this work. */
  eligibleOrgUnitIds?: string[]
  dependencies: string[]
  approvalDependencies?: string[]
  inScope: string[]
  outOfScope: string[]
  acceptance: string[]
  verify: string[]
  deliverables: string[]
  reviewedWorkId?: string
  /** Backlink when this repair work item was opened from a filed ticket. */
  ticketId?: string
  attempt: number
  attemptId?: string
  handoffId?: string
  reassigning?: boolean
  reservationId?: string
  leaseAt?: number
  /** Number of accepted prompts for the current fenced attempt. */
  deliveryAttempts?: number
  output?: string
  verdict?: 'pass' | 'needs_revision' | 'reject'
  findings?: ReviewFinding[]
  evidence?: WorkEvidence
  attemptHistory: WorkAttemptSummary[]
  createdAt: number
  updatedAt: number
}

export const APPROVAL_KINDS = ['bootstrap', 'budget_change', 'pricing_change', 'governance_change', 'temporary_authorization', 'organization_change', 'product_scope', 'model_route', 'release', 'external_effect', 'forced_archive'] as const
export type ApprovalKind = (typeof APPROVAL_KINDS)[number]

export const APPROVAL_STATUSES = ['pending', 'approved', 'rejected', 'cancelled', 'expired'] as const
export type ApprovalStatus = (typeof APPROVAL_STATUSES)[number]

export interface ApprovalRequest {
  id: string
  kind: ApprovalKind
  status: ApprovalStatus
  requestedBy: 'founder' | string
  summary: string
  /** Human-readable description of what the approval decides. */
  detail?: string
  payload: JsonValue
  risk: 'low' | 'medium' | 'high'
  requestedAt: number
  requestedFromUserMessageId?: string
  expiresAt?: number
  resolvedAt?: number
  consumedAt?: number
  resolution?: {
    decision: 'approved' | 'rejected'
    source: 'ui' | 'tool'
    humanStatement?: string
    note?: string
  }
}

export const MESSAGE_DELIVERY_STATES = ['queued', 'reserved', 'accepted', 'held_budget', 'dead'] as const
export type MessageDeliveryState = (typeof MESSAGE_DELIVERY_STATES)[number]

export interface CompanyMessage {
  id: string
  from: 'founder' | string
  to: 'founder' | string
  content: string
  createdAt: number
  deliveryState: MessageDeliveryState
  /** Failed delivery attempts; after 3 the message goes dead and the founder is steered. */
  attempts?: number
  reservationId?: string
  leaseAt?: number
  acceptedAt?: number
}

export interface GovernanceNotification {
  id: string
  governanceRevision: number
  employeeIds: string[]
  deliveredEmployeeIds: string[]
  content: string
  createdAt: number
}

export interface ProvisioningGeneration {
  id: string
  startedAt: number
  approvalId: string
  employeeIds: string[]
  reservationIds: string[]
}

/** Human-filed product issue ticket; triage/dispatch/close are founder-or-support decisions. */
export type TicketSeverity = 'low' | 'medium' | 'high' | 'urgent'
export type TicketStatus = 'filed' | 'triaged' | 'dispatched' | 'resolved' | 'closed'

export interface Ticket {
  id: string
  productId: string
  title: string
  description: string
  reportedBy: 'web-console'
  reportedAt: number
  status: TicketStatus
  severity?: TicketSeverity
  workItemId?: string
  assigneeId?: string
  dispatchNote?: string
  resolvedAt?: number
  reply?: string
  closedAt?: number
}

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

export interface FileTicketInput {
  productId: string
  title: string
  description: string
}

export interface CompanyState {
  schemaVersion: typeof COMPANY_STATE_SCHEMA_VERSION
  revision: number
  id: string
  name: string
  slogan: string
  mission: string
  governanceRevision: number
  workspaceHash: string
  founderSessionId: string
  stagedFromUserMessageId: string
  phase: CompanyPhase
  createdAt: number
  updatedAt: number
  approvedAt?: number
  pausedAt?: number
  archivedAt?: number
  limits: LimitsSnapshot
  counters: {
    employee: number
    product: number
    work: number
    approval: number
    event: number
    orgUnit: number
    position: number
    staffing: number
    authorization: number
    ticket: number
  }
  moneyBudget: MoneyBudget
  modelCatalog: ModelCatalogState
  temporaryAuthorizations: TemporaryAuthorization[]
  formation: FormationPlan
  health: CompanyHealth
  orgUnits: OrgUnit[]
  positions: Position[]
  staffingRequests: StaffingRequest[]
  hrEmployeeId?: string
  employees: Employee[]
  products: Product[]
  workItems: WorkItem[]
  tickets: Ticket[]
  /** Designated support engineer allowed to triage/dispatch/close tickets. */
  supportEmployeeId?: string
  approvals: ApprovalRequest[]
  governanceNotifications: GovernanceNotification[]
  provisioning?: ProvisioningGeneration
}

export interface WorkspaceIdentity {
  schemaVersion: 1
  canonicalPath: string
  sha256: string
  key: string
}

export interface WorkspacePaths {
  workspace: WorkspaceIdentity
  root: string
  identityFile: string
  activeDir: string
  stateFile: string
  auditFile: string
  transactionFile: string
  mailboxDir: string
  archiveDir: string
  retiredSessionsFile: string
}

export interface CompanyAuditEvent {
  schemaVersion: 1
  id: number
  at: number
  type: string
  actor: 'founder' | 'scheduler' | 'human-ui' | string
  summary: string
  revision: number
}

export type CompanyActor =
  | { kind: 'founder'; id: 'founder'; sessionId: string }
  | { kind: 'employee'; id: string; sessionId: string }

export interface SafeEmployeeView {
  id: string
  name: string
  role: string
  department?: string
  status: EmployeeStatus
  activity: 'running' | 'idle' | 'ready' | 'retired'
  /** Visible to the founder (and to the employee itself) for transcript navigation. */
  session_id?: string
  joined_at?: number
  retired_at?: number
  provider?: string
  model?: string
  reasoning_effort?: string
  org_unit_id?: string
  position_id?: string
  is_hr?: boolean
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
  token_safety_limit?: number
  budget_micros?: number
  spent_micros?: number
  reserved_micros?: number
  available_micros?: number
  failure?: string
  operational_block?: OperationalBlock
}

export type DepartmentLoadBand = 'very_idle' | 'normal' | 'busy' | 'pressure'

/** One node of the Host-parsed charter outline projected on the wire. */
export interface SafeCharterClauseView {
  number?: string
  title: string
  body: string[]
  children: SafeCharterClauseView[]
}

export interface DepartmentLoadView {
  band: DepartmentLoadBand
  people: number
  open_work: number
  effective_sum: number
  average: number
  max_effective: number
}

export interface SafeOrgUnitView {
  id: string
  name: string
  kind: OrgUnitKind
  parent_id?: string
  description?: string
  manager_employee_id?: string
  child_ids: string[]
  position_ids: string[]
  load: DepartmentLoadView
  child_count?: number
  position_count?: number
  money_summary?: { budget_micros: number; spent_micros: number; available_micros: number }
}

export interface SafePositionView {
  id: string
  title: string
  org_unit_id: string
  reports_to_position_id?: string
  responsibilities: string[]
  employee_ids: string[]
  employee_count?: number
}

export interface SafeStaffingRequestView {
  id: string
  action: StaffingAction
  status: StaffingStatus
  candidate_name?: string
  employee_id?: string
  work_profile: string
  hr_employee_id: string
  recommendation?: StaffingRecommendation
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
  token_used: number
  budget_micros: number
  spent_micros?: number
  reserved_micros?: number
  available_micros?: number
  completed_work: number
  total_work: number
  created_at?: number
  updated_at?: number
  release_approval_id?: string
}

export interface SafeReviewFindingView {
  id: string
  severity: 'low' | 'medium' | 'high' | 'blocker'
  file?: string
  line?: number
  problem: string
  required_fix: string
}

export interface SafeWorkView {
  id: string
  product_id: string
  kind: WorkKind
  subject: string
  // Absent from the unauthenticated web-readonly projection.
  objective?: string
  status: WorkStatus
  blocked: boolean
  blocked_reasons: string[]
  assignee_id?: string | 'founder'
  ticket_id?: string
  dependencies: string[]
  approval_dependencies: string[]
  attempt: number
  output?: string
  verdict?: 'pass' | 'needs_revision' | 'reject'
  findings?: SafeReviewFindingView[]
  acceptance?: string[]
  verify?: string[]
  deliverables?: string[]
  changed_paths?: string[]
  acceptance_results?: string[]
  commands_run?: string[]
  created_at?: number
  updated_at?: number
}

export interface SafeApprovalView {
  id: string
  kind: ApprovalKind
  status: ApprovalStatus
  requested_by: 'founder' | string
  summary: string
  detail?: string
  payload_summary?: JsonValue
  risk: 'low' | 'medium' | 'high'
  requested_at: number
  expires_at?: number
  resolved_at?: number
  resolution?: {
    decision: 'approved' | 'rejected'
    source: 'ui' | 'tool'
    human_statement?: string
    note?: string
  }
}

export interface SafeMessageView {
  id: string
  from: 'founder' | string
  to: 'founder' | string
  content: string
  created_at: number
  attempts?: number
  delivery_state: MessageDeliveryState
}

export interface SafeTemporaryAuthorizationView {
  id: string
  employee_id: string
  reason: string
  approval_id: string
  authorized_by: 'founder'
  starts_at: number
  expires_at: number
  status: TemporaryAuthorizationStatus
  uses: Array<{
    id: string
    at: number
    work_id: string
    approval_ids: string[]
    bypassed: Array<'company_budget' | 'product_budget' | 'employee_budget' | 'approval_dependency'>
    amount_micros?: number
    usage_id?: string
    unknown_cost?: boolean
  }>
  created_at: number
  revoked_at?: number
  revocation_reason?: string
}

export interface ProviderModelMoneyAggregate {
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

export interface SnapshotQuery {
  employeeOffset?: number
  employeeLimit?: number
  employeeSearch?: string
  employeeStatus?: 'all' | 'active' | 'retired' | 'running'
  employeeExactStatus?: EmployeeStatus
  employeeId?: string
  employeeOrgUnitId?: string
  employeePositionId?: string
  orgOffset?: number
  orgId?: string
  orgLimit?: number
  positionOffset?: number
  positionId?: string
  positionLimit?: number
}

export interface SnapshotPage {
  total: number
  filtered_total: number
  offset: number
  limit: number
  returned: number
  next_offset: number | null
}

export interface SnapshotDirectory {
  employees: SnapshotPage & { query: SnapshotQuery }
  org_units: SnapshotPage
  positions: SnapshotPage
  summary: { employees: number; active_employees: number; retired_employees: number; running_employees: number; org_units: number; positions: number; employee_statuses: Record<string, number> }
}

/** Canonical Host/Web wire projection. */
export interface CompanySnapshot {
  schema_version: typeof COMPANY_SNAPSHOT_SCHEMA_VERSION
  revision: number
  viewer: {
    role: 'founder' | 'employee'
    participant_id: 'founder' | string
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
    updated_at: number
    founder_session_id?: string
    health: CompanyHealth
    max_employees?: number | 'unlimited'
  }
  directory?: SnapshotDirectory
  execution?: { mode: 'adaptive' | 'fixed' | 'unlimited'; running: number; limit: number | null; waiting: number; reason?: string; retry_at?: number }
  org_units: SafeOrgUnitView[]
  positions: SafePositionView[]
  staffing_requests: SafeStaffingRequestView[]
  employees: SafeEmployeeView[]
  products: SafeProductView[]
  work: SafeWorkView[]
  tickets: SafeTicketView[]
  budget: {
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
    prices: Array<{
      provider: string
      model: string
      priced: boolean
      source: ModelPriceSource
      revision: number
      updated_at: number
      input_cache_miss_micros_per_million?: number
      input_cache_hit_micros_per_million?: number
      output_micros_per_million?: number
    }>
    provider_model_aggregates: ProviderModelMoneyAggregate[]
    usage_detail: {
      total: number
      offset: number
      limit: number
      returned: number
      truncated: boolean
      items: Array<{
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
        pricing_digest: string
        matched_price_key?: string
        authorization_id?: string
        at: number
      }>
    }
  }
  model_catalog: SafeModelCatalogView
  temporary_authorizations: SafeTemporaryAuthorizationView[]
  approvals: SafeApprovalView[]
  inbox: SafeMessageView[]
  warnings: string[]
  poll_after_ms?: number
}

/** Structured Host-internal form produced after validating the flat browser action envelope. */
export type CompanyUiAction =
  | { type: 'approve_bootstrap'; confirmation: string }
  | { type: 'edit_formation'; input: EditFormationInput }
  | { type: 'resolve_approval'; approvalId: string; decision: 'approved' | 'rejected'; humanStatement?: string; note?: string }
  | { type: 'file_ticket'; input: FileTicketInput }
  | { type: 'reprobe_models' }
  | { type: 'request_governance_change'; input: GovernanceChangeInput }
  | { type: 'request_budget_change'; input: BudgetChangeInput }
  | { type: 'grant_temporary_authorization'; input: Omit<GrantTemporaryAuthorizationInput, 'approvalId'> }
  | { type: 'revoke_temporary_authorization'; input: Omit<RevokeTemporaryAuthorizationInput, 'approvalId'> }
  | { type: 'pause'; reason: string }
  | { type: 'resume'; reason: string }
  | { type: 'archive'; reason: string; approvalId?: string }
  | { type: 'discard_staged'; reason: string }

export type CompanyUiActionName = CompanyUiAction['type']

/** Canonical browser action envelope; payload is validated per action by the Host. */
export interface CompanyActionRequest {
  sessionId: string
  companyId: string
  expectedRevision: number
  action: CompanyUiActionName
  payload: JsonValue
}

export interface FormationProductInput {
  name: string
  summary: string
  productRoot: string
  successCriteria: string[]
  budgetMicros: number
}

export interface BootstrapInput {
  name: string
  slogan?: string
  mission: string
  charter: string
  firstProduct: FormationProductInput
  totalBudgetMicros: number
  hrBudgetMicros: number
  currency: string
  modelPrices?: ModelPriceInput[]
  draftedBy?: 'ai' | 'user'
  hrName?: string
  hrProvider?: string
  hrModel?: string
  hrReasoningEffort?: string
}

export interface EditFormationInput {
  name?: string
  slogan?: string
  mission?: string
  charter?: string
  firstProduct?: Partial<FormationProductInput>
  totalBudgetMicros?: number
  hrBudgetMicros?: number
  currency?: string
  modelPrices?: ModelPriceInput[]
  hrName?: string
  hrProvider?: string
  hrModel?: string
  hrReasoningEffort?: string
}

export interface GovernanceChangeInput {
  slogan?: string
  mission?: string
  charter?: string
  maxEmployees?: EmployeeLimit
  expectedGovernanceRevision?: number
}

export interface BudgetChangeInput {
  totalBudgetMicros?: number
  productBudgets?: Array<{ productId: string; budgetMicros: number }>
  employeeBudgets?: Array<{ employeeId: string; budgetMicros: number }>
  modelPrices?: ModelPriceInput[]
  expectedPricingRevision?: number
}

export interface GrantTemporaryAuthorizationInput {
  approvalId: string
  employeeId: string
  reason: string
  startsAt?: number
  expiresAt: number
}

export interface RevokeTemporaryAuthorizationInput {
  approvalId: string
  authorizationId: string
  reason: string
}

export interface StaffingRequestInput {
  action: StaffingAction
  candidateName?: string
  employeeId?: string
  workProfile: string
  constraints?: string
}

export interface StaffingAssessmentInput {
  requestId: string
  attemptId: string
  difficulty: StaffingRecommendation['difficulty']
  provider?: string
  model?: string
  reasoningEffort?: string
  budgetMicros?: number
  rationale: string
  orgPath?: string[]
  positionTitle?: string
  responsibilities?: string[]
  designateAsHr?: boolean
}

export interface AddEmployeeInput {
  name: string
  role: string
  executionPrompt?: string
  approvalId: string
  staffingRequestId: string
}

export interface CreateProductInput {
  name: string
  summary: string
  productRoot: string
  successCriteria: string[]
  budgetMicros: number
}

export interface CreateWorkInput {
  productId: string
  kind: WorkKind
  subject: string
  objective: string
  dependencies?: string[]
  approvalDependencies?: string[]
  assigneeId?: string | 'founder'
  eligibleEmployeeIds?: string[]
  /** Org units (incl. descendants) whose members may claim this work. */
  eligibleOrgUnitIds?: string[]
  inScope: string[]
  outOfScope?: string[]
  acceptance: string[]
  verify?: string[]
  deliverables?: string[]
  reviewedWorkId?: string
}

export interface UpdateWorkInput {
  workId: string
  attemptId: string
  status?: 'in_progress' | 'completed' | 'failed' | 'cancelled'
  output?: string
  verdict?: 'pass' | 'needs_revision' | 'reject'
  findings?: ReviewFinding[]
  changedPaths?: string[]
  acceptanceResults?: string[]
  commandsRun?: string[]
}
