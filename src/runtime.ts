import { randomUUID } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import { createApproval, consumeApproval, requireApproved, resolveApproval } from './approvals.js'
import {
  adjustMoneyBudgetTotal,
  activeMoneyReservation,
  CompanyUnpricedModelError,
  matchModelPrice,
  pricingMatrixDigest,
  releaseEmployeeMoneyReservations,
  releaseMoneyReservation,
  replaceModelPrices,
  reserveMoneyTurn,
  resolveModelContextWindow,
  resolveRateSnapshot,
} from './money.js'
import { createTemporaryAuthorization, revokeTemporaryAuthorization as revokeAuthorizationRecord } from './authorizations.js'
import { invalidateModelCatalog, probeRegisteredModels } from './models.js'
import {
  activateFallback,
  activeSelection,
  allocateEmployeeSessionId,
  deliverEmployee,
  employeeLabel,
  installEmployeeSelectionRuntime,
  interruptEmployee,
  isFallbackEligible,
  resolveEmployeeSelection,
  startEmployee,
  untrustedParticipantMessage,
  waitForEmployeeIdle,
  type SelectionRuntime,
} from './employees.js'
import { normalizeMultilineString, normalizeString, normalizeWorkspaceRelative } from './paths.js'
import { assertAcyclic, isRecord, currencyUnitsToMicros, normalizeCurrency, normalizeModelPrices, validateApprovalPayload } from './schemas.js'
import { makeMailboxRoom, RevisionConflictError, type CompanyStore, type MutationContext } from './state.js'
import { COMPANY_STATE_SCHEMA_VERSION } from './types.js'
import type {
  AddEmployeeInput,
  ApprovalKind,
  ApprovalRequest,
  BootstrapInput,
  BudgetChangeInput,
  CompanyActionRequest,
  CompanyActor,
  CompanyMessage,
  CompanySnapshot,
  CompanyState,
  CompanyUiAction,
  CreateProductInput,
  CreateWorkInput,
  EditFormationInput,
  Employee,
  GovernanceChangeInput,
  GrantTemporaryAuthorizationInput,
  RevokeTemporaryAuthorizationInput,
  JsonValue,
  StaffingAssessmentInput,
  StaffingRequest,
  StaffingRequestInput,
  TemporaryAuthorization,
  Product,
  ProductStatus,
  ResolvedCompanyConfig,
  UpdateWorkInput,
  WorkItem,
  WorkKind,
  FileTicketInput,
  Ticket,
  TicketSeverity,
} from './types.js'
import {
  beginWorkAttempt,
  canEmployeeOwn,
  finishHandoff,
  invalidateAttempt,
  isOpenStatus,
  requireWork,
  updateWork,
  validateDependencyReplacement,
} from './work.js'
import { buildSnapshot } from './snapshot.js'

export interface SchedulerHandle {
  kick(cwd: string | undefined, suppliedFounder?: Agent): Promise<void>
  dispose?(): void | Promise<void>
}

type ListChildren = Context['subagents']['listChildren']
const MAX_MESSAGE_DELIVERY_ATTEMPTS = 3

export interface OperationSource {
  source: 'tool' | 'ui'
  expectedRevision?: number
  humanStatement?: string
}

/** Authoritative host-side company orchestration API shared by tools and HTTP. */
export class CompanyRuntime {
  readonly ctx: Context
  readonly config: ResolvedCompanyConfig
  readonly store: CompanyStore
  readonly selections: SelectionRuntime
  private scheduler?: SchedulerHandle
  private closing = false
  private modelTopologyEpoch = 0
  private modelTopologyChangedAt = 0
  private readonly recoveries = new Map<string, Promise<void>>()

  constructor(ctx: Context, config: ResolvedCompanyConfig, store: CompanyStore) {
    this.ctx = ctx
    this.config = config
    this.store = store
    this.selections = installEmployeeSelectionRuntime(ctx, store)
  }

  attachScheduler(scheduler: SchedulerHandle): void {
    this.scheduler = scheduler
  }

  stopAdmission(): void {
    this.closing = true
  }

  noteModelTopologyChange(): void {
    this.modelTopologyEpoch += 1
    this.modelTopologyChangedAt = Math.max(Date.now(), this.modelTopologyChangedAt + 1)
  }

  /** Resume durable sagas that may have been interrupted by Host/plugin restart. */
  async recoverWorkspace(founder: Agent): Promise<void> {
    if (this.closing) return
    const key = String(founder.id)
    const pending = this.recoveries.get(key)
    if (pending !== undefined) return pending
    const recovery = this.recoverWorkspaceOnce(founder)
    this.recoveries.set(key, recovery)
    try {
      await recovery
    } finally {
      if (this.recoveries.get(key) === recovery) this.recoveries.delete(key)
    }
  }

