import { collapseLegacyTokenPrice } from './schemas.js'
import { pricingMatrixDigest } from './money.js'
import { COMPANY_STATE_SCHEMA_VERSION, type ResolvedCompanyConfig } from './types.js'

/**
 * Upgrade every historical on-disk v1 aggregate into the currency-only v2
 * aggregate. The workspace directory stays stable; the next successful
 * transaction persists the normalized shape. Running this function repeatedly
 * is intentionally idempotent.
 */
export function normalizeCompanyState(value: unknown, config: ResolvedCompanyConfig): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const state = value as Record<string, any>
  if (state.schemaVersion !== 1 && state.schemaVersion !== COMPANY_STATE_SCHEMA_VERSION) return value

  const sourceVersion = state.schemaVersion
  const now = typeof state.updatedAt === 'number' ? state.updatedAt : Date.now()
  initializeCollections(state)
  normalizeCounters(state)

  if (sourceVersion === 1) {
    migrateLegacyMoney(state, config, now)
    migrateLegacyApprovals(state, now)
    delete state.budget
    delete state.tokenBudget
    delete state.planReviewState
    state.schemaVersion = COMPANY_STATE_SCHEMA_VERSION
  }

  normalizeCurrentMoney(state, now)
  normalizeCurrentOrganization(state, now)
  normalizeCurrentLifecycles(state, now)
  normalizeCounters(state)
  normalizeTemporaryAuthorizationProvenance(state, now)
  normalizeCounters(state)
  return value
}

function initializeCollections(state: Record<string, any>): void {
  state.counters ??= {}
  for (const key of ['employee', 'product', 'work', 'approval', 'event', 'orgUnit', 'position', 'staffing', 'authorization', 'ticket']) {
    state.counters[key] = nonNegativeInteger(state.counters[key])
  }
  state.employees ??= []
  state.products ??= []
  state.workItems ??= []
  state.tickets ??= []
  state.approvals ??= []
  state.governanceNotifications ??= []
  state.staffingRequests ??= []
  state.orgUnits ??= []
  state.positions ??= []
  state.temporaryAuthorizations ??= []
  state.slogan ??= deriveSlogan(String(state.mission ?? state.name ?? 'Company'))
  state.governanceRevision ??= 1
}

