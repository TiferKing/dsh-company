import { resolveStateRoot } from './paths.js'
import { COMPANY_PHASES, COMPANY_STATE_SCHEMA_VERSION } from './types.js'
import type {
  ApprovalKind,
  CompanyConfig,
  CompanyMessage,
  CompanyState,
  EmployeeLimit,
  JsonValue,
  ModelPrice3,
  ModelPriceInput,
  MoneyRateSnapshot,
  ResolvedCompanyConfig,
  WorkItem,
} from './types.js'

const COMPANY_ID = /^c_[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i
const EMPLOYEE_ID = /^e[1-9][0-9]*$/
const PRODUCT_ID = /^p[1-9][0-9]*$/
const WORK_ID = /^w[1-9][0-9]*$/
const TICKET_ID = /^t[1-9][0-9]*$/
const APPROVAL_ID = /^a[1-9][0-9]*$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i

const HARD_MAX = {
  maxProducts: 64,
  maxWorkItems: 1000,
  maxAttemptsPerWork: 20,
} as const

export function resolveConfig(config: CompanyConfig = {}): ResolvedCompanyConfig {
  const root = resolveStateRoot(config.stateRoot)
  const resolved: ResolvedCompanyConfig = {
    stateRoot: root.path,
    stateRootDisplay: root.display,
    subagentProvider: nonEmpty(config.subagentProvider ?? 'spawn', 'subagentProvider', 128),
    // DSH maxDepth is an absolute ceiling. Normalize the legacy v0.1.x value 0
    // to 1 so existing profiles can still provision a direct employee.
    memberMaxDepth: Math.max(1, boundedInteger(config.memberMaxDepth ?? 1, 'memberMaxDepth', 0, 32)),
    maxEmployees: normalizeEmployeeLimit(config.maxEmployees ?? 'unlimited'),
    executionMode: config.executionMode ?? 'adaptive',
    maxConcurrentEmployees: boundedInteger(config.maxConcurrentEmployees ?? 8, 'maxConcurrentEmployees', 1, Number.MAX_SAFE_INTEGER),
    executionMemoryHighWatermark: boundedNumber(config.executionMemoryHighWatermark ?? 0.8, 'executionMemoryHighWatermark', 0.1, 0.95),
    executionLagHighWatermarkMs: boundedInteger(config.executionLagHighWatermarkMs ?? 200, 'executionLagHighWatermarkMs', 1, 60_000),
    executionMaxPendingWrites: boundedInteger(config.executionMaxPendingWrites ?? 32, 'executionMaxPendingWrites', 1, Number.MAX_SAFE_INTEGER),
    executionRetryMs: boundedInteger(config.executionRetryMs ?? 1000, 'executionRetryMs', 100, 60_000),
    maxProducts: boundedInteger(config.maxProducts ?? 8, 'maxProducts', 1, HARD_MAX.maxProducts),
    maxWorkItems: boundedInteger(config.maxWorkItems ?? 128, 'maxWorkItems', 1, HARD_MAX.maxWorkItems),
    maxOpenWorkItems: boundedInteger(config.maxOpenWorkItems ?? 32, 'maxOpenWorkItems', 1, HARD_MAX.maxWorkItems),
    maxAttemptsPerWork: boundedInteger(config.maxAttemptsPerWork ?? 5, 'maxAttemptsPerWork', 1, HARD_MAX.maxAttemptsPerWork),
    maxPendingApprovals: boundedInteger(config.maxPendingApprovals ?? 32, 'maxPendingApprovals', 1, 256),
    maxMailboxMessages: boundedInteger(config.maxMailboxMessages ?? 1000, 'maxMailboxMessages', 1, 10_000),
    maxAuditBytes: boundedInteger(config.maxAuditBytes ?? 10_485_760, 'maxAuditBytes', 1024, 104_857_600),
    maxMessageChars: boundedInteger(config.maxMessageChars ?? 16_384, 'maxMessageChars', 64, 131_072),
    maxOutputChars: boundedInteger(config.maxOutputChars ?? 65_536, 'maxOutputChars', 256, 1_048_576),
    defaultCurrency: normalizeCurrency(config.defaultCurrency ?? 'USD'),
    maxMoneyBudgetMicros: boundedInteger(config.maxMoneyBudgetMicros ?? 1_000_000_000_000_000, 'maxMoneyBudgetMicros', 1, Number.MAX_SAFE_INTEGER),
    modelPrices: normalizeModelPrices(config.modelPrices ?? [], 'manual', 1, 0),
    maxTemporaryAuthorizationMs: boundedInteger(config.maxTemporaryAuthorizationMs ?? 86_400_000, 'maxTemporaryAuthorizationMs', 1, 31_536_000_000),
    promptSectionOrder: boundedInteger(config.promptSectionOrder ?? 118, 'promptSectionOrder', 0, 10_000),
    uiPollMs: boundedInteger(config.uiPollMs ?? 1000, 'uiPollMs', 500, 60_000),
    allowRemoteUi: config.allowRemoteUi ?? false,
  }
  enumValue(resolved.executionMode, 'executionMode', ['adaptive', 'fixed', 'unlimited'])
  if (resolved.maxOpenWorkItems > resolved.maxWorkItems) {
    throw new Error('maxOpenWorkItems must not exceed maxWorkItems')
  }
  if (config.allowedRoutes !== undefined) {
    if (!Array.isArray(config.allowedRoutes) || config.allowedRoutes.length === 0) {
      throw new Error('allowedRoutes must be a non-empty array when configured')
    }
    resolved.allowedRoutes = config.allowedRoutes.map((route, index) => {
      if (!isRecord(route)) throw new Error(`allowedRoutes[${index}] must be an object`)
      return {
        provider: nonEmpty(route.provider, `allowedRoutes[${index}].provider`, 128),
        ...(route.model === undefined ? {} : { model: nonEmpty(route.model, `allowedRoutes[${index}].model`, 256) }),
      }
    })
  }
  if (config.fallback !== undefined) {
    resolved.fallback = {
      provider: nonEmpty(config.fallback.provider, 'fallback.provider', 128),
      model: nonEmpty(config.fallback.model, 'fallback.model', 256),
    }
  }
  return resolved
}

export function normalizeCurrency(value: string): string {
  const currency = nonEmpty(value, 'currency', 12).toUpperCase()
  if (!/^[A-Z][A-Z0-9_-]{0,11}$/.test(currency)) throw new Error('currency must be a short alphanumeric code')
  return currency
}

export function normalizeEmployeeLimit(value: unknown, label = 'maxEmployees'): EmployeeLimit {
  if (value === 'unlimited') return value
  return boundedInteger(value, label, 1, Number.MAX_SAFE_INTEGER)
}

/** Infinity is internal only: durable and wire values always use the explicit string. */
export function effectiveEmployeeLimit(company: EmployeeLimit, configured: EmployeeLimit): number {
  return Math.min(company === 'unlimited' ? Infinity : company, configured === 'unlimited' ? Infinity : configured)
}

/** Convert a human currency-unit input to durable integer micros exactly once at the Host boundary. */
export function currencyUnitsToMicros(value: unknown, label = 'currency amount'): number {
  if (typeof value !== 'number' && typeof value !== 'string') throw new Error(`${label} must be a decimal currency value`)
  const text = String(value).trim()
  const match = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/.exec(text)
  if (match === null) throw new Error(`${label} must be non-negative with at most 6 decimal places`)
  const whole = BigInt(match[1]!)
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'))
  const micros = whole * 1_000_000n + fraction
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error(`${label} exceeds the safe monetary range`)
  return Number(micros)
}

export function normalizeModelPrices(
  prices: ModelPriceInput[],
  source: ModelPrice3['source'] = 'manual',
  revision = 1,
  updatedAt = Date.now(),
): ModelPrice3[] {
  if (!Array.isArray(prices)) throw new Error('model prices must be an array')
  safeInteger(revision, 'model price revision', 1)
  timestamp(updatedAt, 'model price updatedAt')
  const seen = new Set<string>()
  return prices.map((price, index) => {
    if (!isRecord(price)) throw new Error(`modelPrices[${index}] must be an object`)
    const provider = nonEmpty(price.provider, `modelPrices[${index}].provider`, 128)
    const model = nonEmpty(price.model, `modelPrices[${index}].model`, 256)
    const key = `${provider}/${model}`
    if (seen.has(key)) throw new Error(`duplicate model price route ${key}`)
    seen.add(key)
    const rateKeys = ['inputCacheMissMicrosPerMillion', 'inputCacheHitMicrosPerMillion', 'outputMicrosPerMillion'] as const
    const present = rateKeys.filter((field) => price[field] !== undefined)
    if (present.length !== 0 && present.length !== rateKeys.length) {
      throw new Error(`modelPrices[${index}] must provide all three rates or none`)
    }
    const rates = Object.fromEntries(rateKeys.map((field) => {
      const value = price[field]
      if (value !== undefined) safeInteger(value, `modelPrices[${index}].${field}`, 0, Number.MAX_SAFE_INTEGER)
      return [field, value]
    })) as Pick<ModelPriceInput, typeof rateKeys[number]>
    return {
      provider,
      model,
      ...(present.length === 0 ? {} : rates),
      source,
      revision,
      updatedAt,
    }
  }).filter((price) => price.inputCacheMissMicrosPerMillion !== undefined
    && price.inputCacheHitMicrosPerMillion !== undefined
    && price.outputMicrosPerMillion !== undefined)
}

export function collapseLegacyTokenPrice(price: {
  provider: string
  model: string
  inputMicrosPerMillion: number
  cacheReadMicrosPerMillion: number
  cacheWriteMicrosPerMillion: number
  outputMicrosPerMillion: number
  reasoningMicrosPerMillion?: number
}, revision: number, updatedAt: number): ModelPrice3 | undefined {
  if (price.cacheWriteMicrosPerMillion !== price.inputMicrosPerMillion) return undefined
  if (price.reasoningMicrosPerMillion !== undefined && price.reasoningMicrosPerMillion !== price.outputMicrosPerMillion) return undefined
  return {
    provider: price.provider,
    model: price.model,
    inputCacheMissMicrosPerMillion: price.inputMicrosPerMillion,
    inputCacheHitMicrosPerMillion: price.cacheReadMicrosPerMillion,
    outputMicrosPerMillion: price.outputMicrosPerMillion,
    source: 'legacy',
    revision,
    updatedAt,
  }
}

export function assertCompanyState(value: unknown, expectedWorkspaceHash?: string): asserts value is CompanyState {
  if (!isRecord(value)) throw new Error('company state must be an object')
  exactKeys(value, [
    'schemaVersion', 'revision', 'id', 'name', 'slogan', 'mission', 'governanceRevision', 'workspaceHash', 'founderSessionId',
    'stagedFromUserMessageId', 'phase', 'createdAt', 'updatedAt', 'approvedAt',
    'pausedAt', 'archivedAt', 'limits', 'counters', 'moneyBudget', 'modelCatalog',
    'temporaryAuthorizations', 'formation', 'health', 'orgUnits', 'positions', 'staffingRequests', 'hrEmployeeId',
    'employees', 'products', 'workItems', 'tickets', 'supportEmployeeId', 'approvals', 'governanceNotifications', 'provisioning',
  ], 'company state')
  if (value.schemaVersion !== COMPANY_STATE_SCHEMA_VERSION) throw new Error(`unsupported company schemaVersion ${String(value.schemaVersion)}`)
  safeInteger(value.revision, 'revision', 1)
  stringMatches(value.id, 'company id', COMPANY_ID)
  plainString(value.name, 'company name', 1, 200)
  plainString(value.slogan, 'company slogan', 1, 500)
  plainString(value.mission, 'company mission', 1, 16_384)
  safeInteger(value.governanceRevision, 'governanceRevision', 1)
  stringMatches(value.workspaceHash, 'workspaceHash', /^[0-9a-f]{64}$/)
  if (expectedWorkspaceHash !== undefined && value.workspaceHash !== expectedWorkspaceHash) {
    throw new Error('company workspace hash does not match the canonical caller workspace')
  }
  plainString(value.founderSessionId, 'founderSessionId', 1, 512)
  plainString(value.stagedFromUserMessageId, 'stagedFromUserMessageId', 1, 512)
  enumValue(value.phase, 'phase', COMPANY_PHASES)
  timestamp(value.createdAt, 'createdAt')
  timestamp(value.updatedAt, 'updatedAt')
  for (const key of ['approvedAt', 'pausedAt', 'archivedAt'] as const) if (value[key] !== undefined) timestamp(value[key], key)
  assertLimits(value.limits)
  assertCounters(value.counters)
  assertMoneyBudget(value.moneyBudget)
  assertModelCatalog(value.modelCatalog)
  assertTemporaryAuthorizations(value.temporaryAuthorizations)
  assertFormation(value.formation)
  assertHealth(value.health)
  if (value.phase === 'halted' && (value.health as CompanyState['health']).status !== 'halted') throw new Error('halted company requires halted health')
  if (value.phase === 'paused' && (value.health as CompanyState['health']).status !== 'manual_pause') throw new Error('paused company requires manual_pause health')
  assertOrganization(value.orgUnits, value.positions)
  assertStaffingRequests(value.staffingRequests)
  const limits = value.limits as CompanyState['limits']
  if (!Array.isArray(value.employees) || !Array.isArray(value.products) || !Array.isArray(value.workItems) || !Array.isArray(value.tickets ?? []) || !Array.isArray(value.approvals) || !Array.isArray(value.governanceNotifications)) {
    throw new Error('employees, products, workItems, tickets, approvals, and governanceNotifications must be arrays')
  }
  if (limits.maxEmployees !== 'unlimited' && (value.employees as CompanyState['employees']).filter((employee) => employee.status !== 'retired').length > limits.maxEmployees) throw new Error('saved company exceeds active maxEmployees snapshot')
  if (value.products.length > limits.maxProducts) throw new Error('saved company exceeds maxProducts snapshot')
  if (value.workItems.length > limits.maxWorkItems) throw new Error('saved company exceeds maxWorkItems snapshot')
  const employeeIds = uniqueIds(value.employees, EMPLOYEE_ID, 'employee')
  const productIds = uniqueIds(value.products, PRODUCT_ID, 'product')
  const formation = value.formation as CompanyState['formation']
  if (formation.firstProductId !== undefined && !productIds.has(formation.firstProductId)) throw new Error('formation.firstProductId references an unknown product')
  const workIds = uniqueIds(value.workItems, WORK_ID, 'work')
  const approvalIds = uniqueIds(value.approvals, APPROVAL_ID, 'approval')
  const moneyBudget = value.moneyBudget as CompanyState['moneyBudget']
  for (const reservation of moneyBudget.reservations) {
    if (!employeeIds.has(reservation.employeeId)) throw new Error(`money reservation ${reservation.id} references unknown employee`)
    if (reservation.workId !== undefined) {
      const work = (value.workItems as CompanyState['workItems']).find((candidate) => candidate.id === reservation.workId)
      if (work === undefined) throw new Error(`money reservation ${reservation.id} references unknown work`)
      if (work.assigneeId !== reservation.employeeId) throw new Error(`money reservation ${reservation.id} employee/work owner mismatch`)
      if (reservation.productId !== work.productId) throw new Error(`money reservation ${reservation.id} product/work mismatch`)
    }
    if (reservation.productId !== undefined && !productIds.has(reservation.productId)) throw new Error(`money reservation ${reservation.id} references unknown product`)
    if (reservation.staffingRequestId !== undefined) {
      const request = (value.staffingRequests as CompanyState['staffingRequests']).find((candidate) => candidate.id === reservation.staffingRequestId)
      if (request === undefined || request.hrEmployeeId !== reservation.employeeId || (request.reservationId !== undefined && request.reservationId !== reservation.id)) throw new Error(`money reservation ${reservation.id} staffing request mismatch`)
    }
  }
  for (const work of value.workItems as CompanyState['workItems']) {
    if (work.reservationId === undefined) continue
    const reservation = moneyBudget.reservations.find((candidate) => candidate.id === work.reservationId)
    if (reservation?.workId !== work.id || reservation.employeeId !== work.assigneeId) throw new Error(`work ${work.id} prepared reservation does not match its owner`)
  }
  for (const usage of moneyBudget.usage) {
    if (usage.employeeId !== 'founder' && !employeeIds.has(usage.employeeId)) throw new Error(`money usage ${usage.id} references unknown employee`)
    if (usage.workId !== undefined && !workIds.has(usage.workId)) throw new Error(`money usage ${usage.id} references unknown work`)
    if (usage.productId !== undefined && !productIds.has(usage.productId)) throw new Error(`money usage ${usage.id} references unknown product`)
  }
  for (const authorization of value.temporaryAuthorizations as CompanyState['temporaryAuthorizations']) {
    if (!employeeIds.has(authorization.employeeId)) throw new Error(`temporary authorization ${authorization.id} references unknown employee`)
    const approval = (value.approvals as CompanyState['approvals']).find((candidate) => candidate.id === authorization.approvalId)
    if (approval?.kind !== 'temporary_authorization' || approval.status !== 'approved' || approval.consumedAt === undefined) {
      throw new Error(`temporary authorization ${authorization.id} lacks consumed approval provenance`)
    }
    for (const use of authorization.uses) {
      if (!workIds.has(use.workId)) throw new Error(`temporary authorization ${authorization.id} use references unknown work`)
      for (const approvalId of use.approvalIds ?? []) if (!approvalIds.has(approvalId)) throw new Error(`temporary authorization ${authorization.id} use references unknown approval ${approvalId}`)
    }
  }
  if (value.hrEmployeeId !== undefined && !employeeIds.has(String(value.hrEmployeeId))) throw new Error('hrEmployeeId references an unknown employee')
  for (const request of value.staffingRequests as CompanyState['staffingRequests']) {
    if (!employeeIds.has(request.hrEmployeeId)) throw new Error(`staffing request ${request.id} references unknown HR employee`)
    if (request.employeeId !== undefined && !employeeIds.has(request.employeeId)) throw new Error(`staffing request ${request.id} references unknown employee`)
    if (request.reservationId !== undefined) {
      const reservation = moneyBudget.reservations.find((candidate) => candidate.id === request.reservationId)
      if (reservation?.staffingRequestId !== request.id || reservation.employeeId !== request.hrEmployeeId) throw new Error(`staffing request ${request.id} prepared reservation mismatch`)
    }
    if (request.approvalId !== undefined) {
      const approval = (value.approvals as CompanyState['approvals']).find((candidate) => candidate.id === request.approvalId)
      if (approval?.kind !== 'organization_change') throw new Error(`staffing request ${request.id} references a non-organization approval`)
      if (request.status === 'approved' && approval.status !== 'approved') throw new Error(`staffing request ${request.id} is approved but its approval is ${approval.status}`)
      if (request.status === 'rejected' && !['rejected', 'cancelled', 'expired'].includes(approval.status)) throw new Error(`staffing request ${request.id} is rejected but its approval is ${approval.status}`)
      if (request.status === 'applied' && (approval.status !== 'approved' || approval.consumedAt === undefined)) throw new Error(`staffing request ${request.id} is applied without a consumed approval`)
    }
  }
  for (const unit of value.orgUnits as CompanyState['orgUnits']) if (unit.managerEmployeeId !== undefined && !employeeIds.has(unit.managerEmployeeId)) throw new Error(`org unit ${unit.id} references unknown manager employee`)
  const orgUnitIds = new Set((value.orgUnits as Array<{ id: string }>).map((unit) => unit.id))
  const positionIds = new Set((value.positions as Array<{ id: string }>).map((position) => position.id))
  const positionUnits = new Map((value.positions as Array<{ id: string; orgUnitId: string }>).map((position) => [position.id, position.orgUnitId]))
  const sessionIds = new Set<string>()
  for (const [index, raw] of value.employees.entries()) {
    if (!isRecord(raw)) throw new Error(`employees[${index}] must be an object`)
    exactKeys(raw, ['id', 'name', 'role', 'orgUnitId', 'positionId', 'isHr', 'budgetMicros', 'operationalBlock', 'status', 'sessionId', 'joinedAt', 'retiredAt', 'failure', 'llm', 'executionPrompt'], `employees[${index}]`)
    plainString(raw.name, `employees[${index}].name`, 1, 200)
    plainString(raw.role, `employees[${index}].role`, 1, 1000)
    if (raw.orgUnitId !== undefined) {
      plainString(raw.orgUnitId, `employees[${index}].orgUnitId`, 1, 128)
      if (!orgUnitIds.has(raw.orgUnitId)) throw new Error(`employees[${index}] references unknown org unit`)
    }
    if (raw.positionId !== undefined) {
      plainString(raw.positionId, `employees[${index}].positionId`, 1, 128)
      if (!positionIds.has(raw.positionId)) throw new Error(`employees[${index}] references unknown position`)
      if (raw.orgUnitId !== undefined && positionUnits.get(raw.positionId) !== raw.orgUnitId) throw new Error(`employees[${index}] position belongs to another org unit`)
    }
    if (raw.isHr !== undefined && typeof raw.isHr !== 'boolean') throw new Error(`employees[${index}].isHr must be boolean`)
    safeInteger(raw.budgetMicros, `employees[${index}].budgetMicros`, 0)
    if (raw.operationalBlock !== undefined) assertOperationalBlock(raw.operationalBlock, `employees[${index}].operationalBlock`)
    enumValue(raw.status, `employees[${index}].status`, ['planned', 'provisioning', 'idle', 'working', 'paused', 'failed', 'retired'])
    if (!isRecord(raw.llm)) throw new Error(`employees[${index}].llm must be an object`)
    exactKeys(raw.llm, ['provider', 'model', 'reasoningEffort', 'fallback', 'fallbackActive', 'activeProvider', 'activeModel'], `employees[${index}].llm`)
    plainString(raw.llm.provider, `employees[${index}].llm.provider`, 1, 128)
    plainString(raw.llm.model, `employees[${index}].llm.model`, 1, 256)
    if (raw.llm.reasoningEffort !== undefined) plainString(raw.llm.reasoningEffort, `employees[${index}].llm.reasoningEffort`, 1, 128)
    if (raw.llm.fallback !== undefined) {
      if (!isRecord(raw.llm.fallback)) throw new Error(`employees[${index}].llm.fallback must be an object`)
      exactKeys(raw.llm.fallback, ['provider', 'model'], `employees[${index}].llm.fallback`)
      plainString(raw.llm.fallback.provider, `employees[${index}].llm.fallback.provider`, 1, 128)
      plainString(raw.llm.fallback.model, `employees[${index}].llm.fallback.model`, 1, 256)
    }
    if (raw.llm.fallbackActive !== undefined && typeof raw.llm.fallbackActive !== 'boolean') throw new Error(`employees[${index}].llm.fallbackActive must be boolean`)
    if ((raw.llm.activeProvider === undefined) !== (raw.llm.activeModel === undefined)) throw new Error(`employees[${index}].llm active provider/model must be supplied together`)
    if (raw.llm.activeProvider !== undefined) plainString(raw.llm.activeProvider, `employees[${index}].llm.activeProvider`, 1, 128)
    if (raw.llm.activeModel !== undefined) plainString(raw.llm.activeModel, `employees[${index}].llm.activeModel`, 1, 256)
    if (raw.sessionId !== undefined) {
      plainString(raw.sessionId, `employees[${index}].sessionId`, 1, 512)
      if (sessionIds.has(raw.sessionId)) throw new Error(`duplicate employee sessionId ${raw.sessionId}`)
      sessionIds.add(raw.sessionId)
    }
    if (raw.joinedAt !== undefined) timestamp(raw.joinedAt, `employees[${index}].joinedAt`)
    if (raw.retiredAt !== undefined) timestamp(raw.retiredAt, `employees[${index}].retiredAt`)
    if (raw.failure !== undefined) plainString(raw.failure, `employees[${index}].failure`, 1, 4096)
    if (raw.executionPrompt !== undefined) plainString(raw.executionPrompt, `employees[${index}].executionPrompt`, 1, 16_384)
  }
  for (const [index, raw] of value.products.entries()) {
    if (!isRecord(raw)) throw new Error(`products[${index}] must be an object`)
    exactKeys(raw, ['id', 'name', 'summary', 'status', 'productRoot', 'successCriteria', 'budgetMicros', 'createdAt', 'updatedAt', 'releaseApprovalId'], `products[${index}]`)
    plainString(raw.name, `products[${index}].name`, 1, 200)
    plainString(raw.summary, `products[${index}].summary`, 1, 16_384)
    plainString(raw.productRoot, `products[${index}].productRoot`, 1, 4096)
    enumValue(raw.status, `products[${index}].status`, ['proposed', 'approved', 'active', 'paused', 'validating', 'released', 'retired', 'cancelled'])
    stringArray(raw.successCriteria, `products[${index}].successCriteria`, 1, 256, 16_384)
    safeInteger(raw.budgetMicros, `products[${index}].budgetMicros`, 0)
    timestamp(raw.createdAt, `products[${index}].createdAt`)
    timestamp(raw.updatedAt, `products[${index}].updatedAt`)
    if (raw.releaseApprovalId !== undefined) stringMatches(raw.releaseApprovalId, `products[${index}].releaseApprovalId`, APPROVAL_ID)
  }
  for (const [index, raw] of value.workItems.entries()) assertWork(raw, index, employeeIds, productIds, workIds, approvalIds, limits.maxAttemptsPerWork, orgUnitIds)
  const ticketRows: unknown[] = Array.isArray(value.tickets) ? value.tickets : []
  for (const [index, raw] of ticketRows.entries()) {
    if (!isRecord(raw)) throw new Error(`tickets[${index}] must be an object`)
    exactKeys(raw, ['id', 'productId', 'title', 'description', 'reportedBy', 'reportedAt', 'status', 'severity', 'workItemId', 'assigneeId', 'dispatchNote', 'resolvedAt', 'reply', 'closedAt'], `tickets[${index}]`)
    stringMatches(raw.id, `tickets[${index}].id`, TICKET_ID)
    if (!productIds.has(String(raw.productId))) throw new Error(`tickets[${index}] references unknown product`)
    plainString(raw.title, `tickets[${index}].title`, 1, 200)
    plainString(raw.description, `tickets[${index}].description`, 1, 16_384)
    if (raw.reportedBy !== 'web-console') throw new Error(`tickets[${index}].reportedBy must be web-console`)
    safeInteger(raw.reportedAt, `tickets[${index}].reportedAt`, 1)
    enumValue(raw.status, `tickets[${index}].status`, ['filed', 'triaged', 'dispatched', 'resolved', 'closed'])
    if (raw.severity !== undefined) enumValue(raw.severity, `tickets[${index}].severity`, ['low', 'medium', 'high', 'urgent'])
    if (raw.workItemId !== undefined) {
      stringMatches(raw.workItemId, `tickets[${index}].workItemId`, WORK_ID)
      if (!workIds.has(raw.workItemId)) throw new Error(`tickets[${index}] references unknown work ${String(raw.workItemId)}`)
    }
    if (raw.assigneeId !== undefined && (typeof raw.assigneeId !== 'string' || !employeeIds.has(raw.assigneeId))) throw new Error(`tickets[${index}] references unknown assignee`)
    if (raw.dispatchNote !== undefined) plainString(raw.dispatchNote, `tickets[${index}].dispatchNote`, 1, 4_096)
    if (raw.resolvedAt !== undefined) safeInteger(raw.resolvedAt, `tickets[${index}].resolvedAt`, 1)
    if (raw.reply !== undefined) plainString(raw.reply, `tickets[${index}].reply`, 1, 16_384)
    if (raw.closedAt !== undefined) safeInteger(raw.closedAt, `tickets[${index}].closedAt`, 1)
    if (raw.workItemId !== undefined) {
      const linked = (value.workItems as CompanyState['workItems']).find((work) => work.id === raw.workItemId)
      if (linked?.ticketId !== raw.id) throw new Error(`ticket ${String(raw.id)} and work ${String(raw.workItemId)} are not linked bidirectionally`)
      if (raw.status === 'resolved' && linked.status !== 'completed') throw new Error(`resolved ticket ${String(raw.id)} requires completed repair work`)
      if (raw.status === 'closed' && !['completed', 'failed', 'cancelled'].includes(linked.status)) throw new Error(`closed ticket ${String(raw.id)} requires terminal repair work`)
      if ((raw.status === 'filed' || raw.status === 'triaged') && linked.status !== 'pending') throw new Error(`${String(raw.status)} ticket ${String(raw.id)} requires pending repair work`)
      if (raw.status === 'dispatched' && !['pending', 'claimed', 'in_progress'].includes(linked.status)) throw new Error(`dispatched ticket ${String(raw.id)} requires runnable repair work`)
    }
  }
  for (const work of value.workItems as CompanyState['workItems']) {
    if (work.ticketId === undefined) continue
    const ticket = (value.tickets as CompanyState['tickets']).find((candidate) => candidate.id === work.ticketId)
    if (ticket?.workItemId !== work.id || work.kind !== 'repair') throw new Error(`ticket-linked work ${work.id} has an invalid backlink`)
  }
  if (value.supportEmployeeId !== undefined) {
    const support = (value.employees as CompanyState['employees']).find((employee) => employee.id === value.supportEmployeeId)
    if (support === undefined || ['retired', 'failed', 'planned', 'provisioning'].includes(support.status)) throw new Error('supportEmployeeId must reference a runnable employee')
  }
  assertAcyclic(value.workItems)
  for (const [index, raw] of value.approvals.entries()) {
    if (!isRecord(raw)) throw new Error(`approvals[${index}] must be an object`)
    exactKeys(raw, ['id', 'kind', 'status', 'requestedBy', 'summary', 'detail', 'payload', 'risk', 'requestedAt', 'requestedFromUserMessageId', 'expiresAt', 'resolvedAt', 'consumedAt', 'resolution'], `approvals[${index}]`)
    enumValue(raw.kind, `approvals[${index}].kind`, ['bootstrap', 'budget_change', 'pricing_change', 'governance_change', 'temporary_authorization', 'organization_change', 'product_scope', 'model_route', 'release', 'external_effect', 'forced_archive'])
    enumValue(raw.status, `approvals[${index}].status`, ['pending', 'approved', 'rejected', 'cancelled', 'expired'])
    plainString(raw.requestedBy, `approvals[${index}].requestedBy`, 1, 256)
    if (raw.requestedBy !== 'founder' && !employeeIds.has(raw.requestedBy)) throw new Error(`approvals[${index}] has unknown requester`)
    plainString(raw.summary, `approvals[${index}].summary`, 1, 4096)
    if (raw.detail !== undefined) plainString(raw.detail, `approvals[${index}].detail`, 1, 4096)
    enumValue(raw.risk, `approvals[${index}].risk`, ['low', 'medium', 'high'])
    timestamp(raw.requestedAt, `approvals[${index}].requestedAt`)
    assertJsonValue(raw.payload, `approvals[${index}].payload`)
    validateApprovalPayload(raw.kind as ApprovalKind, raw.payload)
    if (raw.requestedFromUserMessageId !== undefined) plainString(raw.requestedFromUserMessageId, `approvals[${index}].requestedFromUserMessageId`, 1, 512)
    if (raw.expiresAt !== undefined) timestamp(raw.expiresAt, `approvals[${index}].expiresAt`)
    if (raw.resolvedAt !== undefined) timestamp(raw.resolvedAt, `approvals[${index}].resolvedAt`)
    if (raw.consumedAt !== undefined) timestamp(raw.consumedAt, `approvals[${index}].consumedAt`)
    if (raw.resolution !== undefined) {
      if (!isRecord(raw.resolution)) throw new Error(`approvals[${index}].resolution must be an object`)
      exactKeys(raw.resolution, ['decision', 'source', 'humanStatement', 'note'], `approvals[${index}].resolution`)
      enumValue(raw.resolution.decision, `approvals[${index}].resolution.decision`, ['approved', 'rejected'])
      enumValue(raw.resolution.source, `approvals[${index}].resolution.source`, ['ui', 'tool'])
      if (raw.resolution.humanStatement !== undefined) plainString(raw.resolution.humanStatement, `approvals[${index}].resolution.humanStatement`, 1, 4096)
      if (raw.resolution.note !== undefined) plainString(raw.resolution.note, `approvals[${index}].resolution.note`, 1, 4096)
    }
    if (raw.status === 'pending' && raw.resolvedAt !== undefined) throw new Error(`pending approval ${raw.id} must not be resolved`)
    if (raw.status !== 'pending' && raw.resolvedAt === undefined) throw new Error(`terminal approval ${raw.id} requires resolvedAt`)
  }
  for (const [index, raw] of value.governanceNotifications.entries()) {
    if (!isRecord(raw)) throw new Error(`governanceNotifications[${index}] must be an object`)
    exactKeys(raw, ['id', 'governanceRevision', 'employeeIds', 'deliveredEmployeeIds', 'content', 'createdAt'], `governanceNotifications[${index}]`)
    stringMatches(raw.id, `governanceNotifications[${index}].id`, UUID)
    safeInteger(raw.governanceRevision, `governanceNotifications[${index}].governanceRevision`, 1)
    stringArray(raw.employeeIds, `governanceNotifications[${index}].employeeIds`, 0, value.employees.length, 128)
    stringArray(raw.deliveredEmployeeIds, `governanceNotifications[${index}].deliveredEmployeeIds`, 0, value.employees.length, 128)
    for (const id of raw.employeeIds as string[]) if (!employeeIds.has(id)) throw new Error(`governance notification references unknown employee ${id}`)
    for (const id of raw.deliveredEmployeeIds as string[]) if (!(raw.employeeIds as string[]).includes(id)) throw new Error(`governance notification delivered employee ${id} is not a target`)
    plainString(raw.content, `governanceNotifications[${index}].content`, 1, limits.maxMessageChars)
    timestamp(raw.createdAt, `governanceNotifications[${index}].createdAt`)
  }
  if ((value.phase === 'provisioning') !== (value.provisioning !== undefined)) throw new Error('company provisioning phase and generation must agree')
  if (value.provisioning !== undefined) {
    if (!isRecord(value.provisioning)) throw new Error('provisioning must be an object')
    exactKeys(value.provisioning, ['id', 'startedAt', 'approvalId', 'employeeIds', 'reservationIds'], 'provisioning')
    stringMatches(value.provisioning.id, 'provisioning.id', UUID)
    timestamp(value.provisioning.startedAt, 'provisioning.startedAt')
    stringMatches(value.provisioning.approvalId, 'provisioning.approvalId', APPROVAL_ID)
    stringArray(value.provisioning.employeeIds, 'provisioning.employeeIds', 1, value.employees.length, 128)
    for (const id of value.provisioning.employeeIds as string[]) if (!employeeIds.has(id)) throw new Error(`provisioning references unknown employee ${id}`)
    stringArray(value.provisioning.reservationIds, 'provisioning.reservationIds', 1, value.employees.length, 128)
    for (const id of value.provisioning.reservationIds as string[]) stringMatches(id, 'provisioning.reservationIds[]', UUID)
  }
  const typedProducts = value.products as unknown as CompanyState['products']
  const typedWork = value.workItems as unknown as CompanyState['workItems']
  const typedMoney = value.moneyBudget as CompanyState['moneyBudget']
  if (typedMoney.migrationRequired !== true) {
    const productMoneyAllocation = typedProducts.filter((product) => product.status !== 'cancelled' && product.status !== 'retired')
      .reduce((sum, product) => checkedAdd(sum, product.budgetMicros ?? 0, 'product money allocations'), 0)
    const activeEmployees = (value.employees as CompanyState['employees']).filter((employee) => employee.status !== 'retired')
    if (productMoneyAllocation > typedMoney.totalMicros) throw new Error('product money allocations exceed company total micros')
    for (const employee of activeEmployees) if ((employee.budgetMicros ?? 0) > typedMoney.totalMicros) throw new Error(`employee ${employee.id} money ceiling exceeds company total micros`)
  }
  const openByEmployee = new Map<string, number>()
  for (const item of typedWork) {
    if ((item.status === 'claimed' || item.status === 'in_progress') && item.assigneeId !== undefined && item.assigneeId !== 'founder') {
      openByEmployee.set(item.assigneeId, (openByEmployee.get(item.assigneeId) ?? 0) + 1)
    }
  }
  for (const [employee, count] of openByEmployee) if (count > 1) throw new Error(`employee ${employee} owns ${count} open work attempts`)
}

function assertLimits(value: unknown): void {
  if (!isRecord(value)) throw new Error('limits must be an object')
  const keys = ['maxEmployees', 'maxProducts', 'maxWorkItems', 'maxOpenWorkItems', 'maxAttemptsPerWork', 'maxPendingApprovals', 'maxMailboxMessages', 'maxAuditBytes', 'maxMessageChars', 'maxOutputChars', 'memberMaxDepth']
  exactKeys(value, keys, 'limits')
  // Accept zero only when reading legacy v0.1.x snapshots; dispatch clamps it to one.
  normalizeEmployeeLimit(value.maxEmployees, 'limits.maxEmployees')
  for (const key of keys.filter((key) => key !== 'maxEmployees')) safeInteger(value[key], `limits.${key}`, key === 'memberMaxDepth' ? 0 : 1)
  if ((value.maxProducts as number) > HARD_MAX.maxProducts || (value.maxWorkItems as number) > HARD_MAX.maxWorkItems || (value.maxAttemptsPerWork as number) > HARD_MAX.maxAttemptsPerWork) {
    throw new Error('saved limits exceed source hard maxima')
  }
}

function assertCounters(value: unknown): void {
  if (!isRecord(value)) throw new Error('counters must be an object')
  exactKeys(value, ['employee', 'product', 'work', 'approval', 'event', 'orgUnit', 'position', 'staffing', 'authorization', 'ticket'], 'counters')
  for (const key of ['employee', 'product', 'work', 'approval', 'event', 'orgUnit', 'position', 'staffing', 'authorization', 'ticket']) safeInteger(value[key], `counters.${key}`, 0)
}

function assertMoneyBudget(value: unknown): void {
  if (!isRecord(value)) throw new Error('moneyBudget must be an object')
  exactKeys(value, ['unit', 'currency', 'totalMicros', 'reservedMicros', 'spentMicros', 'warningAtMicros', 'pricingRevision', 'prices', 'usage', 'reservations', 'migrationRequired', 'legacyV02'], 'moneyBudget')
  if (value.unit !== 'micro-currency') throw new Error('moneyBudget.unit must be micro-currency')
  normalizeCurrency(String(value.currency))
  for (const key of ['totalMicros', 'reservedMicros', 'spentMicros'] as const) safeInteger(value[key], `moneyBudget.${key}`, 0)
  safeInteger(value.pricingRevision, 'moneyBudget.pricingRevision', 1)
  if (value.warningAtMicros !== undefined) safeInteger(value.warningAtMicros, 'moneyBudget.warningAtMicros', 0)
  if (value.migrationRequired !== undefined && typeof value.migrationRequired !== 'boolean') throw new Error('moneyBudget.migrationRequired must be boolean')
  if (!Array.isArray(value.prices) || !Array.isArray(value.usage) || !Array.isArray(value.reservations)) throw new Error('moneyBudget prices, usage, and reservations must be arrays')
  const priceKeys = new Set<string>()
  for (const [index, raw] of value.prices.entries()) {
    if (!isRecord(raw)) throw new Error(`moneyBudget.prices[${index}] must be an object`)
    exactKeys(raw, ['provider', 'model', 'inputCacheMissMicrosPerMillion', 'inputCacheHitMicrosPerMillion', 'outputMicrosPerMillion', 'source', 'revision', 'updatedAt'], `moneyBudget.prices[${index}]`)
    plainString(raw.provider, `moneyBudget.prices[${index}].provider`, 1, 128)
    plainString(raw.model, `moneyBudget.prices[${index}].model`, 1, 256)
    const priceKey = `${String(raw.provider)}/${String(raw.model)}`
    if (priceKeys.has(priceKey)) throw new Error(`duplicate money price route ${priceKey}`)
    priceKeys.add(priceKey)
    const rateKeys = ['inputCacheMissMicrosPerMillion', 'inputCacheHitMicrosPerMillion', 'outputMicrosPerMillion'] as const
    const present = rateKeys.filter((key) => raw[key] !== undefined)
    if (present.length !== 0 && present.length !== rateKeys.length) throw new Error(`moneyBudget.prices[${index}] must contain all three rates or none`)
    for (const key of present) safeInteger(raw[key], `moneyBudget.prices[${index}].${key}`, 0)
    enumValue(raw.source, `moneyBudget.prices[${index}].source`, ['manual', 'catalog', 'legacy'])
    safeInteger(raw.revision, `moneyBudget.prices[${index}].revision`, 1, value.pricingRevision as number)
    timestamp(raw.updatedAt, `moneyBudget.prices[${index}].updatedAt`)
  }
  let spentMicros = 0
  const usageIds = new Set<string>()
  for (const [index, raw] of value.usage.entries()) {
    if (!isRecord(raw)) throw new Error(`moneyBudget.usage[${index}] must be an object`)
    exactKeys(raw, ['id', 'sessionId', 'eventSeq', 'turn', 'step', 'employeeId', 'workId', 'productId', 'provider', 'model', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'inputCacheMissTokens', 'inputCacheHitTokens', 'totalTokens', 'costMicros', 'priced', 'currency', 'pricingRevision', 'matchedPriceKey', 'rates', 'authorizationId', 'pricingProvenance', 'at'], `moneyBudget.usage[${index}]`)
    plainString(raw.id, `moneyBudget.usage[${index}].id`, 1, 1024)
    if (usageIds.has(raw.id as string)) throw new Error(`duplicate money usage ${raw.id}`)
    usageIds.add(raw.id as string)
    for (const key of ['sessionId', 'employeeId', 'provider', 'model'] as const) plainString(raw[key], `moneyBudget.usage[${index}].${key}`, 1, 512)
    for (const key of ['workId', 'productId', 'matchedPriceKey', 'authorizationId'] as const) if (raw[key] !== undefined) plainString(raw[key], `moneyBudget.usage[${index}].${key}`, 1, 512)
    for (const key of ['eventSeq', 'turn', 'step', 'inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'inputCacheMissTokens', 'inputCacheHitTokens', 'totalTokens', 'costMicros', 'pricingRevision'] as const) safeInteger(raw[key], `moneyBudget.usage[${index}].${key}`, 0)
    if ((raw.reasoningTokens as number) > (raw.outputTokens as number)) throw new Error(`moneyBudget.usage[${index}] reasoning exceeds output`)
    if (raw.inputCacheMissTokens !== (raw.inputTokens as number) + (raw.cacheWriteTokens as number)) throw new Error(`moneyBudget.usage[${index}] miss tokens mismatch`)
    if (raw.inputCacheHitTokens !== raw.cacheReadTokens) throw new Error(`moneyBudget.usage[${index}] hit tokens mismatch`)
    if (raw.totalTokens !== (raw.inputCacheMissTokens as number) + (raw.inputCacheHitTokens as number) + (raw.outputTokens as number)) throw new Error(`moneyBudget.usage[${index}] total tokens mismatch`)
    if (typeof raw.priced !== 'boolean') throw new Error(`moneyBudget.usage[${index}].priced must be boolean`)
    if (raw.pricingProvenance !== undefined) enumValue(raw.pricingProvenance, `moneyBudget.usage[${index}].pricingProvenance`, ['legacy_recorded_event', 'legacy_recorded_total'])
    const legacyRecordedEvent = raw.pricingProvenance === 'legacy_recorded_event'
    const legacyRecordedTotal = raw.pricingProvenance === 'legacy_recorded_total'
    const legacyRecorded = legacyRecordedEvent || legacyRecordedTotal
    if (!legacyRecorded && raw.priced === false && raw.costMicros !== 0) throw new Error(`unpriced money usage ${raw.id} must have zero recorded cost`)
    normalizeCurrency(String(raw.currency))
    if (raw.rates !== undefined) assertMoneyRateSnapshot(raw.rates, `moneyBudget.usage[${index}].rates`)
    if (legacyRecordedTotal) {
      if (raw.priced !== true || raw.rates !== undefined || raw.totalTokens !== 0) throw new Error(`moneyBudget.usage[${index}] invalid legacy recorded total`)
    } else if (legacyRecordedEvent) {
      if (raw.priced !== true || raw.rates !== undefined) throw new Error(`moneyBudget.usage[${index}] invalid legacy recorded event`)
    } else if (!legacyRecorded && (raw.priced === true) !== (raw.rates !== undefined)) throw new Error(`moneyBudget.usage[${index}] priced/rates mismatch`)
    if (!legacyRecorded && raw.priced === true && raw.rates !== undefined) {
      const recomputed = recomputeThreeRateCost({
        inputTokens: raw.inputTokens as number,
        outputTokens: raw.outputTokens as number,
        cacheReadTokens: raw.cacheReadTokens as number,
        cacheWriteTokens: raw.cacheWriteTokens as number,
        reasoningTokens: raw.reasoningTokens as number,
      }, raw.rates as unknown as MoneyRateSnapshot)
      if (recomputed.costMicros !== raw.costMicros) throw new Error(`moneyBudget.usage[${index}] cost does not match its immutable rate snapshot`)
    }
    timestamp(raw.at, `moneyBudget.usage[${index}].at`)
    spentMicros = checkedAdd(spentMicros, raw.costMicros as number, 'money usage')
  }
  if (spentMicros !== value.spentMicros) throw new Error('moneyBudget spent aggregate mismatch')
  let reservedMicros = 0
  const reservationIds = new Set<string>()
  const reservedEmployees = new Set<string>()
  for (const [index, raw] of value.reservations.entries()) {
    if (!isRecord(raw)) throw new Error(`moneyBudget.reservations[${index}] must be an object`)
    exactKeys(raw, ['id', 'employeeId', 'workId', 'productId', 'messageId', 'staffingRequestId', 'limitTokens', 'remainingTokens', 'reservedMicros', 'remainingMicros', 'callHeadroomMicros', 'rates', 'routes', 'routeRates', 'authorizationId', 'unknownCost', 'createdAt'], `moneyBudget.reservations[${index}]`)
    stringMatches(raw.id, `moneyBudget.reservations[${index}].id`, UUID)
    if (reservationIds.has(raw.id as string)) throw new Error(`duplicate money reservation ${raw.id}`)
    reservationIds.add(raw.id as string)
    plainString(raw.employeeId, `moneyBudget.reservations[${index}].employeeId`, 1, 128)
    if (reservedEmployees.has(raw.employeeId as string)) throw new Error(`employee ${raw.employeeId} has multiple active money reservations`)
    reservedEmployees.add(raw.employeeId as string)
    for (const key of ['workId', 'productId', 'messageId', 'staffingRequestId', 'authorizationId'] as const) if (raw[key] !== undefined) plainString(raw[key], `moneyBudget.reservations[${index}].${key}`, 1, 512)
    safeInteger(raw.limitTokens, `moneyBudget.reservations[${index}].limitTokens`, 1)
    safeInteger(raw.remainingTokens, `moneyBudget.reservations[${index}].remainingTokens`, 0, raw.limitTokens as number)
    safeInteger(raw.reservedMicros, `moneyBudget.reservations[${index}].reservedMicros`, 0)
    safeInteger(raw.remainingMicros, `moneyBudget.reservations[${index}].remainingMicros`, 0, raw.reservedMicros as number)
    if (raw.callHeadroomMicros !== undefined) safeInteger(raw.callHeadroomMicros, `moneyBudget.reservations[${index}].callHeadroomMicros`, 0, raw.reservedMicros as number)
    if (raw.rates !== undefined) assertMoneyRateSnapshot(raw.rates, `moneyBudget.reservations[${index}].rates`)
    if (raw.routes !== undefined) {
      if (!Array.isArray(raw.routes) || raw.routes.length === 0) throw new Error(`moneyBudget.reservations[${index}].routes must be a non-empty array`)
      const keys = new Set<string>()
      raw.routes.forEach((route, routeIndex) => {
        if (!isRecord(route)) throw new Error(`moneyBudget.reservations[${index}].routes[${routeIndex}] must be an object`)
        exactKeys(route, ['provider', 'model'], `moneyBudget.reservations[${index}].routes[${routeIndex}]`)
        plainString(route.provider, `moneyBudget.reservations[${index}].routes[${routeIndex}].provider`, 1, 128)
        plainString(route.model, `moneyBudget.reservations[${index}].routes[${routeIndex}].model`, 1, 256)
        const key = `${String(route.provider)}\u0000${String(route.model)}`
        if (keys.has(key)) throw new Error(`moneyBudget.reservations[${index}].routes must be unique`)
        keys.add(key)
      })
    }
    if (raw.routeRates !== undefined) {
      if (!Array.isArray(raw.routeRates)) throw new Error(`moneyBudget.reservations[${index}].routeRates must be an array`)
      raw.routeRates.forEach((rates, rateIndex) => assertMoneyRateSnapshot(rates, `moneyBudget.reservations[${index}].routeRates[${rateIndex}]`))
    }
    if (raw.unknownCost !== undefined && typeof raw.unknownCost !== 'boolean') throw new Error(`moneyBudget.reservations[${index}].unknownCost must be boolean`)
    if ((raw.rates === undefined) !== (raw.unknownCost === true)) throw new Error(`moneyBudget.reservations[${index}] must be either priced or explicitly unknown-cost`)
    if (raw.unknownCost === true && (raw.authorizationId === undefined || raw.reservedMicros !== 0 || raw.remainingMicros !== 0 || !Array.isArray(raw.routes) || raw.routes.length === 0)) throw new Error(`moneyBudget.reservations[${index}] unknown-cost admission requires authorization, captured routes, and zero known reservation`)
    timestamp(raw.createdAt, `moneyBudget.reservations[${index}].createdAt`)
    reservedMicros = checkedAdd(reservedMicros, raw.remainingMicros as number, 'money reservations')
  }
  if (reservedMicros !== value.reservedMicros) throw new Error('moneyBudget reserved aggregate mismatch')
  if (value.legacyV02 !== undefined) {
    if (!isRecord(value.legacyV02)) throw new Error('moneyBudget.legacyV02 must be an object')
    exactKeys(value.legacyV02, ['totalTokens', 'usedTokens', 'reservedTokens', 'totalCostMicros', 'prices', 'treatment'], 'moneyBudget.legacyV02')
    for (const key of ['totalTokens', 'usedTokens', 'reservedTokens', 'totalCostMicros'] as const) safeInteger(value.legacyV02[key], `moneyBudget.legacyV02.${key}`, 0)
    if (!Array.isArray(value.legacyV02.prices)) throw new Error('moneyBudget.legacyV02.prices must be an array')
    enumValue(value.legacyV02.treatment, 'moneyBudget.legacyV02.treatment', ['unverified', 'accepted'])
  }
}

function assertMoneyRateSnapshot(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  exactKeys(value, ['provider', 'model', 'matchedProvider', 'matchedModel', 'currency', 'pricingRevision', 'pricingDigest', 'inputCacheMissMicrosPerMillion', 'inputCacheHitMicrosPerMillion', 'outputMicrosPerMillion'], path)
  for (const key of ['provider', 'model', 'matchedProvider', 'matchedModel'] as const) plainString(value[key], `${path}.${key}`, 1, 512)
  normalizeCurrency(String(value.currency))
  stringMatches(value.pricingDigest, `${path}.pricingDigest`, /^[a-f0-9]{64}$/)
  for (const key of ['pricingRevision', 'inputCacheMissMicrosPerMillion', 'inputCacheHitMicrosPerMillion', 'outputMicrosPerMillion'] as const) safeInteger(value[key], `${path}.${key}`, key === 'pricingRevision' ? 1 : 0)
}

function assertModelCatalog(value: unknown): void {
  if (!isRecord(value)) throw new Error('modelCatalog must be an object')
  exactKeys(value, ['stale', 'generation', 'probedAt', 'invalidatedAt', 'models', 'errors'], 'modelCatalog')
  if (typeof value.stale !== 'boolean') throw new Error('modelCatalog.stale must be boolean')
  safeInteger(value.generation, 'modelCatalog.generation', 0)
  if (value.probedAt !== undefined) timestamp(value.probedAt, 'modelCatalog.probedAt')
  if (value.invalidatedAt !== undefined) timestamp(value.invalidatedAt, 'modelCatalog.invalidatedAt')
  if (!Array.isArray(value.models) || !Array.isArray(value.errors)) throw new Error('modelCatalog models/errors must be arrays')
  const keys = new Set<string>()
  for (const [index, raw] of value.models.entries()) {
    if (!isRecord(raw)) throw new Error(`modelCatalog.models[${index}] must be an object`)
    exactKeys(raw, ['provider', 'model', 'name', 'description', 'inputModalities', 'contextWindow', 'defaultMaxTokens', 'reasoningEfforts', 'defaultReasoningEffort', 'advertised', 'available'], `modelCatalog.models[${index}]`)
    for (const key of ['provider', 'model', 'name'] as const) plainString(raw[key], `modelCatalog.models[${index}].${key}`, 1, 512)
    const key = `${String(raw.provider)}/${String(raw.model)}`
    if (keys.has(key)) throw new Error(`duplicate model catalog row ${key}`)
    keys.add(key)
    if (raw.description !== undefined) plainString(raw.description, `modelCatalog.models[${index}].description`, 1, 4096)
    if (raw.inputModalities !== undefined) stringArray(raw.inputModalities, `modelCatalog.models[${index}].inputModalities`, 0, 32, 128)
    if (raw.contextWindow !== undefined) safeInteger(raw.contextWindow, `modelCatalog.models[${index}].contextWindow`, 1)
    if (raw.defaultMaxTokens !== undefined) safeInteger(raw.defaultMaxTokens, `modelCatalog.models[${index}].defaultMaxTokens`, 1)
    if (raw.reasoningEfforts !== undefined) {
      if (!Array.isArray(raw.reasoningEfforts)) throw new Error(`modelCatalog.models[${index}].reasoningEfforts must be an array`)
      for (const [effortIndex, effort] of raw.reasoningEfforts.entries()) {
        if (!isRecord(effort)) throw new Error(`modelCatalog.models[${index}].reasoningEfforts[${effortIndex}] must be an object`)
        exactKeys(effort, ['id', 'name', 'description'], `modelCatalog.models[${index}].reasoningEfforts[${effortIndex}]`)
        plainString(effort.id, `modelCatalog.models[${index}].reasoningEfforts[${effortIndex}].id`, 1, 128)
        plainString(effort.name, `modelCatalog.models[${index}].reasoningEfforts[${effortIndex}].name`, 1, 256)
        if (effort.description !== undefined) plainString(effort.description, `modelCatalog.models[${index}].reasoningEfforts[${effortIndex}].description`, 1, 1024)
      }
    }
    if (raw.defaultReasoningEffort !== undefined) plainString(raw.defaultReasoningEffort, `modelCatalog.models[${index}].defaultReasoningEffort`, 1, 128)
    if (typeof raw.advertised !== 'boolean') throw new Error(`modelCatalog.models[${index}].advertised must be boolean`)
    if (typeof raw.available !== 'boolean') throw new Error(`modelCatalog.models[${index}].available must be boolean`)
  }
  for (const [index, raw] of value.errors.entries()) {
    if (!isRecord(raw)) throw new Error(`modelCatalog.errors[${index}] must be an object`)
    exactKeys(raw, ['provider', 'message'], `modelCatalog.errors[${index}]`)
    plainString(raw.provider, `modelCatalog.errors[${index}].provider`, 1, 128)
    plainString(raw.message, `modelCatalog.errors[${index}].message`, 1, 2048)
  }
}

function assertTemporaryAuthorizations(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('temporaryAuthorizations must be an array')
  const ids = new Set<string>()
  for (const [index, raw] of value.entries()) {
    if (!isRecord(raw)) throw new Error(`temporaryAuthorizations[${index}] must be an object`)
    exactKeys(raw, ['id', 'employeeId', 'reason', 'approvalId', 'authorizedBy', 'startsAt', 'expiresAt', 'createdAt', 'revokedAt', 'revokedBy', 'revocationReason', 'uses'], `temporaryAuthorizations[${index}]`)
    stringMatches(raw.id, `temporaryAuthorizations[${index}].id`, /^ta[1-9][0-9]*$/)
    if (ids.has(raw.id as string)) throw new Error(`duplicate temporary authorization ${raw.id}`)
    ids.add(raw.id as string)
    stringMatches(raw.employeeId, `temporaryAuthorizations[${index}].employeeId`, EMPLOYEE_ID)
    plainString(raw.reason, `temporaryAuthorizations[${index}].reason`, 1, 4096)
    stringMatches(raw.approvalId, `temporaryAuthorizations[${index}].approvalId`, APPROVAL_ID)
    if (raw.authorizedBy !== 'founder') throw new Error(`temporaryAuthorizations[${index}].authorizedBy must be founder`)
    for (const key of ['startsAt', 'expiresAt', 'createdAt'] as const) timestamp(raw[key], `temporaryAuthorizations[${index}].${key}`)
    if ((raw.expiresAt as number) <= (raw.startsAt as number)) throw new Error(`temporaryAuthorizations[${index}] expiry must be after start`)
    if (raw.revokedAt !== undefined) timestamp(raw.revokedAt, `temporaryAuthorizations[${index}].revokedAt`)
    if (raw.revokedBy !== undefined && raw.revokedBy !== 'founder') throw new Error(`temporaryAuthorizations[${index}].revokedBy must be founder`)
    if (raw.revocationReason !== undefined) plainString(raw.revocationReason, `temporaryAuthorizations[${index}].revocationReason`, 1, 4096)
    if (!Array.isArray(raw.uses)) throw new Error(`temporaryAuthorizations[${index}].uses must be an array`)
    const useIds = new Set<string>()
    for (const [useIndex, use] of raw.uses.entries()) {
      if (!isRecord(use)) throw new Error(`temporaryAuthorizations[${index}].uses[${useIndex}] must be an object`)
      exactKeys(use, ['id', 'at', 'workId', 'employeeId', 'bypassed', 'approvalIds', 'amountMicros', 'usageId', 'unknownCost'], `temporaryAuthorizations[${index}].uses[${useIndex}]`)
      stringMatches(use.id, `temporaryAuthorizations[${index}].uses[${useIndex}].id`, UUID)
      if (useIds.has(use.id as string)) throw new Error(`temporaryAuthorizations[${index}] duplicate use ${use.id}`)
      useIds.add(use.id as string)
      timestamp(use.at, `temporaryAuthorizations[${index}].uses[${useIndex}].at`)
      stringMatches(use.workId, `temporaryAuthorizations[${index}].uses[${useIndex}].workId`, WORK_ID)
      if (use.employeeId !== raw.employeeId) throw new Error(`temporaryAuthorizations[${index}].uses[${useIndex}] employee scope mismatch`)
      if (!Array.isArray(use.bypassed) || use.bypassed.length === 0) throw new Error(`temporaryAuthorizations[${index}].uses[${useIndex}].bypassed must be non-empty`)
      for (const bypass of use.bypassed) enumValue(bypass, `temporaryAuthorizations[${index}].uses[${useIndex}].bypassed`, ['company_budget', 'product_budget', 'employee_budget', 'approval_dependency'])
      if (use.approvalIds !== undefined) stringArray(use.approvalIds, `temporaryAuthorizations[${index}].uses[${useIndex}].approvalIds`, 1, 128, 128)
      if (use.amountMicros !== undefined) safeInteger(use.amountMicros, `temporaryAuthorizations[${index}].uses[${useIndex}].amountMicros`, 0)
      if (use.usageId !== undefined) plainString(use.usageId, `temporaryAuthorizations[${index}].uses[${useIndex}].usageId`, 1, 1024)
      if (use.unknownCost !== undefined && typeof use.unknownCost !== 'boolean') throw new Error(`temporaryAuthorizations[${index}].uses[${useIndex}].unknownCost must be boolean`)
    }
  }
}

function assertFormation(value: unknown): void {
  if (!isRecord(value)) throw new Error('formation must be an object')
  exactKeys(value, ['status', 'charter', 'firstProductId', 'draftedBy', 'lastEditedAt', 'approvedAt'], 'formation')
  enumValue(value.status, 'formation.status', ['draft', 'approved'])
  plainString(value.charter, 'formation.charter', 1, 32_768)
  if (value.firstProductId !== undefined) stringMatches(value.firstProductId, 'formation.firstProductId', PRODUCT_ID)
  enumValue(value.draftedBy, 'formation.draftedBy', ['ai', 'user'])
  timestamp(value.lastEditedAt, 'formation.lastEditedAt')
  if (value.approvedAt !== undefined) timestamp(value.approvedAt, 'formation.approvedAt')
}

function assertHealth(value: unknown): void {
  if (!isRecord(value)) throw new Error('health must be an object')
  exactKeys(value, ['status', 'reason', 'detail', 'detectedAt', 'resumable'], 'health')
  enumValue(value.status, 'health.status', ['healthy', 'degraded', 'manual_pause', 'halted'])
  if (value.reason !== undefined) enumValue(value.reason, 'health.reason', ['network', 'quota', 'rate_limit', 'money_budget', 'unpriced_model', 'session_unrecoverable', 'provider', 'unknown', 'manual', 'financial_migration', 'needs_budget_review'])
  if (value.detail !== undefined) plainString(value.detail, 'health.detail', 1, 4096)
  if (value.detectedAt !== undefined) timestamp(value.detectedAt, 'health.detectedAt')
  if (typeof value.resumable !== 'boolean') throw new Error('health.resumable must be boolean')
}

function assertOrganization(units: unknown, positions: unknown): void {
  if (!Array.isArray(units) || !Array.isArray(positions)) throw new Error('orgUnits and positions must be arrays')
  const unitIds = new Set<string>()
  for (const [index, unit] of units.entries()) {
    if (!isRecord(unit)) throw new Error(`orgUnits[${index}] must be an object`)
    exactKeys(unit, ['id', 'name', 'kind', 'parentId', 'description', 'managerEmployeeId', 'createdAt'], `orgUnits[${index}]`)
    plainString(unit.id, `orgUnits[${index}].id`, 1, 128)
    if (unitIds.has(unit.id as string)) throw new Error(`duplicate org unit ${unit.id}`)
    unitIds.add(unit.id as string)
    plainString(unit.name, `orgUnits[${index}].name`, 1, 200)
    enumValue(unit.kind, `orgUnits[${index}].kind`, ['company', 'division', 'department', 'team'])
    if (unit.parentId !== undefined) plainString(unit.parentId, `orgUnits[${index}].parentId`, 1, 128)
    if (unit.description !== undefined) plainString(unit.description, `orgUnits[${index}].description`, 1, 4096)
    if (unit.managerEmployeeId !== undefined) plainString(unit.managerEmployeeId, `orgUnits[${index}].managerEmployeeId`, 1, 128)
    timestamp(unit.createdAt, `orgUnits[${index}].createdAt`)
  }
  const typedUnits = units as Array<Record<string, unknown>>
  for (const unit of typedUnits) if (unit.parentId !== undefined && !unitIds.has(unit.parentId as string)) throw new Error(`org unit ${unit.id} has unknown parent`)
  if (typedUnits.filter((unit) => unit.parentId === undefined).length !== 1) throw new Error('organization must have exactly one root unit')
  const parentByUnit = new Map(typedUnits.map((unit) => [unit.id as string, unit.parentId as string | undefined]))
  for (const id of unitIds) {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`organization cycle includes ${current}`)
      seen.add(current)
      current = parentByUnit.get(current)
    }
  }
  const positionIds = new Set<string>()
  for (const [index, position] of positions.entries()) {
    if (!isRecord(position)) throw new Error(`positions[${index}] must be an object`)
    exactKeys(position, ['id', 'title', 'orgUnitId', 'reportsToPositionId', 'responsibilities', 'createdAt'], `positions[${index}]`)
    plainString(position.id, `positions[${index}].id`, 1, 128)
    if (positionIds.has(position.id as string)) throw new Error(`duplicate position ${position.id}`)
    positionIds.add(position.id as string)
    plainString(position.title, `positions[${index}].title`, 1, 500)
    if (!unitIds.has(position.orgUnitId as string)) throw new Error(`position ${position.id} has unknown org unit`)
    if (position.reportsToPositionId !== undefined) plainString(position.reportsToPositionId, `positions[${index}].reportsToPositionId`, 1, 128)
    stringArray(position.responsibilities, `positions[${index}].responsibilities`, 0, 128, 4096)
    timestamp(position.createdAt, `positions[${index}].createdAt`)
  }
  const typedPositions = positions as Array<Record<string, unknown>>
  const reportsByPosition = new Map(typedPositions.map((position) => [position.id as string, position.reportsToPositionId as string | undefined]))
  for (const position of typedPositions) {
    if (position.reportsToPositionId !== undefined && !positionIds.has(position.reportsToPositionId as string)) throw new Error(`position ${position.id} reports to an unknown position`)
  }
  for (const id of positionIds) {
    const seen = new Set<string>()
    let current: string | undefined = id
    while (current !== undefined) {
      if (seen.has(current)) throw new Error(`position reporting cycle includes ${current}`)
      seen.add(current)
      current = reportsByPosition.get(current)
    }
  }
}

function assertStaffingRequests(value: unknown): void {
  if (!Array.isArray(value)) throw new Error('staffingRequests must be an array')
  for (const [index, request] of value.entries()) {
    if (!isRecord(request)) throw new Error(`staffingRequests[${index}] must be an object`)
    exactKeys(request, ['id', 'action', 'status', 'requestedBy', 'candidateName', 'employeeId', 'workProfile', 'constraints', 'hrEmployeeId', 'attemptId', 'reviewDeliveryAttempts', 'recommendation', 'approvalId', 'lastDeliveredAt', 'reservationId', 'leaseAt', 'createdAt', 'updatedAt'], `staffingRequests[${index}]`)
    plainString(request.id, `staffingRequests[${index}].id`, 1, 128)
    enumValue(request.action, `staffingRequests[${index}].action`, ['hire', 'adjust', 'retire'])
    enumValue(request.status, `staffingRequests[${index}].status`, ['pending', 'in_review', 'recommended', 'approved', 'rejected', 'applied'])
    for (const key of ['requestedBy', 'workProfile', 'hrEmployeeId'] as const) plainString(request[key], `staffingRequests[${index}].${key}`, 1, 16_384)
    for (const key of ['candidateName', 'employeeId', 'constraints', 'attemptId', 'approvalId', 'reservationId'] as const) if (request[key] !== undefined) plainString(request[key], `staffingRequests[${index}].${key}`, 1, 4096)
    if (request.recommendation !== undefined) assertStaffingRecommendation(request.recommendation, `staffingRequests[${index}].recommendation`)
    if (request.action === 'hire' && request.candidateName === undefined) throw new Error(`staffingRequests[${index}] hire requires candidateName`)
    if (request.action !== 'hire' && request.employeeId === undefined) throw new Error(`staffingRequests[${index}] ${String(request.action)} requires employeeId`)
    if ((request.status === 'in_review') !== (request.attemptId !== undefined)) throw new Error(`staffingRequests[${index}] in_review status and attemptId must agree`)
    if (request.reviewDeliveryAttempts !== undefined) safeInteger(request.reviewDeliveryAttempts, `staffingRequests[${index}].reviewDeliveryAttempts`, 0, 3)
    if (['recommended', 'approved', 'rejected', 'applied'].includes(String(request.status)) && (request.recommendation === undefined || request.approvalId === undefined)) {
      throw new Error(`staffingRequests[${index}] ${String(request.status)} requires recommendation and approvalId`)
    }
    if (request.lastDeliveredAt !== undefined) timestamp(request.lastDeliveredAt, `staffingRequests[${index}].lastDeliveredAt`)
    if (request.leaseAt !== undefined) timestamp(request.leaseAt, `staffingRequests[${index}].leaseAt`)
    if ((request.reservationId === undefined) !== (request.leaseAt === undefined)) throw new Error(`staffingRequests[${index}] reservationId and leaseAt must agree`)
    timestamp(request.createdAt, `staffingRequests[${index}].createdAt`)
    timestamp(request.updatedAt, `staffingRequests[${index}].updatedAt`)
  }
}

function assertStaffingRecommendation(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  exactKeys(value, ['difficulty', 'provider', 'model', 'reasoningEffort', 'budgetMicros', 'rationale', 'orgPath', 'positionTitle', 'responsibilities', 'designateAsHr', 'assessedAt'], path)
  enumValue(value.difficulty, `${path}.difficulty`, ['low', 'medium', 'high', 'critical'])
  for (const key of ['provider', 'model', 'rationale', 'positionTitle'] as const) plainString(value[key], `${path}.${key}`, 1, 16_384)
  if (value.reasoningEffort !== undefined) plainString(value.reasoningEffort, `${path}.reasoningEffort`, 1, 128)
  if (value.budgetMicros !== undefined) safeInteger(value.budgetMicros, `${path}.budgetMicros`, 0)
  stringArray(value.orgPath, `${path}.orgPath`, 1, 16, 200)
  stringArray(value.responsibilities, `${path}.responsibilities`, 1, 128, 4096)
  if (value.designateAsHr !== undefined && typeof value.designateAsHr !== 'boolean') throw new Error(`${path}.designateAsHr must be boolean`)
  timestamp(value.assessedAt, `${path}.assessedAt`)
}

function assertOperationalBlock(value: unknown, path: string): void {
  if (!isRecord(value)) throw new Error(`${path} must be an object`)
  exactKeys(value, ['kind', 'code', 'message', 'at'], path)
  enumValue(value.kind, `${path}.kind`, ['network', 'quota', 'rate_limit', 'money_budget', 'unpriced_model', 'session_unrecoverable', 'provider', 'unknown'])
  plainString(value.code, `${path}.code`, 1, 128)
  plainString(value.message, `${path}.message`, 1, 4096)
  timestamp(value.at, `${path}.at`)
}

function assertWork(raw: unknown, index: number, employees: Set<string>, products: Set<string>, workIds: Set<string>, approvals: Set<string>, maxAttempts: number, orgUnits?: Set<string>): void {
  if (!isRecord(raw)) throw new Error(`workItems[${index}] must be an object`)
  exactKeys(raw, [
    'id', 'productId', 'kind', 'subject', 'objective', 'status', 'assigneeId', 'eligibleEmployeeIds',
    'dependencies', 'approvalDependencies', 'inScope', 'outOfScope', 'acceptance', 'verify', 'deliverables',
    'reviewedWorkId', 'ticketId', 'eligibleOrgUnitIds', 'attempt', 'attemptId', 'handoffId', 'reassigning', 'reservationId', 'leaseAt', 'deliveryAttempts',
    'output', 'verdict', 'findings', 'evidence', 'attemptHistory', 'createdAt', 'updatedAt',
  ], `workItems[${index}]`)
  if (!products.has(String(raw.productId))) throw new Error(`workItems[${index}] references unknown product`)
  enumValue(raw.kind, `workItems[${index}].kind`, ['discovery', 'design', 'implementation', 'verification', 'review', 'repair', 'integration', 'release', 'operations'])
  enumValue(raw.status, `workItems[${index}].status`, ['pending', 'claimed', 'in_progress', 'completed', 'failed', 'cancelled'])
  plainString(raw.subject, `workItems[${index}].subject`, 1, 500)
  plainString(raw.objective, `workItems[${index}].objective`, 1, 32_768)
  for (const key of ['dependencies', 'inScope', 'outOfScope', 'acceptance', 'verify', 'deliverables'] as const) stringArray(raw[key], `workItems[${index}].${key}`, 0, 512, 16_384)
  if (raw.approvalDependencies !== undefined) {
    stringArray(raw.approvalDependencies, `workItems[${index}].approvalDependencies`, 0, 128, 256)
    for (const id of raw.approvalDependencies as string[]) if (!approvals.has(id)) throw new Error(`workItems[${index}] references unknown approval ${id}`)
  }
  for (const id of raw.dependencies as string[]) {
    if (!workIds.has(id)) throw new Error(`workItems[${index}] references unknown dependency ${id}`)
    if (id === raw.id) throw new Error(`workItems[${index}] depends on itself`)
  }
  if (raw.assigneeId !== undefined && raw.assigneeId !== 'founder') {
    plainString(raw.assigneeId, `workItems[${index}].assigneeId`, 1, 256)
    if (!employees.has(raw.assigneeId)) throw new Error(`workItems[${index}] has unknown assignee`)
  }
  if (raw.eligibleEmployeeIds !== undefined) {
    stringArray(raw.eligibleEmployeeIds, `workItems[${index}].eligibleEmployeeIds`, 0, 128, 256)
    for (const id of raw.eligibleEmployeeIds as string[]) if (!employees.has(id)) throw new Error(`workItems[${index}] has unknown eligible employee ${id}`)
  }
  if (raw.ticketId !== undefined) stringMatches(raw.ticketId, `workItems[${index}].ticketId`, TICKET_ID)
  if (raw.eligibleOrgUnitIds !== undefined) {
    if (!Array.isArray(raw.eligibleOrgUnitIds)) throw new Error(`workItems[${index}].eligibleOrgUnitIds must be an array`)
    for (const [ui, uid] of raw.eligibleOrgUnitIds.entries()) {
      stringMatches(String(uid), `workItems[${index}].eligibleOrgUnitIds[${ui}]`, /^ou[1-9][0-9]*$/)
      if (orgUnits !== undefined && !orgUnits.has(String(uid))) throw new Error(`workItems[${index}] references unknown eligible org unit ${String(uid)}`)
    }
  }
  if (raw.reviewedWorkId !== undefined) {
    stringMatches(raw.reviewedWorkId, `workItems[${index}].reviewedWorkId`, WORK_ID)
    if (!workIds.has(raw.reviewedWorkId)) throw new Error(`workItems[${index}] references unknown reviewed work ${raw.reviewedWorkId}`)
    if (raw.reviewedWorkId === raw.id) throw new Error(`workItems[${index}] cannot review itself`)
  }
  safeInteger(raw.attempt, `workItems[${index}].attempt`, 0, maxAttempts)
  if (raw.attemptId !== undefined) stringMatches(raw.attemptId, `workItems[${index}].attemptId`, UUID)
  if (raw.handoffId !== undefined) stringMatches(raw.handoffId, `workItems[${index}].handoffId`, UUID)
  if (raw.reassigning !== undefined && typeof raw.reassigning !== 'boolean') throw new Error(`workItems[${index}].reassigning must be boolean`)
  if (raw.reservationId !== undefined) stringMatches(raw.reservationId, `workItems[${index}].reservationId`, UUID)
  if (raw.leaseAt !== undefined) timestamp(raw.leaseAt, `workItems[${index}].leaseAt`)
  if (raw.deliveryAttempts !== undefined) safeInteger(raw.deliveryAttempts, `workItems[${index}].deliveryAttempts`, 0, 3)
  const open = raw.status === 'claimed' || raw.status === 'in_progress'
  const terminal = raw.status === 'completed' || raw.status === 'failed' || raw.status === 'cancelled'
  if (open && (raw.attemptId === undefined || raw.assigneeId === undefined)) {
    throw new Error(`open work item ${raw.id} requires assigneeId and attemptId`)
  }
  if (!open && raw.attemptId !== undefined) throw new Error(`non-open work item ${raw.id} must not retain attemptId`)
  if ((raw.reservationId === undefined) !== (raw.leaseAt === undefined)) throw new Error(`work item ${raw.id} reservationId and leaseAt must agree`)
  if (!open && raw.reservationId !== undefined) throw new Error(`non-open work item ${raw.id} must not retain a prepared reservation`)
  if (raw.reassigning === true && (raw.status !== 'pending' || raw.handoffId === undefined)) throw new Error(`reassigning work item ${raw.id} requires a pending handoff`)
  if (raw.reassigning !== true && raw.handoffId !== undefined) throw new Error(`work item ${raw.id} retains a handoffId outside reassignment`)
  if (raw.output !== undefined) plainString(raw.output, `workItems[${index}].output`, 1, 1_048_576)
  if (terminal && raw.output === undefined) throw new Error(`terminal work item ${raw.id} requires output`)
  if (raw.verdict !== undefined) enumValue(raw.verdict, `workItems[${index}].verdict`, ['pass', 'needs_revision', 'reject'])
  if (raw.findings !== undefined) {
    if (!Array.isArray(raw.findings)) throw new Error(`workItems[${index}].findings must be an array`)
    for (const [findingIndex, finding] of raw.findings.entries()) {
      if (!isRecord(finding)) throw new Error(`workItems[${index}].findings[${findingIndex}] must be an object`)
      exactKeys(finding, ['id', 'severity', 'file', 'line', 'problem', 'requiredFix'], `workItems[${index}].findings[${findingIndex}]`)
      plainString(finding.id, `workItems[${index}].findings[${findingIndex}].id`, 1, 128)
      enumValue(finding.severity, `workItems[${index}].findings[${findingIndex}].severity`, ['low', 'medium', 'high', 'blocker'])
      if (finding.file !== undefined) plainString(finding.file, `workItems[${index}].findings[${findingIndex}].file`, 1, 4096)
      if (finding.line !== undefined) safeInteger(finding.line, `workItems[${index}].findings[${findingIndex}].line`, 1)
      plainString(finding.problem, `workItems[${index}].findings[${findingIndex}].problem`, 1, 16_384)
      plainString(finding.requiredFix, `workItems[${index}].findings[${findingIndex}].requiredFix`, 1, 16_384)
    }
  }
  if (raw.evidence !== undefined) {
    if (!isRecord(raw.evidence)) throw new Error(`workItems[${index}].evidence must be an object`)
    exactKeys(raw.evidence, ['changedPaths', 'acceptanceResults', 'commandsRun'], `workItems[${index}].evidence`)
    for (const key of ['changedPaths', 'acceptanceResults', 'commandsRun'] as const) {
      if (raw.evidence[key] !== undefined) stringArray(raw.evidence[key], `workItems[${index}].evidence.${key}`, 0, 512, 16_384)
    }
  }
  if (!Array.isArray(raw.attemptHistory) || raw.attemptHistory.length > maxAttempts) throw new Error(`workItems[${index}].attemptHistory is invalid`)
  for (const [historyIndex, history] of raw.attemptHistory.entries()) {
    if (!isRecord(history)) throw new Error(`workItems[${index}].attemptHistory[${historyIndex}] must be an object`)
    exactKeys(history, ['attempt', 'assigneeId', 'status', 'output', 'closedAt'], `workItems[${index}].attemptHistory[${historyIndex}]`)
    safeInteger(history.attempt, `workItems[${index}].attemptHistory[${historyIndex}].attempt`, 1, maxAttempts)
    if (history.assigneeId !== undefined && history.assigneeId !== 'founder' && !employees.has(String(history.assigneeId))) throw new Error(`workItems[${index}].attemptHistory[${historyIndex}] has unknown assignee`)
    enumValue(history.status, `workItems[${index}].attemptHistory[${historyIndex}].status`, ['failed', 'cancelled'])
    if (history.output !== undefined) plainString(history.output, `workItems[${index}].attemptHistory[${historyIndex}].output`, 1, 1_048_576)
    timestamp(history.closedAt, `workItems[${index}].attemptHistory[${historyIndex}].closedAt`)
  }
  timestamp(raw.createdAt, `workItems[${index}].createdAt`)
  timestamp(raw.updatedAt, `workItems[${index}].updatedAt`)
}

export function assertAcyclic(workItems: readonly Pick<WorkItem, 'id' | 'dependencies'>[]): void {
  const graph = new Map(workItems.map((item) => [item.id, item.dependencies]))
  const visiting = new Set<string>()
  const visited = new Set<string>()
  const visit = (id: string): void => {
    if (visited.has(id)) return
    if (visiting.has(id)) throw new Error(`work dependency cycle includes ${id}`)
    visiting.add(id)
    for (const dependency of graph.get(id) ?? []) visit(dependency)
    visiting.delete(id)
    visited.add(id)
  }
  for (const id of graph.keys()) visit(id)
}

export function validateApprovalPayload(kind: ApprovalKind, payload: unknown): asserts payload is JsonValue {
  assertJsonValue(payload, `${kind} approval payload`)
  if (!isRecord(payload)) throw new Error(`${kind} approval payload must be an object`)
  rejectDangerousKeys(payload, `${kind} approval payload`)
  switch (kind) {
    case 'bootstrap':
      exactKeys(payload, ['companyId', 'stagedRevision'], 'bootstrap approval payload')
      plainString(payload.companyId, 'bootstrap.companyId', 1, 128)
      safeInteger(payload.stagedRevision, 'bootstrap.stagedRevision', 1)
      break
    case 'budget_change':
      exactKeys(payload, ['newTotalMicros', 'expectedTotalMicros', 'productAllocations', 'employeeAllocations', 'legacyTreatment'], 'budget_change approval payload')
      safeInteger(payload.newTotalMicros, 'budget_change.newTotalMicros', 0)
      safeInteger(payload.expectedTotalMicros, 'budget_change.expectedTotalMicros', 0)
      for (const field of ['productAllocations', 'employeeAllocations'] as const) {
        if (payload[field] === undefined) continue
        if (!Array.isArray(payload[field])) throw new Error(`budget_change.${field} must be an array`)
        for (const [index, allocation] of payload[field].entries()) {
          if (!isRecord(allocation)) throw new Error(`budget_change.${field}[${index}] must be an object`)
          exactKeys(allocation, field === 'employeeAllocations' ? ['id', 'budgetMicros', 'expectedBudgetMicros'] : ['id', 'budgetMicros'], `budget_change.${field}[${index}]`)
          plainString(allocation.id, `budget_change.${field}[${index}].id`, 1, 128)
          safeInteger(allocation.budgetMicros, `budget_change.${field}[${index}].budgetMicros`, 0)
          if (allocation.expectedBudgetMicros !== undefined) safeInteger(allocation.expectedBudgetMicros, `budget_change.${field}[${index}].expectedBudgetMicros`, 0)
        }
      }
      if (payload.legacyTreatment !== undefined) enumValue(payload.legacyTreatment, 'budget_change.legacyTreatment', ['accepted'])
      break
    case 'pricing_change':
      exactKeys(payload, ['currency', 'expectedCurrency', 'expectedPricingRevision', 'expectedDigest', 'prices'], 'pricing_change approval payload')
      normalizeCurrency(String(payload.currency))
      normalizeCurrency(String(payload.expectedCurrency))
      safeInteger(payload.expectedPricingRevision, 'pricing_change.expectedPricingRevision', 1)
      plainString(payload.expectedDigest, 'pricing_change.expectedDigest', 1, 128)
      if (!Array.isArray(payload.prices)) throw new Error('pricing_change.prices must be an array')
      normalizeModelPrices(payload.prices as unknown as ModelPriceInput[], 'manual', 1, 0)
      break
    case 'governance_change':
      exactKeys(payload, ['expectedGovernanceRevision', 'slogan', 'mission', 'charter', 'maxEmployees'], 'governance_change approval payload')
      safeInteger(payload.expectedGovernanceRevision, 'governance_change.expectedGovernanceRevision', 1)
      if (payload.slogan !== undefined) plainString(payload.slogan, 'governance_change.slogan', 1, 160)
      if (payload.mission !== undefined) plainString(payload.mission, 'governance_change.mission', 1, 16_384)
      if (payload.charter !== undefined) plainString(payload.charter, 'governance_change.charter', 1, 32_768)
      if (payload.maxEmployees !== undefined) normalizeEmployeeLimit(payload.maxEmployees, 'governance_change.maxEmployees')
      if (payload.slogan === undefined && payload.mission === undefined && payload.charter === undefined && payload.maxEmployees === undefined) throw new Error('governance_change must change slogan, mission, charter, or maxEmployees')
      break
    case 'temporary_authorization':
      exactKeys(payload, ['action', 'authorizationId', 'employeeId', 'reason', 'startsAt', 'expiresAt'], 'temporary_authorization approval payload')
      enumValue(payload.action, 'temporary_authorization.action', ['grant', 'revoke'])
      if (payload.authorizationId !== undefined) plainString(payload.authorizationId, 'temporary_authorization.authorizationId', 1, 128)
      if (payload.employeeId !== undefined) plainString(payload.employeeId, 'temporary_authorization.employeeId', 1, 128)
      plainString(payload.reason, 'temporary_authorization.reason', 1, 4096)
      if (payload.startsAt !== undefined) timestamp(payload.startsAt, 'temporary_authorization.startsAt')
      if (payload.expiresAt !== undefined) timestamp(payload.expiresAt, 'temporary_authorization.expiresAt')
      if (payload.action === 'grant') {
        if (payload.authorizationId !== undefined) throw new Error('temporary_authorization grant must not name an existing authorization')
        if (payload.employeeId === undefined || payload.expiresAt === undefined) throw new Error('temporary_authorization grant requires employeeId and expiresAt')
        if (payload.startsAt !== undefined && (payload.expiresAt as number) <= (payload.startsAt as number)) throw new Error('temporary_authorization expiry must be after start')
      } else {
        if (payload.authorizationId === undefined) throw new Error('temporary_authorization revoke requires authorizationId')
        for (const key of ['employeeId', 'startsAt', 'expiresAt'] as const) if (payload[key] !== undefined) throw new Error(`temporary_authorization revoke must not include ${key}`)
      }
      break
    case 'organization_change':
      exactKeys(payload, ['action', 'employeeId', 'name', 'role', 'staffingRequestId', 'budgetMicros', 'designateAsHr'], 'organization_change approval payload')
      enumValue(payload.action, 'organization_change.action', ['add', 'remove', 'hire', 'adjust', 'retire'])
      if (payload.staffingRequestId !== undefined) plainString(payload.staffingRequestId, 'organization_change.staffingRequestId', 1, 128)
      if (payload.employeeId !== undefined) plainString(payload.employeeId, 'organization_change.employeeId', 1, 128)
      if (payload.name !== undefined) plainString(payload.name, 'organization_change.name', 1, 200)
      if (payload.role !== undefined) plainString(payload.role, 'organization_change.role', 1, 1000)
      if (payload.budgetMicros !== undefined) safeInteger(payload.budgetMicros, 'organization_change.budgetMicros', 0)
      if (payload.designateAsHr !== undefined && typeof payload.designateAsHr !== 'boolean') throw new Error('organization_change.designateAsHr must be boolean')
      break
    case 'product_scope':
      exactKeys(payload, ['action', 'productId', 'name', 'productRoot', 'budgetMicros'], 'product_scope approval payload')
      enumValue(payload.action, 'product_scope.action', ['create', 'update', 'activate', 'cancel'])
      if (payload.productId !== undefined) plainString(payload.productId, 'product_scope.productId', 1, 128)
      if (payload.name !== undefined) plainString(payload.name, 'product_scope.name', 1, 200)
      if (payload.productRoot !== undefined) plainString(payload.productRoot, 'product_scope.productRoot', 1, 4096)
      if (payload.budgetMicros !== undefined) safeInteger(payload.budgetMicros, 'product_scope.budgetMicros', 0)
      break
    case 'model_route':
      exactKeys(payload, ['employeeId', 'provider', 'model', 'reasoningEffort'], 'model_route approval payload')
      plainString(payload.employeeId, 'model_route.employeeId', 1, 128)
      plainString(payload.provider, 'model_route.provider', 1, 128)
      plainString(payload.model, 'model_route.model', 1, 256)
      if (payload.reasoningEffort !== undefined) plainString(payload.reasoningEffort, 'model_route.reasoningEffort', 1, 128)
      break
    case 'release':
      exactKeys(payload, ['productId'], 'release approval payload')
      plainString(payload.productId, 'release.productId', 1, 128)
      break
    case 'external_effect':
      exactKeys(payload, ['description', 'target', 'controls'], 'external_effect approval payload')
      plainString(payload.description, 'external_effect.description', 1, 4096)
      if (payload.target !== undefined) plainString(payload.target, 'external_effect.target', 1, 1024)
      if (payload.controls !== undefined) stringArray(payload.controls, 'external_effect.controls', 1, 32, 1024)
      break
    case 'forced_archive':
      exactKeys(payload, ['reason'], 'forced_archive approval payload')
      plainString(payload.reason, 'forced_archive.reason', 1, 4096)
      break
  }
}

export function assertCompanyMessage(value: unknown): asserts value is CompanyMessage {
  if (!isRecord(value)) throw new Error('mailbox record must be an object')
  exactKeys(value, ['id', 'from', 'to', 'content', 'createdAt', 'deliveryState', 'attempts', 'reservationId', 'leaseAt', 'acceptedAt'], 'mailbox record')
  stringMatches(value.id, 'message.id', UUID)
  plainString(value.from, 'message.from', 1, 128)
  plainString(value.to, 'message.to', 1, 128)
  plainString(value.content, 'message.content', 1, 131_072)
  timestamp(value.createdAt, 'message.createdAt')
  enumValue(value.deliveryState, 'message.deliveryState', ['queued', 'reserved', 'accepted', 'held_budget', 'dead'])
  if (value.attempts !== undefined) safeInteger(value.attempts, 'message.attempts', 0, 3)
  if (value.reservationId !== undefined) stringMatches(value.reservationId, 'message.reservationId', UUID)
  if (value.leaseAt !== undefined) timestamp(value.leaseAt, 'message.leaseAt')
  if (value.acceptedAt !== undefined) timestamp(value.acceptedAt, 'message.acceptedAt')
}

function rejectDangerousKeys(value: JsonValue, path: string, allowed?: ReadonlySet<string>): void {
  if (Array.isArray(value)) {
    value.forEach((child, index) => rejectDangerousKeys(child, `${path}[${index}]`, allowed))
    return
  }
  if (!isRecord(value)) return
  for (const [key, child] of Object.entries(value)) {
    if (!allowed?.has(key) && /(?:api.?key|secret|credential|password|token|command|shell|private.?key)/i.test(key)) {
      throw new Error(`${path} contains forbidden key ${JSON.stringify(key)}`)
    }
    rejectDangerousKeys(child as JsonValue, `${path}.${key}`, allowed)
  }
}

export function assertJsonValue(value: unknown, path = 'value'): asserts value is JsonValue {
  const seen = new Set<object>()
  const visit = (candidate: unknown, current: string, depth: number): void => {
    if (depth > 64) throw new Error(`${current} exceeds the maximum JSON nesting depth`)
    if (candidate === null || typeof candidate === 'string' || typeof candidate === 'boolean') return
    if (typeof candidate === 'number') {
      if (!Number.isFinite(candidate) || Object.is(candidate, -0)) throw new Error(`${current} is not a lossless JSON number`)
      return
    }
    if (typeof candidate !== 'object') throw new Error(`${current} is not JSON-serializable`)
    if (seen.has(candidate)) throw new Error(`${current} contains a cycle`)
    seen.add(candidate)
    if (Array.isArray(candidate)) {
      if (Object.keys(candidate).length !== candidate.length) throw new Error(`${current} is a sparse array`)
      candidate.forEach((item, index) => visit(item, `${current}[${index}]`, depth + 1))
    } else {
      const prototype = Object.getPrototypeOf(candidate)
      if (prototype !== Object.prototype && prototype !== null) throw new Error(`${current} must be a plain object`)
      for (const [key, child] of Object.entries(candidate)) visit(child, `${current}.${key}`, depth + 1)
    }
    seen.delete(candidate)
  }
  visit(value, path, 0)
}

function uniqueIds(items: unknown[], pattern: RegExp, label: string): Set<string> {
  const result = new Set<string>()
  for (const [index, raw] of items.entries()) {
    if (!isRecord(raw)) throw new Error(`${label}s[${index}] must be an object`)
    stringMatches(raw.id, `${label}s[${index}].id`, pattern)
    if (result.has(raw.id as string)) throw new Error(`duplicate ${label} id ${String(raw.id)}`)
    result.add(raw.id as string)
  }
  return result
}

function exactKeys(value: Record<string, unknown>, allowed: readonly string[], label: string): void {
  const set = new Set(allowed)
  const unknown = Object.keys(value).filter((key) => !set.has(key))
  if (unknown.length > 0) throw new Error(`${label} contains unknown field(s): ${unknown.join(', ')}`)
}

function enumValue(value: unknown, label: string, allowed: readonly string[]): asserts value is string {
  if (typeof value !== 'string' || !allowed.includes(value)) throw new Error(`${label} must be one of ${allowed.join(', ')}`)
}

function stringArray(value: unknown, label: string, min: number, maxItems: number, maxChars: number): asserts value is string[] {
  if (!Array.isArray(value) || value.length < min || value.length > maxItems) throw new Error(`${label} must contain ${min}..${maxItems} strings`)
  const seen = new Set<string>()
  for (const [index, item] of value.entries()) {
    plainString(item, `${label}[${index}]`, 1, maxChars)
    if (seen.has(item as string)) throw new Error(`${label} contains duplicate ${JSON.stringify(item)}`)
    seen.add(item as string)
  }
}

function stringMatches(value: unknown, label: string, pattern: RegExp): asserts value is string {
  if (typeof value !== 'string' || !pattern.test(value)) throw new Error(`${label} has an invalid format`)
}

function plainString(value: unknown, label: string, min: number, max: number): asserts value is string {
  if (typeof value !== 'string' || value.length < min || value.length > max) throw new Error(`${label} must be a string of ${min}..${max} characters`)
  if (value.includes('\0')) throw new Error(`${label} must not contain NUL`)
}

function nonEmpty(value: unknown, label: string, max: number): string {
  if (typeof value !== 'string') throw new Error(`${label} must be a string`)
  const trimmed = value.trim()
  plainString(trimmed, label, 1, max)
  return trimmed
}

function timestamp(value: unknown, label: string): asserts value is number {
  safeInteger(value, label, 0)
}

function safeInteger(value: unknown, label: string, min: number, max = Number.MAX_SAFE_INTEGER): asserts value is number {
  if (!Number.isSafeInteger(value) || (value as number) < min || (value as number) > max) throw new Error(`${label} must be a safe integer in ${min}..${max}`)
}

function checkedAdd(left: number, right: number, label: string): number {
  const value = left + right
  if (!Number.isSafeInteger(value)) throw new Error(`${label} arithmetic overflow`)
  return value
}

function recomputeThreeRateCost(
  usage: { inputTokens: number; outputTokens: number; cacheReadTokens: number; cacheWriteTokens: number; reasoningTokens: number },
  rates: MoneyRateSnapshot,
): { costMicros: number } {
  const numerator = BigInt(usage.inputTokens + usage.cacheWriteTokens) * BigInt(rates.inputCacheMissMicrosPerMillion)
    + BigInt(usage.cacheReadTokens) * BigInt(rates.inputCacheHitMicrosPerMillion)
    + BigInt(usage.outputTokens) * BigInt(rates.outputMicrosPerMillion)
  const rounded = (numerator + 500_000n) / 1_000_000n
  if (rounded > BigInt(Number.MAX_SAFE_INTEGER)) throw new Error('money usage cost arithmetic overflow')
  return { costMicros: Number(rounded) }
}

function boundedInteger(value: unknown, label: string, min: number, max: number): number {
  safeInteger(value, label, min, max)
  return value
}

function boundedNumber(value: unknown, label: string, min: number, max: number): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < min || value > max) throw new Error(`${label} must be a finite number in ${min}..${max}`)
  return value
}

export function isRecord(value: unknown): value is Record<string, unknown> {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
}
