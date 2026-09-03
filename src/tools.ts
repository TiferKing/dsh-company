import type { Context } from '@deepseek-ai/cordis'
import { defineTool, type JsonValue, type ParameterSchemaSpec, type ToolRunContext } from '@deepseek-ai/dsh-tools'
import type { Agent } from '@deepseek-ai/dsh-agent'
import type { CompanyRuntime } from './runtime.js'
import type { ApprovalKind, ModelPriceInput, ProductStatus, ReviewFinding, TokenPriceInput, WorkKind } from './types.js'
import { currencyUnitsToMicros } from './schemas.js'

const WORK_KINDS: WorkKind[] = ['discovery', 'design', 'implementation', 'verification', 'review', 'repair', 'integration', 'release', 'operations']
const PRODUCT_STATUSES: ProductStatus[] = ['proposed', 'approved', 'active', 'paused', 'validating', 'released', 'retired', 'cancelled']
const APPROVAL_KINDS: ApprovalKind[] = ['budget_change', 'pricing_change', 'governance_change', 'temporary_authorization', 'organization_change', 'product_scope', 'model_route', 'release', 'external_effect', 'forced_archive']

export const COMPANY_TOOL_NAMES = [
  'company_bootstrap', 'company_edit_formation', 'company_approve',
  'company_request_staffing', 'company_claim_staffing_assessment', 'company_submit_staffing_assessment', 'company_apply_staffing_adjustment',
  'company_add_employee', 'company_remove_employee', 'company_create_product', 'company_update_product', 'company_create_work', 'company_edit_work',
  'company_reassign_work', 'company_claim_work', 'company_update_work', 'company_send_message',
  'company_request_approval', 'company_request_budget_change', 'company_resolve_approval', 'company_reprobe_models', 'company_request_governance_change',
  'company_grant_temporary_authorization', 'company_revoke_temporary_authorization', 'company_status', 'company_control',
] as const

