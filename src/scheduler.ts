import { createHash } from 'node:crypto'
import type { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import { SessionId } from '@deepseek-ai/dsh-session'
import {
  CompanyMoneyBudgetError,
  CompanyUnpricedModelError,
  availableMoney,
  employeeMoneyTotals,
  maximumReservationMicros,
  productMoneyTotals,
  releaseEmployeeMoneyReservations,
  releaseMoneyReservation,
  reserveMoneyTurn,
  resolveModelContextWindow,
  resolveRateSnapshot,
} from './money.js'
import {
  consumeTemporaryAuthorization,
  resolveAuthorizationAdmission,
} from './authorizations.js'
import { deliverEmployee, untrustedParticipantMessage } from './employees.js'
import { handleEmployeeOperationalFailure } from './accounting.js'
import type { CompanyRuntime, SchedulerHandle } from './runtime.js'
import type { CompanyStore } from './state.js'
import type { CompanyMessage, CompanyState, Employee, ResolvedCompanyConfig, WorkItem } from './types.js'
import { beginWorkAttempt, selectReadyWork, workBlockedReasons } from './work.js'

const PREPARED_LEASE_MS = 60_000

export function installCompanyScheduler(
  ctx: Context,
  config: ResolvedCompanyConfig,
  store: CompanyStore,
): SchedulerHandle {
  const queues = new Map<string, Promise<void>>()
  let disposed = false

  const enqueue = async (cwd: string | undefined, suppliedFounder?: Agent): Promise<void> => {
    if (disposed || cwd === undefined) return
    const key = (await store.pathsForCwd(cwd, false)).workspace.key
    const previous = queues.get(key) ?? Promise.resolve()
    const next = previous.catch(() => undefined).then(async () => {
      await driveWorkspace(cwd, suppliedFounder)
    })
    queues.set(key, next)
    try {
      await next
    } finally {
      if (queues.get(key) === next) queues.delete(key)
    }
  }

  const driveWorkspace = async (cwd: string, suppliedFounder?: Agent): Promise<void> => {
    let state = await store.readActive(cwd)
    if (state === undefined) return
    const founder = suppliedFounder?.id === state.founderSessionId
      ? suppliedFounder
      : ctx.agents.get(SessionId(state.founderSessionId))
    if (founder === undefined || String(founder.id) !== state.founderSessionId) return
    await reconcileOrphanedTurnReservations(cwd, state)
    state = await store.readActive(cwd) ?? state
    await reconcileExpiredPrepared(cwd, state)
    state = await store.readActive(cwd) ?? state
    await fanoutGovernanceNotifications(cwd)
    state = await store.readActive(cwd) ?? state
    if (state.phase !== 'operating') return
    await deliverFounderMailbox(cwd, founder)
    for (const row of state.employees) {
      if (disposed) return
      const fresh = await store.readActive(cwd)
      if (fresh === undefined || fresh.phase !== 'operating') return
      const employee = fresh.employees.find((candidate) => candidate.id === row.id)
      if (employee === undefined || employee.status === 'retired' || employee.status === 'failed' || employee.operationalBlock !== undefined || employee.sessionId === undefined) continue
      const live = ctx.agents.get(SessionId(employee.sessionId))
      try {
        const open = fresh.workItems.find((work) => work.assigneeId === employee.id && (work.status === 'claimed' || work.status === 'in_progress'))
        if (open !== undefined) {
          // A live child owns the durable attempt. If it has disappeared, always
          // re-deliver the same capability; process-local markers must never
          // strand work after a cold unload or child loss. An idle (or
          // unloaded/ready) live child that ended its turn without a terminal
          // update is re-driven with the SAME attempt instead of being stranded.
          if (live !== undefined && live.status === 'running') continue
          await recoverOpenAttempt(cwd, founder, employee, open)
          continue
        }
        if (live !== undefined && live.status !== 'idle') continue
        if (employee.status !== 'idle') continue
        if (employee.isHr === true && await deliverOneStaffingRequest(cwd, founder, employee)) continue
        if (await deliverOneQueuedMessage(cwd, founder, employee)) continue
        await dispatchOne(cwd, founder, employee.id)
      } catch (error) {
        if (error instanceof CompanyMoneyBudgetError || error instanceof CompanyUnpricedModelError) {
          await handleEmployeeOperationalFailure(ctx, store, cwd, employee.id, {
            kind: error instanceof CompanyUnpricedModelError ? 'unpriced_model' : 'money_budget',
            code: error instanceof CompanyMoneyBudgetError ? `${error.code}:${error.level}` : error.code,
            message: error.message.slice(0, 4096),
            at: Date.now(),
          }).catch((failure) => ctx.logger.warn(`dsh-company failed to persist admission block for ${employee.id}: ${String(failure)}`))
        } else {
          ctx.logger.warn(`dsh-company activation for ${employee.id} failed without stalling other employees: ${String(error)}`)
        }
      }
    }
  }

  const fanoutGovernanceNotifications = async (cwd: string): Promise<void> => {
    for (let delivered = 0; delivered < config.maxEmployees; delivered += 1) {
      const visible = await store.readActive(cwd)
      const notice = visible?.governanceNotifications.find((candidate) => candidate.employeeIds.some((id) => !candidate.deliveredEmployeeIds.includes(id)))
      if (visible === undefined || notice === undefined) {
        if (visible?.governanceNotifications.some((candidate) => candidate.employeeIds.length === candidate.deliveredEmployeeIds.length) === true) {
          await store.transact(cwd, { actor: 'scheduler', type: 'governance.notifications_completed', summary: 'Retired completed governance notification outbox rows' }, (state) => {
            state.governanceNotifications = state.governanceNotifications.filter((candidate) => candidate.employeeIds.length !== candidate.deliveredEmployeeIds.length)
          })
        }
        return
      }
      const employeeId = notice.employeeIds.find((id) => !notice.deliveredEmployeeIds.includes(id))!
      const messageId = deterministicGovernanceMessageId(notice.id, employeeId)
      const result = await store.transact(cwd, {
        actor: 'scheduler', type: 'governance.notification_queued', summary: `Queued governance revision ${notice.governanceRevision} notice for ${employeeId}`,
      }, async (state, io) => {
        const current = state.governanceNotifications.find((candidate) => candidate.id === notice.id)
        if (current === undefined || current.deliveredEmployeeIds.includes(employeeId) || !current.employeeIds.includes(employeeId)) return true
        const messages = await io.readMailbox(employeeId)
        if (!messages.some((message) => message.id === messageId)) {
          while (messages.length >= state.limits.maxMailboxMessages) {
            const disposable = messages.findIndex((message) => message.deliveryState === 'accepted' || message.deliveryState === 'read')
            if (disposable < 0) return false
            messages.splice(disposable, 1)
          }
          messages.push({ id: messageId, from: 'founder', to: employeeId, content: current.content, createdAt: current.createdAt, deliveryState: 'queued' })
          await io.writeMailbox(employeeId, messages)
        }
        current.deliveredEmployeeIds.push(employeeId)
        if (current.deliveredEmployeeIds.length === current.employeeIds.length) {
          state.governanceNotifications = state.governanceNotifications.filter((candidate) => candidate.id !== current.id)
        }
        return true
      })
      if (!result.result) return
    }
  }

  const reconcileOrphanedTurnReservations = async (cwd: string, snapshot: CompanyState): Promise<void> => {
    const orphaned = snapshot.employees.filter((employee) => employee.sessionId !== undefined
      && snapshot.moneyBudget.reservations.some((reservation) => reservation.employeeId === employee.id)
      && ctx.agents.get(SessionId(employee.sessionId)) === undefined)
    if (orphaned.length === 0) return
    await store.transact(cwd, {
      actor: 'scheduler', type: 'tokens.orphan_released', summary: 'Released token reservations whose employee activation disappeared',
    }, (state) => {
      for (const employee of orphaned) {
        const current = state.employees.find((candidate) => candidate.id === employee.id)
        if (current?.sessionId === undefined || ctx.agents.get(SessionId(current.sessionId)) !== undefined) continue
        releaseEmployeeMoneyReservations(state, current.id)
      }
    })
  }

  const reconcileExpiredPrepared = async (cwd: string, snapshot: CompanyState): Promise<void> => {
    const staleWork = snapshot.workItems.filter((work) => work.reservationId !== undefined && (work.leaseAt ?? 0) + PREPARED_LEASE_MS <= Date.now())
    const employees = snapshot.employees.filter((employee) => employee.sessionId !== undefined)
    let hasStaleMail = false
    for (const employee of employees) {
      const messages = await store.readMailbox(cwd, employee.id)
      if (messages.some((message) => message.deliveryState === 'reserved' && (message.leaseAt ?? 0) + PREPARED_LEASE_MS <= Date.now())) hasStaleMail = true
    }
    if (staleWork.length === 0 && !hasStaleMail) return
    await store.transact(cwd, {
      actor: 'scheduler',
      type: 'scheduler.recovered',
      summary: 'Released crash-left token reservations and requeued prepared dispatches',
    }, async (state, io) => {
      for (const work of state.workItems) {
        if (work.reservationId === undefined || (work.leaseAt ?? 0) + PREPARED_LEASE_MS > Date.now()) continue
        releaseMoneyReservation(state, work.reservationId)
        work.status = 'pending'
        work.attempt = Math.max(0, work.attempt - 1)
        work.attemptId = undefined
        work.reservationId = undefined
        work.leaseAt = undefined
      }
      for (const employee of state.employees) {
        const messages = await io.readMailbox(employee.id)
        let changed = false
        for (const message of messages) {
          if (message.deliveryState !== 'reserved' || message.reservationId === undefined || (message.leaseAt ?? 0) + PREPARED_LEASE_MS > Date.now()) continue
          releaseMoneyReservation(state, message.reservationId)
          message.deliveryState = 'queued'
          message.reservationId = undefined
          message.leaseAt = undefined
          changed = true
        }
        if (changed) await io.writeMailbox(employee.id, messages)
      }
    })
  }

  const deliverFounderMailbox = async (cwd: string, founder: Agent): Promise<void> => {
    const messages = await store.readMailbox(cwd, 'founder')
    const queued = messages.find((message) => message.deliveryState === 'queued')
    if (queued === undefined) return
    try {
      founder.steer(createUserMessage({
        content: [{ type: 'text', text: untrustedParticipantMessage(queued.from, queued.id, queued.content) }],
        source: { kind: 'plugin', plugin: 'dsh-company' },
      }))
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'message.accepted',
        summary: `Delivered queued message ${queued.id} to founder`,
      }, async (_state, io) => {
        const current = await io.readMailbox('founder')
        const row = current.find((message) => message.id === queued.id)
        if (row !== undefined) {
          row.deliveryState = 'accepted'
          row.acceptedAt = Date.now()
          await io.writeMailbox('founder', current)
        }
      })
    } catch {
      // Durable queued row remains for the next kick.
    }
  }

  const deliverOneStaffingRequest = async (cwd: string, founder: Agent, employee: Employee): Promise<boolean> => {
    const visible = await store.readActive(cwd)
    const request = visible?.staffingRequests.find((candidate) => candidate.hrEmployeeId === employee.id && candidate.status === 'pending')
    if (visible === undefined || request === undefined) return false
    let reservationId: string | undefined
    try {
      const prepared = await store.transact(cwd, {
        actor: 'scheduler', type: 'staffing.delivery_prepared', summary: `Prepared staffing assessment ${request.id}`,
      }, (state) => {
        if (state.phase !== 'operating') return false
        const current = state.staffingRequests.find((candidate) => candidate.id === request.id && candidate.status === 'pending')
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id && candidate.status === 'idle' && candidate.operationalBlock === undefined)
        if (current === undefined || currentEmployee === undefined) return false
        const now = Date.now()
        reservationId = reserveEmployeeTurn(state, currentEmployee, config, {}, now)
        return true
      })
      if (!prepared.result || reservationId === undefined) return false
      await deliverEmployee(ctx, founder, employee, `HR staffing assessment ${request.id} is ready. Action: ${request.action}. Work profile: ${request.workProfile}${request.constraints === undefined ? '' : `\nConstraints: ${request.constraints}`}\n\nClaim it with company_claim_staffing_assessment, assess difficulty, provider/model, reasoning effort, turn token limit, multi-level org path, position, and responsibilities, then submit through company_submit_staffing_assessment. Never calculate token usage or monetary cost.`, new AbortController().signal)
      await store.transact(cwd, { actor: 'scheduler', type: 'staffing.delivered', summary: `Delivered staffing assessment ${request.id}` }, () => undefined)
      return true
    } catch {
      if (reservationId !== undefined) await store.transact(cwd, {
        actor: 'scheduler', type: 'staffing.delivery_failed', summary: `Staffing assessment ${request.id} delivery failed`,
      }, (state) => { releaseMoneyReservation(state, reservationId) }).catch(() => undefined)
      return false
    }
  }

  const deliverOneQueuedMessage = async (cwd: string, founder: Agent, employee: Employee): Promise<boolean> => {
    const visible = await store.readMailbox(cwd, employee.id)
    if (!visible.some((message) => message.deliveryState === 'queued' || message.deliveryState === 'held_budget')) return false
    let prepared: CompanyMessage | undefined
    let reservationId: string | undefined
    try {
      const transaction = await store.transact(cwd, {
        actor: 'scheduler',
        type: 'message.prepared',
        summary: `Prepared queued mailbox delivery for ${employee.id}`,
      }, async (state, io) => {
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id)
        if (currentEmployee === undefined || currentEmployee.status !== 'idle') return undefined
        const messages = await io.readMailbox(employee.id)
        const message = messages.find((candidate) => candidate.deliveryState === 'queued' || candidate.deliveryState === 'held_budget')
        if (message === undefined) return undefined
        try {
          const now = Date.now()
          reservationId = reserveEmployeeTurn(state, currentEmployee, config, { messageId: message.id }, now)
        } catch {
          message.deliveryState = 'held_budget'
          await io.writeMailbox(employee.id, messages)
          return undefined
        }
        message.deliveryState = 'reserved'
        message.reservationId = reservationId
        message.leaseAt = Date.now()
        await io.writeMailbox(employee.id, messages)
        return structuredClone(message)
      })
      prepared = transaction.result
    } catch {
      return false
    }
    if (prepared === undefined || reservationId === undefined) return false
    try {
      await deliverEmployee(ctx, founder, employee, `${untrustedParticipantMessage(prepared.from, prepared.id, prepared.content)}

Handle this direct message only; do not claim unrelated work.`, new AbortController().signal)
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'message.accepted',
        summary: `Queued message ${prepared.id} accepted by ${employee.id}`,
      }, async (_state, io) => {
        const messages = await io.readMailbox(employee.id)
        const message = messages.find((candidate) => candidate.id === prepared!.id)
        if (message !== undefined && message.reservationId === reservationId) {
          message.deliveryState = 'accepted'
          message.acceptedAt = Date.now()
          message.reservationId = undefined
          message.leaseAt = undefined
          await io.writeMailbox(employee.id, messages)
        }
      })
      return true
    } catch (error) {
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'message.delivery_failed',
        summary: `Queued message ${prepared.id} delivery failed: ${String(error)}`,
      }, async (state, io) => {
        releaseMoneyReservation(state, reservationId!)
        const messages = await io.readMailbox(employee.id)
        const message = messages.find((candidate) => candidate.id === prepared!.id)
        if (message !== undefined && message.reservationId === reservationId) {
          message.deliveryState = 'queued'
          message.reservationId = undefined
          message.leaseAt = undefined
          await io.writeMailbox(employee.id, messages)
        }
      })
      return true
    }
  }

  const dispatchOne = async (cwd: string, founder: Agent, employeeId: string): Promise<void> => {
    const visible = await store.readActive(cwd)
    const visibleEmployee = visible?.employees.find((candidate) => candidate.id === employeeId)
    if (visible === undefined || visible.phase !== 'operating' || visibleEmployee?.status !== 'idle' || selectReadyWork(visible, employeeId) === undefined) return
    let reservationId: string | undefined
    let previousAssignee: string | 'founder' | undefined
    const prepared = await store.transact(cwd, {
      actor: 'scheduler',
      type: 'work.dispatch_prepared',
      summary: `Prepared next ready work for ${employeeId}`,
    }, (state) => {
      if (state.phase !== 'operating') return undefined
      const employee = state.employees.find((candidate) => candidate.id === employeeId)
      if (employee === undefined || employee.status !== 'idle' || employee.sessionId === undefined) return undefined
      const live = ctx.agents.get(SessionId(employee.sessionId))
      if (live !== undefined && live.status !== 'idle') return undefined
      const now = Date.now()
      const work = selectReadyWork(state, employeeId, now)
      if (work === undefined) return undefined
      previousAssignee = work.assigneeId
      const attemptId = beginWorkAttempt(state, work, employee.id, now)
      reservationId = reserveAuthorizedWorkTurn(state, employee, work, config, now)
      work.reservationId = reservationId
      work.leaseAt = now
      employee.status = 'working'
      return { work: structuredClone(work), employee: structuredClone(employee), attemptId }
    })
    if (prepared.result === undefined || reservationId === undefined) return
    const { work, employee, attemptId } = prepared.result
    try {
      const currentGovernance = await store.readActive(cwd)
      await deliverEmployee(ctx, founder, employee, assignmentPrompt(currentGovernance ?? visible, work, attemptId), new AbortController().signal)
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.dispatched',
        summary: `Work ${work.id} attempt ${work.attempt} accepted by ${employee.id}`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current?.attemptId !== attemptId || current.reservationId !== reservationId) throw new Error('work dispatch was superseded before acceptance commit')
        current.reservationId = undefined
        current.leaseAt = undefined
      })
    } catch (error) {
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.dispatch_rejected',
        summary: `Work ${work.id} admission failed before inbox acceptance`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current?.attemptId !== attemptId || current.reservationId !== reservationId) return
        releaseMoneyReservation(state, reservationId!)
        current.status = 'pending'
        current.attempt = Math.max(0, current.attempt - 1)
        current.attemptId = undefined
        current.reservationId = undefined
        current.leaseAt = undefined
        current.assigneeId = previousAssignee
        current.updatedAt = Date.now()
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id)
        if (currentEmployee !== undefined && currentEmployee.status !== 'retired') currentEmployee.status = 'idle'
      })
      ctx.logger.warn(`dsh-company dispatch ${work.id} to ${employee.id} failed: ${String(error)}`)
    }
  }

  const recoverOpenAttempt = async (cwd: string, founder: Agent, employee: Employee, work: WorkItem): Promise<void> => {
    if (work.attemptId === undefined || employee.sessionId === undefined) return
    let reservationId: string | undefined
    const prepared = await store.transact(cwd, {
      actor: 'scheduler',
      type: 'work.recovery_checked',
      summary: `Checked cold recovery for ${work.id} attempt ${work.attempt}`,
    }, (state) => {
      const current = state.workItems.find((candidate) => candidate.id === work.id)
      const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id)
      if (current === undefined || current.attemptId !== work.attemptId || currentEmployee === undefined || currentEmployee.status === 'retired') return 'superseded' as const
      const now = Date.now()
      const blockers = workBlockedReasons(state, current, currentEmployee.id, now).filter((reason) => reason !== 'open_work_cap')
      if (blockers.length > 0) {
        releaseMoneyReservation(state, current.reservationId)
        current.status = 'pending'
        current.attempt = Math.max(0, current.attempt - 1)
        current.attemptId = undefined
        current.reservationId = undefined
        current.leaseAt = undefined
        current.updatedAt = now
        currentEmployee.status = 'idle'
        return 'blocked' as const
      }
      reservationId = reserveAuthorizedWorkTurn(state, currentEmployee, current, config, now)
      current.reservationId = reservationId
      current.leaseAt = now
      currentEmployee.status = 'working'
      return 'ready' as const
    })
    if (prepared.result !== 'ready' || reservationId === undefined) return
    try {
      const currentGovernance = await store.readActive(cwd)
      await deliverEmployee(ctx, founder, employee, recoveryPrompt(currentGovernance ?? prepared.state, work), new AbortController().signal)
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.recovered',
        summary: `Recovered ${work.id} attempt ${work.attempt} with the same capability`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current === undefined || current.attemptId !== work.attemptId || current.reservationId !== reservationId) throw new Error('recovery attempt was superseded')
        current.reservationId = undefined
        current.leaseAt = undefined
      })
    } catch (error) {
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.recovery_failed',
        summary: `Cold recovery delivery failed for ${work.id}`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current === undefined || current.attemptId !== work.attemptId || current.reservationId !== reservationId) return
        current.reservationId = undefined
        current.leaseAt = undefined
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id)
        if (currentEmployee !== undefined && currentEmployee.status !== 'retired') currentEmployee.status = 'idle'
      })
      ctx.logger.warn(`dsh-company cold recovery ${work.id} failed: ${String(error)}`)
    }
  }

  const syncEmployeeStatus = async (agent: Agent, status: 'idle' | 'running'): Promise<void> => {
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const located = await store.readActive(cwd)
    if (located === undefined) return
    const employee = located.employees.find((candidate) => candidate.sessionId === String(agent.id) && candidate.status !== 'retired')
    if (employee === undefined) return
    await store.transact(cwd, {
      actor: 'scheduler',
      type: 'employee.activity',
      summary: `Employee ${employee.id} became ${status}`,
    }, (state) => {
      const current = state.employees.find((candidate) => candidate.id === employee.id)
      if (current === undefined || current.status === 'retired' || current.status === 'failed') return
      if (status === 'idle') releaseEmployeeMoneyReservations(state, current.id)
      if (state.phase === 'paused' || state.phase === 'halted' || current.operationalBlock !== undefined) current.status = 'paused'
      else current.status = status === 'running' ? 'working' : 'idle'
    })
    if (status === 'idle') await enqueue(cwd)
  }

  ctx.on('agent/status', ({ agent, status }) => {
    void syncEmployeeStatus(agent, status).catch((error) => ctx.logger.warn(`dsh-company employee activity sync failed: ${String(error)}`))
  })

  return {
    kick: enqueue,
    dispose(): void {
      disposed = true
    },
  }
}

