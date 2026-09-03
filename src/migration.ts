import { collapseLegacyTokenPrice } from './schemas.js'
import { pricingMatrixDigest } from './money.js'
import type { ResolvedCompanyConfig } from './types.js'

/** Normalize additive v0.2/v0.3 fields while preserving the on-disk v1 path and revision. */
export function normalizeCompanyState(value: unknown, config: ResolvedCompanyConfig): unknown {
  if (value === null || typeof value !== 'object' || Array.isArray(value)) return value
  const state = value as Record<string, any>
  if (state.schemaVersion !== 1) return value
  const now = typeof state.updatedAt === 'number' ? state.updatedAt : Date.now()
  state.counters ??= {}
  state.counters.orgUnit ??= 0
  state.counters.position ??= 0
  state.counters.staffing ??= 0
  state.counters.authorization ??= 0
  state.counters.ticket ??= 0
  state.employees ??= []
  if (state.hrEmployeeId !== undefined && !state.employees.some((employee: any) => employee.id === state.hrEmployeeId)) delete state.hrEmployeeId
  state.products ??= []
  state.workItems ??= []
  state.tickets ??= []
  state.approvals ??= []
  state.governanceNotifications ??= []
  state.slogan ??= deriveSlogan(String(state.mission ?? state.name ?? 'Company'))
  state.governanceRevision ??= 1

  if (state.tokenBudget === undefined) {
    state.tokenBudget = {
      unit: 'token',
      currency: config.defaultCurrency,
      totalTokens: config.defaultTokenBudget,
      reservedTokens: 0,
      usedTokens: 0,
      warningAtTokens: Math.max(1, Math.floor(config.defaultTokenBudget * 0.2)),
      totalCostMicros: 0,
      prices: structuredClone(config.tokenPrices),
      usage: [],
      reservations: [],
      ...(state.budget?.totalCredits === undefined ? {} : { legacyActivationCredits: state.budget.totalCredits }),
    }
  }
  state.tokenBudget.prices ??= structuredClone(config.tokenPrices)
  state.tokenBudget.usage ??= []
  state.tokenBudget.reservations ??= []
  state.tokenBudget.reservedTokens ??= 0
  state.tokenBudget.usedTokens ??= 0
  state.tokenBudget.totalCostMicros ??= 0

  const productCount = Math.max(1, state.products.length)
  const baseProductBudget = Math.max(1, Math.floor(state.tokenBudget.totalTokens / productCount))
  for (const product of state.products) product.tokenBudget ??= baseProductBudget

  state.formation ??= {
    status: state.phase === 'staged' || state.phase === 'provisioning_failed' ? 'draft' : 'approved',
    charter: `Legacy company charter migrated from mission: ${String(state.mission ?? '')}`.slice(0, 32_768),
    ...(state.products[0]?.id === undefined ? {} : { firstProductId: state.products[0].id }),
    draftedBy: 'user',
    lastEditedAt: now,
    ...(state.approvedAt === undefined ? {} : { approvedAt: state.approvedAt }),
  }
  state.health ??= { status: state.phase === 'paused' ? 'manual_pause' : 'healthy', resumable: true }
  state.orgUnits ??= []
  state.positions ??= []
  state.staffingRequests ??= []
  state.modelCatalog ??= { stale: true, generation: 0, invalidatedAt: now, models: [], errors: [] }
  for (const model of state.modelCatalog.models ?? []) model.available ??= model.advertised !== false
  state.temporaryAuthorizations ??= []
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
  }

  const hadMoneyBudget = state.moneyBudget !== undefined
  if (!hadMoneyBudget) {
    const collapsedRows = state.tokenBudget.prices.map((price: any) => collapseLegacyTokenPrice(price, 1, now))
    const hasIncompatibleLegacyPrice = collapsedRows.some((price: unknown, index: number) => price === undefined && state.tokenBudget.prices[index] !== undefined)
    const collapsed = collapsedRows.map((price: any, index: number) => price ?? {
      provider: String(state.tokenBudget.prices[index].provider),
      model: String(state.tokenBudget.prices[index].model),
      source: 'legacy',
      revision: 1,
      updatedAt: now,
    })
    const configuredKeys = new Set(collapsed.map((price: any) => `${price.provider}\u0000${price.model}`))
    for (const configured of config.modelPrices) {
      const key = `${configured.provider}\u0000${configured.model}`
      if (!configuredKeys.has(key)) collapsed.push({ ...structuredClone(configured), updatedAt: now })
    }
    const legacyUsage = state.tokenBudget.usage.map((entry: any) => {
      const inputTokens = Number(entry.inputTokens ?? 0)
      const outputTokens = Number(entry.outputTokens ?? 0)
      const cacheReadTokens = Number(entry.cacheReadTokens ?? 0)
      const cacheWriteTokens = Number(entry.cacheWriteTokens ?? 0)
      const reasoningTokens = Number(entry.reasoningTokens ?? 0)
      const inputCacheMissTokens = inputTokens + cacheWriteTokens
      const inputCacheHitTokens = cacheReadTokens
      const productId = entry.workId === undefined ? undefined : state.workItems.find((work: any) => work.id === entry.workId)?.productId
      return {
        id: entry.id,
        sessionId: entry.sessionId,
        eventSeq: entry.eventSeq,
        turn: entry.turn,
        step: entry.step,
        employeeId: entry.employeeId,
        ...(entry.workId === undefined ? {} : { workId: entry.workId }),
        ...(productId === undefined ? {} : { productId }),
        provider: entry.provider,
        model: entry.model,
        inputTokens,
        outputTokens,
        cacheReadTokens,
        cacheWriteTokens,
        reasoningTokens,
        inputCacheMissTokens,
        inputCacheHitTokens,
        totalTokens: inputCacheMissTokens + inputCacheHitTokens + outputTokens,
        costMicros: entry.priced === true ? Number(entry.costMicros ?? 0) : 0,
        priced: entry.priced === true,
        currency: String(state.tokenBudget.currency ?? config.defaultCurrency),
        pricingRevision: 0,
        ...(entry.priced === true ? { pricingProvenance: 'legacy_recorded_event' } : {}),
        at: entry.at,
      }
    })
    const bookedCostMicros = Number(state.tokenBudget.totalCostMicros ?? 0)
    const recordedEventCostMicros = legacyUsage.reduce((sum: number, entry: any) => sum + Number(entry.costMicros ?? 0), 0)
    const reconciliationCostMicros = Math.max(0, bookedCostMicros - recordedEventCostMicros)
    if (reconciliationCostMicros > 0 && state.employees.length === 0) {
      const prior = Number(state.counters.employee ?? 0)
      state.counters.employee = Math.max(0, Number.isSafeInteger(prior) ? prior : 0) + 1
      state.employees.push({
        id: `e${state.counters.employee}`,
        name: 'Legacy unattributed ledger identity',
        role: 'Preserve v0.2 booked monetary facts only',
        department: 'Legacy records',
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
    const preservedBookedCostMicros = recordedEventCostMicros + reconciliationCostMicros
    if (reconciliationCostMicros > 0 && bookedEmployeeId !== undefined) legacyUsage.push({
      id: `legacy-v02-booked-cost:${state.id}`,
      sessionId: state.founderSessionId,
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
      currency: String(state.tokenBudget.currency ?? config.defaultCurrency),
      pricingRevision: 0,
      pricingProvenance: 'legacy_recorded_total',
      at: now,
    })
    const formationCanRemediateDirectly = state.phase === 'staged' || state.phase === 'provisioning' || state.phase === 'provisioning_failed'
    state.moneyBudget = {
      unit: 'micro-currency',
      currency: String(state.tokenBudget.currency ?? config.defaultCurrency),
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
        totalTokens: state.tokenBudget.totalTokens,
        usedTokens: state.tokenBudget.usedTokens,
        reservedTokens: state.tokenBudget.reservedTokens,
        totalCostMicros: state.tokenBudget.totalCostMicros,
        prices: structuredClone(state.tokenBudget.prices),
        treatment: formationCanRemediateDirectly ? 'accepted' : 'unverified',
      },
    }
    // A v0.2 token reservation cannot safely become a currency reservation: it
    // has no call-time price revision. Revoke it and let normal recovery re-admit.
    state.tokenBudget.reservations = []
    state.tokenBudget.reservedTokens = 0
    for (const work of state.workItems) {
      work.reservationId = undefined
      work.leaseAt = undefined
    }
    if (state.phase === 'provisioning') {
      state.phase = 'provisioning_failed'
      state.formation.status = 'draft'
      state.formation.approvedAt = undefined
      state.provisioning = undefined
      for (const employee of state.employees) {
        if (employee.status === 'retired' || employee.status === 'idle') continue
        employee.status = 'failed'
        employee.failure = 'v0.3 financial migration revoked an incomplete provisioning generation; edit the formation finances and explicitly approve retry.'
      }
      for (const work of state.workItems) {
        if (work.status !== 'claimed' && work.status !== 'in_progress') continue
        work.status = 'pending'
        work.attempt = Math.max(0, Number(work.attempt ?? 0) - 1)
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
        work.reassigning = false
        work.handoffId = undefined
        work.updatedAt = now
      }
      for (const request of state.staffingRequests) {
        if (request.status !== 'in_review') continue
        request.status = 'pending'
        request.attemptId = undefined
        request.updatedAt = now
      }
    }
    if (state.phase === 'operating' || state.phase === 'halted') {
      for (const employee of state.employees) {
        if (employee.status === 'retired' || employee.status === 'failed') continue
        employee.status = 'paused'
      }
      for (const work of state.workItems) {
        if (work.status !== 'claimed' && work.status !== 'in_progress') continue
        work.status = 'pending'
        work.attempt = Math.max(0, Number(work.attempt ?? 0) - 1)
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
        work.reassigning = false
        work.handoffId = undefined
        work.updatedAt = now
      }
      for (const request of state.staffingRequests) {
        if (request.status !== 'in_review') continue
        request.status = 'pending'
        request.attemptId = undefined
        request.updatedAt = now
      }
    }
    for (const approval of state.approvals) {
      if (approval.kind !== 'budget_change' || approval.status !== 'pending') continue
      if (approval.payload?.newTotalTokens === undefined && approval.payload?.expectedTotalTokens === undefined) continue
      approval.status = 'cancelled'
      approval.resolvedAt = now
      approval.resolution = { decision: 'rejected', source: 'tool', note: 'Cancelled by v0.3 financial migration; token ceilings cannot be converted to money.' }
    }
    if (state.phase === 'operating' || state.phase === 'provisioning' || state.phase === 'halted') {
      state.phase = 'halted'
      state.pausedAt ??= now
      state.health = {
        status: 'halted',
        reason: hasIncompatibleLegacyPrice ? 'needs_budget_review' : 'financial_migration',
        detail: hasIncompatibleLegacyPrice
          ? 'Legacy four-rate prices cannot be collapsed safely; booked facts are preserved and approved remediation is required before a later manual resume.'
          : 'Human approval must establish a currency budget, three-rate prices, and allocations; clearing migration does not resume the company automatically.',
        detectedAt: now,
        resumable: false,
      }
    }
  } else {
    state.moneyBudget.prices ??= []
    state.moneyBudget.usage ??= []
    state.moneyBudget.reservations ??= []
    state.moneyBudget.reservedMicros ??= 0
    state.moneyBudget.spentMicros ??= 0
    state.moneyBudget.pricingRevision ??= 1
  }

  if (state.moneyBudget.migrationRequired === true && (state.phase === 'operating' || state.phase === 'provisioning')) {
    state.phase = 'halted'
    state.pausedAt ??= now
    state.health = { status: 'halted', reason: 'financial_migration', detail: 'Approved financial remediation and a later explicit manual resume are required.', detectedAt: now, resumable: false }
  }
  const pricingDigest = pricingMatrixDigest(state.moneyBudget)
  for (const entry of state.moneyBudget.usage) if (entry.rates !== undefined) entry.rates.pricingDigest ??= pricingDigest
  for (const reservation of state.moneyBudget.reservations) {
    if (reservation.rates !== undefined) reservation.rates.pricingDigest ??= pricingDigest
    for (const rates of reservation.routeRates ?? []) rates.pricingDigest ??= pricingDigest
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
    // v0.13: per-turn token limits were removed; strip the legacy fields.
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
    if (employee.positionId === undefined) {
      let position = state.positions.find((candidate: any) => candidate.orgUnitId === employee.orgUnitId && candidate.title === employee.role)
      if (position === undefined) {
        state.counters.position += 1
        position = { id: `pos${state.counters.position}`, title: String(employee.role), orgUnitId: employee.orgUnitId, responsibilities: [], createdAt: now }
        state.positions.push(position)
      }
      employee.positionId = position.id
    }
    if (employee.isHr === true || employee.orgUnitId === hrUnit.id) {
      employee.isHr = true
      state.hrEmployeeId ??= employee.id
    }
  }
  for (const product of state.products) product.budgetMicros ??= 0
  if (state.hrEmployeeId === undefined) {
    const legacyHr = state.employees.find((employee: any) => employee.status !== 'retired')
    if (legacyHr !== undefined) {
      legacyHr.isHr = true
      legacyHr.orgUnitId = hrUnit.id
      legacyHr.positionId = hrPosition.id
      legacyHr.department = hrUnit.name
      state.hrEmployeeId = legacyHr.id
    }
  }
  return value
}

function deriveSlogan(value: string): string {
  const normalized = value.normalize('NFC').trim()
  const first = normalized.split(/(?<=[.!?。！？])\s*/u, 1)[0]?.trim() ?? normalized
  return (first || 'Company').slice(0, 160)
}
