import type { IncomingMessage, ServerResponse } from 'node:http'
import type { Context } from '@deepseek-ai/cordis'
import { SessionId } from '@deepseek-ai/dsh-session'
import type {} from '@deepseek-ai/dsh-host-webserver'
import { isRecord } from './schemas.js'
import { RevisionConflictError, type CompanyRuntime } from './runtime.js'
import type { CompanyActionRequest, CompanySnapshot, CompanyUiActionName, JsonValue, ResolvedCompanyConfig } from './types.js'

const STATE_PATH = '/plugins/dsh-company/state'
const ACTION_PATH = '/plugins/dsh-company/action'

export function installCompanyRoutes(ctx: Context, runtime: CompanyRuntime, config: ResolvedCompanyConfig): void {
  ctx.inject(['webServer'], (webCtx) => {
    webCtx.effect(function* () {
      yield webCtx.webServer.register({
        kind: 'exact',
        path: STATE_PATH,
        handler: (req, res) => safeHandler(req, res, () => handleSnapshot(webCtx, runtime, config, req, res)),
      })
      yield webCtx.webServer.register({
        kind: 'exact',
        path: ACTION_PATH,
        handler: (req, res) => safeHandler(req, res, () => handleAction(webCtx, runtime, config, req, res)),
      })
    }, 'dsh-company: snapshot and action routes')
  })
}

async function handleSnapshot(ctx: Context, runtime: CompanyRuntime, config: ResolvedCompanyConfig, req: IncomingMessage, res: ServerResponse): Promise<void> {
  if (req.method !== 'GET') return json(res, 405, { error: 'method_not_allowed', message: 'snapshot requires GET' }, { allow: 'GET' })
  // The snapshot contains objectives, outputs, findings and financials; apply
  // the same loopback/Origin transport gate the mutation route uses.
  assertUiTransport(req, config)
  const url = new URL(req.url ?? STATE_PATH, 'http://dsh.local')
  const sessionId = url.searchParams.get('sessionId')?.trim()
  if (sessionId === undefined || sessionId === '') return json(res, 400, { error: 'invalid_request', message: 'sessionId query parameter is required' })
  const agent = ctx.agents.get(SessionId(sessionId))
  if (agent === undefined) return json(res, 404, { error: 'session_not_found', message: 'sessionId does not identify an exact live agent' })
  const archivedValue = url.searchParams.get('archived')
  if (archivedValue !== null && archivedValue !== '0' && archivedValue !== '1') return json(res, 400, { error: 'invalid_request', message: 'archived must be 0 or 1' })
  let snapshot
  if (isRemoteUiRequest(req)) {
    // Remote browsers never receive participant identity: same trust line the
    // host's own settings UI draws (loopback writes, remote memory mirror).
    try {
      snapshot = await runtime.webPublicStatus(agent, archivedValue === '1')
    } catch (error) {
      if (error instanceof Error && error.message === 'no company exists for this workspace') {
        throw new HttpError(404, 'company_not_found', error.message)
      }
      throw error
    }
    downgradeSnapshotToReadonlyWeb(snapshot)
  } else {
    // A loopback same-origin page acts as the session's own participant: the
    // founder session gets the full editable founder view, employee sessions
    // get their role-filtered view.
    try {
      snapshot = await runtime.status(agent, archivedValue === '1')
    } catch (error) {
      if (error instanceof Error && error.message === 'no company exists for this workspace') {
        throw new HttpError(404, 'company_not_found', error.message)
      }
      throw error
    }
  }
  json(res, 200, snapshot)
}

function downgradeSnapshotToReadonlyWeb(snapshot: CompanySnapshot): void {
  snapshot.viewer.role = 'employee'
  snapshot.viewer.participant_id = 'web-readonly'
  snapshot.viewer.permissions = []
  delete snapshot.company.founder_session_id
  snapshot.inbox = []
  for (const employee of snapshot.employees) {
    delete employee.session_id
    delete employee.failure
  }
  for (const work of snapshot.work) {
    delete work.acceptance
    delete work.verify
    delete work.deliverables
    delete work.changed_paths
    delete work.acceptance_results
    delete work.commands_run
    delete work.objective
    delete work.output
    delete work.findings
  }
  snapshot.warnings = [
    'This remote web view is read-only. Loopback pages act as the session participant and may edit; remote clients only observe.',
    ...snapshot.warnings,
  ]
}

