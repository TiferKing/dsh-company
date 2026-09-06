import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-agent'
import { SessionId } from '@deepseek-ai/dsh-session'
import { availableMoney, matchModelPrice, productMoneyTotals, productTokenTotals } from './money.js'
import { parseCharterClauses } from './charter.js'
import { temporaryAuthorizationStatus } from './authorizations.js'
import { COMPANY_SNAPSHOT_SCHEMA_VERSION, EMPLOYEE_STATUSES } from './types.js'
import type {
  CompanyActor,
  CompanyMessage,
  CompanySnapshot,
  CompanyState,
  DepartmentLoadView,
  MoneyUsageEntry,
  ProviderModelMoneyAggregate,
  SafeApprovalView,
  SafeEmployeeView,
  SafeMessageView,
  SafeProductView,
  SafeTicketView,
  SafeWorkView,
  SnapshotQuery,
  SnapshotPage,
} from './types.js'
import { workBlockedReasons } from './work.js'
import { getCompanyExecution } from './execution.js'

const FOUNDER_PERMISSIONS = [
  'bootstrap.approve', 'employee.manage', 'product.manage', 'work.plan', 'work.reassign',
  'approval.resolve', 'company.pause', 'company.resume', 'company.archive', 'money-budget.view-ledger',
  'money-pricing.manage', 'models.reprobe', 'governance.request-change', 'authorization.manage',
  'organization.view-tree', 'staffing.manage',
]
const EMPLOYEE_PERMISSIONS = ['work.claim-self', 'work.update-self', 'message.send', 'approval.request', 'company.status-filtered']
const DETAIL_LIMIT = 200
const HISTORY_LIMIT = 100
const WORK_DETAIL_LIMIT = 32
const INBOX_LIMIT = 100
const MODEL_CATALOG_LIMIT = 1_000
export const DIRECTORY_PAGE_LIMIT = 100

export function normalizeSnapshotQuery(query: SnapshotQuery = {}): SnapshotQuery {
  const normalized: SnapshotQuery = {}
  for (const key of ['employeeOffset', 'orgOffset', 'positionOffset', 'employeeLimit', 'orgLimit', 'positionLimit'] as const) {
    const value = query[key]
    if (value === undefined) continue
    if (!Number.isSafeInteger(value) || value < (key.endsWith('Limit') ? 1 : 0) || (key.endsWith('Limit') && value > DIRECTORY_PAGE_LIMIT)) throw new Error(`invalid snapshot ${key}`)
    normalized[key] = value
  }
  for (const key of ['employeeSearch', 'employeeId', 'employeeOrgUnitId', 'employeePositionId', 'orgId', 'positionId'] as const) {
    const value = query[key]
    if (value === undefined || value === '') continue
    if (typeof value !== 'string' || value.length > 256) throw new Error(`invalid snapshot ${key}`)
    if (value.trim() !== '') normalized[key] = value.trim()
  }
  if (query.employeeStatus !== undefined) {
    if (!['all', 'active', 'retired', 'running'].includes(query.employeeStatus)) throw new Error('invalid snapshot employeeStatus')
    normalized.employeeStatus = query.employeeStatus
  }
  if (query.employeeExactStatus !== undefined) {
    if (!EMPLOYEE_STATUSES.includes(query.employeeExactStatus)) throw new Error('invalid snapshot employeeExactStatus')
    normalized.employeeExactStatus = query.employeeExactStatus
  }
  return normalized
}

function pageRows<T>(rows: readonly T[], offset = 0, limit = 50, total = rows.length): { rows: T[]; page: SnapshotPage } {
  const start = rows.length === 0 ? 0 : offset >= rows.length ? Math.floor((rows.length - 1) / limit) * limit : offset
  const items = rows.slice(start, start + limit)
  return { rows: items, page: { total, filtered_total: rows.length, offset: start, limit, returned: items.length, next_offset: start + items.length < rows.length ? start + items.length : null } }
}