function migrateLegacyMoney(state: Record<string, any>, config: ResolvedCompanyConfig, now: number): void {
  const legacy = legacyTokenLedger(state.tokenBudget, config)
  for (const product of state.products) {
    product.budgetMicros ??= 0
    delete product.budgetCredits
    delete product.tokenBudget
  }
  for (const employee of state.employees) employee.budgetMicros ??= 0
  if (state.moneyBudget !== undefined) return

  const collapsedRows = legacy.prices.map((price: any) => collapseLegacyTokenPrice(price, 1, now))
  const hasIncompatibleLegacyPrice = collapsedRows.some((price: unknown, index: number) => price === undefined && legacy.prices[index] !== undefined)
  const collapsed = collapsedRows.map((price: any, index: number) => price ?? {
    provider: String(legacy.prices[index]?.provider ?? 'legacy-v0.2'),
    model: String(legacy.prices[index]?.model ?? 'unpriced'),
    source: 'legacy',
    revision: 1,
    updatedAt: now,
  })
  const configuredKeys = new Set(collapsed.map((price: any) => `${price.provider}\u0000${price.model}`))
  for (const configured of config.modelPrices) {
    const key = `${configured.provider}\u0000${configured.model}`
    if (!configuredKeys.has(key)) collapsed.push({ ...structuredClone(configured), updatedAt: now })
  }

  const legacyUsage = legacy.usage.map((entry: any) => legacyUsageEntry(state, entry, legacy.currency))
  const recordedEventCostMicros = legacyUsage.reduce((sum: number, entry: any) => safeAdd(sum, Number(entry.costMicros ?? 0)), 0)
  const reconciliationCostMicros = Math.max(0, Number(legacy.totalCostMicros ?? 0) - recordedEventCostMicros)
  if (reconciliationCostMicros > 0 && state.employees.length === 0) {
    state.counters.employee += 1
    state.employees.push({
      id: `e${state.counters.employee}`,
      name: 'Legacy unattributed ledger identity',
      role: 'Preserve historical booked monetary facts only',
      budgetMicros: 0,
      status: 'retired',
      joinedAt: now,
      retiredAt: now,
      llm: { provider: 'legacy-v0.2', model: 'unattributed-recorded-cost' },
    })
  }
  const bookedEmployeeId = state.employees.find((employee: any) => employee.id === state.hrEmployeeId)?.id
    ?? state.employees.find((employee: any) => employee.status !== 'retired')?.id
    ?? state.employees[0]?.id
  if (reconciliationCostMicros > 0 && bookedEmployeeId !== undefined) {
    legacyUsage.push({
      id: `legacy-v02-booked-cost:${String(state.id)}`,
      sessionId: String(state.founderSessionId),
      eventSeq: 0,
      turn: 0,
      step: 0,
      employeeId: bookedEmployeeId,
      provider: 'legacy-v0.2',
      model: 'unattributed-recorded-cost',
      inputTokens: 0,
      outputTokens: 0,
      cacheReadTokens: 0,
      cacheWriteTokens: 0,
      reasoningTokens: 0,
      inputCacheMissTokens: 0,
      inputCacheHitTokens: 0,
      totalTokens: 0,
      costMicros: reconciliationCostMicros,
      priced: true,
      currency: legacy.currency,
      pricingRevision: 0,
      pricingProvenance: 'legacy_recorded_total',
      at: now,
    })
  }

  const formationCanRemediateDirectly = ['staged', 'provisioning', 'provisioning_failed'].includes(String(state.phase))
  const preservedBookedCostMicros = safeAdd(recordedEventCostMicros, reconciliationCostMicros)
  state.moneyBudget = {
    unit: 'micro-currency',
    currency: legacy.currency,
    totalMicros: 0,
    reservedMicros: 0,
    spentMicros: preservedBookedCostMicros,
    warningAtMicros: 0,
    pricingRevision: 1,
    prices: collapsed,
    usage: legacyUsage,
    reservations: [],
    migrationRequired: !formationCanRemediateDirectly,
    legacyV02: {
      totalTokens: legacy.totalTokens,
      usedTokens: legacy.usedTokens,
      reservedTokens: legacy.reservedTokens,
      totalCostMicros: legacy.totalCostMicros,
      prices: structuredClone(legacy.prices),
      treatment: formationCanRemediateDirectly ? 'accepted' : 'unverified',
    },
  }

  for (const work of state.workItems) {
    work.reservationId = undefined
    work.leaseAt = undefined
  }
  if (state.phase === 'provisioning') {
    state.phase = 'provisioning_failed'
    state.formation && (state.formation.status = 'draft')
    if (state.formation !== undefined) state.formation.approvedAt = undefined
    state.provisioning = undefined
    for (const employee of state.employees) {
      if (employee.status === 'retired' || employee.status === 'idle') continue
      employee.status = 'failed'
      employee.failure = 'Currency-ledger migration revoked an incomplete provisioning generation; edit the formation finances and explicitly retry.'
    }
  }
  if (state.phase === 'operating' || state.phase === 'halted') {
    for (const employee of state.employees) {
      if (employee.status !== 'retired' && employee.status !== 'failed') employee.status = 'paused'
    }
  }
  if (state.phase === 'operating' || state.phase === 'halted') {
    state.phase = 'halted'
    state.pausedAt ??= now
    state.health = {
      status: 'halted',
      reason: hasIncompatibleLegacyPrice ? 'needs_budget_review' : 'financial_migration',
      detail: hasIncompatibleLegacyPrice
        ? 'Legacy four-rate prices cannot be collapsed safely; booked facts are preserved and approved remediation is required.'
        : 'Human approval must establish a currency budget, three-rate prices, and allocations before a later manual resume.',
      detectedAt: now,
      resumable: false,
    }
  }
}