export async function handleAction(
  ctx: Context,
  runtime: CompanyRuntime,
  config: ResolvedCompanyConfig,
  req: IncomingMessage,
  res: ServerResponse,
): Promise<void> {
  if (req.method !== 'POST') return json(res, 405, { error: 'method_not_allowed', message: 'action requires POST' }, { allow: 'POST' })
  assertUiTransport(req, config)
  const request = parseActionRequest(await readJsonBody(req))
  const snapshot = await executeUiAction(ctx, runtime, request, { remote: isRemoteUiRequest(req) })
  json(res, 200, snapshot)
}

/**
 * Execute one Web UI mutation. Trust model mirrors the host's own settings
 * APIs: a loopback same-origin page acts as the exact session participant it
 * names (the runtime re-verifies founder identity and company binding);
 * remote clients — only reachable when allowRemoteUi is enabled — never
 * mutate and fail closed.
 */
export async function executeUiAction(
  ctx: Context,
  runtime: CompanyRuntime,
  request: CompanyActionRequest,
  options: { remote: boolean },
): Promise<CompanySnapshot> {
  if (options.remote) {
    throw new HttpError(403, 'web_mutations_require_loopback', 'Web mutations require a loopback same-origin page; remote web clients are read-only.')
  }
  const agent = ctx.agents.get(SessionId(request.sessionId))
  if (agent === undefined) throw new HttpError(404, 'session_not_found', 'sessionId does not identify an exact live agent')
  return runtime.handleUiAction(agent, request)
}

/** True when the request arrives from a non-loopback socket. */
export function isRemoteUiRequest(req: { socket: { remoteAddress?: string } }): boolean {
  return !isLoopback(normalizeAddress(req.socket.remoteAddress))
}

async function readJsonBody(req: IncomingMessage, maxBytes = 1_048_576): Promise<unknown> {
  const chunks: Buffer[] = []
  let total = 0
  for await (const chunk of req) {
    const piece = typeof chunk === 'string' ? Buffer.from(chunk) : chunk as Buffer
    total += piece.length
    if (total > maxBytes) throw new HttpError(413, 'payload_too_large', `request body exceeds ${maxBytes} bytes`)
    chunks.push(piece)
  }
  const text = Buffer.concat(chunks).toString('utf8').trim()
  if (text.length === 0) throw new HttpError(400, 'invalid_request', 'request body must be a JSON object')
  try {
    return JSON.parse(text) as unknown
  } catch {
    throw new HttpError(400, 'invalid_request', 'request body must be valid JSON')
  }
}

export function parseActionRequest(value: unknown): CompanyActionRequest {
  if (!isRecord(value)) throw new HttpError(400, 'invalid_request', 'request body must be a JSON object')
  assertClosed(value, new Set(['sessionId', 'companyId', 'expectedRevision', 'action', 'payload']), 'request')
  if (typeof value.sessionId !== 'string' || value.sessionId.trim() === '') throw new HttpError(400, 'invalid_request', 'sessionId is required')
  if (typeof value.companyId !== 'string' || value.companyId.trim() === '') throw new HttpError(400, 'invalid_request', 'companyId is required')
  if (!Number.isSafeInteger(value.expectedRevision) || (value.expectedRevision as number) < 1) throw new HttpError(400, 'invalid_request', 'expectedRevision must be a positive safe integer')
  const actions = ['approve_bootstrap', 'edit_formation', 'file_ticket', 'resolve_approval', 'reprobe_models', 'request_governance_change', 'request_budget_change', 'grant_temporary_authorization', 'revoke_temporary_authorization', 'pause', 'resume', 'archive', 'discard_staged'] as const
  if (typeof value.action !== 'string' || !(actions as readonly string[]).includes(value.action)) throw new HttpError(400, 'invalid_request', 'action is invalid')
  if (!isRecord(value.payload) || !isJsonValue(value.payload)) throw new HttpError(400, 'invalid_request', 'payload must be a JSON object')
  validateActionPayload(value.action as CompanyUiActionName, value.payload)
  return {
    sessionId: value.sessionId,
    companyId: value.companyId,
    expectedRevision: value.expectedRevision as number,
    action: value.action as CompanyUiActionName,
    payload: value.payload,
  }
}