/** Build the canonical schema-v5 snake_case Host/Web projection. */
export function buildSnapshot(
  ctx: Context,
  state: CompanyState,
  actor: CompanyActor,
  inbox: CompanyMessage[],
  pollAfterMs?: number,
  queryInput: SnapshotQuery = {},
): CompanySnapshot {
  const query = normalizeSnapshotQuery(queryInput)
  const now = Date.now()
  const founderView = actor.kind === 'founder'
  const visibleAuthorizations = state.temporaryAuthorizations.filter((authorization) => founderView || authorization.employeeId === actor.id)
  const currentAuthorizations = visibleAuthorizations.filter((authorization) => ['active', 'scheduled'].includes(temporaryAuthorizationStatus(authorization, now)))
  const historicalAuthorizations = visibleAuthorizations.filter((authorization) => !['active', 'scheduled'].includes(temporaryAuthorizationStatus(authorization, now))).slice(-HISTORY_LIMIT)
  const authorizationRows = [...currentAuthorizations, ...historicalAuthorizations]
  const liveRunning = new Set(state.employees.flatMap((employee) => {
    if (employee.sessionId === undefined) return []
    return ctx.agents.get(SessionId(employee.sessionId))?.status === 'running' ? [employee.id] : []
  }))
  const search = query.employeeSearch?.toLocaleLowerCase()
  const filteredEmployees = state.employees.filter((employee) =>
    (query.employeeStatus !== 'active' || employee.status !== 'retired')
    && (query.employeeStatus !== 'retired' || employee.status === 'retired')
    && (query.employeeStatus !== 'running' || (employee.status !== 'retired' && liveRunning.has(employee.id)))
    && (query.employeeId === undefined || employee.id === query.employeeId)
    && (query.employeeExactStatus === undefined || employee.status === query.employeeExactStatus)
    && (query.employeeOrgUnitId === undefined || employee.orgUnitId === query.employeeOrgUnitId)
    && (query.employeePositionId === undefined || employee.positionId === query.employeePositionId)
    && (search === undefined || `${employee.id} ${employee.name} ${employee.role}`.toLocaleLowerCase().includes(search)))
  const employeePage = pageRows(filteredEmployees, query.employeeOffset, query.employeeLimit, state.employees.length)
  const projectedEmployees = employeePage.rows
  const totals = new Map(state.employees.map((employee) => [employee.id, { inputTokens: 0, outputTokens: 0, cacheReadTokens: 0, cacheWriteTokens: 0, reasoningTokens: 0, totalTokens: 0, spentMicros: 0, reservedMicros: 0, availableMicros: 0, pricedCalls: 0, unpricedCalls: 0 }]))
  for (const entry of state.moneyBudget.usage) {
    const total = totals.get(entry.employeeId)
    if (total === undefined) continue
    for (const key of ['inputTokens', 'outputTokens', 'cacheReadTokens', 'cacheWriteTokens', 'reasoningTokens', 'totalTokens'] as const) total[key] += entry[key]
    total.spentMicros += entry.costMicros
    if (entry.priced) total.pricedCalls += 1
    else total.unpricedCalls += 1
  }
  for (const entry of state.moneyBudget.reservations) {
    const total = totals.get(entry.employeeId)
    if (total !== undefined) total.reservedMicros += entry.remainingMicros
  }
  for (const employee of state.employees) {
    const total = totals.get(employee.id)!
    total.availableMicros = Math.max(0, (employee.budgetMicros ?? 0) - total.spentMicros - total.reservedMicros)
  }
  const orgById = new Map(state.orgUnits.map((unit) => [unit.id, unit]))
  const employees: SafeEmployeeView[] = projectedEmployees.map((employee) => {
    const live = employee.sessionId === undefined ? undefined : ctx.agents.get(SessionId(employee.sessionId))
    // A persisted working flag can outlive its process. Only the Host can
    // establish that a turn is running; lifecycle state remains separate.
    const activity: SafeEmployeeView['activity'] = employee.status === 'retired'
      ? 'retired'
      : liveRunning.has(employee.id)
        ? 'running'
        : live?.status === 'idle' || (live === undefined && (employee.status === 'idle' || employee.status === 'paused'))
          ? 'idle'
          : 'ready'
    const showPrivate = founderView || employee.id === actor.id
    const orgUnitName = employee.orgUnitId === undefined ? undefined : orgById.get(employee.orgUnitId)?.name
    const tokenUsage = totals.get(employee.id)!
    const money = tokenUsage
    const { pricedCalls, unpricedCalls } = tokenUsage
    return {
      id: employee.id,
      name: employee.name,
      role: employee.role,
      ...(orgUnitName === undefined ? {} : { department: orgUnitName }),
      ...(employee.orgUnitId === undefined ? {} : { org_unit_id: employee.orgUnitId }),
      ...(employee.positionId === undefined ? {} : { position_id: employee.positionId }),
      ...(employee.isHr === undefined ? {} : { is_hr: employee.isHr }),
      status: employee.status,
      activity,
      ...(showPrivate && employee.sessionId !== undefined ? { session_id: employee.sessionId } : {}),
      ...(employee.joinedAt === undefined ? {} : { joined_at: employee.joinedAt }),
      ...(employee.retiredAt === undefined ? {} : { retired_at: employee.retiredAt }),
      ...(showPrivate ? {
        provider: employee.llm.activeProvider ?? employee.llm.provider,
        model: employee.llm.activeModel ?? employee.llm.model,
      } : {}),
      ...(showPrivate && employee.llm.reasoningEffort !== undefined ? { reasoning_effort: employee.llm.reasoningEffort } : {}),
      token_usage: {
        input: tokenUsage.inputTokens,
        output: tokenUsage.outputTokens,
        cache_read: tokenUsage.cacheReadTokens,
        cache_write: tokenUsage.cacheWriteTokens,
        reasoning: tokenUsage.reasoningTokens,
        total: tokenUsage.totalTokens,
        cost_micros: money.spentMicros,
        currency: state.moneyBudget.currency,
        priced_calls: pricedCalls,
        unpriced_calls: unpricedCalls,
      },
      budget_micros: employee.budgetMicros ?? 0,
      spent_micros: money.spentMicros,
      reserved_micros: money.reservedMicros,
      available_micros: money.availableMicros,
      ...(employee.operationalBlock === undefined ? {} : { operational_block: {
        ...structuredClone(employee.operationalBlock),
        message: redactDiagnostic(employee.operationalBlock.message, 4096),
      } }),
      ...(founderView && employee.failure !== undefined ? { failure: redactDiagnostic(employee.failure, 4096) } : {}),
    }
  })

  const orgPage = pageRows(state.orgUnits.filter((unit) => query.orgId === undefined || unit.id === query.orgId), query.orgOffset, query.orgLimit, state.orgUnits.length)
  const positionPage = pageRows(state.positions.filter((position) => query.positionId === undefined || position.id === query.positionId), query.positionOffset, query.positionLimit, state.positions.length)
  const projectedOrgUnits = orgPage.rows
  const projectedPositions = positionPage.rows
  const openByEmployee = new Map<string, number>()
  for (const work of state.workItems) if (work.assigneeId !== undefined && ['pending', 'claimed', 'in_progress'].includes(work.status)) openByEmployee.set(work.assigneeId, (openByEmployee.get(work.assigneeId) ?? 0) + 1)
  const positionCounts = new Map<string, number>()
  const orgCounts = new Map(state.orgUnits.map((unit) => [unit.id, { people: 0, open: 0, sum: 0, max: 0, budget: 0, spent: 0, available: 0, children: 0, positions: 0 }]))
  for (const unit of state.orgUnits) {
    const parent = unit.parentId === undefined ? undefined : orgCounts.get(unit.parentId)
    if (parent !== undefined) parent.children += 1
  }
  for (const position of state.positions) orgCounts.get(position.orgUnitId)!.positions += 1
  for (const employee of state.employees) {
    if (employee.status === 'retired') continue
    if (employee.positionId !== undefined) positionCounts.set(employee.positionId, (positionCounts.get(employee.positionId) ?? 0) + 1)
    const money = totals.get(employee.id)!
    const open = openByEmployee.get(employee.id) ?? 0
    const effective = Math.max(open, liveRunning.has(employee.id) ? 1 : 0)
    let unit = employee.orgUnitId === undefined ? undefined : orgById.get(employee.orgUnitId)
    const seen = new Set<string>()
    while (unit !== undefined && !seen.has(unit.id)) {
      seen.add(unit.id)
      const count = orgCounts.get(unit.id)!
      count.people += 1; count.open += open; count.sum += effective; count.max = Math.max(count.max, effective)
      count.budget += employee.budgetMicros ?? 0; count.spent += money.spentMicros; count.available += money.availableMicros
      unit = unit.parentId === undefined ? undefined : orgById.get(unit.parentId)
    }
  }
  const orgUnits = projectedOrgUnits.map((unit) => ({
    id: unit.id,
    name: unit.name,
    kind: unit.kind,
    ...(unit.parentId === undefined ? {} : { parent_id: unit.parentId }),
    ...(unit.description === undefined ? {} : { description: bounded(unit.description, 1_024) }),
    ...(unit.managerEmployeeId === undefined ? {} : { manager_employee_id: unit.managerEmployeeId }),
    child_ids: projectedOrgUnits.filter((candidate) => candidate.parentId === unit.id).map((candidate) => candidate.id),
    position_ids: projectedPositions.filter((position) => position.orgUnitId === unit.id).map((position) => position.id),
    load: orgLoad(orgCounts.get(unit.id)!),
    child_count: orgCounts.get(unit.id)!.children,
    position_count: orgCounts.get(unit.id)!.positions,
    money_summary: { budget_micros: orgCounts.get(unit.id)!.budget, spent_micros: orgCounts.get(unit.id)!.spent, available_micros: orgCounts.get(unit.id)!.available },
  }))
  const positions = projectedPositions.map((position) => ({
    id: position.id,
    title: position.title,
    org_unit_id: position.orgUnitId,
    ...(position.reportsToPositionId === undefined ? {} : { reports_to_position_id: position.reportsToPositionId }),
    responsibilities: boundedItems(position.responsibilities, 16, 1_024),
    employee_ids: projectedEmployees.filter((employee) => employee.positionId === position.id && employee.status !== 'retired').map((employee) => employee.id),
    employee_count: positionCounts.get(position.id) ?? 0,
  }))
  const activeStaffing = state.staffingRequests.filter((request) => !['rejected', 'applied'].includes(request.status))
  const recentStaffing = state.staffingRequests.filter((request) => ['rejected', 'applied'].includes(request.status)).slice(-HISTORY_LIMIT)
  const staffingRequests = (founderView ? [...activeStaffing, ...recentStaffing] : []).map((request) => ({
    id: request.id,
    action: request.action,
    status: request.status,
    ...(request.candidateName === undefined ? {} : { candidate_name: request.candidateName }),
    ...(request.employeeId === undefined ? {} : { employee_id: request.employeeId }),
    work_profile: request.workProfile,
    hr_employee_id: request.hrEmployeeId,
    ...(request.recommendation === undefined ? {} : { recommendation: {
      difficulty: request.recommendation.difficulty,
      provider: request.recommendation.provider,
      model: request.recommendation.model,
      ...(request.recommendation.reasoningEffort === undefined ? {} : { reasoningEffort: request.recommendation.reasoningEffort }),
      ...(request.recommendation.budgetMicros === undefined ? {} : { budgetMicros: request.recommendation.budgetMicros }),
      rationale: bounded(request.recommendation.rationale, 2_048),
      orgPath: request.recommendation.orgPath.slice(0, 16),
      positionTitle: bounded(request.recommendation.positionTitle, 512),
      responsibilities: boundedItems(request.recommendation.responsibilities, 16, 1_024),
      ...(request.recommendation.designateAsHr === undefined ? {} : { designateAsHr: request.recommendation.designateAsHr }),
      assessedAt: request.recommendation.assessedAt,
    } }),
    ...(request.approvalId === undefined ? {} : { approval_id: request.approvalId }),
    created_at: request.createdAt,
    updated_at: request.updatedAt,
  }))
  const products: SafeProductView[] = state.products.map((product) => {
    const productWork = state.workItems.filter((item) => item.productId === product.id)
    const tokenUsage = productTokenTotals(state, product.id)
    const money = productMoneyTotals(state, product.id)
    return {
      id: product.id,
      name: product.name,
      summary: bounded(product.summary, 8_192),
      status: product.status,
      product_root: product.productRoot,
      success_criteria: boundedItems(product.successCriteria, 32, 1_024),
      token_used: tokenUsage.totalTokens,
      budget_micros: product.budgetMicros,
      spent_micros: money.spentMicros,
      reserved_micros: money.reservedMicros,
      available_micros: money.availableMicros,
      completed_work: productWork.filter((item) => item.status === 'completed').length,
      total_work: productWork.length,
      created_at: product.createdAt,
      updated_at: product.updatedAt,
      ...(product.releaseApprovalId === undefined ? {} : { release_approval_id: product.releaseApprovalId }),
    }
  })

  const recentWorkIds = new Set(state.workItems.slice(-WORK_DETAIL_LIMIT).map((item) => item.id))
  const work: SafeWorkView[] = state.workItems.map((item) => {
    const blockerEmployeeId = item.assigneeId !== undefined && item.assigneeId !== 'founder'
      ? item.assigneeId
      : actor.kind === 'employee' ? actor.id : undefined
    const blockedReasons = item.status === 'pending' ? workBlockedReasons(state, item, blockerEmployeeId, now) : []
    const canSeePrivate = founderView || item.assigneeId === actor.id
    const showDetail = canSeePrivate && (recentWorkIds.has(item.id) || item.status === 'claimed' || item.status === 'in_progress')
    return {
      id: item.id,
      product_id: item.productId,
      kind: item.kind,
      subject: item.subject,
      ...(showDetail ? { objective: bounded(item.objective, 8_192) } : {}),
      status: item.status,
      blocked: blockedReasons.length > 0,
      blocked_reasons: blockedReasons,
      ...(item.assigneeId === undefined ? {} : { assignee_id: item.assigneeId }),
      ...(item.ticketId === undefined ? {} : { ticket_id: item.ticketId }),
      dependencies: [...item.dependencies],
      approval_dependencies: [...(item.approvalDependencies ?? [])],
      attempt: item.attempt,
      ...(!showDetail || item.output === undefined ? {} : { output: bounded(item.output, founderView ? Math.min(state.limits.maxOutputChars, 32_768) : 16_384) }),
      ...(!showDetail || item.verdict === undefined ? {} : { verdict: item.verdict }),
      ...(!showDetail || item.findings === undefined ? {} : {
        findings: item.findings.slice(-8).map((finding) => ({
          id: finding.id,
          severity: finding.severity,
          ...(finding.file === undefined ? {} : { file: finding.file }),
          ...(finding.line === undefined ? {} : { line: finding.line }),
          problem: bounded(finding.problem, 1_024),
          required_fix: bounded(finding.requiredFix, 1_024),
        })),
      }),
      ...(showDetail ? {
        acceptance: boundedItems(item.acceptance, 8, 1_024),
        verify: boundedItems(item.verify, 8, 1_024),
        deliverables: boundedItems(item.deliverables, 8, 1_024),
        changed_paths: boundedItems(item.evidence?.changedPaths ?? [], 32, 1_024),
        acceptance_results: boundedItems(item.evidence?.acceptanceResults ?? [], 8, 1_024),
        commands_run: boundedItems(item.evidence?.commandsRun ?? [], 8, 1_024),
      } : {}),
      created_at: item.createdAt,
      updated_at: item.updatedAt,
    }
  })

  const visibleApprovals = state.approvals
    .filter((approval) => founderView || approval.requestedBy === actor.id || (approval.status === 'approved' && (approval.kind === 'release' || approval.kind === 'external_effect')))
  const pendingApprovals = visibleApprovals.filter((approval) => approval.status === 'pending')
  const historicalApprovals = visibleApprovals.filter((approval) => approval.status !== 'pending').slice(-HISTORY_LIMIT)
  const approvals: SafeApprovalView[] = [...pendingApprovals, ...historicalApprovals]
    .sort((left, right) => statusRank(left.status) - statusRank(right.status) || right.requestedAt - left.requestedAt)
    .map((approval) => ({
      id: approval.id,
      kind: approval.kind,
      status: approval.status,
      requested_by: approval.requestedBy,
      summary: approval.summary,
      payload_summary: summarizePayload(approval.payload),
      ...(approval.detail === undefined ? {} : { detail: bounded(approval.detail, 4096) }),
      risk: approval.risk,
      requested_at: approval.requestedAt,
      ...(approval.expiresAt === undefined ? {} : { expires_at: approval.expiresAt }),
      ...(approval.resolvedAt === undefined ? {} : { resolved_at: approval.resolvedAt }),
      ...(approval.resolution === undefined ? {} : {
        resolution: {
          decision: approval.resolution.decision,
          source: approval.resolution.source,
          ...(approval.resolution.humanStatement === undefined ? {} : { human_statement: redactDiagnostic(approval.resolution.humanStatement, 4096) }),
          ...(approval.resolution.note === undefined ? {} : { note: redactDiagnostic(approval.resolution.note, 4096) }),
        },
      }),
    }))

  const safeInbox: SafeMessageView[] = inbox
    .filter((message) => actor.kind === 'founder' ? message.to === 'founder' : message.to === actor.id)
    .slice(-INBOX_LIMIT)
    .map((message) => ({
      id: message.id,
      from: message.from,
      to: message.to,
      content: bounded(message.content, Math.min(state.limits.maxMessageChars, 16_384)),
      created_at: message.createdAt,
      ...(message.attempts === undefined ? {} : { attempts: message.attempts }),
      delivery_state: message.deliveryState,
    }))

  const visibleUsage = founderView ? state.moneyBudget.usage : state.moneyBudget.usage.filter((entry) => entry.employeeId === actor.id)
  const detailTotal = visibleUsage.length
  const detailOffset = Math.max(0, detailTotal - DETAIL_LIMIT)
  const detailItems = visibleUsage.slice(detailOffset, detailOffset + DETAIL_LIMIT)
  const available = availableMoney(state)
  const warnings: string[] = []
  if (available <= (state.moneyBudget.warningAtMicros ?? 0)) warnings.push('Monetary budget is at or below its warning threshold.')
  if (state.modelCatalog.models.some((model) => matchModelPrice(state.moneyBudget.prices, model.provider, model.model) === undefined)) warnings.push('Some model routes are unpriced and normally blocked; an active temporary authorization may admit them only as unknown cost, never as free usage.')
  if (visibleUsage.some((entry) => !entry.priced)) warnings.push('Unpriced usage remains visible as unknown-cost token/event counts and is never treated as a configured zero-cost route.')
  if (state.moneyBudget.migrationRequired === true) warnings.push('Financial migration review is required before work can resume.')
  if (state.phase === 'provisioning_failed') warnings.push('Employee provisioning failed; fix the route or capacity issue before retrying approval.')
  if (state.phase === 'paused') warnings.push('The company is paused; automatic work admission is disabled.')
  if (state.phase === 'halted') warnings.push(`The company halted automatically: ${state.health.detail ?? state.health.reason ?? 'operational failure'}. Manual resume is available after correction.`)
  else if (state.health.status === 'degraded') warnings.push(`Some employees are operationally blocked: ${state.health.detail ?? state.health.reason ?? 'operational failure'}. Manual resume is available after correction.`)
  if (state.workItems.length > WORK_DETAIL_LIMIT) warnings.push(`Full contracts and evidence are included only for the newest ${WORK_DETAIL_LIMIT} work items and every currently open attempt.`)
  if (state.staffingRequests.length > staffingRequests.length) warnings.push(`Staffing history is limited to the newest ${HISTORY_LIMIT} terminal requests.`)
  if (visibleApprovals.length > approvals.length) warnings.push(`Approval history is limited to the newest ${HISTORY_LIMIT} terminal requests.`)
  if (visibleAuthorizations.length > authorizationRows.length) warnings.push(`Temporary authorization history is limited to the newest ${HISTORY_LIMIT} terminal records.`)
  if (state.tickets.filter((ticket) => ticket.status === 'closed').length > HISTORY_LIMIT) warnings.push(`Closed ticket history is limited to the newest ${HISTORY_LIMIT} records.`)

  const requiredModelKeys = new Set([
    ...state.employees.flatMap((employee) => [`${employee.llm.provider}\u0000${employee.llm.model}`, ...(employee.llm.fallback === undefined ? [] : [`${employee.llm.fallback.provider}\u0000${employee.llm.fallback.model}`])]),
    ...state.moneyBudget.prices.filter((price) => price.model !== '*').map((price) => `${price.provider}\u0000${price.model}`),
  ])
  const modelCatalogRows = [...state.modelCatalog.models]
    .sort((left, right) => Number(requiredModelKeys.has(`${right.provider}\u0000${right.model}`)) - Number(requiredModelKeys.has(`${left.provider}\u0000${left.model}`)))
    .slice(0, MODEL_CATALOG_LIMIT)
  if (state.modelCatalog.models.length > modelCatalogRows.length) warnings.push(`Model catalog projection is limited to ${MODEL_CATALOG_LIMIT} routes; active and priced routes are prioritized.`)

  const activeTickets = state.tickets.filter((ticket) => ticket.status !== 'closed')
  const recentClosedTickets = state.tickets.filter((ticket) => ticket.status === 'closed').slice(-HISTORY_LIMIT)
  const tickets: SafeTicketView[] = [...activeTickets, ...recentClosedTickets].map((ticket) => ({
    id: ticket.id,
    product_id: ticket.productId,
    title: ticket.title,
    description: bounded(ticket.description, 4_096),
    reported_by: ticket.reportedBy,
    reported_at: ticket.reportedAt,
    status: ticket.status,
    ...(ticket.severity === undefined ? {} : { severity: ticket.severity }),
    ...(ticket.workItemId === undefined ? {} : { work_item_id: ticket.workItemId }),
    ...(ticket.assigneeId === undefined ? {} : { assignee_id: ticket.assigneeId }),
    ...(ticket.resolvedAt === undefined ? {} : { resolved_at: ticket.resolvedAt }),
    ...(ticket.reply === undefined ? {} : { reply: bounded(ticket.reply, 8_192) }),
    ...(ticket.closedAt === undefined ? {} : { closed_at: ticket.closedAt }),
  }))

  return {
    schema_version: COMPANY_SNAPSHOT_SCHEMA_VERSION,
    revision: state.revision,
    execution: getCompanyExecution(ctx)?.snapshot(state.id),
    directory: {
      employees: { ...employeePage.page, query }, org_units: orgPage.page, positions: positionPage.page,
      summary: {
        employees: state.employees.length, active_employees: state.employees.filter((employee) => employee.status !== 'retired').length,
        retired_employees: state.employees.filter((employee) => employee.status === 'retired').length,
        running_employees: state.employees.filter((employee) => employee.status !== 'retired' && liveRunning.has(employee.id)).length,
        org_units: state.orgUnits.length, positions: state.positions.length,
        employee_statuses: Object.fromEntries(EMPLOYEE_STATUSES.map((status) => [status, state.employees.filter((employee) => employee.status === status).length])),
      },
    },
    viewer: {
      role: actor.kind,
      participant_id: actor.id,
      permissions: actor.kind === 'founder' ? [...FOUNDER_PERMISSIONS] : [...EMPLOYEE_PERMISSIONS],
    },
    company: {
      id: state.id,
      name: state.name,
      slogan: state.slogan,
      mission: state.mission,
      charter: state.formation.charter,
      charter_outline: parseCharterClauses(state.formation.charter),
      governance_revision: state.governanceRevision,
      formation_status: state.formation.status,
      phase: state.phase,
      updated_at: state.updatedAt,
      ...(actor.kind === 'founder' ? { founder_session_id: state.founderSessionId } : {}),
      health: {
        ...structuredClone(state.health),
        ...(state.health.reason === undefined ? {} : { reason: state.health.reason }),
        ...(state.health.detail === undefined ? {} : { detail: redactDiagnostic(state.health.detail, 4096) }),
      },
      max_employees: state.limits.maxEmployees,
    },
    org_units: orgUnits,
    positions,
    staffing_requests: staffingRequests,
    employees,
    products,
    work,
    tickets,
    budget: {
      unit: 'micro-currency',
      currency: state.moneyBudget.currency,
      total_micros: state.moneyBudget.totalMicros,
      reserved_micros: state.moneyBudget.reservedMicros,
      spent_micros: state.moneyBudget.spentMicros,
      available_micros: available,
      warning: available <= (state.moneyBudget.warningAtMicros ?? 0),
      ...(state.moneyBudget.warningAtMicros === undefined ? {} : { warning_at_micros: state.moneyBudget.warningAtMicros }),
      pricing_revision: state.moneyBudget.pricingRevision,
      migration_required: state.moneyBudget.migrationRequired === true,
      prices: state.moneyBudget.prices.map((price) => ({
        provider: price.provider,
        model: price.model,
        priced: price.inputCacheMissMicrosPerMillion !== undefined,
        source: price.source,
        revision: price.revision,
        updated_at: price.updatedAt,
        ...(price.inputCacheMissMicrosPerMillion === undefined ? {} : { input_cache_miss_micros_per_million: price.inputCacheMissMicrosPerMillion }),
        ...(price.inputCacheHitMicrosPerMillion === undefined ? {} : { input_cache_hit_micros_per_million: price.inputCacheHitMicrosPerMillion }),
        ...(price.outputMicrosPerMillion === undefined ? {} : { output_micros_per_million: price.outputMicrosPerMillion }),
      })),
      provider_model_aggregates: aggregateProviderModels(visibleUsage),
      usage_detail: {
        total: detailTotal,
        offset: detailOffset,
        limit: DETAIL_LIMIT,
        returned: detailItems.length,
        truncated: detailItems.length !== detailTotal,
        items: detailItems.map(projectUsage),
      },
    },
    model_catalog: {
      stale: state.modelCatalog.stale,
      generation: state.modelCatalog.generation,
      ...(state.modelCatalog.probedAt === undefined ? {} : { probed_at: state.modelCatalog.probedAt }),
      ...(state.modelCatalog.invalidatedAt === undefined ? {} : { invalidated_at: state.modelCatalog.invalidatedAt }),
      models: modelCatalogRows.map((model) => ({
        provider: model.provider,
        model: model.model,
        name: model.name,
        ...(model.description === undefined ? {} : { description: bounded(model.description, 1_024) }),
        ...(model.inputModalities === undefined ? {} : { input_modalities: model.inputModalities.slice(0, 16) }),
        ...(model.contextWindow === undefined ? {} : { context_window: model.contextWindow }),
        ...(model.defaultMaxTokens === undefined ? {} : { default_max_tokens: model.defaultMaxTokens }),
        ...(model.reasoningEfforts === undefined ? {} : { reasoning_efforts: model.reasoningEfforts.slice(0, 8).map((effort) => ({
          id: bounded(effort.id, 128),
          name: bounded(effort.name, 256),
          ...(effort.description === undefined ? {} : { description: bounded(effort.description, 512) }),
        })) }),
        ...(model.defaultReasoningEffort === undefined ? {} : { default_reasoning_effort: model.defaultReasoningEffort }),
        advertised: model.advertised,
        available: model.available,
      })),
      errors: state.modelCatalog.errors.map((error) => ({
        provider: redactDiagnostic(error.provider, 128),
        message: redactDiagnostic(error.message, 4096),
      })),
    },
    temporary_authorizations: authorizationRows
      .map((authorization) => ({
        id: authorization.id,
        employee_id: authorization.employeeId,
        reason: authorization.reason,
        approval_id: authorization.approvalId,
        authorized_by: authorization.authorizedBy,
        starts_at: authorization.startsAt,
        expires_at: authorization.expiresAt,
        status: temporaryAuthorizationStatus(authorization, now),
        uses: authorization.uses.slice(-DETAIL_LIMIT).map((use) => ({
          id: use.id,
          at: use.at,
          work_id: use.workId,
          approval_ids: [...(use.approvalIds ?? [])],
          bypassed: [...use.bypassed],
          ...(use.amountMicros === undefined ? {} : { amount_micros: use.amountMicros }),
          ...(use.usageId === undefined ? {} : { usage_id: use.usageId }),
          ...(use.unknownCost === undefined ? {} : { unknown_cost: use.unknownCost }),
        })),
        created_at: authorization.createdAt,
        ...(authorization.revokedAt === undefined ? {} : { revoked_at: authorization.revokedAt }),
        ...(authorization.revocationReason === undefined ? {} : { revocation_reason: authorization.revocationReason }),
      })),
    approvals,
    inbox: safeInbox,
    warnings: warnings.map((warning) => redactDiagnostic(warning, 4096)),
    ...(pollAfterMs === undefined ? {} : { poll_after_ms: pollAfterMs }),
  }
}