export function registerCompanyTools(ctx: Context, runtime: CompanyRuntime): void {
  register(ctx, 'company_bootstrap', 'Stage a currency-budget-first formation decision with company identity, governance, first product, three-rate price matrix, and initial HR lead. Nothing starts until a later explicit human approval.', {
    name: requiredString('Proposed company name.'),
    slogan: { type: 'string', description: 'Short company slogan; derived from mission when omitted.' },
    mission: requiredString('Proposed concrete mission and bounded outcome. Multi-line allowed.'),
    charter: requiredString('Proposed company charter and governance rules. Multi-line: one clause per line using 1. / 1.1 / # / - outline markers; the UI renders them as an expandable tree.'),
    first_product: {
      type: 'object', required: true, additionalProperties: false,
      properties: {
        name: requiredString('First product name.'), summary: requiredString('Bounded first-product scope.'),
        product_root: requiredString('Workspace-relative product root.'),
        success_criteria: requiredStringArray('Measurable product success criteria.'),
        product_budget: { type: 'number', required: true, description: 'First-product monetary ceiling in normal currency units (maximum 6 decimals).' },
        token_budget: { type: 'integer', description: 'Deprecated compatibility token-safety allocation.' },
      },
    },
    total_budget: { type: 'number', required: true, description: 'Company-wide monetary ceiling in normal currency units (maximum 6 decimals).' },
    total_token_budget: { type: 'integer', description: 'Deprecated compatibility token-safety ceiling.' },
    currency: requiredString('ISO-like currency code for all monetary amounts, e.g. USD or CNY.'),
    model_prices: modelPriceArray(),
    prices: tokenPriceArray(),
    drafted_by: { type: 'string', enum: ['ai', 'user'] },
    hr_name: { type: 'string', description: 'Initial HR governance lead display name.' },
    hr_provider: { type: 'string' }, hr_model: { type: 'string' }, hr_reasoning_effort: { type: 'string' },
  }, async (args, exec) => {
    const first = args.first_product as Record<string, unknown>
    const result = await runtime.bootstrap(requireAgent(exec), {
      name: args.name as string, ...(args.slogan === undefined ? {} : { slogan: args.slogan as string }), mission: args.mission as string, charter: args.charter as string,
      firstProduct: {
        name: first.name as string, summary: first.summary as string, productRoot: first.product_root as string,
        successCriteria: first.success_criteria as string[], budgetMicros: currencyUnitsToMicros(first.product_budget, 'first_product.product_budget'),
        ...(first.token_budget === undefined ? {} : { tokenBudget: first.token_budget as number }),
      },
      totalBudgetMicros: currencyUnitsToMicros(args.total_budget, 'total_budget'), currency: args.currency as string,
      ...(args.total_token_budget === undefined ? {} : { totalTokenBudget: args.total_token_budget as number }),
      ...(args.model_prices === undefined ? {} : { modelPrices: modelPricesFromArgs(args.model_prices) }),
      ...(args.prices === undefined ? {} : { prices: tokenPricesFromArgs(args.prices) }),
      ...(args.drafted_by === undefined ? {} : { draftedBy: args.drafted_by as 'ai' | 'user' }),
      ...(args.hr_name === undefined ? {} : { hrName: args.hr_name as string }),
      ...(args.hr_provider === undefined ? {} : { hrProvider: args.hr_provider as string }),
      ...(args.hr_model === undefined ? {} : { hrModel: args.hr_model as string }),
      ...(args.hr_reasoning_effort === undefined ? {} : { hrReasoningEffort: args.hr_reasoning_effort as string }),
    })
    return { company_id: result.companyId, phase: result.phase, revision: result.revision, state_root_display: result.stateRootDisplay }
  })

  register(ctx, 'company_edit_formation', 'Edit the staged company identity, governance, first product, monetary budget, currency, or three-rate price matrix before approval.', {
    name: { type: 'string' }, slogan: { type: 'string' }, mission: { type: 'string' }, charter: { type: 'string' },
    first_product: {
      type: 'object', additionalProperties: false,
      properties: {
        name: { type: 'string' }, summary: { type: 'string' }, product_root: { type: 'string' },
        success_criteria: { type: 'array', items: { type: 'string' } }, product_budget: { type: 'number' }, token_budget: { type: 'integer' },
      },
    },
    total_budget: { type: 'number' }, total_token_budget: { type: 'integer' }, currency: { type: 'string' }, model_prices: modelPriceArray(), prices: tokenPriceArray(),
    expected_revision: { type: 'integer' },
  }, async (args, exec) => {
    const first = args.first_product as Record<string, unknown> | undefined
    const state = await runtime.editFormation(requireAgent(exec), {
      ...(args.name === undefined ? {} : { name: args.name as string }),
      ...(args.slogan === undefined ? {} : { slogan: args.slogan as string }),
      ...(args.mission === undefined ? {} : { mission: args.mission as string }),
      ...(args.charter === undefined ? {} : { charter: args.charter as string }),
      ...(first === undefined ? {} : { firstProduct: {
        ...(first.name === undefined ? {} : { name: first.name as string }),
        ...(first.summary === undefined ? {} : { summary: first.summary as string }),
        ...(first.product_root === undefined ? {} : { productRoot: first.product_root as string }),
        ...(first.success_criteria === undefined ? {} : { successCriteria: first.success_criteria as string[] }),
        ...(first.product_budget === undefined ? {} : { budgetMicros: currencyUnitsToMicros(first.product_budget, 'first_product.product_budget') }),
        ...(first.token_budget === undefined ? {} : { tokenBudget: first.token_budget as number }),
      } }),
      ...(args.total_budget === undefined ? {} : { totalBudgetMicros: currencyUnitsToMicros(args.total_budget, 'total_budget') }),
      ...(args.total_token_budget === undefined ? {} : { totalTokenBudget: args.total_token_budget as number }),
      ...(args.currency === undefined ? {} : { currency: args.currency as string }),
      ...(args.model_prices === undefined ? {} : { modelPrices: modelPricesFromArgs(args.model_prices) }),
      ...(args.prices === undefined ? {} : { prices: tokenPricesFromArgs(args.prices) }),
    }, args.expected_revision as number | undefined)
    return { company_id: state.id, phase: state.phase, revision: state.revision, formation_status: state.formation.status }
  })

  register(ctx, 'company_approve', 'Approve the complete formation proposal and provision only its initial HR governance lead. Requires an explicit human confirmation from a later user turn.', {
    confirmation: requiredString('Exact human approval statement from the current user turn.'),
    expected_revision: { type: 'integer', description: 'Optional optimistic revision fence.' },
  }, async (args, exec) => {
    const state = await runtime.approveBootstrap(requireAgent(exec), args.confirmation as string, {
      source: 'tool',
      ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision as number }),
    })
    return { company_id: state.id, phase: state.phase, revision: state.revision, employees: state.employees.map((employee) => ({ id: employee.id, status: employee.status })) }
  })

  register(ctx, 'company_request_staffing', 'Ask the designated HR lead to assess a hire, adjustment, or retirement. HR decides difficulty, model route, reasoning effort, token limit, org path, position, and responsibilities before human approval.', {
    action: { type: 'string', required: true, enum: ['hire', 'adjust', 'retire'] },
    candidate_name: { type: 'string' }, employee_id: { type: 'string' },
    work_profile: requiredString('Concrete work profile and expected outcomes.'), constraints: { type: 'string' },
  }, async (args, exec) => runtime.requestStaffing(requireAgent(exec), {
    action: args.action as 'hire' | 'adjust' | 'retire',
    ...(args.candidate_name === undefined ? {} : { candidateName: args.candidate_name as string }),
    ...(args.employee_id === undefined ? {} : { employeeId: args.employee_id as string }),
    workProfile: args.work_profile as string,
    ...(args.constraints === undefined ? {} : { constraints: args.constraints as string }),
  }))

  register(ctx, 'company_claim_staffing_assessment', 'Claim a pending staffing assessment. Only the designated HR governance employee may call this tool.', {
    request_id: requiredString('Staffing request id.'),
  }, async (args, exec) => {
    const result = await runtime.claimStaffingAssessment(requireAgent(exec), args.request_id as string)
    return { request_id: result.requestId, attempt_id: result.attemptId }
  })

  register(ctx, 'company_submit_staffing_assessment', 'Submit the designated HR lead assessment and open an organization_change approval. Token and money usage remain program-calculated. The recommended provider/model must be an enabled route: one with a complete three-rate price row configured on the recruiting page (check company_status budget prices first; unpriced routes are rejected).', {
    request_id: requiredString('Staffing request id.'), attempt_id: requiredString('Exact HR assessment capability.'),
    difficulty: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'critical'] },
    provider: requiredString('Recommended provider; must be an enabled (three-rate priced) route.'), model: requiredString('Recommended model; must be an enabled (three-rate priced) route.'),
    employee_budget: { type: 'number', required: true, description: 'Recommended employee monetary ceiling in normal company-currency units (maximum 6 decimals).' },
    rationale: requiredString('HR assessment rationale.'), org_path: requiredStringArray('Multi-level organization path from the company root.'),
    position_title: requiredString('Recommended staffed position.'), responsibilities: requiredStringArray('Bounded responsibilities.'),
  }, async (args, exec) => runtime.submitStaffingAssessment(requireAgent(exec), {
    requestId: args.request_id as string, attemptId: args.attempt_id as string,
    difficulty: args.difficulty as 'low' | 'medium' | 'high' | 'critical', provider: args.provider as string, model: args.model as string,
    ...(args.reasoning_effort === undefined ? {} : { reasoningEffort: args.reasoning_effort as string }),
    budgetMicros: currencyUnitsToMicros(args.employee_budget, 'employee_budget'),
    rationale: args.rationale as string, orgPath: args.org_path as string[],
    positionTitle: args.position_title as string, responsibilities: args.responsibilities as string[],
  }))

  register(ctx, 'company_apply_staffing_adjustment', 'Apply one human-approved HR employee adjustment by reprovisioning the employee route and position without losing its durable identity.', {
    request_id: requiredString('Approved adjustment staffing request id.'), approval_id: requiredString('Approved organization_change id.'),
  }, async (args, exec) => runtime.applyStaffingAdjustment(requireAgent(exec), args.request_id as string, args.approval_id as string, exec.signal))

  register(ctx, 'company_add_employee', 'Provision a hire exactly matching a completed HR recommendation and approved organization_change request.', {
    name: requiredString('Employee display name.'),
    role: requiredString('Employee responsibility and expertise; must match the HR-approved staffed position.'),
    execution_prompt: { type: 'string', description: 'Optional bounded role-specific execution guidance.' },
    staffing_request_id: requiredString('Completed HR hire recommendation id.'),
    approval_id: requiredString('Approved organization_change id for this HR recommendation.'),
  }, async (args, exec) => runtime.addEmployee(requireAgent(exec), {
    name: args.name as string,
    role: args.role as string,
    ...(args.execution_prompt === undefined ? {} : { executionPrompt: args.execution_prompt as string }),
    staffingRequestId: args.staffing_request_id as string,
    approvalId: args.approval_id as string,
  }, exec.signal))

  register(ctx, 'company_remove_employee', 'Safely retire an active employee after an HR recommendation and approved organization change, with attempt revocation, interruption, and requeue.', {
    employee_id: requiredString('Immutable employee id.'),
    reason: requiredString('Why the employee is removed or retired.'),
    staffing_request_id: requiredString('Completed HR retirement recommendation id.'),
    approval_id: requiredString('Approved organization_change request for this retirement.'),
  }, async (args, exec) => runtime.removeEmployee(requireAgent(exec), args.employee_id as string, args.reason as string, args.approval_id as string, args.staffing_request_id as string, exec.signal))

  register(ctx, 'company_create_product', 'Create one bounded post-formation product with a normalized workspace-relative root, measurable success criteria, and monetary allocation ceiling.', {
    name: requiredString('Product name.'),
    summary: requiredString('Bounded product scope.'),
    product_root: requiredString('Workspace-relative POSIX path; no traversal.'),
    success_criteria: requiredStringArray('Measurable product success criteria.'),
    product_budget: { type: 'number', required: true, description: 'Product monetary allocation ceiling in normal currency units (maximum 6 decimals).' },
    token_budget: { type: 'integer', description: 'Deprecated compatibility token-safety allocation.' },
  }, async (args, exec) => runtime.createProduct(requireAgent(exec), {
    name: args.name as string,
    summary: args.summary as string,
    productRoot: args.product_root as string,
    successCriteria: args.success_criteria as string[],
    budgetMicros: currencyUnitsToMicros(args.product_budget, 'product_budget'),
    ...(args.token_budget === undefined ? {} : { tokenBudget: args.token_budget as number }),
  }))

  register(ctx, 'company_update_product', 'Edit bounded product metadata or request a validated lifecycle transition. Releases require approved release scope plus completed verification and independent review.', {
    product_id: requiredString('Immutable product id.'),
    status: { type: 'string', enum: [...PRODUCT_STATUSES] },
    summary: { type: 'string' },
    success_criteria: { type: 'array', items: { type: 'string' } },
    token_budget: { type: 'integer' },
    approval_id: { type: 'string' },
  }, async (args, exec) => runtime.updateProduct(requireAgent(exec), {
    productId: args.product_id as string,
    ...(args.status === undefined ? {} : { status: args.status as ProductStatus }),
    ...(args.summary === undefined ? {} : { summary: args.summary as string }),
    ...(args.success_criteria === undefined ? {} : { successCriteria: args.success_criteria as string[] }),
    ...(args.token_budget === undefined ? {} : { tokenBudget: args.token_budget as number }),
    ...(args.approval_id === undefined ? {} : { approvalId: args.approval_id as string }),
  }))

  register(ctx, 'company_create_work', 'Create a contracted work item with dependency, scope, acceptance, verification, deliverable, approval, owner, and review-independence constraints.', workPlanParameters(true), async (args, exec) => runtime.createWork(requireAgent(exec), workPlanFromArgs(args)))

  register(ctx, 'company_edit_work', 'Atomically edit plan fields of a pending work item that has never been attempted. The dependency DAG is revalidated.', {
    work_id: requiredString('Work item id.'),
    expected_revision: { type: 'integer' },
    ...workPlanParameters(false),
  }, async (args, exec) => runtime.editWork(requireAgent(exec), args.work_id as string, workPlanFromArgs(args, true), args.expected_revision as number | undefined))

  register(ctx, 'company_reassign_work', 'Revoke an old work attempt capability, wait best-effort for its prior owner, and complete a fenced handoff to an employee or the founder.', {
    work_id: requiredString('Work item id.'),
    assignee_id: requiredString('Employee id or founder.'),
    reason: requiredString('Why this capability must be revoked and reassigned.'),
  }, async (args, exec) => runtime.reassignWork(requireAgent(exec), args.work_id as string, args.assignee_id as string, args.reason as string, exec.signal))

  register(ctx, 'company_claim_work', 'Confirm scheduler-preclaimed work with its matching employee reservation, or claim founder-assigned takeover work. Returns the guarded attempt_id capability.', {
    work_id: requiredString('Work item id.'),
  }, async (args, exec) => {
    const result = await runtime.claimWork(requireAgent(exec), args.work_id as string)
    return { work_id: result.workId, attempt_id: result.attemptId, attempt: result.attempt }
  })

  register(ctx, 'company_update_work', 'Update only the caller-owned current attempt. Every update requires the exact attempt_id; stale capabilities are rejected. Terminal updates require output and kind-specific evidence.', {
    work_id: requiredString('Work item id.'),
    attempt_id: requiredString('Exact current attempt capability.'),
    status: { type: 'string', enum: ['in_progress', 'completed', 'failed', 'cancelled'] },
    output: { type: 'string' },
    verdict: { type: 'string', enum: ['pass', 'needs_revision', 'reject'] },
    findings: {
      type: 'array',
      items: {
        type: 'object',
        additionalProperties: false,
        properties: {
          id: requiredString('Finding id.'),
          severity: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'blocker'] },
          file: { type: 'string' },
          line: { type: 'integer' },
          problem: requiredString('Observed problem.'),
          required_fix: requiredString('Required correction.'),
        },
      },
    },
    changed_paths: { type: 'array', items: { type: 'string' } },
    acceptance_results: { type: 'array', items: { type: 'string' } },
    commands_run: { type: 'array', items: { type: 'string' } },
  }, async (args, exec) => runtime.updateWork(requireAgent(exec), {
    workId: args.work_id as string,
    attemptId: args.attempt_id as string,
    ...(args.status === undefined ? {} : { status: args.status as 'in_progress' | 'completed' | 'failed' | 'cancelled' }),
    ...(args.output === undefined ? {} : { output: args.output as string }),
    ...(args.verdict === undefined ? {} : { verdict: args.verdict as 'pass' | 'needs_revision' | 'reject' }),
    ...(args.findings === undefined ? {} : { findings: (args.findings as Array<Record<string, unknown>>).map(findingFromArgs) }),
    ...(args.changed_paths === undefined ? {} : { changedPaths: args.changed_paths as string[] }),
    ...(args.acceptance_results === undefined ? {} : { acceptanceResults: args.acceptance_results as string[] }),
    ...(args.commands_run === undefined ? {} : { commandsRun: args.commands_run as string[] }),
  }))

  register(ctx, 'company_send_message', 'Persist a direct participant message before best-effort live delivery. Sender identity is derived from the caller; delivery may be held when a deterministic turn-token reservation is unavailable.', {
    to: requiredString('Recipient: founder or an employee id.'),
    content: requiredString('Durable message content.'),
  }, async (args, exec) => runtime.sendMessage(requireAgent(exec), args.to as string, args.content as string, exec.signal))

  register(ctx, 'company_request_budget_change', 'Request revision-fenced monetary ceiling/allocation and three-rate price changes using normal currency units. The returned requests require later human approval.', {
    total_budget: { type: 'number', description: 'Company monetary ceiling in normal currency units (maximum 6 decimals).' },
    product_budgets: {
      type: 'array', items: { type: 'object', additionalProperties: false, properties: {
        product_id: requiredString('Product id.'),
        product_budget: { type: 'number', required: true, description: 'Product monetary allocation in normal currency units.' },
      } },
    },
    model_prices: modelPriceArray(),
    expected_pricing_revision: { type: 'integer' },
    expected_revision: { type: 'integer' },
  }, async (args, exec) => {
    const productBudgets = args.product_budgets as Array<Record<string, unknown>> | undefined
    const approvals = await runtime.requestBudgetChange(requireAgent(exec), {
      ...(args.total_budget === undefined ? {} : { totalBudgetMicros: currencyUnitsToMicros(args.total_budget, 'total_budget') }),
      ...(productBudgets === undefined ? {} : { productBudgets: productBudgets.map((entry) => ({ productId: entry.product_id as string, budgetMicros: currencyUnitsToMicros(entry.product_budget, 'product_budget') })) }),
      ...(args.model_prices === undefined ? {} : { modelPrices: modelPricesFromArgs(args.model_prices) }),
      ...(args.expected_pricing_revision === undefined ? {} : { expectedPricingRevision: args.expected_pricing_revision as number }),
    }, args.expected_revision as number | undefined)
    return approvals.map((approval) => ({ approval_id: approval.id, kind: approval.kind, status: approval.status }))
  })

  register(ctx, 'company_request_approval', 'Request a bounded typed human approval. Payload schemas are closed and may not contain credentials, commands, secrets, or arbitrary external-action data.', {
    kind: { type: 'string', required: true, enum: [...APPROVAL_KINDS] },
    summary: requiredString('Plain-language requested decision.'),
    detail: { type: 'string', description: 'Human-readable description of what this approval decides and why; shown at the top of the approval card. Multi-line allowed.' },
    payload: { type: 'json', required: true, description: 'Closed kind-specific JSON payload.' },
    risk: { type: 'string', enum: ['low', 'medium', 'high'] },
    expires_at: { type: 'integer' },
  }, async (args, exec) => runtime.requestApproval(requireAgent(exec), {
    kind: args.kind as ApprovalKind,
    summary: args.summary as string,
    ...(args.detail === undefined ? {} : { detail: args.detail as string }),
    payload: args.payload as JsonValue,
    ...(args.risk === undefined ? {} : { risk: args.risk as 'low' | 'medium' | 'high' }),
    ...(args.expires_at === undefined ? {} : { expiresAt: args.expires_at as number }),
  }))

  register(ctx, 'company_resolve_approval', 'Approve or reject a pending typed request. Founder only, using an explicit human statement from a later genuine user turn. Terminal approvals are immutable.', {
    approval_id: requiredString('Pending approval id.'),
    decision: { type: 'string', required: true, enum: ['approved', 'rejected'] },
    human_statement: requiredString('Exact human decision statement from this user turn.'),
    note: { type: 'string' },
    expected_revision: { type: 'integer' },
  }, async (args, exec) => runtime.resolveApproval(requireAgent(exec), {
    approvalId: args.approval_id as string,
    decision: args.decision as 'approved' | 'rejected',
    humanStatement: args.human_statement as string,
    ...(args.note === undefined ? {} : { note: args.note as string }),
    ...(args.expected_revision === undefined ? {} : { expectedRevision: args.expected_revision as number }),
  }))

  register(ctx, 'company_triage_ticket', 'Set the severity of a filed product ticket. Founder or the designated support engineer only.', {
    ticket_id: requiredString('Ticket id.'), severity: { type: 'string', required: true, enum: ['low', 'medium', 'high', 'urgent'] },
  }, async (args, exec) => runtime.triageTicket(requireAgent(exec), { ticketId: args.ticket_id as string, severity: args.severity as 'low' | 'medium' | 'high' | 'urgent' }))

  register(ctx, 'company_dispatch_ticket', 'Assign a triaged ticket to a runnable employee (never the founder). The linked repair work item must be pending and never attempted.', {
    ticket_id: requiredString('Ticket id.'), assignee_id: requiredString('Target employee id; must be an active employee.'),
    note: { type: 'string', description: 'Optional dispatch note for the audit trail.' },
  }, async (args, exec) => runtime.dispatchTicket(requireAgent(exec), {
    ticketId: args.ticket_id as string, assigneeId: args.assignee_id as string,
    ...(args.note === undefined ? {} : { note: args.note as string }),
  }))

  register(ctx, 'company_close_ticket', 'Close a resolved ticket with a human-facing reply. The reply defaults to the linked work output when omitted. Founder or the designated support engineer only.', {
    ticket_id: requiredString('Ticket id.'), reply: { type: 'string', description: 'Human-facing resolution reply; defaults to the work output.' },
  }, async (args, exec) => runtime.closeTicket(requireAgent(exec), {
    ticketId: args.ticket_id as string,
    ...(args.reply === undefined ? {} : { reply: args.reply as string }),
  }))

  register(ctx, 'company_designate_support', 'Designate (or clear) the stationed support engineer allowed to triage, dispatch, and close tickets. Founder only.', {
    employee_id: { type: 'string', description: 'Employee id to designate; omit to clear.' },
  }, async (args, exec) => runtime.designateSupport(requireAgent(exec), args.employee_id === undefined ? undefined : args.employee_id as string))

  register(ctx, 'company_reprobe_models', 'Reprobe all registered LLM providers/models and revision-fenced merge capability rows. Previously configured price rows are preserved; discovered routes without prices remain explicitly unpriced.', {
    expected_revision: { type: 'integer', description: 'Optional optimistic revision fence; the pre-probe state is always fenced.' },
  }, async (args, exec) => runtime.reprobeModels(requireAgent(exec), args.expected_revision as number | undefined))

  register(ctx, 'company_request_governance_change', 'Request a high-risk, revision-fenced post-formation change to the company slogan, mission, or charter.', {
    slogan: { type: 'string' }, mission: { type: 'string' }, charter: { type: 'string' },
    expected_governance_revision: { type: 'integer' },
  }, async (args, exec) => runtime.requestGovernanceChange(requireAgent(exec), {
    ...(args.slogan === undefined ? {} : { slogan: args.slogan as string }),
    ...(args.mission === undefined ? {} : { mission: args.mission as string }),
    ...(args.charter === undefined ? {} : { charter: args.charter as string }),
    ...(args.expected_governance_revision === undefined ? {} : { expectedGovernanceRevision: args.expected_governance_revision as number }),
  }))

  register(ctx, 'company_grant_temporary_authorization', 'Apply one approved employee-wide temporary authorization with a required reason and bounded expiry. Fixed scope: monetary admission plus product_scope/model_route dependencies on the seven ordinary internal work kinds; all protected Host boundaries remain enforced.', {
    approval_id: requiredString('Approved temporary_authorization request id.'),
    employee_id: requiredString('Exact employee id.'),
    reason: requiredString('Required bounded authorization reason.'),
    starts_at: { type: 'integer' },
    expires_at: { type: 'integer', required: true },
  }, async (args, exec) => runtime.grantTemporaryAuthorization(requireAgent(exec), {
    approvalId: args.approval_id as string,
    employeeId: args.employee_id as string,
    reason: args.reason as string,
    ...(args.starts_at === undefined ? {} : { startsAt: args.starts_at as number }),
    expiresAt: args.expires_at as number,
  }))

  register(ctx, 'company_revoke_temporary_authorization', 'Explicitly revoke one temporary authorization using an approved, exact revocation decision.', {
    approval_id: requiredString('Approved temporary_authorization revocation request id.'),
    authorization_id: requiredString('Exact authorization id.'), reason: requiredString('Revocation reason.'),
  }, async (args, exec) => runtime.revokeTemporaryAuthorization(requireAgent(exec), {
    approvalId: args.approval_id as string, authorizationId: args.authorization_id as string, reason: args.reason as string,
  }))

  register(ctx, 'company_status', 'Read a role-filtered company snapshot with organization load, capability catalog, monetary authority, full-lifecycle aggregates, bounded detail, temporary authorizations, health, approvals, and only the caller mailbox.', {
    archived: { type: 'boolean', description: 'Read the newest archive when no active company exists.' },
  }, async (args, exec) => runtime.status(requireAgent(exec), args.archived === true))

  register(ctx, 'company_control', 'Pause, resume, archive, or discard a staged company. Archive revokes scheduling and attempts but preserves child transcripts. Forced archive requires approval.', {
    action: { type: 'string', required: true, enum: ['pause', 'resume', 'archive', 'discard_staged'] },
    reason: requiredString('Human-readable control reason.'),
    approval_id: { type: 'string', description: 'Approved forced_archive id when unfinished work exists.' },
    expected_revision: { type: 'integer' },
  }, async (args, exec) => {
    const state = await runtime.control(
      requireAgent(exec),
      args.action as 'pause' | 'resume' | 'archive' | 'discard_staged',
      args.reason as string,
      args.approval_id as string | undefined,
      args.expected_revision as number | undefined,
    )
    return { company_id: state.id, phase: state.phase, revision: state.revision }
  })
}

