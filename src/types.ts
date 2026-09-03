/** Shared durable and wire contracts for dsh-company. */

export type JsonPrimitive = string | number | boolean | null
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue }

export type CompanyPhase =
  | 'staged'
  | 'provisioning'
  | 'provisioning_failed'
  | 'operating'
  | 'paused'
  | 'halted'
  | 'closing'
  | 'archived'

export interface CompanyConfig {
  stateRoot?: string
  subagentProvider?: string
  memberMaxDepth?: number
  maxEmployees?: number
  maxProducts?: number
  maxWorkItems?: number
  maxOpenWorkItems?: number
  maxAttemptsPerWork?: number
  maxPendingApprovals?: number
  maxMailboxMessages?: number
  maxAuditBytes?: number
  maxMessageChars?: number
  maxOutputChars?: number
  defaultBudgetCredits?: number
  maxBudgetCredits?: number
  /** @deprecated v0.1 activation-credit compatibility only. */
  defaultActivationCredits?: number
  /** @deprecated v0.1 activation-credit compatibility only. */
  routeCosts?: Record<string, number>
  defaultTokenBudget?: number
  maxTokenBudget?: number
  defaultCurrency?: string
  tokenPrices?: TokenPriceInput[]
  /** v0.3 currency-first defaults, stored as integer micro-currency units. */
  defaultMoneyBudgetMicros?: number
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
  maxEmployees: number
  maxProducts: number
  maxWorkItems: number
  maxOpenWorkItems: number
  maxAttemptsPerWork: number
  maxPendingApprovals: number
  maxMailboxMessages: number
  maxAuditBytes: number
  maxMessageChars: number
  maxOutputChars: number
  defaultBudgetCredits: number
  maxBudgetCredits: number
  defaultActivationCredits: number
  routeCosts: Record<string, number>
  defaultTokenBudget: number
  maxTokenBudget: number
  defaultCurrency: string
  tokenPrices: TokenPrice[]
  defaultMoneyBudgetMicros: number
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
  maxEmployees: number
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

export type BudgetEntryKind = 'reserve' | 'commit' | 'release' | 'increase' | 'decrease'
export type BudgetReason =
  | 'employee-onboarding'
  | 'work-dispatch'
  | 'message-delivery'
  | 'human-adjustment'
  | 'recovery'

export interface BudgetEntry {
  id: string
  kind: BudgetEntryKind
  credits: number
  reason: BudgetReason
  employeeId?: string
  workId?: string
  messageId?: string
  approvalId?: string
  reservationId?: string
  at: number
}

export interface CompanyBudget {
  unit: 'activation-credit'
  totalCredits: number
  reservedCredits: number
  spentCredits: number
  warningAtCredits?: number
  entries: BudgetEntry[]
}

/** Human-facing prices per one million tokens. Values are normalized to integer micro-currency units. */
export interface TokenPriceInput {
  provider: string
  model: string
  inputPerMillion?: number
  cacheReadPerMillion?: number
  cacheWritePerMillion?: number
  outputPerMillion?: number
  reasoningPerMillion?: number
}

export interface TokenPrice {
  provider: string
  model: string
  inputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheWriteMicrosPerMillion: number
  outputMicrosPerMillion: number
  reasoningMicrosPerMillion?: number
}

export interface TokenUsageEntry {
  id: string
  sessionId: string
  eventSeq: number
  turn: number
  step: number
  employeeId: string
  workId?: string
  provider: string
  model: string
  inputTokens: number
  outputTokens: number
  cacheReadTokens: number
  cacheWriteTokens: number
  reasoningTokens: number
  totalTokens: number
  costMicros: number
  priced: boolean
  at: number
}

export interface TokenReservation {
  id: string
  employeeId: string
  workId?: string
  messageId?: string
  limitTokens: number
  remainingTokens: number
  createdAt: number
}

export interface TokenBudget {
  unit: 'token'
  currency: string
  totalTokens: number
  reservedTokens: number
  usedTokens: number
  warningAtTokens?: number
  totalCostMicros: number
  prices: TokenPrice[]
  usage: TokenUsageEntry[]
  reservations: TokenReservation[]
  legacyActivationCredits?: number
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
  prices: TokenPrice[]
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
  approvalId?: string
  authorizedBy: 'founder'
  startsAt: number
  expiresAt: number
  createdAt: number
  revokedAt?: number
  revokedBy?: 'founder'
  revocationReason?: string
  uses: TemporaryAuthorizationUse[]
}

export type OperationalBlockKind = 'network' | 'quota' | 'rate_limit' | 'money_budget' | 'unpriced_model' | 'token_budget' | 'turn_limit' | 'provider' | 'unknown'

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

export type StaffingAction = 'hire' | 'adjust' | 'retire'
export type StaffingStatus = 'pending' | 'in_review' | 'recommended' | 'approved' | 'rejected' | 'applied'

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
  recommendation?: StaffingRecommendation
  approvalId?: string
  createdAt: number
  updatedAt: number
}

export type EmployeeStatus =
  | 'planned'
  | 'provisioning'
  | 'idle'
  | 'working'
  | 'paused'
  | 'failed'
  | 'retired'

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
  /** The staffed position/title for this employee in v0.1. */
  role: string
  /** Legacy flat organizational label retained for v0.1 migration. */
  department?: string
  orgUnitId?: string
  positionId?: string
  isHr?: boolean
  /** Per-turn safety ceiling retained independently of monetary authority. */
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

export type ProductStatus =
  | 'proposed'
  | 'approved'
  | 'active'
  | 'paused'
  | 'validating'
  | 'released'
  | 'retired'
  | 'cancelled'