function orgLoad({ people, open, sum, max }: { people: number; open: number; sum: number; max: number }): DepartmentLoadView {
  const band: DepartmentLoadView['band'] = people === 0 || sum === 0
    ? 'very_idle'
    : max >= 4 || sum > 3 * people
      ? 'pressure'
      : max >= 2 || sum > people
        ? 'busy'
        : 'normal'
  return { band, people, open_work: open, effective_sum: sum, average: people === 0 ? 0 : sum / people, max_effective: max }
}

function aggregateProviderModels(entries: readonly MoneyUsageEntry[]): ProviderModelMoneyAggregate[] {
  const rows = new Map<string, ProviderModelMoneyAggregate>()
  for (const entry of entries) {
    const key = `${entry.provider}\u0000${entry.model}`
    let row = rows.get(key)
    if (row === undefined) {
      row = {
        provider: entry.provider,
        model: entry.model,
        calls: 0,
        input_cache_miss_tokens: 0,
        input_cache_hit_tokens: 0,
        output_tokens: 0,
        reasoning_tokens: 0,
        total_tokens: 0,
        cost_micros: 0,
        priced_calls: 0,
        unpriced_calls: 0,
      }
      rows.set(key, row)
    }
    row.calls += 1
    row.input_cache_miss_tokens += entry.inputCacheMissTokens
    row.input_cache_hit_tokens += entry.inputCacheHitTokens
    row.output_tokens += entry.outputTokens
    row.reasoning_tokens += entry.reasoningTokens
    row.total_tokens += entry.totalTokens
    row.cost_micros += entry.costMicros
    if (entry.priced) row.priced_calls += 1
    else row.unpriced_calls += 1
  }
  return [...rows.values()].sort((left, right) => right.cost_micros - left.cost_micros
    || left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
}

function projectUsage(entry: MoneyUsageEntry): CompanySnapshot['budget']['usage_detail']['items'][number] {
  return {
    id: entry.id,
    employee_id: entry.employeeId,
    ...(entry.workId === undefined ? {} : { work_id: entry.workId }),
    ...(entry.productId === undefined ? {} : { product_id: entry.productId }),
    provider: entry.provider,
    model: entry.model,
    input_tokens: entry.inputTokens,
    output_tokens: entry.outputTokens,
    cache_read_tokens: entry.cacheReadTokens,
    cache_write_tokens: entry.cacheWriteTokens,
    reasoning_tokens: entry.reasoningTokens,
    input_cache_miss_tokens: entry.inputCacheMissTokens,
    input_cache_hit_tokens: entry.inputCacheHitTokens,
    total_tokens: entry.totalTokens,
    cost_micros: entry.costMicros,
    priced: entry.priced,
    pricing_revision: entry.pricingRevision,
    pricing_digest: entry.rates?.pricingDigest
      ?? (entry.pricingProvenance === 'legacy_recorded_event' ? 'legacy-recorded-event'
        : entry.pricingProvenance === 'legacy_recorded_total' ? 'legacy-recorded-total'
          : 'legacy-unpriced'),
    ...(entry.matchedPriceKey === undefined ? {} : { matched_price_key: entry.matchedPriceKey }),
    ...(entry.authorizationId === undefined ? {} : { authorization_id: entry.authorizationId }),
    at: entry.at,
  }
}

function summarizePayload(payload: import('./types.js').JsonValue): import('./types.js').JsonValue {
  const redacted = redactJsonValue(payload)
  const serialized = JSON.stringify(redacted)
  if (serialized.length <= 4096) return redacted
  return { summary: `${serialized.slice(0, 4095)}…` }
}

function redactJsonValue(value: import('./types.js').JsonValue, key = ''): import('./types.js').JsonValue {
  if (/^(?:api.?key|access.?token|refresh.?token|password|passwd|secret|credential|authorization)$/i.test(key)) return '[REDACTED]'
  if (typeof value === 'string') return redactDiagnostic(value, 16_384)
  if (Array.isArray(value)) return value.map((item) => redactJsonValue(item))
  if (value !== null && typeof value === 'object') {
    return Object.fromEntries(Object.entries(value).map(([childKey, child]) => [childKey, redactJsonValue(child, childKey)]))
  }
  return value
}

function redactDiagnostic(value: string, max: number): string {
  return bounded(value
    .replace(/\bBearer\s+[A-Za-z0-9._~+/=-]+/giu, 'Bearer [REDACTED]')
    .replace(/\b(?:api.?key|access.?token|refresh.?token|password|passwd|secret|credential|authorization)\b\s*[:=]\s*["']?[^\s,"']+/giu, '[REDACTED]')
    .replace(/\bsk-[A-Za-z0-9_-]{10,}\b/gu, '[REDACTED]')
    .replace(/https?:\/\/[^\s)\]}>]+/giu, '[REDACTED_URL]'), max)
}

function statusRank(status: string): number {
  return status === 'pending' ? 0 : 1
}

function boundedItems(values: readonly string[], maxItems: number, maxChars: number): string[] {
  return values.slice(0, maxItems).map((value) => bounded(value, maxChars))
}

function bounded(value: string, max: number): string {
  return value.length <= max ? value : `${value.slice(0, Math.max(0, max - 1))}…`
}