function legacyTokenLedger(value: unknown, config: ResolvedCompanyConfig): Record<string, any> {
  const token = value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, any> : {}
  return {
    currency: typeof token.currency === 'string' ? token.currency : config.defaultCurrency,
    totalTokens: nonNegativeInteger(token.totalTokens),
    usedTokens: nonNegativeInteger(token.usedTokens),
    reservedTokens: nonNegativeInteger(token.reservedTokens),
    totalCostMicros: nonNegativeInteger(token.totalCostMicros),
    prices: Array.isArray(token.prices) ? token.prices : [],
    usage: Array.isArray(token.usage) ? token.usage : [],
  }
}

function legacyUsageEntry(state: Record<string, any>, entry: Record<string, any>, currency: string): Record<string, any> {
  const inputTokens = nonNegativeInteger(entry.inputTokens)
  const outputTokens = nonNegativeInteger(entry.outputTokens)
  const cacheReadTokens = nonNegativeInteger(entry.cacheReadTokens)
  const cacheWriteTokens = nonNegativeInteger(entry.cacheWriteTokens)
  const reasoningTokens = Math.min(nonNegativeInteger(entry.reasoningTokens), outputTokens)
  const inputCacheMissTokens = safeAdd(inputTokens, cacheWriteTokens)
  const inputCacheHitTokens = cacheReadTokens
  const productId = entry.workId === undefined ? undefined : state.workItems.find((work: any) => work.id === entry.workId)?.productId
  return {
    id: String(entry.id),
    sessionId: String(entry.sessionId),
    eventSeq: nonNegativeInteger(entry.eventSeq),
    turn: nonNegativeInteger(entry.turn),
    step: nonNegativeInteger(entry.step),
    employeeId: String(entry.employeeId),
    ...(entry.workId === undefined ? {} : { workId: String(entry.workId) }),
    ...(productId === undefined ? {} : { productId }),
    provider: String(entry.provider),
    model: String(entry.model),
    inputTokens,
    outputTokens,
    cacheReadTokens,
    cacheWriteTokens,
    reasoningTokens,
    inputCacheMissTokens,
    inputCacheHitTokens,
    totalTokens: safeAdd(safeAdd(inputCacheMissTokens, inputCacheHitTokens), outputTokens),
    costMicros: entry.priced === true ? nonNegativeInteger(entry.costMicros) : 0,
    priced: entry.priced === true,
    currency,
    pricingRevision: 0,
    ...(entry.priced === true ? { pricingProvenance: 'legacy_recorded_event' } : {}),
    at: nonNegativeInteger(entry.at),
  }
}

function migrateLegacyApprovals(state: Record<string, any>, now: number): void {
  for (const approval of state.approvals) {
    if (approval.kind === 'budget_change' && approval.payload?.newTotalMicros === undefined) {
      if (approval.status === 'pending') {
        approval.status = 'cancelled'
        approval.resolvedAt = now
        approval.resolution = { decision: 'rejected', source: 'tool', note: 'Cancelled while retiring the legacy token/activation-credit budget contract.' }
      }
      approval.payload = {
        newTotalMicros: nonNegativeInteger(state.moneyBudget?.totalMicros),
        expectedTotalMicros: nonNegativeInteger(state.moneyBudget?.totalMicros),
      }
    }
    if (approval.kind === 'product_scope' && approval.payload !== null && typeof approval.payload === 'object') {
      delete approval.payload.budgetCredits
    }
    if (approval.kind === 'organization_change' && approval.payload !== null && typeof approval.payload === 'object') {
      delete approval.payload.department
    }
  }
}