function validateActionPayload(action: CompanyUiActionName, payload: Record<string, unknown>): void {
  switch (action) {
    case 'approve_bootstrap':
      assertClosed(payload, new Set(['confirmation']), `${action} payload`)
      requireNonBlank(payload.confirmation, 'approve_bootstrap confirmation')
      return
    case 'edit_formation': {
      const allowed = new Set(['name', 'slogan', 'mission', 'charter', 'first_product', 'total_budget', 'total_token_budget', 'currency', 'model_prices', 'prices'])
      assertClosed(payload, allowed, `${action} payload`)
      if (Object.keys(payload).length === 0) throw new HttpError(400, 'invalid_request', 'edit_formation payload must change at least one field')
      for (const key of ['name', 'slogan', 'mission', 'charter', 'currency']) if (payload[key] !== undefined) requireNonBlank(payload[key], `edit_formation ${key}`)
      if (payload.total_budget !== undefined) validateHumanMoney(payload.total_budget, 'total_budget')
      if (payload.total_token_budget !== undefined && (!Number.isSafeInteger(payload.total_token_budget) || (payload.total_token_budget as number) < 1)) throw new HttpError(400, 'invalid_request', 'total_token_budget must be a positive safe integer')
      if (payload.first_product !== undefined) {
        if (!isRecord(payload.first_product)) throw new HttpError(400, 'invalid_request', 'first_product must be an object')
        assertClosed(payload.first_product, new Set(['name', 'summary', 'product_root', 'success_criteria', 'product_budget', 'token_budget']), 'first_product')
        for (const key of ['name', 'summary', 'product_root']) if (payload.first_product[key] !== undefined) requireNonBlank(payload.first_product[key], `first_product ${key}`)
        if (payload.first_product.success_criteria !== undefined && (!Array.isArray(payload.first_product.success_criteria) || payload.first_product.success_criteria.some((item) => typeof item !== 'string' || item.trim() === ''))) throw new HttpError(400, 'invalid_request', 'success_criteria must contain non-blank strings')
        if (payload.first_product.product_budget !== undefined) validateHumanMoney(payload.first_product.product_budget, 'first_product product_budget')
        if (payload.first_product.token_budget !== undefined && (!Number.isSafeInteger(payload.first_product.token_budget) || (payload.first_product.token_budget as number) < 1)) throw new HttpError(400, 'invalid_request', 'first_product token_budget must be a positive safe integer')
      }
      if (payload.model_prices !== undefined) {
        if (!Array.isArray(payload.model_prices)) throw new HttpError(400, 'invalid_request', 'model_prices must be an array')
        for (const [index, price] of payload.model_prices.entries()) {
          if (!isRecord(price)) throw new HttpError(400, 'invalid_request', `model_prices[${index}] must be an object`)
          validateHumanModelPrice(price, index)
        }
      }
      if (payload.prices !== undefined) {
        if (!Array.isArray(payload.prices)) throw new HttpError(400, 'invalid_request', 'prices must be an array')
        for (const [index, price] of payload.prices.entries()) {
          if (!isRecord(price)) throw new HttpError(400, 'invalid_request', `prices[${index}] must be an object`)
          assertClosed(price, new Set(['provider', 'model', 'input_per_million', 'cache_read_per_million', 'cache_write_per_million', 'output_per_million', 'reasoning_per_million']), `prices[${index}]`)
          requireNonBlank(price.provider, `prices[${index}] provider`)
          requireNonBlank(price.model, `prices[${index}] model`)
          for (const key of ['input_per_million', 'cache_read_per_million', 'cache_write_per_million', 'output_per_million', 'reasoning_per_million']) {
            if (key === 'reasoning_per_million' && price[key] === undefined) continue
            if (typeof price[key] !== 'number' || !Number.isFinite(price[key]) || (price[key] as number) < 0) throw new HttpError(400, 'invalid_request', `prices[${index}] ${key} must be a non-negative number`)
          }
        }
      }
      return
    }
    case 'file_ticket':
      assertClosed(payload, new Set(['product_id', 'title', 'description']), `${action} payload`)
      for (const key of ['product_id', 'title', 'description']) requireNonBlank(payload[key], `file_ticket ${key}`)
      return
    case 'resolve_approval':
      assertClosed(payload, new Set(['approval_id', 'decision', 'human_statement', 'note']), `${action} payload`)
      requireNonBlank(payload.approval_id, 'resolve_approval approval_id')
      if (payload.decision !== 'approved' && payload.decision !== 'rejected') throw new HttpError(400, 'invalid_request', 'resolve_approval decision must be approved or rejected')
      if (payload.human_statement !== undefined) requireNonBlank(payload.human_statement, 'resolve_approval human_statement')
      if (payload.note !== undefined && typeof payload.note !== 'string') throw new HttpError(400, 'invalid_request', 'resolve_approval note must be a string')
      return
    case 'reprobe_models':
      assertClosed(payload, new Set(), `${action} payload`)
      return
    case 'request_governance_change':
      assertClosed(payload, new Set(['slogan', 'mission', 'charter', 'expected_governance_revision']), `${action} payload`)
      for (const key of ['slogan', 'mission', 'charter']) if (payload[key] !== undefined) requireNonBlank(payload[key], `${action} ${key}`)
      if (payload.slogan === undefined && payload.mission === undefined && payload.charter === undefined) throw new HttpError(400, 'invalid_request', `${action} must change at least one governance field`)
      if (payload.expected_governance_revision !== undefined && (!Number.isSafeInteger(payload.expected_governance_revision) || (payload.expected_governance_revision as number) < 1)) throw new HttpError(400, 'invalid_request', 'expected_governance_revision must be a positive safe integer')
      return
    case 'request_budget_change': {
      assertClosed(payload, new Set(['total_budget', 'product_budgets', 'model_prices', 'expected_pricing_revision']), `${action} payload`)
      if (payload.total_budget === undefined && payload.product_budgets === undefined && payload.model_prices === undefined) throw new HttpError(400, 'invalid_request', `${action} must change a budget or price`)
      if (payload.total_budget !== undefined) validateHumanMoney(payload.total_budget, 'total_budget')
      if (payload.product_budgets !== undefined) {
        if (!Array.isArray(payload.product_budgets)) throw new HttpError(400, 'invalid_request', 'product_budgets must be an array')
        for (const [index, row] of payload.product_budgets.entries()) {
          if (!isRecord(row)) throw new HttpError(400, 'invalid_request', `product_budgets[${index}] must be an object`)
          assertClosed(row, new Set(['product_id', 'product_budget']), `product_budgets[${index}]`)
          requireNonBlank(row.product_id, `product_budgets[${index}] product_id`)
          validateHumanMoney(row.product_budget, `product_budgets[${index}] product_budget`)
        }
      }
      if (payload.model_prices !== undefined) {
        if (!Array.isArray(payload.model_prices)) throw new HttpError(400, 'invalid_request', 'model_prices must be an array')
        payload.model_prices.forEach((price, index) => {
          if (!isRecord(price)) throw new HttpError(400, 'invalid_request', `model_prices[${index}] must be an object`)
          validateHumanModelPrice(price, index)
        })
      }
      if (payload.expected_pricing_revision !== undefined && (!Number.isSafeInteger(payload.expected_pricing_revision) || (payload.expected_pricing_revision as number) < 1)) throw new HttpError(400, 'invalid_request', 'expected_pricing_revision must be a positive safe integer')
      return
    }
    case 'grant_temporary_authorization':
      assertClosed(payload, new Set(['approval_id', 'employee_id', 'reason', 'starts_at', 'expires_at']), `${action} payload`)
      for (const key of ['employee_id', 'reason']) requireNonBlank(payload[key], `${action} ${key}`)
      if (payload.approval_id !== undefined) requireNonBlank(payload.approval_id, `${action} approval_id`)
      for (const key of ['starts_at', 'expires_at']) {
        if (key === 'starts_at' && payload[key] === undefined) continue
        if (!Number.isSafeInteger(payload[key]) || (payload[key] as number) < 0) throw new HttpError(400, 'invalid_request', `${action} ${key} is invalid`)
      }
      return
    case 'revoke_temporary_authorization':
      assertClosed(payload, new Set(['approval_id', 'authorization_id', 'reason']), `${action} payload`)
      for (const key of ['authorization_id', 'reason']) requireNonBlank(payload[key], `${action} ${key}`)
      if (payload.approval_id !== undefined) requireNonBlank(payload.approval_id, `${action} approval_id`)
      return
    case 'pause':
    case 'resume':
    case 'discard_staged':
      assertClosed(payload, new Set(['reason']), `${action} payload`)
      requireNonBlank(payload.reason, `${action} reason`)
      return
    case 'archive':
      assertClosed(payload, new Set(['reason', 'approval_id']), `${action} payload`)
      requireNonBlank(payload.reason, 'archive reason')
      if (payload.approval_id !== undefined) requireNonBlank(payload.approval_id, 'archive approval_id')
  }
}