function register(
  ctx: Context,
  name: string,
  description: string,
  parameters: ParameterSchemaSpec,
  execute: (args: Record<string, unknown>, exec: ToolRunContext) => Promise<unknown>,
): void {
  ctx.tools.register(defineTool({
    name,
    description,
    parameters,
    output: {
      schema: { type: 'json' },
      render: (_args, value) => [{ type: 'text', text: renderValue(value) }],
    },
    async execute(args, exec) {
      const value = await execute(args as Record<string, unknown>, exec)
      return toJsonValue(value)
    },
  }))
}

function requireAgent(exec: ToolRunContext): Agent {
  if (exec.agent === undefined) throw new Error('dsh-company tools require a calling live agent session')
  return exec.agent
}

function requiredString(description: string): ParameterSchemaSpec[string] {
  return { type: 'string', required: true, description }
}

function requiredStringArray(description: string): ParameterSchemaSpec[string] {
  return { type: 'array', required: true, description, items: { type: 'string' } }
}

function modelPriceArray(): ParameterSchemaSpec[string] {
  return {
    type: 'array',
    description: 'Provider/model prices in normal currency units per one million tokens; all three rates must be supplied together or all omitted (unpriced). Maximum 6 decimals.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        provider: requiredString('Provider id.'), model: requiredString('Model id.'),
        input_cache_miss_per_million: { type: 'number' },
        input_cache_hit_per_million: { type: 'number' },
        output_per_million: { type: 'number' },
      },
    },
  }
}