function normalizeCurrentMoney(state: Record<string, any>, now: number): void {
  const money = state.moneyBudget
  if (money === undefined || money === null || typeof money !== 'object' || Array.isArray(money)) return
  money.prices ??= []
  money.usage ??= []
  money.reservations ??= []
  money.reservedMicros ??= 0
  money.spentMicros ??= 0
  money.pricingRevision ??= 1
  if (money.migrationRequired === true && (state.phase === 'operating' || state.phase === 'provisioning')) {
    state.phase = 'halted'
    state.provisioning = undefined
    state.pausedAt ??= now
    state.health = { status: 'halted', reason: 'financial_migration', detail: 'Approved financial remediation and a later explicit manual resume are required.', detectedAt: now, resumable: false }
  }
  const digest = pricingMatrixDigest(money)
  for (const entry of money.usage) if (entry.rates !== undefined) entry.rates.pricingDigest ??= digest
  for (const reservation of money.reservations) {
    if (reservation.rates !== undefined) reservation.rates.pricingDigest ??= digest
    for (const rates of reservation.routeRates ?? []) rates.pricingDigest ??= digest
    if (reservation.routes === undefined || reservation.routes.length === 0) {
      const employee = state.employees.find((candidate: any) => candidate.id === reservation.employeeId)
      const recovered = [
        ...(reservation.routeRates ?? []).map((rates: any) => ({ provider: rates.provider, model: rates.model })),
        ...(reservation.rates === undefined ? [] : [{ provider: reservation.rates.provider, model: reservation.rates.model }]),
        ...(employee === undefined ? [] : [{ provider: employee.llm.provider, model: employee.llm.model }]),
        ...(employee?.llm.fallback === undefined ? [] : [{ provider: employee.llm.fallback.provider, model: employee.llm.fallback.model }]),
      ]
      reservation.routes = [...new Map(recovered.map((route: any) => [`${route.provider}\u0000${route.model}`, route])).values()]
    }
  }
}

function normalizeCurrentOrganization(state: Record<string, any>, now: number): void {
  if (state.orgUnits.length === 0) {
    state.counters.orgUnit += 1
    state.orgUnits.push({ id: `ou${state.counters.orgUnit}`, name: String(state.name ?? 'Company'), kind: 'company', createdAt: now })
  }
  const root = state.orgUnits.find((unit: any) => unit.parentId === undefined) ?? state.orgUnits[0]
  let hrUnit = state.orgUnits.find((unit: any) => /human resources|人力资源|hr/i.test(String(unit.name)))
  if (hrUnit === undefined) {
    state.counters.orgUnit += 1
    hrUnit = { id: `ou${state.counters.orgUnit}`, name: 'Human Resources', kind: 'department', parentId: root.id, description: 'Staffing, model-route, and reasoning-depth governance.', createdAt: now }
    state.orgUnits.push(hrUnit)
  }
  let hrPosition = state.positions.find((position: any) => position.orgUnitId === hrUnit.id)
  if (hrPosition === undefined) {
    state.counters.position += 1
    hrPosition = { id: `pos${state.counters.position}`, title: 'Head of People & Model Governance', orgUnitId: hrUnit.id, responsibilities: ['Assess work difficulty', 'Recommend model routes and reasoning effort', 'Govern staffing changes'], createdAt: now }
    state.positions.push(hrPosition)
  }

  const unitsByName = new Map(state.orgUnits.map((unit: any) => [String(unit.name).toLowerCase(), unit]))
  for (const employee of state.employees) {
    delete employee.turnTokenLimit
    delete employee.tokenSafetyLimit
    employee.budgetMicros ??= 0
    if (employee.orgUnitId === undefined) {
      const name = String(employee.department ?? 'General')
      let unit: any = unitsByName.get(name.toLowerCase())
      if (unit === undefined) {
        state.counters.orgUnit += 1
        unit = { id: `ou${state.counters.orgUnit}`, name, kind: 'department', parentId: root.id, createdAt: now }
        state.orgUnits.push(unit)
        unitsByName.set(name.toLowerCase(), unit)
      }
      employee.orgUnitId = unit.id
    }
    delete employee.department
    if (employee.positionId === undefined) {
      let position = state.positions.find((candidate: any) => candidate.orgUnitId === employee.orgUnitId && candidate.title === employee.role)
      if (position === undefined) {
        state.counters.position += 1
        position = { id: `pos${state.counters.position}`, title: String(employee.role), orgUnitId: employee.orgUnitId, responsibilities: [], createdAt: now }
        state.positions.push(position)
      }
      employee.positionId = position.id
    }
    if (employee.isHr === true) state.hrEmployeeId ??= employee.id
  }
  if (state.hrEmployeeId !== undefined && !state.employees.some((employee: any) => employee.id === state.hrEmployeeId && employee.status !== 'retired')) delete state.hrEmployeeId
  if (state.hrEmployeeId === undefined) {
    const legacyHr = state.employees.find((employee: any) => employee.status !== 'retired')
    if (legacyHr !== undefined) {
      legacyHr.isHr = true
      legacyHr.orgUnitId = hrUnit.id
      legacyHr.positionId = hrPosition.id
      state.hrEmployeeId = legacyHr.id
    }
  }
}