function reserveEmployeeTurn(
  state: CompanyState,
  employee: Employee,
  config: ResolvedCompanyConfig,
  subject: { workId?: string; messageId?: string },
  now: number,
): string {
  const provider = employee.llm.provider
  const model = employee.llm.model
  return reserveMoneyTurn(state, {
    employeeId: employee.id,
    provider,
    model,
    ...(employee.llm.fallback === undefined ? {} : { fallback: employee.llm.fallback }),
    ...subject,
  }, now)
}

function reserveAuthorizedWorkTurn(
  state: CompanyState,
  employee: Employee,
  work: WorkItem,
  config: ResolvedCompanyConfig,
  now: number,
): string {
  const provider = employee.llm.activeProvider ?? employee.llm.provider
  const model = employee.llm.activeModel ?? employee.llm.model
  const routes = [{ provider, model }, ...(employee.llm.fallback === undefined ? [] : [employee.llm.fallback])]
  let requestedMicros = 0
  let unknownCost = false
  let unboundedPrompt = false
  for (const route of routes) {
    let rates
    try { rates = resolveRateSnapshot(state, route.provider, route.model) }
    catch (error) {
      if (!(error instanceof CompanyUnpricedModelError)) throw error
      unknownCost = true
      continue
    }
    if (rates.inputCacheMissMicrosPerMillion === 0 && rates.inputCacheHitMicrosPerMillion === 0 && rates.outputMicrosPerMillion === 0) continue
    let contextWindow: number
    try { contextWindow = resolveModelContextWindow(state, route.provider, route.model) }
    catch (error) {
      if (!(error instanceof CompanyUnpricedModelError)) throw error
      unboundedPrompt = true
      continue
    }
    const promptHeadroom = maximumReservationMicros(contextWindow, rates)
    const combinedHeadroom = promptHeadroom + maximumReservationMicros(contextWindow, rates)
    if (!Number.isSafeInteger(combinedHeadroom)) throw new Error('prompt-inclusive authorization headroom overflow')
    requestedMicros = Math.max(requestedMicros, combinedHeadroom)
  }
  const admission = resolveAuthorizationAdmission(state, employee.id, work, now)
  const companyDeficit = unknownCost || unboundedPrompt || requestedMicros > availableMoney(state)
  const employeeDeficit = unknownCost || unboundedPrompt || requestedMicros > employeeMoneyTotals(state, employee.id).availableMicros
  const productDeficit = unknownCost || unboundedPrompt || requestedMicros > productMoneyTotals(state, work.productId).availableMicros
  const bypassed: Array<'company_budget' | 'product_budget' | 'employee_budget' | 'approval_dependency'> = []
  if (admission !== undefined) {
    if (companyDeficit) bypassed.push('company_budget')
    if (productDeficit) bypassed.push('product_budget')
    if (employeeDeficit) bypassed.push('employee_budget')
    if (admission.bypassedApprovalIds.length > 0) bypassed.push('approval_dependency')
  }
  const bypass = admission === undefined || (bypassed.length === 0 && !unknownCost) ? undefined : {
    authorizationId: admission.authorization.id,
    bypassCompany: companyDeficit,
    bypassProduct: productDeficit,
    bypassEmployee: employeeDeficit,
  }
  const reservationId = reserveMoneyTurn(state, {
    employeeId: employee.id,
    provider,
    model,
    ...(employee.llm.fallback === undefined ? {} : { fallback: employee.llm.fallback }),
    workId: work.id,
    ...(bypass === undefined ? {} : { bypass }),
  }, now)
  if (admission !== undefined && bypassed.length > 0) {
    consumeTemporaryAuthorization(admission.authorization, {
      employeeId: employee.id,
      workId: work.id,
      bypassed,
      approvalIds: admission.bypassedApprovalIds,
      ...(unknownCost ? { unknownCost: true } : {}),
    }, now)
  }
  return reservationId
}