function modelPricesFromArgs(value: unknown): ModelPriceInput[] {
  return (value as Array<Record<string, unknown>>).map((price) => ({
    provider: price.provider as string,
    model: price.model as string,
    ...(price.input_cache_miss_per_million === undefined ? {} : { inputCacheMissMicrosPerMillion: currencyUnitsToMicros(price.input_cache_miss_per_million, 'input_cache_miss_per_million') }),
    ...(price.input_cache_hit_per_million === undefined ? {} : { inputCacheHitMicrosPerMillion: currencyUnitsToMicros(price.input_cache_hit_per_million, 'input_cache_hit_per_million') }),
    ...(price.output_per_million === undefined ? {} : { outputMicrosPerMillion: currencyUnitsToMicros(price.output_per_million, 'output_per_million') }),
  }))
}

function tokenPriceArray(): ParameterSchemaSpec[string] {
  return {
    type: 'array',
    description: 'Optional provider/model prices per one million tokens in the configured currency.',
    items: {
      type: 'object', additionalProperties: false,
      properties: {
        provider: requiredString('Provider id.'), model: requiredString('Model id.'),
        input_per_million: { type: 'number', required: true }, cache_read_per_million: { type: 'number', required: true },
        cache_write_per_million: { type: 'number', required: true }, output_per_million: { type: 'number', required: true },
        reasoning_per_million: { type: 'number' },
      },
    },
  }
}