function normalizeCurrentLifecycles(state: Record<string, any>, now: number): void {
  state.formation ??= {
    status: state.phase === 'staged' || state.phase === 'provisioning_failed' ? 'draft' : 'approved',
    charter: `Legacy company charter migrated from mission: ${String(state.mission ?? '')}`.slice(0, 32_768),
    ...(state.products[0]?.id === undefined ? {} : { firstProductId: state.products[0].id }),
    draftedBy: 'user',
    lastEditedAt: now,
    ...(state.approvedAt === undefined ? {} : { approvedAt: state.approvedAt }),
  }
  state.health ??= { status: state.phase === 'paused' ? 'manual_pause' : 'healthy', resumable: true }
  if (state.phase === 'provisioning_failed' && state.formation.status === 'approved') {
    state.formation.status = 'draft'
    state.formation.approvedAt = undefined
  }
  if (state.phase === 'closing') {
    state.phase = 'paused'
    state.health = { status: 'manual_pause', reason: 'manual', detail: 'Recovered an obsolete closing phase; review and archive again.', detectedAt: now, resumable: true }
  }
  if (state.health?.reason === 'token_budget' || state.health?.reason === 'turn_limit') state.health.reason = 'unknown'
  state.modelCatalog ??= { stale: true, generation: 0, invalidatedAt: now, models: [], errors: [] }
  for (const model of state.modelCatalog.models ?? []) model.available ??= model.advertised !== false

  for (const product of state.products) {
    product.budgetMicros ??= 0
    delete product.budgetCredits
    delete product.tokenBudget
  }
  for (const work of state.workItems) {
    work.deliveryAttempts ??= ['claimed', 'in_progress'].includes(String(work.status)) ? 1 : 0
    if (!['claimed', 'in_progress'].includes(String(work.status))) {
      work.attemptId = undefined
      work.reservationId = undefined
      work.leaseAt = undefined
    }
    if (work.reassigning === true && work.handoffId === undefined) work.reassigning = false
    if (work.reassigning !== true) work.handoffId = undefined
    if (['completed', 'failed', 'cancelled'].includes(String(work.status)) && (typeof work.output !== 'string' || work.output.trim() === '')) {
      work.output = `Migrated terminal ${String(work.status)} work record.`
    }
  }
  for (const ticket of state.tickets) {
    const work = ticket.workItemId === undefined ? undefined : state.workItems.find((candidate: any) => candidate.id === ticket.workItemId)
    if (work !== undefined) work.ticketId = ticket.id
    if ((ticket.status === 'filed' || ticket.status === 'triaged') && work !== undefined && ['failed', 'cancelled'].includes(String(work.status))) {
      work.status = 'pending'
      work.assigneeId = undefined
      work.output = undefined
      work.verdict = undefined
      work.findings = undefined
      work.evidence = undefined
    }
  }
  for (const request of state.staffingRequests) {
    const approval = request.approvalId === undefined ? undefined : state.approvals.find((candidate: any) => candidate.id === request.approvalId)
    if (request.status === 'recommended' && approval?.status === 'approved') request.status = approval.consumedAt === undefined ? 'approved' : 'applied'
    if (request.status === 'recommended' && ['rejected', 'cancelled', 'expired'].includes(String(approval?.status))) request.status = 'rejected'
    const target = request.employeeId === undefined ? undefined : state.employees.find((employee: any) => employee.id === request.employeeId)
    if (request.status === 'applied' && (target?.status === 'failed' || target?.status === 'provisioning')) request.status = 'approved'
    if (request.status !== 'in_review') request.attemptId = undefined
    if (request.status === 'in_review' && request.attemptId === undefined) request.status = 'pending'
    request.reviewDeliveryAttempts ??= request.status === 'in_review' ? 1 : 0
  }
  if (state.phase !== 'provisioning') state.provisioning = undefined
  if (state.phase === 'provisioning' && state.provisioning === undefined) {
    state.phase = 'provisioning_failed'
    for (const employee of state.employees) if (employee.status === 'provisioning') employee.status = 'failed'
  }
  if (state.supportEmployeeId !== undefined) {
    const support = state.employees.find((employee: any) => employee.id === state.supportEmployeeId)
    if (support === undefined || ['retired', 'failed', 'planned', 'provisioning'].includes(String(support.status))) delete state.supportEmployeeId
  }
}