function deterministicGovernanceMessageId(noticeId: string, employeeId: string): string {
  const hex = createHash('sha256').update(`${noticeId}\0${employeeId}`).digest('hex')
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`
}

function governancePrompt(state: CompanyState): string {
  return `Current company governance revision: ${state.governanceRevision}\nCurrent mission:\n${state.mission}\n\nCurrent charter:\n${state.formation.charter}`
}

function assignmentPrompt(state: CompanyState, work: WorkItem, attemptId: string): string {
  return `dsh-company automatic work assignment.

${governancePrompt(state)}

Work: ${work.id} — ${work.subject}
Kind: ${work.kind}
Objective: ${work.objective}
Attempt: ${work.attempt}
Attempt id: ${attemptId}
Product: ${work.productId}
In scope: ${work.inScope.join(', ') || '(none)'}
Out of scope: ${work.outOfScope.join(', ') || '(none)'}
Acceptance contract:\n${work.acceptance.map((item) => `- ${item}`).join('\n')}
Verification contract:\n${work.verify.map((item) => `- ${item}`).join('\n') || '- none specified'}
Deliverables:\n${work.deliverables.map((item) => `- ${item}`).join('\n') || '- none specified'}

Call company_claim_work with work_id=${work.id}; it returns this same attempt_id. Include attempt_id=${attemptId} in every company_update_work call. Stop immediately if the capability is rejected as stale. Work only this item, send durable coordination through company_send_message, update the work terminally with real evidence, report the founder, then end the turn.`
}

function recoveryPrompt(state: CompanyState, work: WorkItem): string {
  return `dsh-company recovered your existing open work after a Host/plugin restart. Continue the SAME attempt; do not create or infer a new capability.

${governancePrompt(state)}

Work: ${work.id} — ${work.subject}
Attempt: ${work.attempt}
Attempt id: ${work.attemptId}
Current status: ${work.status}
Objective: ${work.objective}

Call company_claim_work for ${work.id}; it idempotently returns the same attempt_id. Include attempt_id=${work.attemptId} in every update. If it is stale, stop immediately.`
}