function validateHumanMoney(value: unknown, label: string): void {
  if ((typeof value !== 'number' && typeof value !== 'string') || (typeof value === 'number' && (!Number.isFinite(value) || value < 0)) || !/^(0|[1-9][0-9]*)(?:\.[0-9]{1,6})?$/.test(String(value).trim())) {
    throw new HttpError(400, 'invalid_request', `${label} must be a non-negative currency value with at most 6 decimals`)
  }
}

function validateHumanModelPrice(price: Record<string, unknown>, index: number): void {
  assertClosed(price, new Set(['provider', 'model', 'input_cache_miss_per_million', 'input_cache_hit_per_million', 'output_per_million']), `model_prices[${index}]`)
  requireNonBlank(price.provider, `model_prices[${index}] provider`)
  requireNonBlank(price.model, `model_prices[${index}] model`)
  const keys = ['input_cache_miss_per_million', 'input_cache_hit_per_million', 'output_per_million'] as const
  const count = keys.filter((key) => price[key] !== undefined).length
  if (count !== 0 && count !== keys.length) throw new HttpError(400, 'invalid_request', `model_prices[${index}] must provide all three rates or none`)
  for (const key of keys) if (price[key] !== undefined) validateHumanMoney(price[key], `model_prices[${index}] ${key}`)
}