  private async recoverWorkspaceOnce(founder: Agent): Promise<void> {
    let state = await this.store.readActive(founder.session.header.cwd)
    if (state === undefined || String(founder.id) !== state.founderSessionId) return
    this.assertFounderState(founder, state)
    if (state.phase === 'provisioning' && state.provisioning !== undefined) {
      await this.continueBootstrapProvisioning(founder, state.provisioning.id)
      return
    }
    if (state.phase !== 'operating') return

    if (state.workItems.some((work) => work.reassigning === true)) {
      state = (await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'work.handoffs_recovered', summary: 'Finalized crash-interrupted work handoffs with revoked capabilities',
      }, (fresh) => {
        for (const work of fresh.workItems) {
          if (work.reassigning !== true) continue
          work.reassigning = false
          work.handoffId = undefined
          work.updatedAt = Date.now()
        }
      })).state
    }

    const known = await this.knownEmployeeSessions(founder, state)
    for (const employee of state.employees.filter((candidate) => candidate.status === 'provisioning' && candidate.sessionId !== undefined)) {
      const request = state.staffingRequests.find((candidate) => candidate.employeeId === employee.id && candidate.status === 'approved')
      if (request === undefined) continue
      await this.continueStaffingProvisioning(founder, employee.id, request.id, known.has(employee.sessionId!))
      state = await this.store.readActive(founder.session.header.cwd) ?? state
    }
    this.kick(founder.session.header.cwd, founder)
  }

  async bootstrap(founder: Agent, input: BootstrapInput): Promise<{ companyId: string; phase: string; revision: number; stateRootDisplay: string }> {
    this.assertAdmission()
    this.assertBootstrapActor(founder)
    const latestUser = latestGenuineUserMessage(founder)
    if (latestUser === undefined) throw new Error('company bootstrap requires a genuine user-source message in the founder session')
    const existing = await this.store.readActive(founder.session.header.cwd)
    if (existing !== undefined) throw new Error(`workspace already has active company ${existing.id} (${existing.phase})`)
    const workspace = await this.store.pathsForCwd(founder.session.header.cwd, true)
    const now = Date.now()
    const name = normalizeString(input.name, 'company name', 200)
    const mission = normalizeMultilineString(input.mission, 'company mission', 16_384)
    const slogan = normalizeString(input.slogan ?? deriveSlogan(mission), 'company slogan', 160)
    const charter = normalizeMultilineString(input.charter, 'company charter', 32_768)
    const totalBudgetMicros = boundedMicros(input.totalBudgetMicros, this.config.maxMoneyBudgetMicros, 'total_budget_micros')
    const currency = normalizeCurrency(input.currency)
    const modelPrices = input.modelPrices === undefined
      ? this.config.modelPrices.map((price) => ({ ...structuredClone(price), updatedAt: now }))
      : normalizeModelPrices(input.modelPrices, 'manual', 1, now)
    const productRoot = normalizeWorkspaceRelative(workspace.workspace.canonicalPath, input.firstProduct.productRoot, 'first_product.product_root')
    const productBudgetMicros = boundedMicros(input.firstProduct.budgetMicros, totalBudgetMicros, 'first_product.budget_micros')
    const successCriteria = normalizeList(input.firstProduct.successCriteria, 'first_product.success_criteria', 1, 256, 16_384)
    const hrName = normalizeString(input.hrName ?? 'People & Model Governance Lead', 'hr_name', 200)
    const hrSelection = await resolveEmployeeSelection(this.ctx, founder, this.config, {
      ...(input.hrProvider === undefined ? {} : { provider: input.hrProvider }),
      ...(input.hrModel === undefined ? {} : { model: input.hrModel }),
      ...(input.hrReasoningEffort === undefined ? {} : { reasoningEffort: input.hrReasoningEffort }),
    })
    let modelCatalog: CompanyState['modelCatalog'] = { stale: true, generation: 0, models: [], errors: [] }
    try {
      if (typeof this.ctx.llm.listProviders === 'function') modelCatalog = await probeRegisteredModels(this.ctx, modelCatalog)
    } catch (error) {
      modelCatalog = { stale: true, generation: 0, models: [], errors: [{ provider: '*', message: boundedError(error) }] }
    }
    const formationRoutes = [
      { provider: hrSelection.provider, model: hrSelection.model },
      ...(hrSelection.fallback === undefined ? [] : [hrSelection.fallback]),
    ]
    for (const route of formationRoutes) if (!modelCatalog.models.some((candidate) => candidate.provider === route.provider && candidate.model === route.model)) {
      modelCatalog.models.push({ provider: route.provider, model: route.model, name: route.model, advertised: false, available: true })
    }
    const companyId = `c_${randomUUID()}`
    const state: CompanyState = {
      schemaVersion: COMPANY_STATE_SCHEMA_VERSION,
      revision: 1,
      id: companyId,
      name,
      slogan,
      mission,
      governanceRevision: 1,
      workspaceHash: workspace.workspace.sha256,
      founderSessionId: String(founder.id),
      stagedFromUserMessageId: String(latestUser.id),
      phase: 'staged',
      createdAt: now,
      updatedAt: now,
      limits: {
        maxEmployees: this.config.maxEmployees,
        maxProducts: this.config.maxProducts,
        maxWorkItems: this.config.maxWorkItems,
        maxOpenWorkItems: this.config.maxOpenWorkItems,
        maxAttemptsPerWork: this.config.maxAttemptsPerWork,
        maxPendingApprovals: this.config.maxPendingApprovals,
        maxMailboxMessages: this.config.maxMailboxMessages,
        maxAuditBytes: this.config.maxAuditBytes,
        maxMessageChars: this.config.maxMessageChars,
        maxOutputChars: this.config.maxOutputChars,
        memberMaxDepth: this.config.memberMaxDepth,
      },
      counters: { employee: 1, product: 1, work: 0, approval: 1, event: 0, orgUnit: 2, position: 1, staffing: 0, authorization: 0, ticket: 0 },
      moneyBudget: {
        unit: 'micro-currency', currency, totalMicros: totalBudgetMicros, reservedMicros: 0, spentMicros: 0,
        warningAtMicros: Math.max(1, Math.floor(totalBudgetMicros * 0.2)), pricingRevision: 1,
        prices: modelPrices, usage: [], reservations: [], migrationRequired: false,
      },
      modelCatalog,
      temporaryAuthorizations: [],
      formation: { status: 'draft', charter, firstProductId: 'p1', draftedBy: input.draftedBy ?? 'ai', lastEditedAt: now },
      health: { status: 'healthy', resumable: true },
      orgUnits: [
        { id: 'ou1', name, kind: 'company', description: `${slogan}\n${mission}`.slice(0, 4096), createdAt: now },
        { id: 'ou2', name: 'Human Resources', kind: 'department', parentId: 'ou1', description: 'Staffing, model-route, reasoning-depth, and organizational-governance authority.', managerEmployeeId: 'e1', createdAt: now },
      ],
      positions: [{
        id: 'pos1', title: 'Head of People & Model Governance', orgUnitId: 'ou2',
        responsibilities: ['Assess work difficulty', 'Recommend provider, model, and reasoning effort', 'Govern hiring and member adjustments'], createdAt: now,
      }],
      staffingRequests: [],
      hrEmployeeId: 'e1',
      employees: [{
        id: 'e1', name: hrName, role: 'Head of People & Model Governance',
        orgUnitId: 'ou2', positionId: 'pos1', isHr: true, budgetMicros: totalBudgetMicros,
        status: 'planned', llm: hrSelection,
        executionPrompt: 'Assess staffing work difficulty and submit structured, bounded model-route and reasoning-effort recommendations. Never estimate or report token usage or money; the plugin accounts for those programmatically.',
      }],
      products: [{
        id: 'p1', name: normalizeString(input.firstProduct.name, 'first product name', 200),
        summary: normalizeMultilineString(input.firstProduct.summary, 'first product summary', 16_384), status: 'approved',
        productRoot, successCriteria, budgetMicros: productBudgetMicros, createdAt: now, updatedAt: now,
      }],
      workItems: [],
      tickets: [],
      governanceNotifications: [],
      approvals: [{
        id: 'a1', kind: 'bootstrap', status: 'pending', requestedBy: 'founder',
        summary: `Approve formation plan for ${name}, its governance, monetary budget/pricing, HR authority, and first product`,
        payload: { companyId, stagedRevision: 1 }, risk: 'high', requestedAt: now,
        requestedFromUserMessageId: String(latestUser.id),
      }],
    }
    await this.store.createStaged(founder.session.header.cwd, state)
    return { companyId: state.id, phase: state.phase, revision: state.revision, stateRootDisplay: `${this.config.stateRootDisplay}/v1/workspaces/${workspace.workspace.key}/active` }
  }

  async editFormation(founder: Agent, input: EditFormationInput, expectedRevision?: number): Promise<CompanyState> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const currentHr = located.state.hrEmployeeId === undefined ? undefined : located.state.employees.find((employee) => employee.id === located.state.hrEmployeeId)
    if ((input.hrName !== undefined || input.hrProvider !== undefined || input.hrModel !== undefined || input.hrReasoningEffort !== undefined) && currentHr === undefined) throw new Error('formation has no HR lead to edit')
    if ((input.hrProvider === undefined) !== (input.hrModel === undefined)) throw new Error('hr_provider and hr_model must be supplied together')
    const currentHrRoute = currentHr === undefined ? undefined : activeSelection(currentHr.llm)
    const requestedEffort = input.hrReasoningEffort?.trim().toLowerCase() === 'default' ? undefined : input.hrReasoningEffort?.trim()
    const editHrSelection = (input.hrProvider !== undefined && (input.hrProvider.trim() !== currentHrRoute?.provider || input.hrModel?.trim() !== currentHrRoute.model))
      || (input.hrReasoningEffort !== undefined && requestedEffort !== currentHrRoute?.reasoningEffort)
    const hrSelection = !editHrSelection ? undefined : await resolveEmployeeSelection(this.ctx, founder, this.config, {
      provider: input.hrProvider ?? currentHr?.llm.provider,
      model: input.hrModel ?? currentHr?.llm.model,
      ...(input.hrReasoningEffort === undefined ? {} : { reasoningEffort: input.hrReasoningEffort }),
    })
    const hrModelInfo = hrSelection === undefined ? undefined : await this.ctx.llm.resolveModelInfo(hrSelection.provider, hrSelection.model).catch(() => undefined)
    const workspace = (await this.store.pathsForCwd(founder.session.header.cwd, false)).workspace.canonicalPath
    const result = await this.store.transact(founder.session.header.cwd, {
      expectedRevision,
      actor: 'founder',
      type: 'formation.edited',
      summary: 'Edited the staged formation proposal before human approval',
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (state.phase !== 'staged' && state.phase !== 'provisioning_failed') throw new Error('formation may be edited only before successful provisioning')
      if (state.formation.status !== 'draft') throw new Error('approved formation is immutable')
      const first = state.formation.firstProductId === undefined ? undefined : state.products.find((product) => product.id === state.formation.firstProductId)
      if (first === undefined) throw new Error('formation has no first product to edit')
      const hr = state.hrEmployeeId === undefined ? undefined : state.employees.find((employee) => employee.id === state.hrEmployeeId)
      if ((input.hrName !== undefined || hrSelection !== undefined) && hr === undefined) throw new Error('formation has no HR lead to edit')
      if (hr !== undefined) {
        if (input.hrName !== undefined) hr.name = normalizeString(input.hrName, 'hr_name', 200)
        if (hrSelection !== undefined) {
          releaseEmployeeMoneyReservations(state, hr.id)
          hr.llm = hrSelection
          const capability = {
            provider: hrSelection.provider,
            model: hrSelection.model,
            name: hrModelInfo?.name ?? hrSelection.model,
            ...(hrModelInfo?.description === undefined ? {} : { description: hrModelInfo.description }),
            ...(hrModelInfo?.inputModalities === undefined ? {} : { inputModalities: [...hrModelInfo.inputModalities] }),
            ...(hrModelInfo?.context?.contextWindow === undefined ? {} : { contextWindow: hrModelInfo.context.contextWindow }),
            ...(hrModelInfo?.defaultMaxTokens === undefined ? {} : { defaultMaxTokens: hrModelInfo.defaultMaxTokens }),
            advertised: state.modelCatalog.models.some((model) => model.provider === hrSelection.provider && model.model === hrSelection.model && model.advertised),
            available: true,
          }
          const catalogIndex = state.modelCatalog.models.findIndex((model) => model.provider === hrSelection.provider && model.model === hrSelection.model)
          if (catalogIndex < 0) state.modelCatalog.models.push(capability)
          else state.modelCatalog.models[catalogIndex] = { ...state.modelCatalog.models[catalogIndex]!, ...capability }
          hr.sessionId = allocateEmployeeSessionId()
          hr.status = 'planned'
          hr.failure = undefined
        }
      }
      if (input.name !== undefined) {
        state.name = normalizeString(input.name, 'company name', 200)
        const root = state.orgUnits.find((unit) => unit.parentId === undefined)
        if (root !== undefined) root.name = state.name
      }
      if (input.slogan !== undefined) state.slogan = normalizeString(input.slogan, 'company slogan', 160)
      if (input.mission !== undefined) state.mission = normalizeMultilineString(input.mission, 'company mission', 16_384)
      if (input.slogan !== undefined || input.mission !== undefined) {
        const root = state.orgUnits.find((unit) => unit.parentId === undefined)
        if (root !== undefined) root.description = `${state.slogan}\n${state.mission}`.slice(0, 4096)
      }
      if (input.charter !== undefined) state.formation.charter = normalizeMultilineString(input.charter, 'company charter', 32_768)
      if (input.currency !== undefined || input.modelPrices !== undefined) {
        const nextCurrency = input.currency === undefined ? state.moneyBudget.currency : normalizeCurrency(input.currency)
        if (nextCurrency !== state.moneyBudget.currency && (
          state.moneyBudget.usage.length > 0 || state.moneyBudget.reservations.length > 0 || state.moneyBudget.legacyV02 !== undefined
        )) throw new Error('currency is immutable after any usage, reservation, or legacy ledger')
        if (nextCurrency !== state.moneyBudget.currency && input.modelPrices === undefined) throw new Error('changing currency requires an explicit replacement model price matrix; old numeric rates are never relabeled')
        state.moneyBudget.currency = nextCurrency
        if (input.modelPrices !== undefined) {
          const normalized = normalizeModelPrices(input.modelPrices, 'manual', state.moneyBudget.pricingRevision + 1, Date.now())
          replaceModelPrices(state, normalized)
        }
      }
      if (input.totalBudgetMicros !== undefined) {
        const total = boundedMicros(input.totalBudgetMicros, this.config.maxMoneyBudgetMicros, 'total_budget_micros')
        const nextFirstProductBudget = input.firstProduct?.budgetMicros ?? first.budgetMicros ?? 0
        if (nextFirstProductBudget > total) throw new Error('first product monetary budget exceeds company monetary budget')
        if (input.firstProduct?.budgetMicros !== undefined) first.budgetMicros = boundedMicros(input.firstProduct.budgetMicros, total, 'first_product.budget_micros')
        if (hr !== undefined && (hr.budgetMicros ?? 0) > total) hr.budgetMicros = total
        adjustMoneyBudgetTotal(state, total)
      }
      if (input.firstProduct !== undefined) {
        if (input.firstProduct.name !== undefined) first.name = normalizeString(input.firstProduct.name, 'first product name', 200)
        if (input.firstProduct.summary !== undefined) first.summary = normalizeMultilineString(input.firstProduct.summary, 'first product summary', 16_384)
        if (input.firstProduct.productRoot !== undefined) first.productRoot = normalizeWorkspaceRelative(workspace, input.firstProduct.productRoot, 'first_product.product_root')
        if (input.firstProduct.successCriteria !== undefined) first.successCriteria = normalizeList(input.firstProduct.successCriteria, 'first_product.success_criteria', 1, 256, 16_384)
        if (input.firstProduct.budgetMicros !== undefined) first.budgetMicros = boundedMicros(input.firstProduct.budgetMicros, state.moneyBudget.totalMicros, 'first_product.budget_micros')
        first.updatedAt = Date.now()
      }
      state.formation.draftedBy = 'user'
      state.formation.lastEditedAt = Date.now()
      const pending = state.approvals.find((approval) => approval.kind === 'bootstrap' && approval.status === 'pending')
      if (pending !== undefined) pending.payload = { companyId: state.id, stagedRevision: state.revision + 1 }
    })
    return result.state
  }

  async requestStaffing(founder: Agent, input: StaffingRequestInput): Promise<StaffingRequest> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const workProfile = normalizeMultilineString(input.workProfile, 'staffing work_profile', 16_384)
    const constraints = input.constraints === undefined ? undefined : normalizeMultilineString(input.constraints, 'staffing constraints', 8192)
    const result = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder', type: 'staffing.requested', summary: `Requested HR assessment for ${input.action}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (!['operating', 'paused', 'halted'].includes(state.phase)) throw new Error('staffing requests begin only after the HR employee is provisioned')
      const activeRequests = state.staffingRequests.filter((request) => !['rejected', 'applied'].includes(request.status)).length
      if (activeRequests >= state.limits.maxPendingApprovals) throw new Error(`active staffing request cap ${state.limits.maxPendingApprovals} reached`)
      const hrEmployeeId = state.hrEmployeeId
      const hr = hrEmployeeId === undefined ? undefined : state.employees.find((employee) => employee.id === hrEmployeeId && employee.isHr === true && employee.status !== 'retired')
      if (hr === undefined) throw new Error('company has no active HR governance employee')
      if (input.action === 'hire' && input.candidateName === undefined) throw new Error('hire staffing request requires candidate_name')
      if (input.action !== 'hire' && input.employeeId === undefined) throw new Error(`${input.action} staffing request requires employee_id`)
      if (input.action === 'hire') {
        const candidateName = normalizeString(input.candidateName!, 'candidate name', 200)
        if (state.employees.some((employee) => employee.status !== 'retired' && employee.name.localeCompare(candidateName, undefined, { sensitivity: 'accent' }) === 0)) throw new Error(`active employee name ${JSON.stringify(candidateName)} already exists`)
        const duplicate = state.staffingRequests.find((request) => request.action === 'hire' && request.candidateName?.localeCompare(candidateName, undefined, { sensitivity: 'accent' }) === 0 && !['rejected', 'applied'].includes(request.status))
        if (duplicate !== undefined) throw new Error(`candidate ${JSON.stringify(candidateName)} already has active staffing request ${duplicate.id}`)
      }
      if (input.employeeId !== undefined) {
        const target = requireEmployee(state, input.employeeId)
        if (target.status === 'retired') throw new Error(`employee ${target.id} is already retired`)
        const duplicate = state.staffingRequests.find((request) => request.employeeId === target.id && !['rejected', 'applied'].includes(request.status))
        if (duplicate !== undefined) throw new Error(`employee ${target.id} already has active staffing request ${duplicate.id}`)
      }
      state.counters.staffing += 1
      const now = Date.now()
      const request: StaffingRequest = {
        id: `sr${state.counters.staffing}`,
        action: input.action,
        status: 'pending',
        requestedBy: 'founder',
        ...(input.candidateName === undefined ? {} : { candidateName: normalizeString(input.candidateName, 'candidate name', 200) }),
        ...(input.employeeId === undefined ? {} : { employeeId: input.employeeId }),
        workProfile,
        ...(constraints === undefined ? {} : { constraints }),
        hrEmployeeId: hr.id,
        createdAt: now,
        updatedAt: now,
      }
      state.staffingRequests.push(request)
      return structuredClone(request)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  async claimStaffingAssessment(caller: Agent, requestId: string): Promise<{ requestId: string; attemptId: string }> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    if (located.actor.kind !== 'employee') throw new Error('only the designated HR employee can claim staffing assessments')
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id, type: 'staffing.claimed', summary: `${located.actor.id} claimed staffing assessment ${requestId}`,
    }, (state) => {
      if (state.phase !== 'operating') throw new Error(`staffing assessments are paused while company is ${state.phase}`)
      const employee = requireEmployeeRunnable(state, located.actor.id)
      if (employee.isHr !== true || state.hrEmployeeId !== employee.id) throw new Error('caller is not the designated HR governance employee')
      const request = requireStaffingRequest(state, requestId)
      if (request.hrEmployeeId !== employee.id) throw new Error('staffing request belongs to another HR employee')
      if (request.status === 'in_review' && request.attemptId !== undefined) return { requestId: request.id, attemptId: request.attemptId }
      if (request.status !== 'pending') throw new Error(`staffing request ${request.id} is ${request.status}`)
      request.status = 'in_review'
      request.attemptId = randomUUID()
      request.reviewDeliveryAttempts = 1
      request.updatedAt = Date.now()
      return { requestId: request.id, attemptId: request.attemptId }
    })
    return result.result
  }

  async submitStaffingAssessment(caller: Agent, input: StaffingAssessmentInput): Promise<StaffingRequest> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    if (located.actor.kind !== 'employee') throw new Error('only the designated HR employee can submit staffing assessments')
    const preview = requireStaffingRequest(located.state, input.requestId)
    const retirement = preview.action === 'retire'
    const target = !retirement || preview.employeeId === undefined ? undefined : requireEmployee(located.state, preview.employeeId)
    if (target?.status === 'retired') throw new Error(`employee ${target.id} is already retired`)
    if (!retirement && (input.provider === undefined || input.model === undefined || input.budgetMicros === undefined || input.orgPath === undefined || input.positionTitle === undefined || input.responsibilities === undefined)) {
      throw new Error('hire/adjust staffing assessment requires provider, model, employee_budget, org_path, position_title, and responsibilities')
    }
    if ((input.provider === undefined) !== (input.model === undefined)) throw new Error('provider and model must be supplied together')
    const founder = this.liveFounder(located.state)
    if (founder === undefined) throw new Error('founder session must be live to validate staffing')
    const targetRoute = target === undefined ? undefined : activeSelection(target.llm)
    const selection = retirement
      ? { provider: targetRoute!.provider, model: targetRoute!.model, ...(targetRoute!.reasoningEffort === undefined ? {} : { reasoningEffort: targetRoute!.reasoningEffort }) }
      : await resolveEmployeeSelection(this.ctx, founder, this.config, {
        provider: input.provider!, model: input.model!, ...(input.reasoningEffort === undefined ? {} : { reasoningEffort: input.reasoningEffort }),
      })
    // New/adjusted routes draw only from models enabled on the recruiting page.
    // Retirement has no future model admission and must remain possible even if
    // the old employee's provider or price row disappeared.
    if (!retirement && matchModelPrice(located.state.moneyBudget.prices, selection.provider, selection.model) === undefined) {
      throw new CompanyUnpricedModelError(selection.provider, selection.model,
        'HR may only recommend models enabled (three-rate priced) on the recruiting page; ask the founder to enable this route first')
    }
    const targetPosition = target?.positionId === undefined ? undefined : located.state.positions.find((position) => position.id === target.positionId)
    const assessedBudget = retirement ? target?.budgetMicros ?? 0 : input.budgetMicros!
    const assessedOrgPath = retirement ? orgPathForEmployee(located.state, target!) : input.orgPath!
    const assessedPosition = retirement ? target?.role ?? 'Retiring employee' : input.positionTitle!
    const assessedResponsibilities = retirement ? targetPosition?.responsibilities ?? ['Preserve handover and retirement record'] : input.responsibilities!
    const approvalUserMessage = latestGenuineUserMessage(founder)
    if (approvalUserMessage === undefined) throw new Error('staffing recommendations require a genuine founder-session user message anchor')
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id, type: 'staffing.recommended', summary: `${located.actor.id} submitted staffing assessment ${input.requestId}`,
    }, async (state, io) => {
      if (state.phase !== 'operating') throw new Error(`staffing assessments are paused while company is ${state.phase}`)
      const employee = requireEmployeeRunnable(state, located.actor.id)
      if (employee.isHr !== true || state.hrEmployeeId !== employee.id) throw new Error('caller is not the designated HR governance employee')
      const request = requireStaffingRequest(state, input.requestId)
      if (request.status !== 'in_review' || request.attemptId !== input.attemptId) throw new Error('stale staffing assessment capability')
      if (request.action === 'retire' && input.designateAsHr === true) throw new Error('retirement recommendations cannot designate HR authority')
      if (request.action !== 'retire' && matchModelPrice(state.moneyBudget.prices, selection.provider, selection.model) === undefined) {
        throw new CompanyUnpricedModelError(selection.provider, selection.model, 'was disabled before the staffing recommendation committed; re-enable it and retry')
      }
      request.recommendation = {
        difficulty: input.difficulty,
        provider: selection.provider,
        model: selection.model,
        ...(selection.reasoningEffort === undefined ? {} : { reasoningEffort: selection.reasoningEffort }),
        budgetMicros: boundedMicros(assessedBudget, state.moneyBudget.totalMicros, 'budget_micros'),
        rationale: normalizeMultilineString(input.rationale, 'staffing rationale', 16_384),
        orgPath: normalizeList(assessedOrgPath, 'org_path', 1, 16, 200),
        positionTitle: normalizeString(assessedPosition, 'position title', 500),
        responsibilities: normalizeList(assessedResponsibilities, 'responsibilities', 1, 128, 4096),
        ...(input.designateAsHr === undefined ? {} : { designateAsHr: input.designateAsHr }),
        assessedAt: Date.now(),
      }
      request.status = 'recommended'
      request.attemptId = undefined
      request.updatedAt = Date.now()
      const approval = createApproval(state, employee.id, {
        kind: 'organization_change',
        summary: `Approve HR staffing recommendation ${request.id}: ${request.action}`,
        detail: request.action === 'retire'
          ? `HR recommends retiring ${request.employeeId}. Rationale: ${request.recommendation.rationale}. Open work will be capability-revoked and requeued; applying is a separate explicit step after approval.`
          : `HR recommends ${request.action === 'hire' ? 'hiring' : request.action} ${request.candidateName === undefined ? request.employeeId ?? 'a team member' : request.candidateName} as ${request.recommendation.positionTitle} under ${request.recommendation.orgPath.join(' / ') || 'the company root'}, running ${request.recommendation.provider}/${request.recommendation.model} with a ${(request.recommendation.budgetMicros ?? 0) / 1_000_000}-unit employee budget${request.recommendation.designateAsHr === true ? ', and transferring singleton HR governance authority after successful provisioning' : ''}. Applying is a separate explicit step after approval.`,
        payload: { action: request.action, staffingRequestId: request.id, ...(request.employeeId === undefined ? {} : { employeeId: request.employeeId }), ...(request.recommendation.budgetMicros === undefined ? {} : { budgetMicros: request.recommendation.budgetMicros }), ...(request.recommendation.designateAsHr === true ? { designateAsHr: true } : {}) },
        risk: request.action === 'retire' || request.recommendation.designateAsHr === true ? 'high' : 'medium',
        ...(approvalUserMessage === undefined ? {} : { requestedFromUserMessageId: String(approvalUserMessage.id) }),
      })
      request.approvalId = approval.id
      await queueFounderNotification(state, io, employee.id, `HR completed staffing assessment ${request.id}. The recommendation is recorded as approval ${approval.id} and awaits the human decision; use company_status for the bounded details.`)
      return structuredClone(request)
    })
    this.kick(caller.session.header.cwd, founder)
    return result.result
  }

  async addEmployee(founder: Agent, input: AddEmployeeInput, signal?: AbortSignal): Promise<Employee> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const planned = located.state.staffingRequests.find((request) => request.id === input.staffingRequestId)
    if (planned === undefined || planned.action !== 'hire' || planned.recommendation === undefined) throw new Error('employee hiring requires a completed HR staffing recommendation')
    const recommendation = planned.recommendation
    const name = normalizeString(planned.candidateName ?? input.name, 'employee name', 200)
    const role = normalizeString(recommendation.positionTitle, 'employee role', 1000)
    if (normalizeString(input.name, 'employee name', 200) !== name || normalizeString(input.role, 'employee role', 1000) !== role) throw new Error('employee name and role must match the approved HR recommendation')
    const selection = await resolveEmployeeSelection(this.ctx, founder, this.config, {
      provider: recommendation.provider, model: recommendation.model,
      ...(recommendation.reasoningEffort === undefined ? {} : { reasoningEffort: recommendation.reasoningEffort }),
    }, signal)
    const executionPrompt = input.executionPrompt === undefined ? undefined : normalizeMultilineString(input.executionPrompt, 'execution_prompt', 16_384)
    let reservationId: string | undefined
    const prepared = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder', type: 'employee.provisioning_prepared', summary: `Prepared approved HR hire ${planned.id} for ${name}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (state.phase !== 'operating') throw new Error(`cannot hire while company is ${state.phase}; resume first`)
      const request = requireStaffingRequest(state, planned.id)
      if (request.approvalId !== input.approvalId || request.recommendation === undefined) throw new Error('staffing recommendation is not ready for application')
      if (matchModelPrice(state.moneyBudget.prices, selection.provider, selection.model) === undefined) throw new CompanyUnpricedModelError(selection.provider, selection.model)

      let employee: Employee
      if (request.employeeId !== undefined) {
        employee = requireEmployee(state, request.employeeId)
        if (request.status === 'applied' && employee.status !== 'failed' && employee.status !== 'provisioning') return structuredClone(employee)
        if (request.status !== 'approved' || employee.status !== 'failed') throw new Error('hire provisioning is not retryable in its current state')
        const approval = state.approvals.find((candidate) => candidate.id === input.approvalId)
        if (approval?.kind !== 'organization_change' || approval.status !== 'approved' || approval.consumedAt === undefined) throw new Error('hire retry lost its consumed organization approval')
        releaseEmployeeMoneyReservations(state, employee.id)
        employee.sessionId = allocateEmployeeSessionId()
        employee.status = 'provisioning'
        employee.failure = undefined
        employee.llm = selection
        employee.executionPrompt = executionPrompt
      } else {
        if (request.status !== 'approved') throw new Error('staffing recommendation must be human-approved before hiring')
        const activeHeadcount = state.employees.filter((candidate) => candidate.status !== 'retired').length
        if (activeHeadcount >= Math.min(state.limits.maxEmployees, this.config.maxEmployees)) throw new Error('active employee headcount cap reached')
        if (state.employees.some((candidate) => candidate.status !== 'retired' && candidate.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)) throw new Error(`active employee name ${JSON.stringify(name)} already exists`)
        const approval = requireApproved(state, input.approvalId, 'organization_change', (payload) => isRecord(payload) && payload.action === 'hire' && payload.staffingRequestId === request.id && (payload.designateAsHr === true) === (recommendation.designateAsHr === true))
        const orgUnit = ensureOrgPath(state, recommendation.orgPath)
        const position = ensurePosition(state, orgUnit.id, recommendation.positionTitle, recommendation.responsibilities)
        state.counters.employee += 1
        employee = {
          id: `e${state.counters.employee}`, name, role, orgUnitId: orgUnit.id, positionId: position.id,
          budgetMicros: recommendation.budgetMicros ?? 0,
          ...(recommendation.designateAsHr === true ? { isHr: true } : {}),
          status: 'provisioning', sessionId: allocateEmployeeSessionId(), llm: selection,
          ...(executionPrompt === undefined ? {} : { executionPrompt }),
        }
        if ((employee.budgetMicros ?? 0) > state.moneyBudget.totalMicros) throw new Error('employee monetary ceiling exceeds company budget')
        state.employees.push(employee)
        request.employeeId = employee.id
        consumeApproval(approval)
      }
      reservationId = this.reserveEmployeeTurn(state, employee)
      request.status = 'approved'
      request.updatedAt = Date.now()
      return structuredClone(employee)
    })
    const employee = prepared.result
    if (employee.status !== 'provisioning') return employee
    let childAccepted = false
    try {
      await startEmployee(this.ctx, this.config, this.selections, founder, prepared.state, employee, signal ?? new AbortController().signal)
      childAccepted = true
      const accepted = await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'employee.provisioned', summary: `Employee ${employee.id} continuable session accepted`,
      }, (state) => {
        const request = requireStaffingRequest(state, planned.id)
        const current = requireEmployee(state, employee.id)
        if (current.sessionId !== employee.sessionId || current.status !== 'provisioning') throw new Error('hire provisioning was superseded')
        current.status = state.phase === 'operating' ? 'idle' : 'paused'
        current.joinedAt ??= Date.now()
        current.failure = undefined
        this.applyHrSuccession(state, request, current)
        request.status = 'applied'
        request.updatedAt = Date.now()
        return structuredClone(current)
      })
      if (accepted.state.phase === 'operating') this.kick(founder.session.header.cwd, founder)
      return accepted.result
    } catch (error) {
      if (childAccepted && employee.sessionId !== undefined) {
        await this.ctx.subagents.drainContinuableChildren(founder, [SessionId(employee.sessionId)]).catch(() => undefined)
        await this.store.recordRetiredSession(founder.session.header.cwd, employee.sessionId).catch(() => undefined)
      }
      await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'employee.provisioning_failed', summary: `Employee ${employee.id} provisioning failed and remains retryable`,
      }, (state) => {
        releaseMoneyReservation(state, reservationId)
        const current = requireEmployee(state, employee.id)
        if (current.sessionId === employee.sessionId) {
          current.status = 'failed'
          current.failure = boundedError(error)
        }
        const request = requireStaffingRequest(state, planned.id)
        request.status = 'approved'
        request.updatedAt = Date.now()
      }).catch(() => undefined)
      throw error
    }
  }

  async removeEmployee(founder: Agent, employeeId: string, reason: string, approvalId: string, staffingRequestId: string, signal?: AbortSignal): Promise<Employee> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const normalizedReason = normalizeString(reason, 'removal reason', 4096)
    let previous: Employee | undefined
    const revoked = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'employee.retiring',
      summary: `Retiring employee ${employeeId}: ${normalizedReason}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const employee = requireEmployee(state, employeeId)
      previous = structuredClone(employee)
      if (employee.status === 'retired') throw new Error(`employee ${employeeId} is already retired`)
      if (state.phase === 'staged' || state.phase === 'provisioning' || state.phase === 'provisioning_failed') throw new Error('the default HR employee is part of the formation plan; edit or discard the formation instead')
      if (employee.isHr === true && state.hrEmployeeId === employee.id) throw new Error('designate and provision a replacement HR governance employee before retiring the current one')
      const staffing = requireStaffingRequest(state, staffingRequestId)
      if (staffing.action !== 'retire' || staffing.employeeId !== employeeId || staffing.status !== 'approved' || staffing.approvalId !== approvalId) throw new Error('retirement requires the matching approved HR staffing recommendation')
      const approval = requireApproved(state, approvalId, 'organization_change', (payload) => isRecord(payload) && payload.action === 'retire' && payload.employeeId === employeeId && payload.staffingRequestId === staffing.id)
      consumeApproval(approval)
      staffing.status = 'applied'
      staffing.updatedAt = Date.now()
      for (const work of state.workItems) {
        if (work.assigneeId !== employeeId || ['completed', 'cancelled'].includes(work.status)) continue
        if (work.reservationId !== undefined) releaseMoneyReservation(state, work.reservationId)
        if (isOpenStatus(work.status)) invalidateAttempt(work, employeeId, normalizedReason)
        work.assigneeId = undefined
        work.handoffId = undefined
        work.reassigning = false
        work.reservationId = undefined
        work.leaseAt = undefined
        work.updatedAt = Date.now()
        if (work.ticketId !== undefined) {
          const ticket = state.tickets.find((candidate) => candidate.id === work.ticketId)
          if (ticket !== undefined && ticket.status === 'dispatched') {
            ticket.status = 'triaged'
            ticket.assigneeId = undefined
          }
        }
      }
      releaseEmployeeMoneyReservations(state, employee.id)
      for (const authorization of state.temporaryAuthorizations) {
        if (authorization.employeeId === employee.id && authorization.revokedAt === undefined) revokeAuthorizationRecord(state, authorization.id, `Employee retired: ${normalizedReason.slice(0, 4_000)}`, Date.now())
      }
      if (state.supportEmployeeId === employee.id) state.supportEmployeeId = undefined
      for (const unit of state.orgUnits) if (unit.managerEmployeeId === employee.id) unit.managerEmployeeId = undefined
      employee.status = 'retired'
      employee.retiredAt = Date.now()
      employee.failure = undefined
      return structuredClone(employee)
    })
    if (previous?.sessionId !== undefined) {
      try {
        interruptEmployee(this.ctx, founder, previous)
        await waitForEmployeeIdle(this.ctx, previous, signal ?? AbortSignal.timeout(10_000))
      } catch (error) {
        this.ctx.logger.warn(`dsh-company retired ${employeeId} after best-effort idle wait failed: ${boundedError(error)}`)
      }
      await this.store.recordRetiredSession(founder.session.header.cwd, previous.sessionId)
        .catch((error) => this.ctx.logger.warn(`dsh-company retired-session index update failed for ${employeeId}: ${boundedError(error)}`))
    }
    this.kick(founder.session.header.cwd, founder)
    return revoked.result
  }

  async applyStaffingAdjustment(founder: Agent, requestId: string, approvalId: string, signal?: AbortSignal): Promise<Employee> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const planned = requireStaffingRequest(located.state, requestId)
    if (planned.action !== 'adjust' || planned.employeeId === undefined || planned.recommendation === undefined) throw new Error('staffing request is not an adjustment recommendation')
    const recommendation = planned.recommendation
    const selection = await resolveEmployeeSelection(this.ctx, founder, this.config, {
      provider: recommendation.provider, model: recommendation.model,
      ...(recommendation.reasoningEffort === undefined ? {} : { reasoningEffort: recommendation.reasoningEffort }),
    }, signal)
    let oldSessionId: string | undefined
    let reservationId: string | undefined
    let handoff: { previousSessionId: string; openWork: string[] } | undefined
    const prepared = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder', type: 'staffing.adjustment_applied', summary: `Applied HR adjustment ${requestId}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (state.phase !== 'operating') throw new Error(`cannot adjust staff while company is ${state.phase}; resume first`)
      const request = requireStaffingRequest(state, requestId)
      if (request.approvalId !== approvalId || request.employeeId === undefined) throw new Error('staffing adjustment is not approved for application')
      const employee = requireEmployee(state, request.employeeId)
      const approvalRecord = state.approvals.find((candidate) => candidate.id === approvalId)
      if (request.status === 'approved' && employee.status === 'failed' && approvalRecord?.kind === 'organization_change' && approvalRecord.status === 'approved' && approvalRecord.consumedAt !== undefined) {
        releaseEmployeeMoneyReservations(state, employee.id)
        employee.sessionId = allocateEmployeeSessionId()
        employee.status = 'provisioning'
        employee.failure = undefined
        reservationId = this.reserveEmployeeTurn(state, employee)
        request.updatedAt = Date.now()
        return structuredClone(employee)
      }
      if (request.status !== 'approved') throw new Error('staffing adjustment must be human-approved before application')
      const approval = requireApproved(state, approvalId, 'organization_change', (payload) => isRecord(payload) && payload.action === 'adjust' && payload.staffingRequestId === request.id && payload.employeeId === request.employeeId && (payload.designateAsHr === true) === (recommendation.designateAsHr === true))
      if (employee.isHr === true) throw new Error('HR self-adjustment requires a separately designated HR reviewer')
      const unit = ensureOrgPath(state, recommendation.orgPath)
      const position = ensurePosition(state, unit.id, recommendation.positionTitle, recommendation.responsibilities)
      const personaUnchanged = employee.role === recommendation.positionTitle
      const currentRoute = employee.llm === undefined ? undefined : activeSelection(employee.llm)
      const nextRoute = activeSelection(selection)
      const routeUnchanged = currentRoute !== undefined
        && currentRoute.provider === nextRoute.provider
        && currentRoute.model === nextRoute.model
        && currentRoute.reasoningEffort === nextRoute.reasoningEffort
      const nextBudget = recommendation.budgetMicros ?? employee.budgetMicros ?? 0
      if (nextBudget > state.moneyBudget.totalMicros) throw new Error('employee monetary ceiling exceeds company budget')
      // Budget-only adjustments keep the continuable session (and its whole
      // conversation memory) alive: the ceiling is consulted at admission
      // time, so bumping it live is safe. Only a route or persona change
      // forces the retire-and-reprovision dance, because continuable
      // descriptors freeze agentProvider/agentModel and persona at creation.
      if (routeUnchanged && personaUnchanged && recommendation.designateAsHr !== true && employee.status !== 'failed' && employee.sessionId !== undefined) {
        employee.role = recommendation.positionTitle
        employee.orgUnitId = unit.id
        employee.positionId = position.id
        employee.budgetMicros = nextBudget
        request.status = 'applied'
        request.updatedAt = Date.now()
        consumeApproval(approval)
        return structuredClone(employee)
      }
      oldSessionId = employee.sessionId
      releaseEmployeeMoneyReservations(state, employee.id)
      for (const work of state.workItems) {
        if (work.assigneeId !== employee.id || !isOpenStatus(work.status)) continue
        if (work.reservationId !== undefined) {
          releaseMoneyReservation(state, work.reservationId)
          }
        work.status = 'pending'
        work.attempt = Math.max(0, work.attempt - 1)
        work.deliveryAttempts = 0
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
      }
      handoff = {
        previousSessionId: employee.sessionId ?? 'unknown',
        openWork: state.workItems.filter((work) => work.assigneeId === employee.id && work.status === 'pending').map((work) => `${work.id}: ${work.subject}`),
      }
      employee.role = recommendation.positionTitle
      employee.orgUnitId = unit.id
      employee.positionId = position.id
      employee.budgetMicros = nextBudget
      employee.llm = selection
      if (recommendation.designateAsHr === true) employee.isHr = true
      employee.sessionId = allocateEmployeeSessionId()
      employee.status = 'provisioning'
      if (state.supportEmployeeId === employee.id) state.supportEmployeeId = undefined
      employee.failure = undefined
      reservationId = this.reserveEmployeeTurn(state, employee)
      request.status = 'approved'
      request.updatedAt = Date.now()
      consumeApproval(approval)
      return structuredClone(employee)
    })
    if (prepared.result.status !== 'provisioning') {
      // Budget-only path: nothing was retired or requeued; the employee keeps
      // its live continuable session and open attempt.
      this.kick(founder.session.header.cwd, founder)
      return prepared.result
    }
    if (oldSessionId !== undefined) {
      const previous = { ...prepared.result, sessionId: oldSessionId }
      interruptEmployee(this.ctx, founder, previous)
      await waitForEmployeeIdle(this.ctx, previous, signal ?? AbortSignal.timeout(10_000)).catch(() => undefined)
      await this.store.recordRetiredSession(founder.session.header.cwd, oldSessionId)
        .catch((error) => this.ctx.logger.warn(`dsh-company adjusted employee retired-session index update failed: ${boundedError(error)}`))
    }
    let childAccepted = false
    try {
      await startEmployee(this.ctx, this.config, this.selections, founder, prepared.state, prepared.result, signal ?? new AbortController().signal, handoff)
      childAccepted = true
      const accepted = await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'employee.reprovisioned', summary: `Employee ${prepared.result.id} accepted its adjusted route`,
      }, (state) => {
        const employee = requireEmployee(state, prepared.result.id)
        if (employee.sessionId !== prepared.result.sessionId || employee.status !== 'provisioning') throw new Error('staffing reprovision was superseded')
        employee.status = state.phase === 'operating' ? 'idle' : 'paused'
        employee.joinedAt = Date.now()
        employee.failure = undefined
        const request = requireStaffingRequest(state, requestId)
        this.applyHrSuccession(state, request, employee)
        request.status = 'applied'
        request.updatedAt = Date.now()
        return structuredClone(employee)
      })
      this.kick(founder.session.header.cwd, founder)
      return accepted.result
    } catch (error) {
      if (childAccepted && prepared.result.sessionId !== undefined) {
        await this.ctx.subagents.drainContinuableChildren(founder, [SessionId(prepared.result.sessionId)]).catch(() => undefined)
        await this.store.recordRetiredSession(founder.session.header.cwd, prepared.result.sessionId).catch(() => undefined)
      }
      await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'employee.reprovisioning_failed', summary: `Adjusted employee ${prepared.result.id} failed to start and remains retryable`,
      }, (state) => {
        releaseMoneyReservation(state, reservationId)
        const employee = requireEmployee(state, prepared.result.id)
        if (employee.sessionId !== prepared.result.sessionId || employee.status !== 'provisioning') return
        employee.status = 'failed'
        employee.failure = boundedError(error)
        const request = requireStaffingRequest(state, requestId)
        request.status = 'approved'
        request.updatedAt = Date.now()
      }).catch(() => undefined)
      throw error
    }
  }

  async createProduct(founder: Agent, input: CreateProductInput): Promise<Product> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const workspace = (await this.store.pathsForCwd(founder.session.header.cwd, false)).workspace.canonicalPath
    const name = normalizeString(input.name, 'product name', 200)
    const summary = normalizeMultilineString(input.summary, 'product summary', 16_384)
    const productRoot = normalizeWorkspaceRelative(workspace, input.productRoot, 'product_root')
    const criteria = normalizeList(input.successCriteria, 'success_criteria', 1, 256, 16_384)
    const requestedBudgetMicros = boundedMicros(input.budgetMicros, this.config.maxMoneyBudgetMicros, 'budget_micros')
    const result = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'product.created',
      summary: `Created product ${name}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (!['operating', 'paused', 'halted'].includes(state.phase)) throw new Error('the first product belongs to the formation decision; additional products may be created only after formation approval')
      if (state.products.length >= Math.min(state.limits.maxProducts, this.config.maxProducts)) throw new Error('product cap reached')
      if (state.products.some((product) => product.name === name || product.productRoot === productRoot)) throw new Error('product name and product_root must be unique')
      const moneyAllocated = state.products.filter((product) => !['cancelled', 'retired'].includes(product.status)).reduce((sum, product) => sum + product.budgetMicros, 0)
      if (moneyAllocated + requestedBudgetMicros > state.moneyBudget.totalMicros) throw new Error('product monetary allocations exceed company budget')
      state.counters.product += 1
      const now = Date.now()
      const product: Product = {
        id: `p${state.counters.product}`,
        name,
        summary,
        status: 'proposed',
        productRoot,
        successCriteria: criteria,
        budgetMicros: boundedMicros(requestedBudgetMicros, state.moneyBudget.totalMicros, 'budget_micros'),
        createdAt: now,
        updatedAt: now,
      }
      state.products.push(product)
      return structuredClone(product)
    })
    return result.result
  }

  async updateProduct(
    founder: Agent,
    input: {
      productId: string
      status?: ProductStatus
      summary?: string
      successCriteria?: string[]
      approvalId?: string
    },
  ): Promise<Product> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const result = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'product.updated',
      summary: `Updated product ${input.productId}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const product = requireProduct(state, input.productId)
      if (['released', 'retired', 'cancelled'].includes(product.status) && (input.summary !== undefined || input.successCriteria !== undefined)) {
        throw new Error(`terminal product ${product.id} metadata is immutable`)
      }
      if (input.summary !== undefined) {
        if (!['staged', 'proposed', 'paused'].includes(state.phase === 'staged' ? 'staged' : product.status)) throw new Error('product summary may be edited only while staged, proposed, or paused')
        product.summary = normalizeMultilineString(input.summary, 'product summary', 16_384)
      }
      if (input.successCriteria !== undefined) product.successCriteria = normalizeList(input.successCriteria, 'success_criteria', 1, 256, 16_384)
      if (input.status !== undefined && input.status !== product.status) this.transitionProduct(state, product, input.status, input.approvalId)
      product.updatedAt = Date.now()
      return structuredClone(product)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  async createWork(founder: Agent, input: CreateWorkInput): Promise<WorkItem> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const workspace = (await this.store.pathsForCwd(founder.session.header.cwd, false)).workspace.canonicalPath
    const normalized = normalizeWorkPlan(workspace, input)
    const result = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'work.created',
      summary: `Created ${input.kind} work ${input.subject}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (!['staged', 'provisioning_failed', 'operating', 'paused'].includes(state.phase)) throw new Error(`cannot create work while company is ${state.phase}`)
      if (state.workItems.length >= Math.min(state.limits.maxWorkItems, this.config.maxWorkItems)) throw new Error('work item cap reached')
      requireProduct(state, input.productId)
      validateWorkReferences(state, normalized)
      state.counters.work += 1
      const now = Date.now()
      const work: WorkItem = {
        id: `w${state.counters.work}`,
        ...normalized,
        status: 'pending',
        attempt: 0,
        attemptHistory: [],
        createdAt: now,
        updatedAt: now,
      }
      const graph = [...state.workItems.map((item) => ({ id: item.id, dependencies: item.dependencies })), { id: work.id, dependencies: work.dependencies }]
      assertAcyclic(graph)
      state.workItems.push(work)
      return structuredClone(work)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  async editWork(founder: Agent, workId: string, replacements: Partial<CreateWorkInput>, expectedRevision?: number): Promise<WorkItem> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const workspace = (await this.store.pathsForCwd(founder.session.header.cwd, false)).workspace.canonicalPath
    const result = await this.store.transact(founder.session.header.cwd, {
      expectedRevision,
      actor: 'founder',
      type: 'work.edited',
      summary: `Edited work ${workId}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const work = requireWork(state, workId)
      if (work.status !== 'pending' || work.attempt !== 0) throw new Error('only never-attempted pending work may be edited')
      const merged: CreateWorkInput = {
        productId: replacements.productId ?? work.productId,
        kind: replacements.kind ?? work.kind,
        subject: replacements.subject ?? work.subject,
        objective: replacements.objective ?? work.objective,
        dependencies: replacements.dependencies ?? work.dependencies,
        approvalDependencies: replacements.approvalDependencies ?? work.approvalDependencies,
        assigneeId: replacements.assigneeId ?? work.assigneeId,
        eligibleEmployeeIds: replacements.eligibleEmployeeIds ?? work.eligibleEmployeeIds,
        eligibleOrgUnitIds: replacements.eligibleOrgUnitIds ?? work.eligibleOrgUnitIds,
        inScope: replacements.inScope ?? work.inScope,
        outOfScope: replacements.outOfScope ?? work.outOfScope,
        acceptance: replacements.acceptance ?? work.acceptance,
        verify: replacements.verify ?? work.verify,
        deliverables: replacements.deliverables ?? work.deliverables,
        reviewedWorkId: replacements.reviewedWorkId ?? work.reviewedWorkId,
      }
      const normalized = normalizeWorkPlan(workspace, merged)
      validateWorkReferences(state, normalized, workId)
      validateDependencyReplacement(state, workId, normalized.dependencies)
      Object.assign(work, normalized, { updatedAt: Date.now() })
      return structuredClone(work)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  async reassignWork(founder: Agent, workId: string, assigneeId: string | 'founder', reason: string, signal?: AbortSignal): Promise<WorkItem> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const normalizedReason = normalizeString(reason, 'reassignment reason', 4096)
    let oldEmployee: Employee | undefined
    let handoffId = ''
    const invalidated = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'work.reassigning',
      summary: `Reassigning work ${workId} to ${assigneeId}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const work = requireWork(state, workId)
      if (work.status === 'completed') throw new Error('completed work is immutable')
      if (assigneeId !== 'founder') requireEmployeeRunnable(state, assigneeId)
      if (isOpenStatus(work.status) && work.assigneeId !== undefined && work.assigneeId !== 'founder') oldEmployee = structuredClone(requireEmployee(state, work.assigneeId))
      if (work.reservationId !== undefined) {
        releaseMoneyReservation(state, work.reservationId)
      }
      handoffId = invalidateAttempt(work, assigneeId, normalizedReason)
      return structuredClone(work)
    })
    let waitError: unknown
    if (oldEmployee !== undefined) {
      try {
        interruptEmployee(this.ctx, founder, oldEmployee)
        await waitForEmployeeIdle(this.ctx, oldEmployee, signal ?? AbortSignal.timeout(10_000))
      } catch (error) {
        waitError = error
      }
    }
    const finished = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'work.reassigned',
      summary: `Work ${workId} handoff completed`,
    }, (state) => {
      const work = requireWork(state, workId)
      finishHandoff(work, handoffId)
      return structuredClone(work)
    })
    this.kick(founder.session.header.cwd, founder)
    if (waitError !== undefined) this.ctx.logger.warn(`dsh-company reassignment ${workId} completed after best-effort idle wait failed: ${boundedError(waitError)}`)
    return finished.result ?? invalidated.result
  }

  async claimWork(caller: Agent, workId: string): Promise<{ workId: string; attemptId: string; attempt: number }> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id,
      type: 'work.claimed',
      summary: `${located.actor.id} claimed work ${workId}`,
    }, (state) => {
      const actor = this.actorFor(state, caller)
      if (state.phase !== 'operating') throw new Error(`work claims are disabled while company is ${state.phase}`)
      if (actor.kind === 'employee') requireEmployeeRunnable(state, actor.id)
      const work = requireWork(state, workId)
      const owner = actor.kind === 'founder' ? 'founder' : actor.id
      if ((work.status === 'claimed' || work.status === 'in_progress') && work.assigneeId === owner && work.attemptId !== undefined) {
        if (actor.kind === 'employee' && activeMoneyReservation(state, actor.id)?.workId !== work.id) {
          throw new Error(`employee ${actor.id} has no active reservation for pre-admitted work ${work.id}`)
        }
        return { workId: work.id, attemptId: work.attemptId, attempt: work.attempt }
      }
      if (actor.kind === 'employee') throw new Error('employees may only confirm scheduler-preclaimed work with its matching reservation')
      const attemptId = beginWorkAttempt(state, work, owner)
      return { workId: work.id, attemptId, attempt: work.attempt }
    })
    return result.result
  }

  async updateWork(caller: Agent, input: UpdateWorkInput): Promise<WorkItem> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    const workspace = (await this.store.pathsForCwd(caller.session.header.cwd, false)).workspace.canonicalPath
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id,
      type: 'work.updated',
      summary: `${located.actor.id} updated work ${input.workId} to ${input.status ?? 'unchanged status'}`,
    }, async (state, io) => {
      const actor = this.actorFor(state, caller)
      const owner = actor.kind === 'founder' ? 'founder' : actor.id
      const work = updateWork(state, workspace, owner, input)
      const terminalStatus = work.status
      const terminalOutput = work.output
      const terminalUpdate = ['completed', 'failed', 'cancelled'].includes(terminalStatus)
      if (work.ticketId !== undefined && terminalUpdate) {
        syncTicketResolution(state, work)
      }
      if (actor.kind === 'employee' && terminalUpdate) {
        const employee = requireEmployee(state, actor.id)
        if (employee.status !== 'retired' && state.phase === 'operating') employee.status = 'idle'
        if (work.ticketId === undefined || terminalStatus !== 'completed') {
          await queueFounderNotification(state, io, actor.id, `Employee ${actor.id} finished work ${work.id} with status ${terminalStatus}. Recorded output: ${terminalOutput ?? '(none)'}`)
        }
      }
      return structuredClone(work)
    })
    this.kick(caller.session.header.cwd, this.liveFounder(result.state))
    if (result.result.ticketId !== undefined && result.result.status === 'completed') this.steerTicketResolved(result.state, result.result)
    return result.result
  }

  async reprobeModels(founder: Agent, expectedRevision?: number, signal?: AbortSignal): Promise<CompanyState['modelCatalog']> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const topologyEpoch = this.modelTopologyEpoch
    const topologyChangedAt = this.modelTopologyChangedAt
    const seed = structuredClone(located.state.modelCatalog)
    const requiredRoutes = [
      ...located.state.employees.flatMap((employee) => [
        { provider: employee.llm.provider, model: employee.llm.model },
        ...(employee.llm.fallback === undefined ? [] : [employee.llm.fallback]),
      ]),
      ...located.state.moneyBudget.prices.filter((price) => price.model !== '*').map((price) => ({ provider: price.provider, model: price.model })),
    ]
    for (const route of requiredRoutes) if (!seed.models.some((candidate) => candidate.provider === route.provider && candidate.model === route.model)) {
      seed.models.push({ provider: route.provider, model: route.model, name: route.model, advertised: false, available: false })
    }
    const probed = await probeRegisteredModels(this.ctx, seed, signal)
    if (this.modelTopologyEpoch !== topologyEpoch) throw new Error('model topology changed during reprobe; retry against the new adapter/settings generation')
    if ((probed.probedAt ?? 0) <= topologyChangedAt) probed.probedAt = topologyChangedAt + 1
    const result = await this.store.transact(founder.session.header.cwd, {
      expectedRevision: expectedRevision ?? located.state.revision,
      actor: 'founder', type: 'models.reprobed', summary: `Reprobed ${probed.models.length} registered provider/model routes`,
    }, (state) => {
      this.assertFounderState(founder, state)
      if (this.modelTopologyEpoch !== topologyEpoch) throw new Error('model topology changed before reprobe commit; retry')
      state.modelCatalog = structuredClone(probed)
      return structuredClone(state.modelCatalog)
    })
    return result.result
  }

  async invalidateModels(cwd: string | undefined, reason: string): Promise<void> {
    const current = await this.store.readActive(cwd)
    if (current === undefined || current.modelCatalog.stale) return
    await this.store.transact(cwd, {
      actor: 'scheduler', type: 'models.invalidated', summary: `Invalidated model capability catalog: ${reason}`,
    }, (state) => invalidateModelCatalog(state.modelCatalog, Date.now()))
  }

  async requestGovernanceChange(founder: Agent, input: GovernanceChangeInput, expectedRevision?: number, source: 'tool' | 'ui' = 'tool'): Promise<ApprovalRequest> {
    const located = await this.requireFounder(founder)
    const expected = input.expectedGovernanceRevision ?? located.state.governanceRevision
    const payload: Record<string, JsonValue> = { expectedGovernanceRevision: expected }
    if (input.slogan !== undefined) payload.slogan = normalizeString(input.slogan, 'company slogan', 160)
    if (input.mission !== undefined) payload.mission = normalizeMultilineString(input.mission, 'company mission', 16_384)
    if (input.charter !== undefined) payload.charter = normalizeMultilineString(input.charter, 'company charter', 32_768)
    if (Object.keys(payload).length === 1) throw new Error('governance change requires slogan, mission, or charter')
    return this.requestApproval(founder, {
      kind: 'governance_change',
      summary: `Change company identity/governance at revision ${expected}`,
      detail: `Update ${Object.keys(payload).filter((key) => key !== 'expectedGovernanceRevision').join(', ')} at governance revision ${expected}. The new values take effect only after human approval.`,
      payload,
      risk: 'high',
    }, expectedRevision, source)
  }

  async requestBudgetChange(founder: Agent, input: BudgetChangeInput, expectedRevision?: number, source: 'tool' | 'ui' = 'tool'): Promise<ApprovalRequest[]> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    // A console (UI) request is itself a genuine human decision — the founder
    // chat anchor is used when present but never required.
    const approvalUserMessage = latestGenuineUserMessage(founder)
    if (source === 'tool' && approvalUserMessage === undefined) throw new Error('budget/pricing requests require a genuine founder-session user message anchor')
    if (input.totalBudgetMicros === undefined && input.productBudgets === undefined && input.modelPrices === undefined) {
      throw new Error('budget change requires a company budget, product allocation, or price matrix change')
    }
    const result = await this.store.transact(founder.session.header.cwd, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      actor: 'founder', type: 'approval.requested', summary: 'Requested monetary budget and pricing changes',
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const approvals: ApprovalRequest[] = []
      if (input.totalBudgetMicros !== undefined || input.productBudgets !== undefined) {
        const total = boundedMicros(input.totalBudgetMicros ?? state.moneyBudget.totalMicros, this.config.maxMoneyBudgetMicros, 'total_budget')
        const allocations = (input.productBudgets ?? []).map((allocation) => {
          if (!state.products.some((product) => product.id === allocation.productId)) throw new Error(`unknown product ${allocation.productId}`)
          return { id: allocation.productId, budgetMicros: boundedMicros(allocation.budgetMicros, this.config.maxMoneyBudgetMicros, `product ${allocation.productId} budget`) }
        })
        const payload: Record<string, JsonValue> = {
          newTotalMicros: total,
          expectedTotalMicros: state.moneyBudget.totalMicros,
          productAllocations: allocations,
          ...(state.moneyBudget.migrationRequired === true ? { legacyTreatment: 'accepted' } : {}),
        }
        approvals.push(createApproval(state, 'founder', {
          kind: 'budget_change',
          summary: `Set company monetary budget to ${total} micros and update ${allocations.length} product allocations`,
          detail: `Adjust the company monetary ceiling and ${allocations.length} product allocation(s)${allocations.length === 0 ? '' : ` (${allocations.map((entry) => `${entry.id}: ${entry.budgetMicros}`).join(', ')})`}. Money stays fully reserved-first; existing usage is never rewritten.`,
          payload,
          risk: 'high',
          ...(approvalUserMessage === undefined ? {} : { requestedFromUserMessageId: String(approvalUserMessage.id) }),
        }))
      }
      if (input.modelPrices !== undefined) {
        const expectedPricingRevision = input.expectedPricingRevision ?? state.moneyBudget.pricingRevision
        if (expectedPricingRevision !== state.moneyBudget.pricingRevision) throw new RevisionConflictError(expectedPricingRevision, state.moneyBudget.pricingRevision)
        const prices = normalizeModelPrices(input.modelPrices, 'manual', state.moneyBudget.pricingRevision + 1, Date.now())
          .map(({ provider, model, inputCacheMissMicrosPerMillion, inputCacheHitMicrosPerMillion, outputMicrosPerMillion }) => ({
            provider,
            model,
            ...(inputCacheMissMicrosPerMillion === undefined ? {} : { inputCacheMissMicrosPerMillion }),
            ...(inputCacheHitMicrosPerMillion === undefined ? {} : { inputCacheHitMicrosPerMillion }),
            ...(outputMicrosPerMillion === undefined ? {} : { outputMicrosPerMillion }),
          }))
        approvals.push(createApproval(state, 'founder', {
          kind: 'pricing_change',
          summary: `Replace the three-rate model price matrix at revision ${expectedPricingRevision}`,
          detail: `Replace the three-rate price matrix with ${prices.filter((price) => price.inputCacheMissMicrosPerMillion !== undefined).length} enabled route(s) at pricing revision ${expectedPricingRevision}. Recorded usage keeps its original revision; only future calls use the new rates.`,
          payload: {
            currency: state.moneyBudget.currency,
            expectedCurrency: state.moneyBudget.currency,
            expectedPricingRevision,
            expectedDigest: pricingMatrixDigest(state.moneyBudget),
            prices,
          },
          risk: 'high',
          ...(approvalUserMessage === undefined ? {} : { requestedFromUserMessageId: String(approvalUserMessage.id) }),
        }))
      }
      return structuredClone(approvals)
    })
    return result.result
  }

  async grantTemporaryAuthorization(founder: Agent, input: GrantTemporaryAuthorizationInput, expectedRevision?: number): Promise<TemporaryAuthorization> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const reason = normalizeString(input.reason, 'authorization reason', 4096)
    const result = await this.store.transact(founder.session.header.cwd, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      actor: 'founder', type: 'authorization.granted', summary: `Granted employee-wide temporary authorization for ${input.employeeId}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const approval = requireApproved(state, input.approvalId, 'temporary_authorization', (payload) => isRecord(payload)
        && payload.action === 'grant'
        && payload.employeeId === input.employeeId
        && payload.reason === reason
        && payload.expiresAt === input.expiresAt
        && (payload.startsAt ?? undefined) === input.startsAt)
      const now = Date.now()
      const authorization = createTemporaryAuthorization(state, {
        employeeId: input.employeeId,
        reason,
        ...(input.startsAt === undefined ? {} : { startsAt: input.startsAt }),
        expiresAt: input.expiresAt,
        approvalId: approval.id,
      }, { maxMs: this.config.maxTemporaryAuthorizationMs }, now)
      consumeApproval(approval)
      return structuredClone(authorization)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  async revokeTemporaryAuthorization(founder: Agent, input: RevokeTemporaryAuthorizationInput, expectedRevision?: number): Promise<TemporaryAuthorization> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const reason = normalizeString(input.reason, 'revocation reason', 4096)
    const result = await this.store.transact(founder.session.header.cwd, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      actor: 'founder', type: 'authorization.revoked', summary: `Revoked temporary authorization ${input.authorizationId}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      const approval = requireApproved(state, input.approvalId, 'temporary_authorization', (payload) => isRecord(payload)
        && payload.action === 'revoke'
        && payload.authorizationId === input.authorizationId
        && payload.reason === reason)
      const authorization = revokeAuthorizationRecord(state, input.authorizationId, reason, Date.now())
      consumeApproval(approval)
      return structuredClone(authorization)
    })
    return result.result
  }

  async requestApproval(
    caller: Agent,
    input: { kind: ApprovalKind; summary: string; detail?: string; payload: JsonValue; risk?: 'low' | 'medium' | 'high'; expiresAt?: number },
    expectedRevision?: number,
    source: 'tool' | 'ui' = 'tool',
  ): Promise<ApprovalRequest> {
    this.assertAdmission()
    validateApprovalPayload(input.kind, input.payload)
    if (input.kind === 'bootstrap') throw new Error('bootstrap approval uses company_approve, not company_request_approval')
    const located = await this.requireParticipant(caller)
    const founder = located.actor.kind === 'founder' ? caller : this.liveFounder(located.state)
    if (founder === undefined) throw new Error('founder session must be live to anchor a later human approval decision')
    const latestUser = latestGenuineUserMessage(founder)
    if (source === 'tool' && latestUser === undefined) throw new Error('approval requests require a current genuine founder-session user message anchor')
    const result = await this.store.transact(caller.session.header.cwd, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      actor: located.actor.id,
      type: 'approval.requested',
      summary: `${located.actor.id} requested ${input.kind} approval`,
    }, async (state, io) => {
      const actor = this.actorFor(state, caller)
      if (actor.kind !== 'founder' && ['budget_change', 'pricing_change', 'governance_change', 'temporary_authorization'].includes(input.kind)) {
        throw new Error(`${input.kind} requests are founder-only governance operations`)
      }
      const approval = createApproval(state, actor.id, {
        kind: input.kind,
        summary: input.summary,
        ...(input.detail === undefined ? {} : { detail: input.detail }),
        payload: input.payload,
        ...(input.risk === undefined ? {} : { risk: input.risk }),
        ...(input.expiresAt === undefined ? {} : { expiresAt: input.expiresAt }),
        ...(latestUser === undefined ? {} : { requestedFromUserMessageId: String(latestUser.id) }),
      })
      if (actor.kind === 'employee') await queueFounderNotification(state, io, actor.id, `Employee ${actor.id} opened ${input.kind} approval ${approval.id}: ${approval.summary}. The request awaits a human decision.`)
      return structuredClone(approval)
    })
    if (located.actor.kind === 'employee') this.kick(caller.session.header.cwd, founder)
    return result.result
  }

  async resolveApproval(
    founder: Agent,
    input: { approvalId: string; decision: 'approved' | 'rejected'; humanStatement: string; note?: string; expectedRevision?: number },
    source: 'tool' | 'ui' = 'tool',
  ): Promise<ApprovalRequest> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    if (source === 'tool') this.assertLaterHumanForApproval(founder, located.state, input.approvalId)
    const result = await this.store.transact(founder.session.header.cwd, {
      expectedRevision: input.expectedRevision,
      actor: source === 'ui' ? 'human-ui' : 'founder',
      type: 'approval.resolved',
      summary: `${input.decision} approval ${input.approvalId}`,
    }, (state) => {
      this.assertFounderState(founder, state)
      const resolved = resolveApproval(state, this.config, {
        approvalId: input.approvalId,
        decision: input.decision,
        source,
        humanStatement: input.humanStatement,
        ...(input.note === undefined ? {} : { note: input.note }),
      })
      if (resolved.approval.kind === 'organization_change' && isRecord(resolved.approval.payload)) {
        const requestId = resolved.approval.payload.staffingRequestId
        const request = typeof requestId === 'string' ? state.staffingRequests.find((candidate) => candidate.id === requestId && candidate.approvalId === resolved.approval.id) : undefined
        if (request !== undefined) {
          request.status = resolved.approval.status === 'approved' ? 'approved' : 'rejected'
          request.updatedAt = Date.now()
        }
      }
      if (source === 'ui' && resolved.approval.kind === 'temporary_authorization' && resolved.approval.status === 'approved' && isRecord(resolved.approval.payload)) {
        const payload = resolved.approval.payload
        if (payload.action === 'grant') {
          createTemporaryAuthorization(state, {
            approvalId: resolved.approval.id,
            employeeId: String(payload.employeeId),
            reason: String(payload.reason),
            ...(payload.startsAt === undefined ? {} : { startsAt: Number(payload.startsAt) }),
            expiresAt: Number(payload.expiresAt),
          }, { maxMs: this.config.maxTemporaryAuthorizationMs }, Date.now())
        } else if (payload.action === 'revoke') {
          revokeAuthorizationRecord(state, String(payload.authorizationId), String(payload.reason), Date.now())
        }
        consumeApproval(resolved.approval)
      }
      if (input.decision === 'approved' && resolved.applied && resolved.approval.kind === 'governance_change') {
        const changed = ['slogan', 'mission', 'charter'].filter((field) => isRecord(resolved.approval.payload) && resolved.approval.payload[field] !== undefined)
        state.governanceNotifications.push({
          id: randomUUID(),
          governanceRevision: state.governanceRevision,
          employeeIds: state.employees.filter((employee) => employee.sessionId !== undefined && employee.status !== 'retired' && employee.status !== 'failed').map((employee) => employee.id),
          deliveredEmployeeIds: [],
          content: `Company governance revision ${state.governanceRevision} was approved. Changed: ${changed.join(', ')}. Current slogan: ${state.slogan}. Call company_status before future work; every assignment and recovery prompt carries the current mission and charter.`,
          createdAt: Date.now(),
        })
      }
      return structuredClone(resolved.approval)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  async approveBootstrap(founder: Agent, confirmation: string, source: OperationSource): Promise<CompanyState> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const statement = normalizeString(confirmation, 'bootstrap confirmation', 4096, 3)
    if (source.source === 'tool') this.assertLaterHuman(founder, located.state.stagedFromUserMessageId, 'bootstrap approval')
    if (!/(approve|approved|confirm|start|launch|proceed|同意|批准|确认|启动|开始)/iu.test(statement)) {
      throw new Error('bootstrap confirmation must explicitly approve or start the staged company')
    }
    await this.validatePlanForApproval(founder, located.state)
    const prepared = await this.store.transact(founder.session.header.cwd, {
      expectedRevision: source.expectedRevision,
      actor: source.source === 'ui' ? 'human-ui' : 'founder',
      type: 'company.provisioning',
      summary: 'Bootstrap approved; employee provisioning generation prepared',
    }, (state) => {
      this.assertFounderState(founder, state)
      if (state.phase !== 'staged' && state.phase !== 'provisioning_failed') throw new Error(`company cannot be approved from ${state.phase}`)
      this.validatePlanPure(state)
      let approval = state.approvals.find((candidate) => candidate.kind === 'bootstrap' && candidate.status === 'pending')
      if (approval === undefined) {
        approval = createApproval(state, 'founder', {
          kind: 'bootstrap',
          summary: 'Retry employee provisioning',
          payload: { companyId: state.id, stagedRevision: state.revision },
          risk: 'high',
          requestedFromUserMessageId: state.stagedFromUserMessageId,
        })
      }
      approval.status = 'approved'
      approval.resolvedAt = Date.now()
      approval.resolution = {
        decision: 'approved',
        source: source.source,
        humanStatement: statement,
      }
      const generationId = randomUUID()
      const employeeIds: string[] = []
      const reservationIds: string[] = []
      for (const employee of state.employees) {
        if (employee.status === 'idle' && employee.sessionId !== undefined) continue
        if (employee.status === 'retired') continue
        employee.sessionId ??= allocateEmployeeSessionId()
        employee.status = 'provisioning'
        employee.failure = undefined
        const reservationId = this.reserveEmployeeTurn(state, employee)
        employeeIds.push(employee.id)
        reservationIds.push(reservationId)
      }
      state.phase = 'provisioning'
      state.approvedAt = Date.now()
      state.formation.status = 'approved'
      state.formation.approvedAt = state.approvedAt
      state.health = { status: 'healthy', resumable: true }
      state.provisioning = { id: generationId, startedAt: Date.now(), approvalId: approval.id, employeeIds, reservationIds }
      return { generationId, employeeIds, reservationIds }
    })
    return this.continueBootstrapProvisioning(founder, prepared.result.generationId)
  }

  async sendMessage(caller: Agent, to: 'founder' | string, content: string, signal?: AbortSignal): Promise<CompanyMessage> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    const normalized = normalizeMultilineString(content, 'message content', located.state.limits.maxMessageChars)
    let reservationId: string | undefined
    const queued = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id,
      type: 'message.queued',
      summary: `${located.actor.id} sent a durable message to ${to}`,
    }, async (state, io) => {
      const actor = this.actorFor(state, caller)
      if (to !== 'founder') {
        const recipient = requireEmployee(state, to)
        if (['retired', 'failed', 'planned', 'provisioning'].includes(recipient.status)) throw new Error(`employee ${to} is not a valid message recipient (${recipient.status})`)
      }
      if (to === actor.id) throw new Error('company messages must target another participant')
      const messages = await io.readMailbox(to)
      makeMailboxRoom(messages, state.limits.maxMailboxMessages)
      const message: CompanyMessage = {
        id: randomUUID(),
        from: actor.id,
        to,
        content: normalized,
        createdAt: Date.now(),
        deliveryState: 'queued',
      }
      if (to !== 'founder') {
        const employee = requireEmployee(state, to)
        if (state.phase === 'operating' && employee.status === 'idle' && employee.operationalBlock === undefined) {
          try {
            reservationId = this.reserveEmployeeTurn(state, employee, { messageId: message.id })
            message.reservationId = reservationId
            message.leaseAt = Date.now()
            message.deliveryState = 'reserved'
          } catch {
            message.deliveryState = 'held_budget'
          }
        }
      }
      messages.push(message)
      await io.writeMailbox(to, messages)
      return structuredClone(message)
    })
    const message = queued.result
    if (to === 'founder') {
      const founder = this.liveFounder(queued.state)
      if (founder !== undefined) {
        try {
          founder.steer(createUserMessage({
            content: [{ type: 'text', text: untrustedParticipantMessage(message.from, message.id, message.content) }],
            source: { kind: 'plugin', plugin: 'dsh-company' },
          }))
          await this.ackMessage(caller.session.header.cwd, 'founder', message.id)
        } catch {
          // Durable mailbox remains queued.
        }
      }
      return message
    }
    if (message.deliveryState !== 'reserved') return message
    const founder = this.liveFounder(queued.state)
    const employee = queued.state.employees.find((candidate) => candidate.id === to)
    if (founder === undefined || employee === undefined) return message
    try {
      await deliverEmployee(this.ctx, founder, employee, directMessagePrompt(message), signal ?? new AbortController().signal)
      await this.ackMessage(caller.session.header.cwd, to, message.id)
    } catch (error) {
      await this.releaseMessage(caller.session.header.cwd, to, message.id, reservationId, error)
    }
    return message
  }

  async status(caller: Agent, archived = false): Promise<CompanySnapshot> {
    const participant = await this.requireParticipant(caller, archived)
    const inbox = archived ? [] : await this.store.readMailbox(caller.session.header.cwd, participant.actor.id)
    if (!archived) this.kick(caller.session.header.cwd, participant.actor.kind === 'founder' ? caller : this.liveFounder(participant.state))
    return buildSnapshot(this.ctx, participant.state, participant.actor, inbox, this.config.uiPollMs)
  }

  async webPublicStatus(locator: Agent, archived = false): Promise<CompanySnapshot> {
    let state = await this.store.readActive(locator.session.header.cwd)
    if (state !== undefined) state = await this.reflectModelTopologyStaleness(locator.session.header.cwd, state)
    if (state === undefined && archived) state = (await this.store.readArchived(locator.session.header.cwd))[0]
    if (state === undefined) throw new Error('no company exists for this workspace')
    const snapshot = buildSnapshot(this.ctx, state, { kind: 'employee', id: 'web-readonly', sessionId: '' }, [], this.config.uiPollMs)
    snapshot.viewer.permissions = []
    return snapshot
  }

  async control(
    founder: Agent,
    action: 'pause' | 'resume' | 'archive' | 'discard_staged',
    reason: string,
    approvalId?: string,
    expectedRevision?: number,
  ): Promise<CompanyState> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const normalizedReason = normalizeString(reason, 'control reason', 4096)
    if (action === 'pause') {
      const paused = await this.store.transact(founder.session.header.cwd, {
        expectedRevision,
        actor: 'founder',
        type: 'company.paused',
        summary: normalizedReason,
      }, async (state, io) => {
        this.assertFounderState(founder, state)
        if (state.phase !== 'operating' && state.phase !== 'halted') throw new Error(`company cannot pause from ${state.phase}`)
        state.phase = 'paused'
        state.pausedAt = Date.now()
        state.health = { status: 'manual_pause', reason: 'manual', detail: normalizedReason, detectedAt: Date.now(), resumable: true }
        for (const employee of state.employees) {
          if (employee.status === 'retired' || employee.status === 'failed') continue
          releaseEmployeeMoneyReservations(state, employee.id)
          employee.status = 'paused'
          employee.operationalBlock = undefined
        }
        for (const employee of state.employees) {
          const messages = await io.readMailbox(employee.id)
          let changed = false
          for (const message of messages) {
            if (message.deliveryState !== 'reserved') continue
            message.deliveryState = 'queued'
            message.reservationId = undefined
            message.leaseAt = undefined
            changed = true
          }
          if (changed) await io.writeMailbox(employee.id, messages)
        }
        for (const request of state.staffingRequests) {
          if (request.reservationId !== undefined) releaseMoneyReservation(state, request.reservationId)
          request.reservationId = undefined
          request.leaseAt = undefined
          if (request.status === 'in_review') {
            request.status = 'pending'
            request.attemptId = undefined
            request.reviewDeliveryAttempts = 0
            request.lastDeliveredAt = undefined
            request.updatedAt = Date.now()
          }
        }
        for (const work of state.workItems) {
          if (!isOpenStatus(work.status)) continue
          if (work.reservationId !== undefined) {
            releaseMoneyReservation(state, work.reservationId)
              }
          work.status = 'pending'
          work.attempt = Math.max(0, work.attempt - 1)
          work.attemptId = undefined
          work.handoffId = undefined
          work.reassigning = false
          work.reservationId = undefined
          work.leaseAt = undefined
          work.updatedAt = Date.now()
        }
      })
      for (const employee of paused.state.employees) {
        if (employee.status === 'retired') continue
        try { interruptEmployee(this.ctx, founder, employee) } catch (error) { this.ctx.logger.warn(`dsh-company pause interrupt ${employee.id} failed: ${String(error)}`) }
      }
      await Promise.all(paused.state.employees.filter((employee) => employee.status !== 'retired').map((employee) => waitForEmployeeIdle(this.ctx, employee, AbortSignal.timeout(5_000)).catch(() => undefined)))
      return (await this.store.readActive(founder.session.header.cwd)) ?? paused.state
    }
    if (action === 'resume') {
      await this.validatePlanForApproval(founder, located.state, false)
      const resumed = await this.store.transact(founder.session.header.cwd, {
        expectedRevision,
        actor: 'founder',
        type: 'company.resumed',
        summary: normalizedReason,
      }, (state) => {
        this.assertFounderState(founder, state)
        const hasBlockedEmployees = state.employees.some((employee) => employee.operationalBlock !== undefined)
        if (state.phase !== 'paused' && state.phase !== 'halted' && !(state.phase === 'operating' && hasBlockedEmployees)) throw new Error(`company cannot resume from ${state.phase}`)
        state.phase = 'operating'
        state.pausedAt = undefined
        state.health = { status: 'healthy', resumable: true }
        for (const employee of state.employees) {
          employee.operationalBlock = undefined
          if (employee.status === 'paused') employee.status = 'idle'
        }
      })
      this.kick(founder.session.header.cwd, founder)
      return resumed.state
    }
    if (action === 'discard_staged') {
      if (located.state.phase !== 'staged') throw new Error('discard_staged applies only to a staged company')
      return this.store.archive(founder.session.header.cwd, expectedRevision, undefined, { companyId: located.state.id, reason: normalizedReason, stagedOnly: true })
    }
    const unfinished = located.state.workItems.filter((work) => !['completed', 'cancelled'].includes(work.status))
    // Validate before interrupting anyone; the Store revalidates and consumes in
    // the same archive transaction after the bounded quiescence wait.
    if (unfinished.length > 0) requireApproved(located.state, approvalId, 'forced_archive', (payload) => isRecord(payload) && payload.reason === normalizedReason)
    for (const employee of located.state.employees) if (employee.status !== 'retired') interruptEmployee(this.ctx, founder, employee)
    for (const employee of located.state.employees) await waitForEmployeeIdle(this.ctx, employee, AbortSignal.timeout(10_000)).catch(() => undefined)
    return this.store.archive(founder.session.header.cwd, expectedRevision, approvalId, { companyId: located.state.id, reason: normalizedReason })
  }

  async handleUiAction(founder: Agent, request: CompanyActionRequest): Promise<CompanySnapshot> {
    if (String(founder.id) !== request.sessionId) throw new Error('UI action sessionId does not identify the exact live founder')
    const located = await this.requireFounder(founder)
    if (located.state.id !== request.companyId) throw new Error('UI action companyId does not match the active company')
    const action = parseUiAction(request.action, request.payload)
    let archived = false
    let ticketNotice: string | undefined
    switch (action.type) {
      case 'approve_bootstrap':
        await this.approveBootstrap(founder, action.confirmation, { source: 'ui', expectedRevision: request.expectedRevision })
        break
      case 'edit_formation':
        await this.editFormation(founder, action.input, request.expectedRevision)
        break
      case 'resolve_approval':
        await this.resolveApproval(founder, {
          approvalId: action.approvalId,
          decision: action.decision,
          humanStatement: action.humanStatement ?? `Decision recorded from company UI: ${action.decision}`,
          ...(action.note === undefined ? {} : { note: action.note }),
          expectedRevision: request.expectedRevision,
        }, 'ui')
        break
      case 'file_ticket': {
        const ticket = await this.fileTicket(founder, action.input, request.expectedRevision)
        ticketNotice = `ticket ${ticket.id} (${ticket.title}) filed for product ${ticket.productId}; awaiting your triage (company_triage_ticket) and dispatch (company_dispatch_ticket), or delegate to the designated support engineer`
        break
      }
      case 'reprobe_models':
        await this.reprobeModels(founder, request.expectedRevision)
        break
      case 'request_governance_change':
        await this.requestGovernanceChange(founder, action.input, request.expectedRevision, 'ui')
        break
      case 'request_budget_change':
        await this.requestBudgetChange(founder, action.input, request.expectedRevision, 'ui')
        break
      case 'grant_temporary_authorization': {
        const now = Date.now()
        const startsAt = action.input.startsAt ?? now
        requireEmployeeRunnable(located.state, action.input.employeeId)
        if (!Number.isSafeInteger(startsAt) || !Number.isSafeInteger(action.input.expiresAt) || startsAt < 0 || action.input.expiresAt <= startsAt || action.input.expiresAt - startsAt > this.config.maxTemporaryAuthorizationMs) {
          throw new Error(`temporary authorization must have a positive duration no greater than ${this.config.maxTemporaryAuthorizationMs}ms`)
        }
        await this.requestApproval(founder, {
          kind: 'temporary_authorization',
          summary: `Authorize temporary admission for ${action.input.employeeId}`,
          detail: `Grant a bounded temporary authorization to ${action.input.employeeId} until epoch ${action.input.expiresAt}. It may bypass internal monetary admission and pending product/model approvals, but never Host permissions or protected external-effect/release decisions.`,
          payload: {
            action: 'grant',
            employeeId: action.input.employeeId,
            reason: action.input.reason,
            ...(action.input.startsAt === undefined ? {} : { startsAt: action.input.startsAt }),
            expiresAt: action.input.expiresAt,
          },
          risk: 'high',
          expiresAt: action.input.expiresAt,
        }, request.expectedRevision, 'ui')
        break
      }
      case 'revoke_temporary_authorization':
        await this.requestApproval(founder, {
          kind: 'temporary_authorization',
          summary: `Revoke temporary authorization ${action.input.authorizationId}`,
          detail: `Revoke ${action.input.authorizationId} with the recorded reason. The revocation takes effect atomically when this approval is resolved.`,
          payload: { action: 'revoke', authorizationId: action.input.authorizationId, reason: action.input.reason },
          risk: 'high',
        }, request.expectedRevision, 'ui')
        break
      case 'pause':
      case 'resume':
      case 'archive':
      case 'discard_staged':
        await this.control(
          founder,
          action.type,
          action.reason,
          action.type === 'archive' ? action.approvalId : undefined,
          request.expectedRevision,
        )
        archived = action.type === 'archive' || action.type === 'discard_staged'
        break
    }
    const snapshot = await this.status(founder, archived)
    // A console action happens outside any agent turn; without a steer the
    // founder conversation never learns the human decided anything. Inject an
    // authoritative record so the agent can continue operating the company.
    this.steerConsoleDecision(founder, action, snapshot, ticketNotice)
    return snapshot
  }

  private steerConsoleDecision(founder: Agent, action: CompanyUiAction, snapshot: CompanySnapshot, extraDetail?: string): void {
    const detail = extraDetail ?? consoleDecisionDetail(action)
    const text = [
      'dsh-company console decision (authoritative record written by the dsh-company plugin).',
      `Action: ${action.type}${detail === undefined ? '' : ` — ${detail}`}.`,
      `Company ${snapshot.company.id} is now ${snapshot.company.phase} at revision ${snapshot.revision}.`,
      'The durable company state already reflects this human decision; use company_status for details and continue operating the company accordingly.',
    ].join(' ')
    try {
      founder.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-company' },
      }))
    } catch (error) {
      this.ctx.logger.warn(`dsh-company console decision steer failed: ${boundedError(error)}`)
    }
  }

  /** File a human ticket from the Web console: one ticket plus one linked, unassigned repair work item. */
  async fileTicket(founder: Agent, input: FileTicketInput, expectedRevision?: number): Promise<Ticket> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const workspace = (await this.store.pathsForCwd(founder.session.header.cwd, false)).workspace.canonicalPath
    const title = normalizeString(input.title, 'ticket title', 200)
    const description = normalizeMultilineString(input.description, 'ticket description', 16_384)
    const result = await this.store.transact(founder.session.header.cwd, {
      ...(expectedRevision === undefined ? {} : { expectedRevision }),
      actor: 'founder',
      type: 'ticket.filed',
      summary: `Filed ticket ${title}`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (state.phase !== 'operating') throw new Error(`tickets may only be filed while the company is operating (currently ${state.phase})`)
      const product = requireProduct(state, input.productId)
      const open = state.tickets.filter((ticket) => ['filed', 'triaged', 'dispatched'].includes(ticket.status)).length
      if (open >= 32) throw new Error('open ticket cap reached (32)')
      const scope = normalizeWorkspaceRelative(workspace, product.productRoot, 'ticket in_scope', {
        allowGlob: true,
        ...(product.productRoot === '.' ? { allowRoot: true } : {}),
      })
      state.counters.ticket += 1
      state.counters.work += 1
      const now = Date.now()
      const ticket: Ticket = {
        id: `t${state.counters.ticket}`,
        productId: product.id,
        title,
        description,
        reportedBy: 'web-console',
        reportedAt: now,
        status: 'filed',
      }
      const work: WorkItem = {
        id: `w${state.counters.work}`,
        productId: product.id,
        kind: 'repair',
        subject: `[${ticket.id}] ${title}`,
        objective: `Fix the human-reported issue.\n\nReported from the Web console.\n\n${description}`,
        dependencies: [],
        inScope: [scope],
        outOfScope: [],
        acceptance: ['The reported issue is fixed and verified'],
        verify: [],
        deliverables: [],
        ticketId: ticket.id,
        status: 'pending',
        attempt: 0,
        attemptHistory: [],
        createdAt: now,
        updatedAt: now,
      }
      assertAcyclic([...state.workItems.map((item) => ({ id: item.id, dependencies: item.dependencies })), { id: work.id, dependencies: work.dependencies }])
      state.tickets.push(ticket)
      state.workItems.push(work)
      ticket.workItemId = work.id
      return structuredClone(ticket)
    })
    this.kick(founder.session.header.cwd, founder)
    return result.result
  }

  /** Triage sets severity. Founder or the designated support engineer only. */
  async triageTicket(caller: Agent, input: { ticketId: string; severity: TicketSeverity }): Promise<Ticket> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    const severity = input.severity
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id,
      type: 'ticket.triaged',
      summary: `Triaged ticket ${input.ticketId} as ${severity}`,
    }, (state) => {
      this.requireTicketDecider(state, caller)
      const ticket = requireTicket(state, input.ticketId)
      if (ticket.status !== 'filed' && ticket.status !== 'triaged') throw new Error(`ticket ${ticket.id} is ${ticket.status} and cannot be triaged`)
      ticket.severity = severity
      ticket.status = 'triaged'
      return structuredClone(ticket)
    })
    return result.result
  }

  /** Dispatch assigns the linked repair work to a runnable employee — never the founder. */
  async dispatchTicket(caller: Agent, input: { ticketId: string; assigneeId: string; note?: string }): Promise<Ticket> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    const note = input.note === undefined ? undefined : normalizeMultilineString(input.note, 'ticket dispatch note', 4_096)
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id,
      type: 'ticket.dispatched',
      summary: `Dispatched ticket ${input.ticketId} to ${input.assigneeId}`,
    }, (state) => {
      this.requireTicketDecider(state, caller)
      const ticket = requireTicket(state, input.ticketId)
      if (ticket.status !== 'triaged' && ticket.status !== 'dispatched') throw new Error(`ticket ${ticket.id} is ${ticket.status} and cannot be dispatched`)
      const employee = requireEmployeeRunnable(state, input.assigneeId)
      if (ticket.workItemId === undefined) throw new Error(`ticket ${ticket.id} has no linked work item`)
      const work = requireWork(state, ticket.workItemId)
      if (work.status !== 'pending' || work.reassigning === true || work.attempt >= state.limits.maxAttemptsPerWork) throw new Error('dispatch requires retryable pending repair work')
      if (!canEmployeeOwn(state, { ...work, assigneeId: employee.id }, employee.id)) throw new Error(`employee ${employee.id} is not eligible for ticket repair ${work.id}`)
      work.assigneeId = employee.id
      work.updatedAt = Date.now()
      ticket.assigneeId = employee.id
      ticket.dispatchNote = note
      ticket.status = 'dispatched'
      return structuredClone(ticket)
    })
    this.kick(caller.session.header.cwd, this.liveFounder(result.state) ?? caller)
    return result.result
  }

  /** Close a resolved ticket with a human-facing reply (defaults to the work output). */
  async closeTicket(caller: Agent, input: { ticketId: string; reply?: string }): Promise<Ticket> {
    this.assertAdmission()
    const located = await this.requireParticipant(caller)
    const result = await this.store.transact(caller.session.header.cwd, {
      actor: located.actor.id,
      type: 'ticket.closed',
      summary: `Closed ticket ${input.ticketId}`,
    }, (state) => {
      this.requireTicketDecider(state, caller)
      const ticket = requireTicket(state, input.ticketId)
      if (ticket.status !== 'resolved') throw new Error(`ticket ${ticket.id} is ${ticket.status}; only resolved tickets may be closed`)
      if (ticket.workItemId === undefined) throw new Error(`ticket ${ticket.id} has no linked work item`)
      const work = requireWork(state, ticket.workItemId)
      if (!['completed', 'failed', 'cancelled'].includes(work.status)) throw new Error('the linked work item must be terminal before closing')
      const reply = input.reply === undefined ? work.output : input.reply
      if (reply === undefined || reply.trim() === '') throw new Error('a reply is required when the linked work has no output')
      ticket.reply = normalizeMultilineString(reply, 'ticket reply', 16_384)
      ticket.status = 'closed'
      ticket.closedAt = Date.now()
      return structuredClone(ticket)
    })
    return result.result
  }

  /** Designate (or clear) the stationed support engineer allowed to run the ticket loop. */
  async designateSupport(founder: Agent, employeeId?: string): Promise<{ supportEmployeeId?: string }> {
    this.assertAdmission()
    const located = await this.requireFounder(founder)
    const result = await this.store.transact(founder.session.header.cwd, {
      actor: 'founder',
      type: 'support.designated',
      summary: employeeId === undefined ? 'Cleared the designated support engineer' : `Designated ${employeeId} as support engineer`,
    }, (state) => {
      this.assertSameCompany(located.state, state)
      this.assertFounderState(founder, state)
      if (employeeId === undefined) {
        delete state.supportEmployeeId
        return {}
      }
      requireEmployeeRunnable(state, employeeId)
      state.supportEmployeeId = employeeId
      return { supportEmployeeId: employeeId }
    })
    return result.result
  }

  private requireTicketDecider(state: CompanyState, caller: Agent): 'founder' | string {
    const actor = this.actorFor(state, caller)
    if (actor.kind === 'founder') return 'founder'
    if (state.supportEmployeeId === actor.id) {
      requireEmployeeRunnable(state, actor.id)
      return actor.id
    }
    throw new Error('only the founder or the designated support engineer may triage, dispatch, or close tickets')
  }

  /** Steer the founder conversation when a ticket's repair work completes. */
  private steerTicketResolved(state: CompanyState, work: WorkItem): void {
    if (work.ticketId === undefined) return
    const ticket = state.tickets.find((candidate) => candidate.id === work.ticketId)
    if (ticket === undefined || ticket.status !== 'resolved') return
    const founder = this.liveFounder(state)
    if (founder === undefined) return
    const assignee = state.employees.find((employee) => employee.id === ticket.assigneeId)
    const text = [
      'dsh-company ticket resolved (authoritative record written by the dsh-company plugin).',
      `Ticket ${ticket.id} (${ticket.title}) — the linked repair work ${ticket.workItemId} was completed${assignee === undefined ? '' : ` by ${assignee.name} (${assignee.id})`}.`,
      'Reply to the human and close the ticket: use company_close_ticket (the reply defaults to the work output).',
    ].join(' ')
    try {
      founder.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-company' },
      }))
    } catch (error) {
      this.ctx.logger.warn(`dsh-company ticket steer failed: ${boundedError(error)}`)
    }
  }

  private reserveEmployeeTurn(
    state: CompanyState,
    employee: Employee,
    subject: { workId?: string; messageId?: string } = {},
    now = Date.now(),
  ): string {
    const route = activeSelection(employee.llm)
    return reserveMoneyTurn(state, {
      employeeId: employee.id,
      provider: route.provider,
      model: route.model,
      ...(employee.llm.fallback === undefined ? {} : { fallback: employee.llm.fallback }),
      ...subject,
    }, now)
  }

  private applyHrSuccession(state: CompanyState, request: StaffingRequest, employee: Employee): void {
    if (request.recommendation?.designateAsHr !== true || state.hrEmployeeId === employee.id) return
    const previousId = state.hrEmployeeId
    const previous = previousId === undefined ? undefined : state.employees.find((candidate) => candidate.id === previousId)
    if (previous !== undefined) previous.isHr = false
    employee.isHr = true
    state.hrEmployeeId = employee.id
    for (const pending of state.staffingRequests) {
      if (pending.id === request.id || ['rejected', 'applied'].includes(pending.status)) continue
      // Accepted HR deliveries clear their preparation pointer, but retain
      // the turn reservation in the ledger until the old HR session idles.
      for (const reservation of [...state.moneyBudget.reservations]) {
        if (reservation.staffingRequestId === pending.id) releaseMoneyReservation(state, reservation.id)
      }
      if (pending.reservationId !== undefined) releaseMoneyReservation(state, pending.reservationId)
      pending.reservationId = undefined
      pending.leaseAt = undefined
      pending.hrEmployeeId = employee.id
      if (pending.status === 'in_review') {
        pending.status = 'pending'
        pending.attemptId = undefined
        pending.reviewDeliveryAttempts = 0
      }
      pending.lastDeliveredAt = undefined
      pending.updatedAt = Date.now()
    }
    for (const unit of state.orgUnits) {
      if (unit.managerEmployeeId === previousId && /human resources|people|人力资源|hr/iu.test(unit.name)) unit.managerEmployeeId = employee.id
    }
    const recipients = [previous?.id, employee.id].filter((id): id is string => id !== undefined)
    state.governanceNotifications.push({
      id: randomUUID(),
      governanceRevision: state.governanceRevision,
      employeeIds: recipients,
      deliveredEmployeeIds: [],
      content: `HR governance succession approved through staffing request ${request.id}. ${employee.name} (${employee.id}) is now the singleton HR/model-governance lead${previous === undefined ? '' : `; ${previous.name} (${previous.id}) no longer holds HR authority`}. Runtime authorization follows durable company state immediately.`,
      createdAt: Date.now(),
    })
  }

  private transitionProduct(state: CompanyState, product: Product, next: ProductStatus, approvalId?: string): void {
    const current = product.status
    if (current === next) return
    if (current === 'proposed' && next === 'approved') {
      const approval = requireApproved(state, approvalId, 'product_scope', (payload) => isRecord(payload) && payload.action === 'activate' && payload.productId === product.id)
      consumeApproval(approval)
    } else if (current === 'approved' && next === 'active') {
      if (state.phase !== 'operating') throw new Error('company must be operating to activate a product')
    } else if (current === 'active' && next === 'paused') {
      // founder control, no side effect
    } else if (current === 'paused' && next === 'active') {
      if (state.phase !== 'operating') throw new Error('company must be operating to resume a product')
    } else if (current === 'active' && next === 'validating') {
      const required = state.workItems.filter((work) => work.productId === product.id && ['implementation', 'integration'].includes(work.kind))
      if (required.length === 0 || required.some((work) => work.status !== 'completed')) throw new Error('all implementation/integration work must complete before validation')
    } else if (current === 'validating' && next === 'active') {
      // revision cycle
    } else if (current === 'validating' && next === 'released') {
      const approval = requireApproved(state, approvalId ?? product.releaseApprovalId, 'release', (payload) => isRecord(payload) && payload.productId === product.id)
      const work = state.workItems.filter((item) => item.productId === product.id && item.status !== 'cancelled')
      const releaseWork = work.filter((item) => item.kind !== 'operations')
      if (releaseWork.some((item) => item.status !== 'completed')) throw new Error('all pre-release and release work must complete before release')
      if (!work.some((item) => item.kind === 'verification' && item.status === 'completed')) throw new Error('release requires completed verification')
      const independentReview = work.some((item) => {
        if (item.kind !== 'review' || item.status !== 'completed' || item.verdict !== 'pass' || item.assigneeId === undefined) return false
        const reviewed = work.find((candidate) => candidate.id === item.reviewedWorkId)
        return reviewed?.status === 'completed' && reviewed.assigneeId !== undefined && reviewed.assigneeId !== item.assigneeId
      })
      if (!independentReview) throw new Error('release requires an independent passing review')
      consumeApproval(approval)
      product.releaseApprovalId = approval.id
    } else if (current === 'released' && next === 'retired') {
      // terminal retirement
    } else if (['proposed', 'approved', 'active', 'paused', 'validating'].includes(current) && next === 'cancelled') {
      if (state.workItems.some((work) => work.productId === product.id && isOpenStatus(work.status))) throw new Error('cancel or reassign open product work before cancelling the product')
    } else {
      throw new Error(`product cannot move from ${current} to ${next}`)
    }
    product.status = next
  }

  private async knownEmployeeSessions(founder: Agent, state: CompanyState): Promise<Set<string>> {
    const known = new Set(state.employees.flatMap((employee) => employee.sessionId !== undefined && this.ctx.agents.get(SessionId(employee.sessionId)) !== undefined ? [employee.sessionId] : []))
    const listChildren = (this.ctx.subagents as unknown as { listChildren?: ListChildren }).listChildren
    if (typeof listChildren !== 'function') return known
    const entries = await listChildren.call(this.ctx.subagents, SessionId(String(founder.id)))
    for (const entry of entries) {
      if (entry.kind !== 'child' || entry.mode !== 'continuable') continue
      const employee = state.employees.find((candidate) => candidate.sessionId === String(entry.id))
      if (employee !== undefined && entry.label === employeeLabel(state.id, employee.id)) known.add(String(entry.id))
    }
    return known
  }

  private async continueBootstrapProvisioning(founder: Agent, generationId: string): Promise<CompanyState> {
    let state = await this.requireActiveState(founder)
    if (state.phase !== 'provisioning' || state.provisioning?.id !== generationId) return state
    const known = await this.knownEmployeeSessions(founder, state)
    const employeeIds = [...state.provisioning.employeeIds]
    for (const employeeId of employeeIds) {
      state = await this.requireActiveState(founder)
      if (state.phase !== 'provisioning' || state.provisioning?.id !== generationId) return state
      let employee = requireEmployee(state, employeeId)
      if (employee.status === 'idle') continue
      try {
        if (employee.sessionId !== undefined && !known.has(employee.sessionId)) {
          try {
            await startEmployee(this.ctx, this.config, this.selections, founder, state, employee, new AbortController().signal)
          } catch (error) {
            if (!isFallbackEligible(error) || employee.llm.fallback === undefined) throw error
            const fallbackState = await this.store.transact(founder.session.header.cwd, {
              actor: 'scheduler', type: 'employee.fallback_activated', summary: `Activated one-time fallback for employee ${employee.id}`,
            }, (fresh) => {
              if (fresh.provisioning?.id !== generationId) throw new Error('provisioning generation was superseded')
              const current = requireEmployee(fresh, employeeId)
              if (!activateFallback(current)) throw error
              return structuredClone(current)
            })
            state = fallbackState.state
            employee = fallbackState.result
            await startEmployee(this.ctx, this.config, this.selections, founder, state, employee, new AbortController().signal)
          }
        }
        await this.store.transact(founder.session.header.cwd, {
          actor: 'scheduler', type: 'employee.provisioned', summary: `Employee ${employeeId} continuable session is durable`,
        }, (fresh) => {
          if (fresh.provisioning?.id !== generationId) throw new Error('provisioning generation was superseded')
          const current = requireEmployee(fresh, employeeId)
          current.status = 'idle'
          current.joinedAt ??= Date.now()
          current.failure = undefined
        })
      } catch (error) {
        await this.failProvisioning(founder, generationId, employeeId, error)
        return this.requireActiveState(founder)
      }
    }
    const operating = await this.store.transact(founder.session.header.cwd, {
      actor: 'scheduler', type: 'company.operating', summary: 'All planned employees provisioned; company is operating',
    }, (fresh) => {
      if (fresh.provisioning?.id !== generationId || fresh.phase !== 'provisioning') throw new Error('provisioning generation is no longer current')
      if (fresh.employees.some((employee) => employee.status === 'provisioning' || employee.status === 'planned' || employee.status === 'failed')) throw new Error('not every employee finished provisioning')
      fresh.phase = 'operating'
      fresh.provisioning = undefined
      for (const product of fresh.products) if (product.status === 'approved') product.status = 'active'
    })
    this.kick(founder.session.header.cwd, founder)
    return operating.state
  }

  private async continueStaffingProvisioning(founder: Agent, employeeId: string, requestId: string, sessionExists: boolean): Promise<void> {
    const state = await this.requireActiveState(founder)
    const employee = requireEmployee(state, employeeId)
    if (state.phase !== 'operating' || employee.status !== 'provisioning') return
    const reservationId = activeMoneyReservation(state, employee.id)?.id
    let childAccepted = sessionExists
    try {
      if (!sessionExists) {
        await startEmployee(this.ctx, this.config, this.selections, founder, state, employee, new AbortController().signal)
        childAccepted = true
      }
      await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'employee.provisioning_recovered', summary: `Recovered staffing provisioning for ${employee.id}`,
      }, (fresh) => {
        this.assertSameCompany(state, fresh)
        this.assertFounderState(founder, fresh)
        const current = requireEmployee(fresh, employee.id)
        const request = requireStaffingRequest(fresh, requestId)
        if (current.sessionId !== employee.sessionId || current.status !== 'provisioning' || request.status !== 'approved') throw new Error('staffing provisioning recovery was superseded')
        current.status = fresh.phase === 'operating' ? 'idle' : 'paused'
        current.joinedAt ??= Date.now()
        current.failure = undefined
        this.applyHrSuccession(fresh, request, current)
        request.status = 'applied'
        request.updatedAt = Date.now()
      })
    } catch (error) {
      if (childAccepted && !sessionExists && employee.sessionId !== undefined) {
        await this.ctx.subagents.drainContinuableChildren(founder, [SessionId(employee.sessionId)]).catch(() => undefined)
        await this.store.recordRetiredSession(founder.session.header.cwd, employee.sessionId).catch(() => undefined)
      }
      await this.store.transact(founder.session.header.cwd, {
        actor: 'scheduler', type: 'employee.provisioning_recovery_failed', summary: `Staffing provisioning recovery failed for ${employee.id}`,
      }, (fresh) => {
        this.assertSameCompany(state, fresh)
        releaseMoneyReservation(fresh, reservationId)
        const current = requireEmployee(fresh, employee.id)
        const request = requireStaffingRequest(fresh, requestId)
        if (current.sessionId !== employee.sessionId || current.status !== 'provisioning' || request.status !== 'approved') return
        current.status = 'failed'
        if (fresh.supportEmployeeId === current.id) fresh.supportEmployeeId = undefined
        current.failure = boundedError(error)
        request.status = 'approved'
        request.updatedAt = Date.now()
      }).catch(() => undefined)
    }
  }

  private async failProvisioning(founder: Agent, generationId: string, failedEmployeeId: string, error: unknown): Promise<void> {
    const failed = await this.store.transact(founder.session.header.cwd, {
      actor: 'scheduler',
      type: 'company.provisioning_failed',
      summary: `Provisioning failed at employee ${failedEmployeeId}`,
    }, (state) => {
      if (state.provisioning?.id !== generationId) return [] as Employee[]
      const accepted: Employee[] = []
      for (let index = 0; index < state.provisioning.employeeIds.length; index += 1) {
        const employeeId = state.provisioning.employeeIds[index]!
        const reservationId = state.provisioning.reservationIds[index]!
        const employee = requireEmployee(state, employeeId)
        if (employee.status === 'idle') {
          // This employee already accepted its continuable session. Release any
          // unfinished turn entitlement before parking it for a later retry.
          releaseEmployeeMoneyReservations(state, employee.id)
          accepted.push(structuredClone(employee))
          continue
        }
        releaseMoneyReservation(state, reservationId)
        if (employeeId === failedEmployeeId) {
          employee.status = 'failed'
          employee.failure = boundedError(error)
        } else if (employee.status === 'provisioning') {
          employee.status = 'planned'
        }
      }
      state.phase = 'provisioning_failed'
      state.provisioning = undefined
      state.formation.status = 'draft'
      state.formation.approvedAt = undefined
      return accepted
    })
    for (const employee of failed.result) interruptEmployee(this.ctx, founder, employee)
  }

  private async ackMessage(cwd: string | undefined, to: string, messageId: string): Promise<void> {
    await this.store.transact(cwd, {
      actor: 'scheduler',
      type: 'message.accepted',
      summary: `Message ${messageId} accepted by ${to}`,
    }, async (_state, io) => {
      const messages = await io.readMailbox(to)
      const message = messages.find((candidate) => candidate.id === messageId)
      if (message === undefined) return
      message.deliveryState = 'accepted'
      message.acceptedAt = Date.now()
      message.reservationId = undefined
      message.leaseAt = undefined
      await io.writeMailbox(to, messages)
    })
  }

  private async releaseMessage(cwd: string | undefined, to: string, messageId: string, reservationId: string | undefined, error: unknown): Promise<void> {
    await this.store.transact(cwd, {
      actor: 'scheduler',
      type: 'message.delivery_failed',
      summary: `Message ${messageId} delivery failed: ${boundedError(error)}`,
    }, async (state, io) => {
      if (reservationId !== undefined) releaseMoneyReservation(state, reservationId)
      const messages = await io.readMailbox(to)
      const message = messages.find((candidate) => candidate.id === messageId)
      if (message !== undefined) {
        message.attempts = (message.attempts ?? 0) + 1
        message.deliveryState = message.attempts >= MAX_MESSAGE_DELIVERY_ATTEMPTS ? 'dead' : 'queued'
        message.reservationId = undefined
        message.leaseAt = undefined
        await io.writeMailbox(to, messages)
      }
    })
  }

  private async validatePlanForApproval(founder: Agent, state: CompanyState, requireComplete = true): Promise<void> {
    if (requireComplete) this.validatePlanPure(state)
    else this.validateMoneyPlanPure(state)
    for (const employee of state.employees) {
      if (employee.status === 'retired') continue
      const activeProvider = employee.llm.fallbackActive === true && employee.llm.fallback !== undefined ? employee.llm.fallback.provider : employee.llm.provider
      const activeModel = employee.llm.fallbackActive === true && employee.llm.fallback !== undefined ? employee.llm.fallback.model : employee.llm.model
      await this.ctx.llm.resolveCallConfig({
        provider: activeProvider,
        model: activeModel,
        ...(employee.llm.reasoningEffort === undefined ? {} : { reasoningEffort: employee.llm.reasoningEffort as never }),
      })
      if (employee.llm.fallback !== undefined) await this.ctx.llm.resolveCallConfig(employee.llm.fallback)
    }
    if (this.ctx.agents.get(founder.id) !== founder) throw new Error('founder is no longer the exact live agent')
  }

  private validatePlanPure(state: CompanyState): void {
    const hr = state.hrEmployeeId === undefined ? undefined : state.employees.find((employee) => employee.id === state.hrEmployeeId && employee.isHr === true && employee.status !== 'retired')
    if (hr === undefined) throw new Error('formation plan requires the default HR governance employee')
    if (state.formation.charter.trim() === '') throw new Error('formation plan requires a non-empty charter')
    const firstProduct = state.formation.firstProductId === undefined ? undefined : state.products.find((product) => product.id === state.formation.firstProductId)
    if (firstProduct === undefined || ['cancelled', 'retired'].includes(firstProduct.status)) throw new Error('formation plan requires its first product')
    if (state.moneyBudget.migrationRequired === true) throw new Error('formation plan still requires financial migration')
    const allocated = state.products.filter((product) => !['cancelled', 'retired'].includes(product.status)).reduce((sum, product) => sum + (product.budgetMicros ?? 0), 0)
    if (allocated > state.moneyBudget.totalMicros) throw new Error('product monetary allocations exceed the company monetary budget')
    for (const employee of state.employees) if (employee.status !== 'retired' && (employee.budgetMicros ?? 0) > state.moneyBudget.totalMicros) throw new Error(`employee ${employee.id} monetary ceiling exceeds company budget`)
    const admissionProbe = structuredClone(state)
    reserveMoneyTurn(admissionProbe, {
      employeeId: hr.id,
      provider: hr.llm.provider,
      model: hr.llm.model,
      ...(hr.llm.fallback === undefined ? {} : { fallback: hr.llm.fallback }),
    })
    assertAcyclic(state.workItems)
    for (const work of state.workItems) validateWorkReferences(state, work)
  }

  private validateMoneyPlanPure(state: CompanyState): void {
    if (state.moneyBudget.migrationRequired === true) throw new Error('financial migration approval is required before resume')
    if (state.moneyBudget.spentMicros + state.moneyBudget.reservedMicros > state.moneyBudget.totalMicros) throw new Error('company monetary budget is overdrawn')
    const productAllocation = state.products.filter((product) => !['cancelled', 'retired'].includes(product.status)).reduce((sum, product) => sum + (product.budgetMicros ?? 0), 0)
    if (productAllocation > state.moneyBudget.totalMicros) throw new Error('product monetary allocations exceed company budget')
    for (const employee of state.employees) if (employee.status !== 'retired' && (employee.budgetMicros ?? 0) > state.moneyBudget.totalMicros) throw new Error(`employee ${employee.id} monetary ceiling exceeds company budget`)
    for (const employee of state.employees) {
      if (employee.status === 'retired' || employee.status === 'failed') continue
      const primaryRates = resolveRateSnapshot(state, employee.llm.provider, employee.llm.model)
      if (primaryRates.inputCacheMissMicrosPerMillion > 0 || primaryRates.inputCacheHitMicrosPerMillion > 0 || primaryRates.outputMicrosPerMillion > 0) {
        resolveModelContextWindow(state, employee.llm.provider, employee.llm.model)
      }
      if (employee.llm.fallback !== undefined) {
        const fallbackRates = resolveRateSnapshot(state, employee.llm.fallback.provider, employee.llm.fallback.model)
        if (fallbackRates.inputCacheMissMicrosPerMillion > 0 || fallbackRates.inputCacheHitMicrosPerMillion > 0 || fallbackRates.outputMicrosPerMillion > 0) {
          resolveModelContextWindow(state, employee.llm.fallback.provider, employee.llm.fallback.model)
        }
      }
    }
  }

  private async requireFounder(founder: Agent): Promise<{ state: CompanyState; actor: Extract<CompanyActor, { kind: 'founder' }> }> {
    const state = await this.requireActiveState(founder)
    this.assertFounderState(founder, state)
    return { state, actor: { kind: 'founder', id: 'founder', sessionId: String(founder.id) } }
  }

  private async requireParticipant(caller: Agent, archived = false): Promise<{ state: CompanyState; actor: CompanyActor }> {
    let state = await this.store.readActive(caller.session.header.cwd)
    if (state !== undefined) state = await this.reflectModelTopologyStaleness(caller.session.header.cwd, state)
    if (state === undefined && archived) state = (await this.store.readArchived(caller.session.header.cwd))[0]
    if (state === undefined) throw new Error('no company exists for this workspace')
    return { state, actor: this.actorFor(state, caller) }
  }

  private actorFor(state: CompanyState, caller: Agent): CompanyActor {
    if (this.ctx.agents.get(caller.id) !== caller) throw new Error('company operation requires the exact live calling agent')
    if (String(caller.id) === state.founderSessionId) return { kind: 'founder', id: 'founder', sessionId: String(caller.id) }
    const employee = state.employees.find((candidate) => candidate.sessionId === String(caller.id) && candidate.status !== 'retired')
    if (employee === undefined) throw new Error('calling agent is not an active participant in this company')
    return { kind: 'employee', id: employee.id, sessionId: String(caller.id) }
  }

  private async requireActiveState(caller: Agent): Promise<CompanyState> {
    const state = await this.store.readActive(caller.session.header.cwd)
    if (state === undefined) throw new Error('no active company exists for this workspace')
    return this.reflectModelTopologyStaleness(caller.session.header.cwd, state)
  }

  private async reflectModelTopologyStaleness(cwd: string | undefined, state: CompanyState): Promise<CompanyState> {
    if (this.modelTopologyChangedAt === 0 || state.modelCatalog.stale || (state.modelCatalog.probedAt ?? 0) > this.modelTopologyChangedAt) return state
    try {
      return (await this.store.transact(cwd, {
        expectedRevision: state.revision,
        actor: 'scheduler',
        type: 'models.invalidated',
        summary: 'Marked a dormant model catalog stale after adapter/settings topology change',
      }, (fresh) => invalidateModelCatalog(fresh.modelCatalog, Date.now()))).state
    } catch (error) {
      if (!(error instanceof RevisionConflictError)) throw error
      const fresh = await this.store.readActive(cwd)
      if (fresh === undefined) throw new Error('active company disappeared while refreshing model catalog topology')
      return this.reflectModelTopologyStaleness(cwd, fresh)
    }
  }

  private assertFounderState(founder: Agent, state: CompanyState): void {
    if (this.ctx.agents.get(founder.id) !== founder || String(founder.id) !== state.founderSessionId) throw new Error('only the exact live founder may perform this operation')
  }

  private assertSameCompany(before: CompanyState, fresh: CompanyState): void {
    if (before.id !== fresh.id) throw new Error('active company changed while the operation was being prepared')
  }

  private assertBootstrapActor(founder: Agent): void {
    if (this.ctx.agents.get(founder.id) !== founder) throw new Error('company bootstrap requires the exact live calling agent')
    if (founder.session.header.origin === 'subagent' || (founder.session.header.delegationDepth ?? 0) !== 0) {
      throw new Error('subagents and delegated sessions cannot bootstrap a company')
    }
  }

  private assertLaterHuman(founder: Agent, earlierMessageId: string, action: string): void {
    const latest = latestGenuineUserMessage(founder)
    if (latest === undefined || String(latest.id) === earlierMessageId) throw new Error(`${action} requires a newer genuine user-source message than the staging/request turn`)
  }

  private assertLaterHumanForApproval(founder: Agent, state: CompanyState, approvalId: string): void {
    const approval = state.approvals.find((candidate) => candidate.id === approvalId)
    if (approval === undefined) throw new Error(`unknown approval ${approvalId}`)
    this.assertLaterHuman(founder, approval.requestedFromUserMessageId ?? state.stagedFromUserMessageId, `resolving approval ${approvalId}`)
    if (approval.requestedBy !== 'founder') {
      const requester = state.employees.find((employee) => employee.id === approval.requestedBy)
      if (requester?.sessionId === String(founder.id)) throw new Error('approval requester may not resolve its own request')
    }
  }

  private liveFounder(state: CompanyState): Agent | undefined {
    return this.ctx.agents.get(SessionId(state.founderSessionId))
  }

  private kick(cwd: string | undefined, founder?: Agent): void {
    if (this.closing) return
    void this.scheduler?.kick(cwd, founder).catch((error) => this.ctx.logger.warn(`dsh-company scheduler kick failed: ${String(error)}`))
  }

  private assertAdmission(): void {
    if (this.closing) throw new Error('dsh-company runtime is unloading; new operations are not admitted')
  }
}

function latestGenuineUserMessage(agent: Agent): ReturnType<Agent['session']['deriveMessages']>[number] | undefined {
  const messages = agent.session.deriveMessages()
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]!
    if (message.role === 'user' && message.source.kind === 'user') return message
  }
  return undefined
}

function requireEmployee(state: CompanyState, employeeId: string): Employee {
  const employee = state.employees.find((candidate) => candidate.id === employeeId)
  if (employee === undefined) throw new Error(`unknown employee ${employeeId}`)
  return employee
}

function requireTicket(state: CompanyState, ticketId: string): Ticket {
  const ticket = state.tickets.find((candidate) => candidate.id === ticketId)
  if (ticket === undefined) throw new Error(`unknown ticket ${ticketId}`)
  return ticket
}

/** Keep the ticket lifecycle in step with its linked work item's terminal status. */
function syncTicketResolution(state: CompanyState, work: WorkItem): void {
  if (work.ticketId === undefined) return
  const ticket = state.tickets.find((candidate) => candidate.id === work.ticketId)
  if (ticket === undefined || ticket.status === 'closed') return
  if (work.status === 'completed') {
    if (ticket.status !== 'resolved') {
      ticket.status = 'resolved'
      ticket.resolvedAt = Date.now()
    }
  } else if (work.status === 'failed' || work.status === 'cancelled') {
    if (ticket.status === 'dispatched' || ticket.status === 'resolved') {
      // Preserve the terminal attempt in attemptHistory, then make the linked
      // repair work retryable for an explicit new dispatch decision.
      ticket.status = 'triaged'
      ticket.assigneeId = undefined
      ticket.resolvedAt = undefined
      const reservation = work.assigneeId === undefined || work.assigneeId === 'founder' ? undefined : activeMoneyReservation(state, work.assigneeId)
      if (reservation?.workId === work.id) releaseMoneyReservation(state, reservation.id)
      work.status = 'pending'
      work.assigneeId = undefined
      work.output = undefined
      work.verdict = undefined
      work.findings = undefined
      work.evidence = undefined
      work.attemptId = undefined
      work.reservationId = undefined
      work.leaseAt = undefined
      work.updatedAt = Date.now()
    }
  }
}

function requireEmployeeRunnable(state: CompanyState, employeeId: string): Employee {
  const employee = requireEmployee(state, employeeId)
  if (['retired', 'failed', 'planned', 'provisioning'].includes(employee.status)) throw new Error(`employee ${employeeId} is not runnable (${employee.status})`)
  if (employee.operationalBlock !== undefined) throw new Error(`employee ${employeeId} is operationally blocked (${employee.operationalBlock.kind})`)
  return employee
}

function requireProduct(state: CompanyState, productId: string): Product {
  const product = state.products.find((candidate) => candidate.id === productId)
  if (product === undefined) throw new Error(`unknown product ${productId}`)
  return product
}

function normalizeWorkPlan(workspace: string, input: CreateWorkInput): Omit<WorkItem, 'id' | 'status' | 'attempt' | 'attemptHistory' | 'createdAt' | 'updatedAt'> {
  const kind = input.kind
  const inScope = normalizeList(input.inScope, 'in_scope', fileScopeMinimum(kind), 512, 4096)
    .map((path, index) => normalizeWorkspaceRelative(workspace, path, `in_scope[${index}]`, { allowGlob: true }))
  const outOfScope = normalizeList(input.outOfScope ?? [], 'out_of_scope', 0, 512, 4096)
    .map((path, index) => normalizeWorkspaceRelative(workspace, path, `out_of_scope[${index}]`, { allowGlob: true }))
  return {
    productId: input.productId,
    kind,
    subject: normalizeString(input.subject, 'work subject', 500),
    objective: normalizeMultilineString(input.objective, 'work objective', 32_768),
    ...(input.assigneeId === undefined ? {} : { assigneeId: input.assigneeId }),
    ...(input.eligibleEmployeeIds === undefined ? {} : { eligibleEmployeeIds: unique(input.eligibleEmployeeIds, 'eligible_employee_ids') }),
    ...(input.eligibleOrgUnitIds === undefined ? {} : { eligibleOrgUnitIds: unique(input.eligibleOrgUnitIds, 'eligible_org_unit_ids') }),
    dependencies: unique(input.dependencies ?? [], 'dependencies'),
    ...(input.approvalDependencies === undefined ? {} : { approvalDependencies: unique(input.approvalDependencies, 'approval_dependencies') }),
    inScope,
    outOfScope,
    acceptance: normalizeList(input.acceptance, 'acceptance', 1, 256, 16_384),
    verify: normalizeList(input.verify ?? [], 'verify', 0, 256, 16_384),
    deliverables: normalizeList(input.deliverables ?? [], 'deliverables', 0, 256, 16_384),
    ...(input.reviewedWorkId === undefined ? {} : { reviewedWorkId: input.reviewedWorkId }),
  }
}

function validateWorkReferences(state: CompanyState, work: Pick<WorkItem, 'productId' | 'kind' | 'dependencies' | 'approvalDependencies' | 'assigneeId' | 'eligibleEmployeeIds' | 'reviewedWorkId'>, selfId?: string): void {
  requireProduct(state, work.productId)
  for (const dependency of work.dependencies) {
    if (dependency === selfId) throw new Error('work cannot depend on itself')
    if (!state.workItems.some((candidate) => candidate.id === dependency)) throw new Error(`unknown work dependency ${dependency}`)
  }
  for (const approvalId of work.approvalDependencies ?? []) if (!state.approvals.some((approval) => approval.id === approvalId)) throw new Error(`unknown approval dependency ${approvalId}`)
  if (work.assigneeId !== undefined && work.assigneeId !== 'founder') requireEmployee(state, work.assigneeId)
  for (const employeeId of work.eligibleEmployeeIds ?? []) requireEmployee(state, employeeId)
  for (const unitId of (work as Pick<WorkItem, 'eligibleOrgUnitIds'>).eligibleOrgUnitIds ?? []) {
    if (!state.orgUnits.some((unit) => unit.id === unitId)) throw new Error(`unknown eligible org unit ${unitId}`)
  }
  if (work.kind === 'review') {
    if (work.reviewedWorkId === undefined) throw new Error('review work requires reviewed_work_id')
    const reviewed = state.workItems.find((candidate) => candidate.id === work.reviewedWorkId)
    if (reviewed === undefined) throw new Error(`reviewed work ${work.reviewedWorkId} does not exist`)
    if (reviewed.productId !== work.productId) throw new Error('reviewed work must belong to the same product')
    if (work.assigneeId !== undefined && reviewed.assigneeId === work.assigneeId) throw new Error('review assignee must differ from reviewed work assignee')
  } else if (work.reviewedWorkId !== undefined) {
    throw new Error('reviewed_work_id is valid only for review work')
  }
  if ((work.kind === 'release' || work.kind === 'operations') && (work.approvalDependencies?.length ?? 0) === 0) {
    throw new Error(`${work.kind} work requires approval_dependencies`)
  }
  const approvalDependencies = (work.approvalDependencies ?? []).map((approvalId) => state.approvals.find((approval) => approval.id === approvalId))
  if (work.kind === 'release' && !approvalDependencies.some((approval) => approval?.kind === 'release'
    && isRecord(approval.payload) && approval.payload.productId === work.productId)) {
    throw new Error(`release work requires a release approval for product ${work.productId}`)
  }
  if (work.kind === 'operations' && !approvalDependencies.some((approval) => approval?.kind === 'external_effect')) {
    throw new Error('operations work requires an external_effect approval dependency')
  }
}

function boundedMicros(value: number, maximum: number, label: string): number {
  if (!Number.isSafeInteger(value) || value < 0 || value > maximum) throw new Error(`${label} must be a safe integer in 0..${maximum}`)
  return value
}

function deriveSlogan(mission: string): string {
  const first = mission.normalize('NFC').trim().split(/(?<=[.!?。！？])\s*/u, 1)[0]?.trim() ?? mission.trim()
  return (first || 'Company').slice(0, 160)
}

function requireStaffingRequest(state: CompanyState, requestId: string): StaffingRequest {
  const request = state.staffingRequests.find((candidate) => candidate.id === requestId)
  if (request === undefined) throw new Error(`unknown staffing request ${requestId}`)
  return request
}

function orgPathForEmployee(state: CompanyState, employee: Employee): string[] {
  const path: string[] = []
  let unit = employee.orgUnitId === undefined ? undefined : state.orgUnits.find((candidate) => candidate.id === employee.orgUnitId)
  const seen = new Set<string>()
  while (unit !== undefined && !seen.has(unit.id)) {
    seen.add(unit.id)
    path.push(unit.name)
    unit = unit.parentId === undefined ? undefined : state.orgUnits.find((candidate) => candidate.id === unit!.parentId)
  }
  path.reverse()
  return path.length === 0 ? [state.name] : path
}

function ensureOrgPath(state: CompanyState, path: string[]): CompanyState['orgUnits'][number] {
  const root = state.orgUnits.find((unit) => unit.parentId === undefined)
  if (root === undefined) throw new Error('organization has no root unit')
  let parent = root
  const segments = path[0]?.localeCompare(root.name, undefined, { sensitivity: 'accent' }) === 0 ? path.slice(1) : path
  for (let index = 0; index < segments.length; index += 1) {
    const name = normalizeString(segments[index]!, `org_path[${index}]`, 200)
    let unit = state.orgUnits.find((candidate) => candidate.parentId === parent.id && candidate.name.localeCompare(name, undefined, { sensitivity: 'accent' }) === 0)
    if (unit === undefined) {
      state.counters.orgUnit += 1
      unit = {
        id: `ou${state.counters.orgUnit}`,
        name,
        kind: segments.length === 1 ? 'department' : index === segments.length - 1 ? 'team' : index === 0 && segments.length > 2 ? 'division' : 'department',
        parentId: parent.id,
        createdAt: Date.now(),
      }
      state.orgUnits.push(unit)
    }
    parent = unit
  }
  return parent
}

function ensurePosition(state: CompanyState, orgUnitId: string, title: string, responsibilities: string[]): CompanyState['positions'][number] {
  let position = state.positions.find((candidate) => candidate.orgUnitId === orgUnitId && candidate.title === title)
  if (position === undefined) {
    state.counters.position += 1
    position = { id: `pos${state.counters.position}`, title, orgUnitId, responsibilities: [...responsibilities], createdAt: Date.now() }
    state.positions.push(position)
  } else if (position.responsibilities.length !== responsibilities.length || position.responsibilities.some((item, index) => item !== responsibilities[index])) {
    throw new Error(`position ${JSON.stringify(title)} already exists in this org unit with different responsibilities; use a distinct position title`)
  }
  return position
}

function normalizeList(values: string[], label: string, min: number, max: number, maxChars: number): string[] {
  if (!Array.isArray(values) || values.length < min || values.length > max) throw new Error(`${label} must contain ${min}..${max} items`)
  return unique(values.map((value, index) => normalizeString(value, `${label}[${index}]`, maxChars)), label)
}

function unique(values: string[], label: string): string[] {
  const result = [...new Set(values)]
  if (result.length !== values.length) throw new Error(`${label} must not contain duplicates`)
  return result
}

function fileScopeMinimum(kind: WorkKind): number {
  return ['implementation', 'repair', 'integration', 'release', 'operations'].includes(kind) ? 1 : 0
}

function parseUiAction(type: CompanyUiAction['type'], payload: JsonValue): CompanyUiAction {
  const value = isRecord(payload) ? payload : {}
  switch (type) {
    case 'approve_bootstrap':
      return { type, confirmation: typeof value.confirmation === 'string' ? value.confirmation : 'Approved and started from the company UI.' }
    case 'edit_formation': {
      const product = isRecord(value.first_product) ? value.first_product : undefined
      const modelPrices = parseHumanModelPrices(value.model_prices)
      return { type, input: {
        ...(typeof value.name === 'string' ? { name: value.name } : {}),
        ...(typeof value.slogan === 'string' ? { slogan: value.slogan } : {}),
        ...(typeof value.mission === 'string' ? { mission: value.mission } : {}),
        ...(typeof value.charter === 'string' ? { charter: value.charter } : {}),
        ...(value.total_budget === undefined ? {} : { totalBudgetMicros: currencyUnitsToMicros(value.total_budget, 'total_budget') }),
        ...(typeof value.currency === 'string' ? { currency: value.currency } : {}),
        ...(modelPrices === undefined ? {} : { modelPrices }),
        ...(typeof value.hr_name === 'string' ? { hrName: value.hr_name } : {}),
        ...(typeof value.hr_provider === 'string' ? { hrProvider: value.hr_provider } : {}),
        ...(typeof value.hr_model === 'string' ? { hrModel: value.hr_model } : {}),
        ...(typeof value.hr_reasoning_effort === 'string' ? { hrReasoningEffort: value.hr_reasoning_effort } : {}),
        ...(product === undefined ? {} : { firstProduct: {
          ...(typeof product.name === 'string' ? { name: product.name } : {}),
          ...(typeof product.summary === 'string' ? { summary: product.summary } : {}),
          ...(typeof product.product_root === 'string' ? { productRoot: product.product_root } : {}),
          ...(Array.isArray(product.success_criteria) ? { successCriteria: product.success_criteria as string[] } : {}),
          ...(product.product_budget === undefined ? {} : { budgetMicros: currencyUnitsToMicros(product.product_budget, 'first_product.product_budget') }),
        } }),
      } }
    }
    case 'resolve_approval': {
      const approvalId = value.approval_id
      if (typeof approvalId !== 'string' || (value.decision !== 'approved' && value.decision !== 'rejected')) throw new Error('resolve_approval payload requires approval_id and decision')
      return {
        type,
        approvalId,
        decision: value.decision,
        ...(typeof value.human_statement === 'string' ? { humanStatement: value.human_statement } : {}),
        ...(typeof value.note === 'string' ? { note: value.note } : {}),
      }
    }
    case 'file_ticket': {
      if (typeof value.product_id !== 'string' || typeof value.title !== 'string' || typeof value.description !== 'string') throw new Error('file_ticket payload requires product_id, title, and description')
      return { type, input: { productId: value.product_id, title: value.title, description: value.description } }
    }
    case 'reprobe_models':
      return { type }
    case 'request_governance_change':
      return { type, input: {
        ...(typeof value.slogan === 'string' ? { slogan: value.slogan } : {}),
        ...(typeof value.mission === 'string' ? { mission: value.mission } : {}),
        ...(typeof value.charter === 'string' ? { charter: value.charter } : {}),
        ...(typeof value.expected_governance_revision === 'number' ? { expectedGovernanceRevision: value.expected_governance_revision } : {}),
      } }
    case 'request_budget_change': {
      const modelPrices = parseHumanModelPrices(value.model_prices)
      const productBudgets = Array.isArray(value.product_budgets) ? value.product_budgets.map((row, index) => {
        if (!isRecord(row) || typeof row.product_id !== 'string' || row.product_budget === undefined) throw new Error(`product_budgets[${index}] is incomplete`)
        return { productId: row.product_id, budgetMicros: currencyUnitsToMicros(row.product_budget, `product_budgets[${index}].product_budget`) }
      }) : undefined
      return { type, input: {
        ...(value.total_budget === undefined ? {} : { totalBudgetMicros: currencyUnitsToMicros(value.total_budget, 'total_budget') }),
        ...(productBudgets === undefined ? {} : { productBudgets }),
        ...(modelPrices === undefined ? {} : { modelPrices }),
        ...(typeof value.expected_pricing_revision === 'number' ? { expectedPricingRevision: value.expected_pricing_revision } : {}),
      } }
    }
    case 'grant_temporary_authorization': {
      if (typeof value.employee_id !== 'string' || typeof value.reason !== 'string' || typeof value.expires_at !== 'number') throw new Error('grant_temporary_authorization payload requires employee_id, reason, and expires_at')
      return { type, input: {
        employeeId: value.employee_id,
        reason: value.reason,
        ...(typeof value.starts_at === 'number' ? { startsAt: value.starts_at } : {}),
        expiresAt: value.expires_at,
      } }
    }
    case 'revoke_temporary_authorization': {
      if (typeof value.authorization_id !== 'string' || typeof value.reason !== 'string') throw new Error('revoke_temporary_authorization payload requires authorization_id and reason')
      return { type, input: { authorizationId: value.authorization_id, reason: value.reason } }
    }
    case 'pause':
    case 'resume':
    case 'discard_staged':
      return { type, reason: typeof value.reason === 'string' ? value.reason : `Requested from company UI: ${type}` }
    case 'archive': {
      const approvalId = value.approval_id
      return {
        type,
        reason: typeof value.reason === 'string' ? value.reason : 'Requested from company UI: archive',
        ...(typeof approvalId === 'string' ? { approvalId } : {}),
      }
    }
  }
}

function parseHumanModelPrices(value: JsonValue | undefined): NonNullable<BudgetChangeInput['modelPrices']> | undefined {
  if (value === undefined) return undefined
  if (!Array.isArray(value)) throw new Error('model_prices must be an array')
  return value.map((raw, index) => {
    if (!isRecord(raw) || typeof raw.provider !== 'string' || typeof raw.model !== 'string') throw new Error(`model_prices[${index}] requires provider and model`)
    const rate = (humanKey: string): number | undefined => raw[humanKey] === undefined
      ? undefined
      : currencyUnitsToMicros(raw[humanKey], `model_prices[${index}].${humanKey}`)
    const miss = rate('input_cache_miss_per_million')
    const hit = rate('input_cache_hit_per_million')
    const output = rate('output_per_million')
    return {
      provider: raw.provider,
      model: raw.model,
      ...(miss === undefined ? {} : { inputCacheMissMicrosPerMillion: miss }),
      ...(hit === undefined ? {} : { inputCacheHitMicrosPerMillion: hit }),
      ...(output === undefined ? {} : { outputMicrosPerMillion: output }),
    }
  })
}

async function queueFounderNotification(
  state: CompanyState,
  io: MutationContext,
  from: string,
  content: string,
): Promise<void> {
  const messages = await io.readMailbox('founder')
  makeMailboxRoom(messages, state.limits.maxMailboxMessages)
  const boundedContent = content.normalize('NFC').replace(/\0/gu, '').trim().slice(0, state.limits.maxMessageChars)
  messages.push({
    id: randomUUID(),
    from,
    to: 'founder',
    content: boundedContent === '' ? 'Company event recorded; use company_status for details.' : boundedContent,
    createdAt: Date.now(),
    deliveryState: 'queued',
  })
  await io.writeMailbox('founder', messages)
}

function directMessagePrompt(message: CompanyMessage): string {
  return `${untrustedParticipantMessage(message.from, message.id, message.content)}

Handle this direct message only in the current turn; do not claim unrelated work.`
}

function boundedError(error: unknown): string {
  const value = error instanceof Error ? `${error.name}: ${error.message}` : String(error)
  return value.length <= 4096 ? value : `${value.slice(0, 4095)}…`
}

/** Human-readable specifics of one Web console decision, for the founder steer. */
function consoleDecisionDetail(action: CompanyUiAction): string | undefined {
  switch (action.type) {
    case 'approve_bootstrap':
      return `human confirmation: "${action.confirmation}"; only the HR lead is provisioned, plan staffing and work next`
    case 'edit_formation': {
      const changed = Object.entries(action.input)
        .filter(([, value]) => value !== undefined)
        .map(([key]) => key)
      return changed.length === 0 ? undefined : `edited formation fields: ${changed.join(', ')}`
    }
    case 'resolve_approval':
      return `${action.decision} approval ${action.approvalId}${action.humanStatement === undefined ? '' : ` (human statement: "${action.humanStatement}")`}${action.note === undefined ? '' : `; note: ${action.note}`}`
    case 'reprobe_models':
      return 'model catalog re-probed; review newly discovered routes on the recruiting page'
    case 'file_ticket':
      return 'a repair work item was opened for the reported issue'
    case 'request_governance_change':
      return 'governance change approval opened; it still awaits a human decision in the approvals tab'
    case 'request_budget_change':
      return 'budget/pricing approval(s) opened; they still await a human decision in the approvals tab'
    case 'grant_temporary_authorization':
      return `temporary authorization request opened for ${action.input.employeeId} (${action.input.reason}); it still awaits approval`
    case 'revoke_temporary_authorization':
      return `revocation request opened for temporary authorization ${action.input.authorizationId} (${action.input.reason}); it still awaits approval`
    case 'pause':
    case 'resume':
    case 'archive':
    case 'discard_staged':
      return `reason: "${action.reason}"`
  }
}

export { RevisionConflictError }
