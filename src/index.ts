/** dsh-company host plugin entrypoint. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-tools'
import { installCompanyAccounting } from './accounting.js'
import { interruptEmployee } from './employees.js'
import { installCompanyRoutes } from './http.js'
import { installCompanyPrompt } from './prompt.js'
import { CompanyRuntime } from './runtime.js'
import { installCompanyScheduler } from './scheduler.js'
import { resolveConfig } from './schemas.js'
import { CompanyStore } from './state.js'
import { registerCompanyTools } from './tools.js'
import type { CompanyConfig } from './types.js'

export const name = 'dsh-company'
export const inject = ['tools', 'llm', 'subagents', 'systemPrompt', 'agents']

export const Config: z<CompanyConfig> = z.object({
  stateRoot: z.string(),
  subagentProvider: z.string().default('spawn'),
  memberMaxDepth: z.natural().max(32).default(1),
  maxEmployees: z.natural().min(1).max(32).default(8),
  maxProducts: z.natural().min(1).max(64).default(8),
  maxWorkItems: z.natural().min(1).max(1000).default(128),
  maxOpenWorkItems: z.natural().min(1).max(1000).default(32),
  maxAttemptsPerWork: z.natural().min(1).max(20).default(5),
  maxPendingApprovals: z.natural().min(1).max(256).default(32),
  maxMailboxMessages: z.natural().min(1).max(10_000).default(1000),
  maxAuditBytes: z.natural().min(1024).max(104_857_600).default(10_485_760),
  maxMessageChars: z.natural().min(64).max(131_072).default(16_384),
  maxOutputChars: z.natural().min(256).max(1_048_576).default(65_536),
  defaultBudgetCredits: z.natural().default(50),
  maxBudgetCredits: z.natural().min(1).max(1_000_000).default(1000),
  defaultActivationCredits: z.natural().min(1).max(10_000).default(1),
  routeCosts: z.dict(z.natural().min(1)).default({}),
  defaultTokenBudget: z.natural().min(1).max(1_000_000_000_000).default(20_000_000),
  maxTokenBudget: z.natural().min(1).max(1_000_000_000_000).default(1_000_000_000),
  defaultCurrency: z.string().default('USD'),
  tokenPrices: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    inputPerMillion: z.number().min(0),
    cacheReadPerMillion: z.number().min(0),
    cacheWritePerMillion: z.number().min(0),
    outputPerMillion: z.number().min(0),
    reasoningPerMillion: z.number().min(0),
  })).default([]),
  defaultMoneyBudgetMicros: z.natural().max(Number.MAX_SAFE_INTEGER).default(100_000_000),
  maxMoneyBudgetMicros: z.natural().min(1).max(Number.MAX_SAFE_INTEGER).default(1_000_000_000_000_000),
  modelPrices: z.array(z.object({
    provider: z.string().required(),
    model: z.string().required(),
    inputCacheMissMicrosPerMillion: z.natural().max(Number.MAX_SAFE_INTEGER),
    inputCacheHitMicrosPerMillion: z.natural().max(Number.MAX_SAFE_INTEGER),
    outputMicrosPerMillion: z.natural().max(Number.MAX_SAFE_INTEGER),
  })).default([]),
  maxTemporaryAuthorizationMs: z.natural().min(1).max(31_536_000_000).default(86_400_000),
  // Schemastery object/array nodes materialize `{}`/`[]` for missing input.
  // Unioning with `never()` preserves true optionality for Cordis config loading.
  allowedRoutes: z.union([z.never(), z.array(z.object({ provider: z.string().required(), model: z.string() }))]),
  fallback: z.union([z.never(), z.object({ provider: z.string().required(), model: z.string().required() })]),
  promptSectionOrder: z.natural().default(118),
  uiPollMs: z.natural().min(250).max(60_000).default(1000),
  allowRemoteUi: z.boolean().default(false),
})

export function apply(ctx: Context, input: CompanyConfig = {}): void {
  const config = resolveConfig(input)
  const store = new CompanyStore(config, {
    onWarning(message, error) {
      ctx.logger.warn(`${message}${error === undefined ? '' : `: ${String(error)}`}`)
    },
  })
  const runtime = new CompanyRuntime(ctx, config, store)
  registerCompanyTools(ctx, runtime)
  installCompanyPrompt(ctx, store, config)
  const scheduler = installCompanyScheduler(ctx, config, store)
  const disposeAccounting = installCompanyAccounting(ctx, store, config)
  runtime.attachScheduler(scheduler)
  const invalidateCatalogs = (reason: string) => {
    runtime.noteModelTopologyChange()
    const workspaces = new Set(ctx.agents.roots().map((root) => root.session.header.cwd).filter((cwd): cwd is string => cwd !== undefined))
    for (const cwd of workspaces) void runtime.invalidateModels(cwd, reason).catch((error) => ctx.logger.warn(`dsh-company model catalog invalidation failed: ${String(error)}`))
  }
  ctx.on('llm/adapters-updated', () => invalidateCatalogs('llm/adapters-updated'))
  const settingsEvents = ctx as Context & { on(name: 'settings/document-updated', listener: (...args: unknown[]) => void): () => void }
  settingsEvents.on('settings/document-updated', () => invalidateCatalogs('settings/document-updated'))
  installCompanyRoutes(ctx, runtime, config)
  ctx.effect(() => () => {
    runtime.stopAdmission()
    disposeAccounting()
    return scheduler.dispose?.()
  }, 'dsh-company runtime disposal')
  queueMicrotask(() => {
    for (const root of ctx.agents.roots()) {
      void (async () => {
        const state = await store.readActive(root.session.header.cwd)
        if (state?.moneyBudget.migrationRequired === true && String(root.id) === state.founderSessionId) {
          for (const employee of state.employees) interruptEmployee(ctx, root, employee)
        }
        await scheduler.kick(root.session.header.cwd, root)
      })().catch((error) => ctx.logger.warn(`dsh-company startup recovery failed: ${String(error)}`))
    }
  })
}

export type * from './types.js'
export { CompanyRuntime } from './runtime.js'
export { CompanyStore, RevisionConflictError } from './state.js'
export { resolveConfig, assertCompanyState, validateApprovalPayload } from './schemas.js'
export { buildSnapshot } from './snapshot.js'
export { availableCredits, routeCost } from './budget.js'
export { availableTokens, employeeTokenTotals, productTokenTotals, recordTokenUsage } from './tokens.js'