function tokenPricesFromArgs(value: unknown): TokenPriceInput[] {
  return (value as Array<Record<string, unknown>>).map((price) => ({
    provider: price.provider as string, model: price.model as string,
    inputPerMillion: price.input_per_million as number, cacheReadPerMillion: price.cache_read_per_million as number,
    cacheWritePerMillion: price.cache_write_per_million as number, outputPerMillion: price.output_per_million as number,
    ...(price.reasoning_per_million === undefined ? {} : { reasoningPerMillion: price.reasoning_per_million as number }),
  }))
}

function workPlanParameters(required: boolean): ParameterSchemaSpec {
  const string = (description: string): ParameterSchemaSpec[string] => ({ type: 'string', ...(required ? { required: true } : {}), description })
  const array = (description: string): ParameterSchemaSpec[string] => ({ type: 'array', ...(required ? { required: true } : {}), description, items: { type: 'string' } })
  return {
    product_id: string('Product id.'),
    kind: { type: 'string', ...(required ? { required: true } : {}), enum: [...WORK_KINDS] },
    subject: string('Short work subject.'),
    objective: string('Concrete bounded work objective.'),
    dependencies: { type: 'array', items: { type: 'string' } },
    approval_dependencies: { type: 'array', items: { type: 'string' } },
    assignee_id: { type: 'string', description: 'Employee id, founder, or omit for shared scheduling.' },
    eligible_employee_ids: { type: 'array', items: { type: 'string' } },
    in_scope: array('Workspace-relative paths/globs the attempt may change.'),
    out_of_scope: { type: 'array', items: { type: 'string' } },
    acceptance: array('Measurable acceptance conditions.'),
    verify: { type: 'array', items: { type: 'string' } },
    deliverables: { type: 'array', items: { type: 'string' } },
    reviewed_work_id: { type: 'string', description: 'Required for review kind.' },
  }
}