export interface Product {
  id: string
  name: string
  summary: string
  status: ProductStatus
  productRoot: string
  successCriteria: string[]
  /** @deprecated legacy activation-credit allocation. */
  budgetCredits: number
  /** @deprecated v0.2 token allocation retained for migration telemetry. */
  tokenBudget: number
  budgetMicros?: number
  createdAt: number
  updatedAt: number
  releaseApprovalId?: string
}

export type WorkKind =
  | 'discovery'
  | 'design'
  | 'implementation'
  | 'verification'
  | 'review'
  | 'repair'
  | 'integration'
  | 'release'
  | 'operations'

export type WorkStatus =
  | 'pending'
  | 'claimed'
  | 'in_progress'
  | 'completed'
  | 'failed'
  | 'cancelled'

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
  output?: string
  verdict?: 'pass' | 'needs_revision' | 'reject'
  findings?: ReviewFinding[]
  evidence?: WorkEvidence
  attemptHistory: WorkAttemptSummary[]
  createdAt: number
  updatedAt: number
}

export type ApprovalKind =
  | 'bootstrap'
  | 'budget_change'
  | 'pricing_change'
  | 'governance_change'
  | 'temporary_authorization'
  | 'organization_change'
  | 'product_scope'
  | 'model_route'
  | 'release'
  | 'external_effect'
  | 'forced_archive'

export type ApprovalStatus = 'pending' | 'approved' | 'rejected' | 'cancelled' | 'expired'

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

export type MessageDeliveryState = 'queued' | 'reserved' | 'accepted' | 'read' | 'held_budget'

export interface CompanyMessage {
  id: string
  from: 'founder' | string
  to: 'founder' | string
  content: string
  createdAt: number
  deliveryState: MessageDeliveryState
  reservationId?: string
  leaseAt?: number
  acceptedAt?: number
  readAt?: number
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
  schemaVersion: 1
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
  planReviewState?: 'awaiting_review' | 'awaiting_feedback'
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
  /** Legacy v0.1 ledger retained only for migration/audit compatibility. */
  budget: CompanyBudget
  tokenBudget: TokenBudget
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
}

export interface SafePositionView {
  id: string
  title: string
  org_unit_id: string
  reports_to_position_id?: string
  responsibilities: string[]
  employee_ids: string[]
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
  budget_credits: number
  token_budget: number
  token_used: number
  cost_micros: number
  budget_micros?: number
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
  delivery_state: MessageDeliveryState
  read_at?: number
}

export interface SafeTemporaryAuthorizationView {
  id: string
  employee_id: string
  reason: string
  approval_id?: string
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

/** Canonical Host/Web wire projection. */
export interface CompanySnapshot {
  schema_version: 4
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
    plan_review_state?: 'awaiting_review' | 'awaiting_feedback'
    updated_at: number
    founder_session_id?: string
    health: CompanyHealth
  }
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
  | { type: 'grant_temporary_authorization'; input: GrantTemporaryAuthorizationInput }
  | { type: 'revoke_temporary_authorization'; input: RevokeTemporaryAuthorizationInput }
  | { type: 'pause'; reason: string }
  | { type: 'resume'; reason: string }
  | { type: 'archive'; reason: string; approvalId?: string }
  | { type: 'discard_staged'; reason: string }

export type CompanyUiActionName = CompanyUiAction['type']

/** Canonical v0.1 browser action envelope; payload is validated per action by the Host. */
export interface CompanyActionRequest {
  sessionId: string
  companyId: string
  expectedRevision: number
  action: CompanyUiActionName
  payload: JsonValue
}

export interface CompanyActionResponse {
  ok: true
  revision: number
  snapshot?: CompanySnapshot
}

export interface FormationProductInput {
  name: string
  summary: string
  productRoot: string
  successCriteria: string[]
  budgetMicros?: number
  /** @deprecated v0.2 compatibility input. */
  tokenBudget?: number
}

export interface BootstrapInput {
  name: string
  slogan?: string
  mission: string
  charter: string
  firstProduct: FormationProductInput
  totalBudgetMicros?: number
  /** @deprecated v0.2 compatibility input. */
  totalTokenBudget?: number
  currency: string
  modelPrices?: ModelPriceInput[]
  /** @deprecated v0.2 compatibility input. */
  prices?: TokenPriceInput[]
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
  /** @deprecated v0.2 compatibility input. */
  totalTokenBudget?: number
  currency?: string
  modelPrices?: ModelPriceInput[]
  /** @deprecated v0.2 compatibility input. */
  prices?: TokenPriceInput[]
}

export interface GovernanceChangeInput {
  slogan?: string
  mission?: string
  charter?: string
  expectedGovernanceRevision?: number
}

export interface BudgetChangeInput {
  totalBudgetMicros?: number
  productBudgets?: Array<{ productId: string; budgetMicros: number }>
  modelPrices?: ModelPriceInput[]
  expectedPricingRevision?: number
}

export interface GrantTemporaryAuthorizationInput {
  approvalId?: string
  employeeId: string
  reason: string
  startsAt?: number
  expiresAt: number
}

export interface RevokeTemporaryAuthorizationInput {
  approvalId?: string
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
  provider: string
  model: string
  reasoningEffort?: string
  budgetMicros?: number
  rationale: string
  orgPath: string[]
  positionTitle: string
  responsibilities: string[]
}

export interface AddEmployeeInput {
  name: string
  role: string
  department?: string
  provider?: string
  model?: string
  reasoningEffort?: string
  fallbackProvider?: string
  fallbackModel?: string
  executionPrompt?: string
  budgetMicros?: number
  approvalId?: string
  staffingRequestId?: string
}

export interface CreateProductInput {
  name: string
  summary: string
  productRoot: string
  successCriteria: string[]
  budgetMicros?: number
  /** @deprecated v0.2 compatibility input. */
  tokenBudget?: number
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