function requireNonBlank(value: unknown, label: string): asserts value is string {
  if (typeof value !== 'string' || value.trim() === '') throw new HttpError(400, 'invalid_request', `${label} is required`)
}

function assertClosed(value: Record<string, unknown>, allowed: Set<string>, label: string): void {
  const unknown = Object.keys(value).filter((key) => !allowed.has(key))
  if (unknown.length > 0) throw new HttpError(400, 'invalid_request', `${label} has unknown field(s): ${unknown.join(', ')}`)
}

function assertUiTransport(req: IncomingMessage, config: ResolvedCompanyConfig): void {
  const remote = normalizeAddress(req.socket.remoteAddress)
  if (!config.allowRemoteUi && !isLoopback(remote)) throw new HttpError(403, 'remote_ui_denied', 'dsh-company UI actions are restricted to loopback clients')
  const origin = req.headers.origin
  const host = req.headers.host
  if (origin !== undefined) {
    if (host === undefined) throw new HttpError(403, 'origin_denied', 'Host header is required when Origin is present')
    let originHost: string
    try {
      originHost = new URL(origin).host
    } catch {
      throw new HttpError(403, 'origin_denied', 'Origin header is invalid')
    }
    if (originHost !== host) throw new HttpError(403, 'origin_denied', 'cross-origin company UI actions are denied')
  }
}

async function safeHandler(req: IncomingMessage, res: ServerResponse, operation: () => Promise<void>): Promise<void> {
  try {
    await operation()
  } catch (error) {
    if (res.headersSent) {
      res.destroy(error instanceof Error ? error : new Error(String(error)))
      return
    }
    if (error instanceof RevisionConflictError) {
      json(res, 409, { ok: false, code: 'conflict', message: error.message, revision: error.latestRevision })
      return
    }
    if (error instanceof HttpError) {
      json(res, error.status, { ok: false, code: responseCode(error.status), message: error.message })
      return
    }
    if (error instanceof Error) {
      json(res, 422, { ok: false, code: 'invalid_transition', message: error.message })
      return
    }
    json(res, 500, { ok: false, code: 'internal', message: 'unexpected dsh-company handler failure' })
  }
}

function responseCode(status: number): 'bad_request' | 'unauthorized' | 'not_found' | 'conflict' | 'internal' {
  if (status === 401 || status === 403) return 'unauthorized'
  if (status === 404) return 'not_found'
  if (status === 409) return 'conflict'
  if (status >= 500) return 'internal'
  return 'bad_request'
}

function json(res: ServerResponse, status: number, value: unknown, extraHeaders: Record<string, string> = {}): void {
  const body = JSON.stringify(value)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'cache-control': 'no-store',
    'content-length': String(Buffer.byteLength(body)),
    ...extraHeaders,
  })
  res.end(body)
}

function normalizeAddress(address: string | undefined): string {
  if (address === undefined) return ''
  return address.startsWith('::ffff:') ? address.slice('::ffff:'.length) : address
}

function isLoopback(address: string): boolean {
  return address === '127.0.0.1' || address === '::1' || address.startsWith('127.')
}

function isJsonValue(value: unknown): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true
  if (typeof value === 'number') return Number.isFinite(value) && !Object.is(value, -0)
  if (Array.isArray(value)) return value.every(isJsonValue)
  if (!isRecord(value)) return false
  return Object.values(value).every(isJsonValue)
}

class HttpError extends Error {
  readonly status: number
  readonly code: string

  constructor(status: number, code: string, message: string) {
    super(message)
    this.name = 'HttpError'
    this.status = status
    this.code = code
  }
}