function workPlanFromArgs(args: Record<string, unknown>, partial = false): any {
  const result: Record<string, unknown> = {}
  const copy = (wire: string, internal: string): void => { if (args[wire] !== undefined) result[internal] = args[wire] }
  copy('product_id', 'productId')
  copy('kind', 'kind')
  copy('subject', 'subject')
  copy('objective', 'objective')
  copy('dependencies', 'dependencies')
  copy('approval_dependencies', 'approvalDependencies')
  copy('assignee_id', 'assigneeId')
  copy('eligible_employee_ids', 'eligibleEmployeeIds')
  copy('in_scope', 'inScope')
  copy('out_of_scope', 'outOfScope')
  copy('acceptance', 'acceptance')
  copy('verify', 'verify')
  copy('deliverables', 'deliverables')
  copy('reviewed_work_id', 'reviewedWorkId')
  return result
}

function findingFromArgs(input: Record<string, unknown>): ReviewFinding {
  return {
    id: input.id as string,
    severity: input.severity as ReviewFinding['severity'],
    ...(input.file === undefined ? {} : { file: input.file as string }),
    ...(input.line === undefined ? {} : { line: input.line as number }),
    problem: input.problem as string,
    requiredFix: input.required_fix as string,
  }
}

function toJsonValue(value: unknown): JsonValue {
  const serialized = JSON.stringify(value)
  if (serialized === undefined) throw new Error('company tool returned a non-JSON value')
  return JSON.parse(serialized) as JsonValue
}

function renderValue(value: JsonValue): string {
  const rendered = typeof value === 'string' ? value : JSON.stringify(value, null, 2)
  return rendered.length <= 20_000 ? rendered : `${rendered.slice(0, 19_999)}…`
}
