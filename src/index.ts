/** dsh-company host plugin entrypoint. */
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import type {} from '@deepseek-ai/dsh-agent'
import type {} from '@deepseek-ai/dsh-llm'
import type {} from '@deepseek-ai/dsh-subagent'
import type {} from '@deepseek-ai/dsh-settings/types'
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
  defaultCurrency: z.string().default('USD'),
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
  uiPollMs: z.natural().min(500).max(60_000).default(1000),
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
  const scheduler = installCompanyScheduler(ctx, config, store, runtime)
  const disposeAccounting = installCompanyAccounting(ctx, store, config)
  runtime.attachScheduler(scheduler)
  const invalidateCatalogs = (reason: string) => {
    runtime.noteModelTopologyChange()
    const workspaces = new Set(ctx.agents.roots().map((root) => root.session.header.cwd).filter((cwd): cwd is string => cwd !== undefined))
    for (const cwd of workspaces) void runtime.invalidateModels(cwd, reason).catch((error) => ctx.logger.warn(`dsh-company model catalog invalidation failed: ${String(error)}`))
  }
  ctx.on('llm/adapters-updated', () => invalidateCatalogs('llm/adapters-updated'))
  ctx.on('settings/document-updated', () => invalidateCatalogs('settings/document-updated'))
  installCompanyRoutes(ctx, runtime, config)
  let active = true
  const recover = (root: ReturnType<typeof ctx.agents.roots>[number]): void => {
    void (async () => {
      if (!active) return
      const state = await store.readActive(root.session.header.cwd)
      if (state === undefined || String(root.id) !== state.founderSessionId) return
      if (state.moneyBudget.migrationRequired === true) {
        for (const employee of state.employees) interruptEmployee(ctx, root, employee)
      }
      await runtime.recoverWorkspace(root)
      if (active) await scheduler.kick(root.session.header.cwd, root)
    })().catch((error) => ctx.logger.warn(`dsh-company startup recovery failed: ${String(error)}`))
  }
  ctx.on('agent/created', ({ agent }) => {
    if ((agent.session.header.delegationDepth ?? 0) === 0) recover(agent)
  })
  ctx.effect(() => {
    queueMicrotask(() => {
      if (active) for (const root of ctx.agents.roots()) recover(root)
    })
    return async () => {
      active = false
      runtime.stopAdmission()
      await scheduler.dispose?.()
      await disposeAccounting()
    }
  }, 'dsh-company runtime lifecycle')
}

export type * from './types.js'
export { CompanyRuntime } from './runtime.js'
export { CompanyStore, RevisionConflictError } from './state.js'
export { resolveConfig, assertCompanyState, validateApprovalPayload } from './schemas.js'
export { buildSnapshot } from './snapshot.js'
export {
  availableMoney,
  employeeMoneyTotals,
  matchModelPrice,
  priceUsageThreeRate,
  productMoneyTotals,
} from './money.js'