function normalizeTemporaryAuthorizationProvenance(state: Record<string, any>, now: number): void {
  for (const authorization of state.temporaryAuthorizations) {
    delete authorization.workId
    delete authorization.maxUses
    delete authorization.usedCount
    delete authorization.allowanceMicros
    delete authorization.usedAllowanceMicros
    delete authorization.approvalDependencyIds
    authorization.uses ??= []
    for (const use of authorization.uses) {
      use.employeeId ??= authorization.employeeId
      use.approvalIds ??= []
    }
    if (authorization.approvalId !== undefined) continue
    state.counters.approval += 1
    const approvalId = `a${state.counters.approval}`
    const requestedAt = nonNegativeInteger(authorization.createdAt) || now
    state.approvals.push({
      id: approvalId,
      kind: 'temporary_authorization',
      status: 'approved',
      requestedBy: 'founder',
      summary: `Migrated legacy temporary authorization ${String(authorization.id)}`,
      detail: 'Synthetic provenance record created while removing the historical direct-Web authorization bypass.',
      payload: {
        action: 'grant',
        employeeId: String(authorization.employeeId),
        reason: String(authorization.reason),
        startsAt: nonNegativeInteger(authorization.startsAt),
        expiresAt: nonNegativeInteger(authorization.expiresAt),
      },
      risk: 'high',
      requestedAt,
      resolvedAt: requestedAt,
      consumedAt: requestedAt,
      resolution: { decision: 'approved', source: 'ui', humanStatement: 'Migrated legacy authorization provenance.' },
    })
    authorization.approvalId = approvalId
  }
}

function normalizeCounters(state: Record<string, any>): void {
  const maxima: Record<string, number> = {
    employee: maxNumericId(state.employees, 'e'),
    product: maxNumericId(state.products, 'p'),
    work: maxNumericId(state.workItems, 'w'),
    approval: maxNumericId(state.approvals, 'a'),
    orgUnit: maxNumericId(state.orgUnits, 'ou'),
    position: maxNumericId(state.positions, 'pos'),
    staffing: maxNumericId(state.staffingRequests, 'sr'),
    authorization: maxNumericId(state.temporaryAuthorizations, 'ta'),
    ticket: maxNumericId(state.tickets, 't'),
  }
  for (const [key, value] of Object.entries(maxima)) state.counters[key] = Math.max(nonNegativeInteger(state.counters[key]), value)
}

function maxNumericId(rows: any[], prefix: string): number {
  let maximum = 0
  for (const row of rows) {
    const value = typeof row?.id === 'string' && row.id.startsWith(prefix) ? Number(row.id.slice(prefix.length)) : 0
    if (Number.isSafeInteger(value) && value > maximum) maximum = value
  }
  return maximum
}

function nonNegativeInteger(value: unknown): number {
  return Number.isSafeInteger(value) && (value as number) >= 0 ? value as number : 0
}

function safeAdd(left: number, right: number): number {
  const value = left + right
  return Number.isSafeInteger(value) && value >= 0 ? value : 0
}

function deriveSlogan(value: string): string {
  const normalized = value.normalize('NFC').trim()
  const first = normalized.split(/(?<=[.!?。！？])\s*/u, 1)[0]?.trim() ?? normalized
  return (first || 'Company').slice(0, 160)
}
