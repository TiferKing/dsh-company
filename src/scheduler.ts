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
import { SubagentError } from '@deepseek-ai/dsh-subagent'
import { activeSelection, deliverEmployee, untrustedParticipantMessage } from './employees.js'
import { HR_ASSESSMENT_REMINDER } from './hr-policy.js'
import { CompanyExecutionDeferredError, ensureCompanyExecution, hasEmployeeExecution } from './execution.js'
import { handleEmployeeOperationalFailure } from './accounting.js'
import type { CompanyRuntime, SchedulerHandle } from './runtime.js'
import { makeMailboxRoom, type CompanyStore } from './state.js'
import type { CompanyMessage, CompanyState, Employee, ResolvedCompanyConfig, StaffingRequest, WorkItem } from './types.js'
import { beginWorkAttempt, selectReadyWork, workBlockedReasons } from './work.js'

const PREPARED_LEASE_MS = 60_000
const MAX_ATTEMPT_DELIVERIES = 3
const STAFFING_REDELIVERY_COOLDOWN_MS = 5 * 60_000
const BACKLOG_STEER_COOLDOWN_MS = 30 * 60_000
const DELIVERY_RETRY_MS = 30_000
const EMPLOYEE_BATCH_SIZE = 64

export function installCompanyScheduler(
  ctx: Context,
  config: ResolvedCompanyConfig,
  store: CompanyStore,
  runtime?: Pick<CompanyRuntime, 'recoverWorkspace' | 'reprobeModels'>,
): SchedulerHandle {
  const execution = ensureCompanyExecution(ctx, config, store)
  const readState = (cwd: string) => typeof store.readActiveView === 'function' ? store.readActiveView(cwd) : store.readActive.call(store, cwd)
  const cursors = new Map<string, number>()
  const maintenanceCursors = new Map<string, number>()
  const queues = new Map<string, { rerun: boolean; promise: Promise<void> }>()
  const lifecycle = new AbortController()
  let disposed = false
  const workspaceKeys = new Map<string, string>()
  const wakeups = new Map<string, { at: number; timer: ReturnType<typeof setTimeout> }>()

  const clearWakeup = (key: string): void => {
    const pending = wakeups.get(key)
    if (pending !== undefined) clearTimeout(pending.timer)
    wakeups.delete(key)
  }

  const scheduleWakeup = (cwd: string, delayMs: number): void => {
    const key = workspaceKeys.get(cwd)
    if (disposed || lifecycle.signal.aborted || key === undefined) return
    const at = Date.now() + Math.max(1, delayMs)
    if ((wakeups.get(key)?.at ?? Infinity) <= at) return
    clearWakeup(key)
    const timer = setTimeout(() => {
      wakeups.delete(key)
      // Resolve the currently live founder from Host state on every wake;
      // a cached Agent must never revive an unloaded founder session.
      void enqueue(cwd).catch((error) => ctx.logger.warn(`dsh-company scheduled wake failed: ${String(error)}`))
    }, Math.max(1, delayMs))
    timer.unref()
    wakeups.set(key, { at, timer })
  }

  const defer = (cwd: string | undefined, delayMs: number): void => {
    if (cwd === undefined || disposed) return
    void store.pathsForCwd(cwd, false).then(({ workspace }) => {
      if (disposed) return
      workspaceKeys.set(cwd, workspace.key)
      scheduleWakeup(cwd, delayMs)
    }).catch((error) => ctx.logger.warn(`dsh-company resource retry failed: ${String(error)}`))
  }
  execution.setWakeup(defer)

  const backlogSteeredAt = new Map<string, number>()
  const steerBacklog = async (cwd: string, founder: Agent): Promise<void> => {
    const state = await readState(cwd)
    if (state === undefined || state.phase !== 'operating') return
    const pending = state.workItems.filter((work) => work.status === 'pending' && work.reassigning !== true && work.ticketId === undefined)
    if (pending.length === 0) return
    const nonHr = state.employees.filter((e) => e.status !== 'retired' && e.isHr !== true)
    // Overload: more than 2× pending per active non-HR employee.
    if (pending.length <= nonHr.length * 2) return
    const last = backlogSteeredAt.get(cwd) ?? 0
    const now = Date.now()
    if (now - last < BACKLOG_STEER_COOLDOWN_MS) return
    backlogSteeredAt.set(cwd, now)
    // Identify the most-loaded org unit for actionable advice.
    const byUnit = new Map<string, number>()
    for (const work of pending) {
      for (const unitId of work.eligibleOrgUnitIds ?? []) byUnit.set(unitId, (byUnit.get(unitId) ?? 0) + 1)
    }
    const hottest = [...byUnit.entries()].sort((a, b) => b[1] - a[1])[0]
    const unitName = hottest === undefined ? '' : state.orgUnits.find((u) => u.id === hottest[0])?.name ?? ''
    const text = [
      'dsh-company backlog alert (authoritative record written by the dsh-company plugin).',
      `${pending.length} work items are pending with only ${nonHr.length} active non-HR employee(s)`,
      hottest === undefined ? '' : `; the most loaded scope is ${unitName} (${hottest[1]} items)`,
      '. Consider requesting additional headcount via company_request_staffing so HR can assess and the human can approve.',
    ].join('')
    try {
      founder.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-company' },
      }))
    } catch {
      // Best-effort steer; cooldown prevents retry storms.
    }
  }

  const enqueue = async (cwd: string | undefined): Promise<void> => {
    if (disposed || lifecycle.signal.aborted || cwd === undefined) return
    const key = (await store.pathsForCwd(cwd, false)).workspace.key
    if (disposed || lifecycle.signal.aborted) return
    workspaceKeys.set(cwd, key)
    const existing = queues.get(key)
    if (existing !== undefined) {
      // Collapse any number of concurrent UI/status/event wakeups into at most
      // one follow-up pass. The old Promise chain retained one closure per kick
      // whenever state I/O became slower than the wakeup rate.
      existing.rerun = true
      return existing.promise
    }
    const pump: { rerun: boolean; promise: Promise<void> } = {
      rerun: true,
      promise: Promise.resolve(),
    }
    pump.promise = Promise.resolve().then(async () => {
      try {
        do {
          pump.rerun = false
          if (lifecycle.signal.aborted) return
          clearWakeup(key)
          await driveWorkspace(cwd)
        } while (pump.rerun && !lifecycle.signal.aborted)
      } finally {
        // Remove the completed pump before another microtask can join it and
        // set rerun after the loop has already decided to stop.
        if (queues.get(key) === pump) queues.delete(key)
      }
    })
    queues.set(key, pump)
    return pump.promise
  }

  const driveWorkspace = async (cwd: string): Promise<void> => {
    if (lifecycle.signal.aborted) return
    let state = await readState(cwd)
    if (lifecycle.signal.aborted) return
    if (state === undefined) return
    execution.observe(state, cwd)
    // Only a currently registered founder can authorize continuation. Callers
    // may still hold an old Agent across a Host unload/reload boundary.
    const founder = ctx.agents.get(SessionId(state.founderSessionId))
    if (founder === undefined || String(founder.id) !== state.founderSessionId) return
    if (runtime !== undefined && (state.phase === 'provisioning' || state.employees.some((employee) => employee.status === 'provisioning') || state.workItems.some((work) => work.reassigning === true))) {
      await runtime.recoverWorkspace(founder)
      state = await readState(cwd) ?? state
    }
    // Classify expired preparations before releasing turn reservations: the
    // release helpers clear the work/HR pointers needed to identify an
    // assignment that was prepared but never accepted.
    await reconcileExpiredPrepared(cwd, state)
    if (lifecycle.signal.aborted) return
    state = await readState(cwd) ?? state
    state = await reconcileEmployeeActivity(cwd, state)
    if (lifecycle.signal.aborted) return
    await reconcileOrphanedTurnReservations(cwd, state)
    if (lifecycle.signal.aborted) return
    state = await readState(cwd) ?? state
    await fanoutGovernanceNotifications(cwd)
    if (lifecycle.signal.aborted) return
    state = await readState(cwd) ?? state
    if (state.phase !== 'operating') return
    // Context windows and route availability are admission inputs. Never turn a
    // stale topology marker off without re-probing the actual DSH registry.
    if (state.modelCatalog.stale) {
      if (runtime === undefined) return
      try {
        await runtime.reprobeModels(founder, state.revision, lifecycle.signal)
        if (lifecycle.signal.aborted) return
        state = await readState(cwd) ?? state
      } catch (probeError) {
        if (lifecycle.signal.aborted) return
        ctx.logger.warn(`dsh-company automatic model reprobe failed: ${String(probeError)}`)
        scheduleWakeup(cwd, DELIVERY_RETRY_MS)
        return
      }
    }
    await deliverFounderMailbox(cwd, founder)
    const start = (cursors.get(state.id) ?? 0) % Math.max(1, state.employees.length)
    for (let scanned = 0; scanned < Math.min(EMPLOYEE_BATCH_SIZE, state.employees.length); scanned += 1) {
      const index = (start + scanned) % state.employees.length
      const row = state.employees[index]!
      cursors.set(state.id, (index + 1) % state.employees.length)
      if (disposed) return
      const fresh = await readState(cwd)
      if (fresh === undefined || fresh.phase !== 'operating') return
      const employee = fresh.employees.find((candidate) => candidate.id === row.id)
      // Rebuild diagnostic waiting state only for tasks that still exist.
      // Cancellation or retirement must not leave a phantom queue entry.
      if (employee?.sessionId !== undefined) execution.clearWaiting(employee.sessionId)
      if (employee === undefined || !['idle', 'working'].includes(employee.status) || employee.operationalBlock !== undefined || employee.sessionId === undefined) continue
      const live = ctx.agents.get(SessionId(employee.sessionId))
      try {
        const open = fresh.workItems.find((work) => work.assigneeId === employee.id && (work.status === 'claimed' || work.status === 'in_progress'))
        if (open !== undefined) {
          // A live child owns the durable attempt. If it has disappeared, always
          // re-deliver the same capability; process-local markers must never
          // strand work after a cold unload or child loss. An idle (or
          // unloaded/ready) live child that ended its turn without a terminal
          // update is re-driven with the SAME attempt instead of being stranded.
          if (hasEmployeeExecution(live)) continue
          await recoverOpenAttempt(cwd, founder, employee, open)
          continue
        }
        const staffingReview = employee.isHr === true
          ? fresh.staffingRequests.find((request) => request.hrEmployeeId === employee.id && request.status === 'in_review')
          : undefined
        if (staffingReview !== undefined) {
          if (hasEmployeeExecution(live)) continue
          await recoverStaffingAssessment(cwd, founder, employee, staffingReview)
          continue
        }
        if (live !== undefined && live.status !== 'idle') continue
        if (employee.status !== 'idle') continue
        if (employee.isHr === true) {
          // HR governance employees handle staffing assessments and messages
          // only — never ordinary work dispatch.
          if (await deliverOneStaffingRequest(cwd, founder, employee)) continue
          if (await deliverOneQueuedMessage(cwd, founder, employee)) continue
          continue
        }
        if (await deliverOneQueuedMessage(cwd, founder, employee)) continue
        await dispatchOne(cwd, founder, employee.id)
      } catch (error) {
        if (error instanceof CompanyExecutionDeferredError) {
          scheduleWakeup(cwd, error.retryAfterMs)
          continue
        }
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
    if (state.employees.length > EMPLOYEE_BATCH_SIZE) scheduleWakeup(cwd, config.executionRetryMs)
    await steerBacklog(cwd, founder)
    const remaining = await readState(cwd)
    if (remaining?.phase !== 'operating') return
    for (const request of remaining.staffingRequests) {
      if (request.status !== 'pending' || request.lastDeliveredAt === undefined) continue
      const employee = remaining.employees.find((candidate) => candidate.id === request.hrEmployeeId)
      if (employee?.status !== 'idle' || employee.operationalBlock !== undefined || employee.sessionId === undefined) continue
      const live = ctx.agents.get(SessionId(employee.sessionId))
      if (live !== undefined && live.status !== 'idle') continue
      scheduleWakeup(cwd, Math.max(DELIVERY_RETRY_MS, request.lastDeliveredAt + STAFFING_REDELIVERY_COOLDOWN_MS - Date.now()))
    }
  }

  const fanoutGovernanceNotifications = async (cwd: string): Promise<void> => {
    for (let delivered = 0; delivered < EMPLOYEE_BATCH_SIZE; delivered += 1) {
      const visible = await readState(cwd)
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
          try { makeMailboxRoom(messages, state.limits.maxMailboxMessages) } catch { return false }
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
    scheduleWakeup(cwd, config.executionRetryMs)
  }

  const reconcileEmployeeActivity = async (cwd: string, snapshot: CompanyState): Promise<CompanyState> => {
    // Status events emitted while the plugin was absent cannot update its
    // durable ledger. A saved `working` flag is not evidence of a live turn.
    const stopped = snapshot.employees.filter((employee) => employee.status === 'working')
      .map((employee) => ({ employee, live: employee.sessionId === undefined ? undefined : ctx.agents.get(SessionId(employee.sessionId)) }))
      .filter(({ live }) => !hasEmployeeExecution(live))
    if (stopped.length === 0) return snapshot
    const reconciled = await store.transact(cwd, {
      actor: 'scheduler', type: 'employee.activity_reconciled', summary: 'Reconciled saved working employees with current Host activity',
    }, (state) => {
      if (lifecycle.signal.aborted || state.id !== snapshot.id) return
      for (const { employee: previous, live: observedLive } of stopped) {
        const employee = state.employees.find((candidate) => candidate.id === previous.id)
        if (employee?.status !== 'working' || employee.sessionId !== previous.sessionId) continue
        // Recheck after waiting for the state transaction: a replacement or a
        // newly started turn must keep both its status and its reservation.
        const live = employee.sessionId === undefined ? undefined : ctx.agents.get(SessionId(employee.sessionId))
        if (live !== observedLive || hasEmployeeExecution(live)) continue
        releaseEmployeeMoneyReservations(state, employee.id)
        employee.status = state.phase === 'operating' && employee.operationalBlock === undefined ? 'idle' : 'paused'
        // Open work/HR capabilities are preserved for the recovery paths below.
      }
    })
    return reconciled.state
  }

  const reconcileOrphanedTurnReservations = async (cwd: string, snapshot: CompanyState): Promise<void> => {
    const orphaned = snapshot.employees.filter((employee) => employee.status !== 'provisioning' && employee.sessionId !== undefined
      && snapshot.moneyBudget.reservations.some((reservation) => reservation.employeeId === employee.id)
      && ctx.agents.get(SessionId(employee.sessionId)) === undefined)
    if (orphaned.length === 0) return
    await store.transact(cwd, {
      actor: 'scheduler', type: 'money.orphan_released', summary: 'Released monetary reservations whose employee activation disappeared',
    }, (state) => {
      for (const employee of orphaned) {
        const current = state.employees.find((candidate) => candidate.id === employee.id)
        if (current?.sessionId === undefined || current.status === 'provisioning' || ctx.agents.get(SessionId(current.sessionId)) !== undefined) continue
        releaseEmployeeMoneyReservations(state, current.id)
      }
    })
  }

  const reconcileExpiredPrepared = async (cwd: string, snapshot: CompanyState): Promise<void> => {
    const staleWork = snapshot.workItems.filter((work) => work.reservationId !== undefined && (work.leaseAt ?? 0) + PREPARED_LEASE_MS <= Date.now())
    const staleStaffing = snapshot.staffingRequests.filter((request) => request.reservationId !== undefined && (request.leaseAt ?? 0) + PREPARED_LEASE_MS <= Date.now())
    const candidates = snapshot.employees.filter((employee) => employee.sessionId !== undefined)
    const start = (maintenanceCursors.get(snapshot.id) ?? 0) % Math.max(1, candidates.length)
    const employees = Array.from({ length: Math.min(EMPLOYEE_BATCH_SIZE, candidates.length) }, (_, offset) => candidates[(start + offset) % candidates.length]!)
    maintenanceCursors.set(snapshot.id, (start + employees.length) % Math.max(1, candidates.length))
    const scannedIds = new Set(employees.map((employee) => employee.id))
    let hasStaleMail = false
    for (const employee of employees) {
      const messages = await store.readMailbox(cwd, employee.id)
      if (messages.some((message) => message.deliveryState === 'reserved' && (message.leaseAt ?? 0) + PREPARED_LEASE_MS <= Date.now())) hasStaleMail = true
    }
    if (staleWork.length === 0 && staleStaffing.length === 0 && !hasStaleMail) return
    await store.transact(cwd, {
      actor: 'scheduler',
      type: 'scheduler.recovered',
      summary: 'Released crash-left monetary reservations and requeued prepared dispatches',
    }, async (state, io) => {
      const recoveredEmployeeIds = new Set<string>()
      const isEmployeeRunning = (employeeId: string | undefined): boolean => {
        const employee = state.employees.find((candidate) => candidate.id === employeeId)
        return employee?.sessionId !== undefined && hasEmployeeExecution(ctx.agents.get(SessionId(employee.sessionId)))
      }
      for (const work of state.workItems) {
        if (work.reservationId === undefined || (work.leaseAt ?? 0) + PREPARED_LEASE_MS > Date.now()) continue
        // A crash can occur after inbox acceptance and before its commit. The
        // lease alone does not prove that a running child failed admission.
        if (isEmployeeRunning(work.assigneeId)) continue
        releaseMoneyReservation(state, work.reservationId)
        if (work.assigneeId !== undefined && work.assigneeId !== 'founder') recoveredEmployeeIds.add(work.assigneeId)
        // Recovery preparations belong to an already accepted attempt. Keep
        // its capability and progress when only the re-delivery lease expires.
        if (work.status === 'claimed' && (work.deliveryAttempts ?? 0) === 0) {
          work.status = 'pending'
          work.attempt = Math.max(0, work.attempt - 1)
          work.deliveryAttempts = 0
          work.attemptId = undefined
        }
        work.reservationId = undefined
        work.leaseAt = undefined
      }
      for (const request of state.staffingRequests) {
        if (request.reservationId === undefined || (request.leaseAt ?? 0) + PREPARED_LEASE_MS > Date.now()) continue
        if (isEmployeeRunning(request.hrEmployeeId)) continue
        releaseMoneyReservation(state, request.reservationId)
        recoveredEmployeeIds.add(request.hrEmployeeId)
        request.reservationId = undefined
        request.leaseAt = undefined
      }
      for (const employeeId of recoveredEmployeeIds) {
        const employee = state.employees.find((candidate) => candidate.id === employeeId)
        const hasOtherOpenWork = state.workItems.some((work) => work.assigneeId === employeeId && (work.status === 'claimed' || work.status === 'in_progress'))
        if (employee?.status === 'working' && !hasOtherOpenWork) employee.status = state.phase === 'operating' ? 'idle' : 'paused'
      }
      for (const employee of state.employees) {
        if (!scannedIds.has(employee.id)) continue
        if (isEmployeeRunning(employee.id)) continue
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
      scheduleWakeup(cwd, DELIVERY_RETRY_MS)
    }
  }

  const recoverStaffingAssessment = async (cwd: string, founder: Agent, employee: Employee, request: StaffingRequest): Promise<void> => {
    if (request.attemptId === undefined) return
    execution.check(employee.sessionId!, cwd, activeSelection(employee.llm).provider)
    let reservationId: string | undefined
    const prepared = await store.transact(cwd, {
      actor: 'scheduler', type: 'staffing.recovery_prepared', summary: `Prepared staffing recovery ${request.id}`,
    }, (state) => {
      const current = state.staffingRequests.find((candidate) => candidate.id === request.id && candidate.status === 'in_review' && candidate.attemptId === request.attemptId)
      const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === employee.sessionId && ['idle', 'working'].includes(candidate.status) && candidate.operationalBlock === undefined)
      if (state.phase !== 'operating' || current === undefined || currentEmployee === undefined) return 'superseded' as const
      if ((current.reviewDeliveryAttempts ?? 1) >= MAX_ATTEMPT_DELIVERIES) {
        releaseMoneyReservation(state, current.reservationId)
        current.status = 'pending'
        current.attemptId = undefined
        current.reviewDeliveryAttempts = 0
        current.lastDeliveredAt = Date.now()
        current.reservationId = undefined
        current.leaseAt = undefined
        current.updatedAt = Date.now()
        currentEmployee.status = 'idle'
        return 'exhausted' as const
      }
      const now = Date.now()
      reservationId = reserveEmployeeTurn(state, currentEmployee, { staffingRequestId: current.id }, now)
      current.reservationId = reservationId
      current.leaseAt = now
      currentEmployee.status = 'working'
      return 'ready' as const
    })
    if (prepared.result === 'exhausted') {
      try {
        founder.steer(createUserMessage({
          content: [{ type: 'text', text: `dsh-company staffing supervision alert (authoritative record). HR assessment ${request.id} was reset after ${MAX_ATTEMPT_DELIVERIES} accepted prompts without a recommendation. It may be claimed again after review.` }],
          source: { kind: 'plugin', plugin: 'dsh-company' },
        }))
      } catch { /* best-effort */ }
      return
    }
    if (prepared.result !== 'ready' || reservationId === undefined) return
    try {
      await deliverEmployee(ctx, founder, employee, `dsh-company recovered staffing assessment ${request.id} after an interrupted HR turn. Continue the SAME assessment capability. Call company_claim_staffing_assessment for ${request.id}; it must return attempt_id=${request.attemptId}. Stop if the capability is stale.\n\n${staffingAssessmentGuidance(prepared.state, request)}`, lifecycle.signal, execution)
      if (lifecycle.signal.aborted) return
      await store.transact(cwd, { actor: 'scheduler', type: 'staffing.recovered', summary: `Recovered staffing assessment ${request.id}` }, (state) => {
        const current = state.staffingRequests.find((candidate) => candidate.id === request.id && candidate.attemptId === request.attemptId)
        if (current === undefined) throw new Error('staffing recovery was superseded')
        current.reviewDeliveryAttempts = (current.reviewDeliveryAttempts ?? 1) + 1
        if (current.reservationId === reservationId) {
          current.reservationId = undefined
          current.leaseAt = undefined
        }
      })
    } catch (error) {
      if (lifecycle.signal.aborted) return
      await store.transact(cwd, { actor: 'scheduler', type: 'staffing.recovery_failed', summary: `Staffing recovery ${request.id} failed` }, (state) => {
        releaseMoneyReservation(state, reservationId)
        const current = state.staffingRequests.find((candidate) => candidate.id === request.id && candidate.reservationId === reservationId)
        if (current !== undefined) {
          current.reservationId = undefined
          current.leaseAt = undefined
        }
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === employee.sessionId)
        if (currentEmployee?.status === 'working') currentEmployee.status = state.phase === 'operating' ? 'idle' : 'paused'
      }).catch(() => undefined)
      if (error instanceof SubagentError && error.code === 'NOT_RESUMABLE') {
        await markEmployeeSessionFailed(cwd, employee, String(error))
        await steerSessionUnrecoverable(cwd, founder, employee.id, String(error))
      } else scheduleWakeup(cwd, error instanceof CompanyExecutionDeferredError ? error.retryAfterMs : DELIVERY_RETRY_MS)
      if (!(error instanceof CompanyExecutionDeferredError)) ctx.logger.warn(`dsh-company staffing recovery ${request.id} failed: ${String(error)}`)
    }
  }

  const deliverOneStaffingRequest = async (cwd: string, founder: Agent, employee: Employee): Promise<boolean> => {
    const visible = await readState(cwd)
    const request = visible?.staffingRequests.find((candidate) => candidate.hrEmployeeId === employee.id && candidate.status === 'pending' && (candidate.lastDeliveredAt ?? 0) + STAFFING_REDELIVERY_COOLDOWN_MS <= Date.now())
    if (visible === undefined || request === undefined) return false
    execution.check(employee.sessionId!, cwd, activeSelection(employee.llm).provider)
    let reservationId: string | undefined
    try {
      const prepared = await store.transact(cwd, {
        actor: 'scheduler', type: 'staffing.delivery_prepared', summary: `Prepared staffing assessment ${request.id}`,
      }, (state) => {
        if (state.phase !== 'operating') return false
        const current = state.staffingRequests.find((candidate) => candidate.id === request.id && candidate.status === 'pending' && (candidate.lastDeliveredAt ?? 0) + STAFFING_REDELIVERY_COOLDOWN_MS <= Date.now())
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === employee.sessionId && candidate.status === 'idle' && candidate.operationalBlock === undefined)
        if (current === undefined || currentEmployee === undefined) return false
        const now = Date.now()
        reservationId = reserveEmployeeTurn(state, currentEmployee, { staffingRequestId: current.id }, now)
        current.reservationId = reservationId
        current.leaseAt = now
        return true
      })
      if (!prepared.result || reservationId === undefined) return false
      await deliverEmployee(ctx, founder, employee, `HR staffing assessment ${request.id} is ready. Claim it with company_claim_staffing_assessment.\n\n${staffingAssessmentGuidance(prepared.state, request)}`, lifecycle.signal, execution)
      if (lifecycle.signal.aborted) return false
      await store.transact(cwd, { actor: 'scheduler', type: 'staffing.delivered', summary: `Delivered staffing assessment ${request.id}` }, (state) => {
        const current = state.staffingRequests.find((candidate) => candidate.id === request.id)
        if (current !== undefined) {
          if (current.status === 'pending') current.lastDeliveredAt = Date.now()
          if (current.reservationId === reservationId) {
            current.reservationId = undefined
            current.leaseAt = undefined
          }
        }
      })
      return true
    } catch (error) {
      if (lifecycle.signal.aborted) return false
      if (reservationId !== undefined) await store.transact(cwd, {
        actor: 'scheduler', type: 'staffing.delivery_failed', summary: `Staffing assessment ${request.id} delivery failed`,
      }, (state) => {
        releaseMoneyReservation(state, reservationId)
        const current = state.staffingRequests.find((candidate) => candidate.id === request.id && candidate.reservationId === reservationId)
        if (current !== undefined) {
          current.reservationId = undefined
          current.leaseAt = undefined
        }
      }).catch(() => undefined)
      if (error instanceof SubagentError && error.code === 'NOT_RESUMABLE') {
        await markEmployeeSessionFailed(cwd, employee, String(error))
        await steerSessionUnrecoverable(cwd, founder, employee.id, String(error))
      } else if (!(error instanceof CompanyMoneyBudgetError) && !(error instanceof CompanyUnpricedModelError)) scheduleWakeup(cwd, DELIVERY_RETRY_MS)
      if (error instanceof CompanyMoneyBudgetError || error instanceof CompanyUnpricedModelError) throw error
      return false
    }
  }

  const MAX_DELIVERY_ATTEMPTS = 3

  const steerSessionUnrecoverable = async (cwd: string, founder: Agent, employeeId: string, sessionErr: string): Promise<void> => {
    const state = await readState(cwd)
    const employee = state?.employees.find((candidate) => candidate.id === employeeId)
    if (employee === undefined) return
    const text = [
      'dsh-company session failure (authoritative record written by the dsh-company plugin).',
      `Employee ${employee.name} (${employeeId}) has an unrecoverable continuable session: ${sessionErr.slice(0, 200)}`,
      'The scheduler will skip this employee until corrected. If the session cannot be recovered, retire and re-hire through the HR staffing flow (company_request_staffing → company_remove_employee → company_add_employee) so the org tree and audit reflect the change.',
    ].join(' ')
    try {
      founder.steer(createUserMessage({
        content: [{ type: 'text', text }],
        source: { kind: 'plugin', plugin: 'dsh-company' },
      }))
    } catch {
      // Best-effort steer.
    }
  }

  const markEmployeeSessionFailed = async (cwd: string, failed: Employee, message: string): Promise<void> => {
    await store.transact(cwd, {
      actor: 'scheduler', type: 'employee.session_unrecoverable',
      summary: `Employee ${failed.id} continuable session is unrecoverable`,
    }, (state) => {
      const employee = state.employees.find((candidate) => candidate.id === failed.id)
      if (employee === undefined || employee.sessionId !== failed.sessionId || employee.status === 'retired') return
      employee.status = 'failed'
      employee.operationalBlock = { kind: 'session_unrecoverable', code: 'NOT_RESUMABLE', message: message.slice(0, 4096), at: Date.now() }
      if (state.supportEmployeeId === employee.id) state.supportEmployeeId = undefined
    }).catch(() => undefined)
  }

  const deliverOneQueuedMessage = async (cwd: string, founder: Agent, employee: Employee): Promise<boolean> => {
    const visible = await store.readMailbox(cwd, employee.id)
    const queued = visible.filter((message) => message.deliveryState === 'queued' || message.deliveryState === 'held_budget')
    // Skip messages that exceeded the retry limit.
    const deliverable = queued.filter((message) => (message.attempts ?? 0) < MAX_DELIVERY_ATTEMPTS)
    if (deliverable.length === 0) return false
    execution.check(employee.sessionId!, cwd, activeSelection(employee.llm).provider)
    let prepared: CompanyMessage | undefined
    let reservationId: string | undefined
    let reserveFailure: unknown
    try {
      const transaction = await store.transact(cwd, {
        actor: 'scheduler',
        type: 'message.prepared',
        summary: `Prepared queued mailbox delivery for ${employee.id}`,
      }, async (state, io) => {
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id)
        if (state.phase !== 'operating' || currentEmployee === undefined || currentEmployee.sessionId !== employee.sessionId || currentEmployee.status !== 'idle' || currentEmployee.operationalBlock !== undefined) return undefined
        const messages = await io.readMailbox(employee.id)
        const message = messages.find((candidate) => (candidate.deliveryState === 'queued' || candidate.deliveryState === 'held_budget') && (candidate.attempts ?? 0) < MAX_DELIVERY_ATTEMPTS)
        if (message === undefined) return undefined
        try {
          const now = Date.now()
          reservationId = reserveEmployeeTurn(state, currentEmployee, { messageId: message.id }, now)
        } catch (reserveError) {
          // No delivery was attempted. Temporary admission failures must not
          // exhaust transport retries or lose the message after a budget fix.
          reserveFailure = reserveError
          message.deliveryState = 'held_budget'
          message.reservationId = undefined
          message.leaseAt = undefined
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
    if (reserveFailure !== undefined) throw reserveFailure
    if (prepared === undefined || reservationId === undefined) return false
    try {
      await deliverEmployee(ctx, founder, employee, `${untrustedParticipantMessage(prepared.from, prepared.id, prepared.content)}\n\nHandle this direct message only; do not claim unrelated work.`, lifecycle.signal, execution)
      if (lifecycle.signal.aborted) return true
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
          message.attempts = undefined
          await io.writeMailbox(employee.id, messages)
        }
      })
      return true
    } catch (error) {
      if (lifecycle.signal.aborted) return true
      const isSessionGone = error instanceof SubagentError && error.code === 'NOT_RESUMABLE'
      const attempts = (prepared.attempts ?? 0) + (error instanceof CompanyExecutionDeferredError ? 0 : 1)
      const dead = isSessionGone || attempts >= MAX_DELIVERY_ATTEMPTS
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'message.delivery_failed',
        summary: `Queued message ${prepared.id} delivery failed (attempt ${attempts}/${MAX_DELIVERY_ATTEMPTS}${dead ? ', dead' : ''}): ${String(error)}`,
      }, async (state, io) => {
        releaseMoneyReservation(state, reservationId!)
        const messages = await io.readMailbox(employee.id)
        const message = messages.find((candidate) => candidate.id === prepared!.id)
        if (message !== undefined && message.reservationId === reservationId) {
          message.reservationId = undefined
          message.leaseAt = undefined
          message.attempts = attempts
          message.deliveryState = dead ? 'dead' : 'queued'
          await io.writeMailbox(employee.id, messages)
        }
      })
      if (isSessionGone) {
        await markEmployeeSessionFailed(cwd, employee, String(error))
        await steerSessionUnrecoverable(cwd, founder, employee.id, String(error))
      } else if (!dead) scheduleWakeup(cwd, DELIVERY_RETRY_MS)
      return true
    }
  }

  const dispatchOne = async (cwd: string, founder: Agent, employeeId: string): Promise<void> => {
    const visible = await readState(cwd)
    const visibleEmployee = visible?.employees.find((candidate) => candidate.id === employeeId)
    if (visible === undefined || visible.phase !== 'operating' || visibleEmployee?.status !== 'idle' || selectReadyWork(visible, employeeId) === undefined) return
    execution.check(visibleEmployee.sessionId!, cwd, activeSelection(visibleEmployee.llm).provider)
    let reservationId: string | undefined
    let previousAssignee: string | 'founder' | undefined
    const prepared = await store.transact(cwd, {
      actor: 'scheduler',
      type: 'work.dispatch_prepared',
      summary: `Prepared next ready work for ${employeeId}`,
    }, (state) => {
      if (state.phase !== 'operating') return undefined
      const employee = state.employees.find((candidate) => candidate.id === employeeId)
      if (employee === undefined || employee.status !== 'idle' || employee.operationalBlock !== undefined || employee.sessionId === undefined) return undefined
      const live = ctx.agents.get(SessionId(employee.sessionId))
      if (live !== undefined && live.status !== 'idle') return undefined
      const now = Date.now()
      const work = selectReadyWork(state, employeeId, now)
      if (work === undefined) return undefined
      previousAssignee = work.assigneeId
      const attemptId = beginWorkAttempt(state, work, employee.id, now)
      reservationId = reserveAuthorizedWorkTurn(state, employee, work, now)
      work.reservationId = reservationId
      work.leaseAt = now
      employee.status = 'working'
      return { work: structuredClone(work), employee: structuredClone(employee), attemptId }
    })
    if (prepared.result === undefined || reservationId === undefined) return
    const { work, employee, attemptId } = prepared.result
    try {
      const currentGovernance = await readState(cwd)
      await deliverEmployee(ctx, founder, employee, assignmentPrompt(currentGovernance ?? visible, work, attemptId), lifecycle.signal, execution)
      if (lifecycle.signal.aborted) return
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.dispatched',
        summary: `Work ${work.id} attempt ${work.attempt} accepted by ${employee.id}`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current?.attemptId !== attemptId || (current.reservationId !== undefined && current.reservationId !== reservationId)) throw new Error('work dispatch was superseded before acceptance commit')
        current.deliveryAttempts = (current.deliveryAttempts ?? 0) + 1
        if (current.reservationId === reservationId) {
          current.reservationId = undefined
          current.leaseAt = undefined
        }
      })
    } catch (error) {
      if (lifecycle.signal.aborted) return
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
        current.deliveryAttempts = 0
        current.attemptId = undefined
        current.reservationId = undefined
        current.leaseAt = undefined
        current.assigneeId = previousAssignee
        current.updatedAt = Date.now()
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === employee.sessionId)
        if (currentEmployee?.status === 'working') currentEmployee.status = state.phase === 'operating' ? 'idle' : 'paused'
      })
      if (error instanceof SubagentError && error.code === 'NOT_RESUMABLE') {
        await markEmployeeSessionFailed(cwd, employee, String(error))
        await steerSessionUnrecoverable(cwd, founder, employee.id, String(error))
      } else scheduleWakeup(cwd, error instanceof CompanyExecutionDeferredError ? error.retryAfterMs : DELIVERY_RETRY_MS)
      if (!(error instanceof CompanyExecutionDeferredError)) ctx.logger.warn(`dsh-company dispatch ${work.id} to ${employee.id} failed: ${String(error)}`)
    }
  }

  const recoverOpenAttempt = async (cwd: string, founder: Agent, employee: Employee, work: WorkItem): Promise<void> => {
    if (work.attemptId === undefined || employee.sessionId === undefined) return
    execution.check(employee.sessionId, cwd, activeSelection(employee.llm).provider)
    let reservationId: string | undefined
    const prepared = await store.transact(cwd, {
      actor: 'scheduler',
      type: 'work.recovery_checked',
      summary: `Checked cold recovery for ${work.id} attempt ${work.attempt}`,
    }, (state) => {
      const current = state.workItems.find((candidate) => candidate.id === work.id)
      const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id)
      if (state.phase !== 'operating' || current === undefined || current.attemptId !== work.attemptId || currentEmployee === undefined || currentEmployee.sessionId !== employee.sessionId || !['idle', 'working'].includes(currentEmployee.status) || currentEmployee.operationalBlock !== undefined) return 'superseded' as const
      const now = Date.now()
      if ((current.deliveryAttempts ?? 0) >= MAX_ATTEMPT_DELIVERIES) {
        releaseMoneyReservation(state, current.reservationId)
        const output = `Attempt stopped after ${MAX_ATTEMPT_DELIVERIES} accepted assignment prompts without a terminal company_update_work.`
        current.attemptHistory.push({ attempt: current.attempt, assigneeId: currentEmployee.id, status: 'failed', output, closedAt: now })
        current.status = 'failed'
        current.output = output
        current.attemptId = undefined
        current.reservationId = undefined
        current.leaseAt = undefined
        current.updatedAt = now
        currentEmployee.status = 'idle'
        return 'exhausted' as const
      }
      const blockers = workBlockedReasons(state, current, currentEmployee.id, now).filter((reason) => reason !== 'open_work_cap')
      if (blockers.length > 0) {
        releaseMoneyReservation(state, current.reservationId)
        current.status = 'pending'
        current.attempt = Math.max(0, current.attempt - 1)
        current.deliveryAttempts = 0
        current.attemptId = undefined
        current.reservationId = undefined
        current.leaseAt = undefined
        current.updatedAt = now
        currentEmployee.status = 'idle'
        return 'blocked' as const
      }
      reservationId = reserveAuthorizedWorkTurn(state, currentEmployee, current, now)
      current.reservationId = reservationId
      current.leaseAt = now
      currentEmployee.status = 'working'
      return 'ready' as const
    })
    if (prepared.result === 'exhausted') {
      try {
        founder.steer(createUserMessage({
          content: [{ type: 'text', text: `dsh-company work supervision alert (authoritative record). Work ${work.id} attempt ${work.attempt} stopped after ${MAX_ATTEMPT_DELIVERIES} accepted prompts without a terminal update. Review the employee transcript, then explicitly reassign or replace the work.` }],
          source: { kind: 'plugin', plugin: 'dsh-company' },
        }))
      } catch { /* best-effort */ }
      return
    }
    if (prepared.result !== 'ready' || reservationId === undefined) return
    try {
      const currentGovernance = await readState(cwd)
      await deliverEmployee(ctx, founder, employee, recoveryPrompt(currentGovernance ?? prepared.state, work), lifecycle.signal, execution)
      if (lifecycle.signal.aborted) return
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.recovered',
        summary: `Recovered ${work.id} attempt ${work.attempt} with the same capability`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current === undefined || current.attemptId !== work.attemptId || (current.reservationId !== undefined && current.reservationId !== reservationId)) throw new Error('recovery attempt was superseded')
        current.deliveryAttempts = (current.deliveryAttempts ?? 0) + 1
        if (current.reservationId === reservationId) {
          current.reservationId = undefined
          current.leaseAt = undefined
        }
      })
    } catch (error) {
      if (lifecycle.signal.aborted) return
      await store.transact(cwd, {
        actor: 'scheduler',
        type: 'work.recovery_failed',
        summary: `Cold recovery delivery failed for ${work.id}`,
      }, (state) => {
        const current = state.workItems.find((candidate) => candidate.id === work.id)
        if (current === undefined || current.attemptId !== work.attemptId || current.reservationId !== reservationId) return
        releaseMoneyReservation(state, reservationId)
        current.reservationId = undefined
        current.leaseAt = undefined
        const currentEmployee = state.employees.find((candidate) => candidate.id === employee.id && candidate.sessionId === employee.sessionId)
        if (currentEmployee?.status === 'working') currentEmployee.status = state.phase === 'operating' ? 'idle' : 'paused'
      })
      if (error instanceof SubagentError && error.code === 'NOT_RESUMABLE') {
        await markEmployeeSessionFailed(cwd, employee, String(error))
        await steerSessionUnrecoverable(cwd, founder, employee.id, String(error))
      } else scheduleWakeup(cwd, error instanceof CompanyExecutionDeferredError ? error.retryAfterMs : DELIVERY_RETRY_MS)
      if (!(error instanceof CompanyExecutionDeferredError)) ctx.logger.warn(`dsh-company cold recovery ${work.id} failed: ${String(error)}`)
    }
  }

  const syncEmployeeStatus = async (agent: Agent): Promise<void> => {
    if (disposed || lifecycle.signal.aborted) return
    const cwd = agent.session.header.cwd
    if (cwd === undefined) return
    const located = await readState(cwd)
    if (located === undefined || lifecycle.signal.aborted) return
    const employee = located.employees.find((candidate) => candidate.sessionId === String(agent.id) && candidate.status !== 'retired')
    if (employee === undefined) return
    const synced = await store.transact(cwd, {
      actor: 'scheduler',
      type: 'employee.activity',
      summary: `Synchronized employee ${employee.id} with current Host activity`,
    }, (state) => {
      if (lifecycle.signal.aborted || ctx.agents.get(agent.id) !== agent) return false
      const current = state.employees.find((candidate) => candidate.id === employee.id)
      if (state.id !== located.id || current === undefined || current.sessionId !== String(agent.id) || current.status === 'retired' || current.status === 'failed') return false
      // An earlier idle event can finish its I/O after this same Agent has
      // started another turn. Never clear that new turn's money reservation.
      const status = agent.status
      if (status === 'idle' && !hasEmployeeExecution(agent)) releaseEmployeeMoneyReservations(state, current.id)
      // The provisioning saga owns this status until it commits the approved
      // staffing request. A fast welcome turn must not skip that commit.
      if (current.status === 'provisioning') return status === 'idle' && !hasEmployeeExecution(agent)
      if (state.phase === 'paused' || state.phase === 'halted' || current.operationalBlock !== undefined) current.status = 'paused'
      else current.status = hasEmployeeExecution(agent) ? 'working' : 'idle'
      return status === 'idle' && !hasEmployeeExecution(agent)
    })
    if (synced.result) await enqueue(cwd)
  }

  ctx.on('agent/status', ({ agent }) => {
    void syncEmployeeStatus(agent).catch((error) => ctx.logger.warn(`dsh-company employee activity sync failed: ${String(error)}`))
  })

  const wakeForEmployee = async (agent: Agent): Promise<void> => {
    if (lifecycle.signal.aborted || agent.session.header.cwd === undefined) return
    const state = await store.readActive(agent.session.header.cwd)
    if (lifecycle.signal.aborted || state === undefined) return
    if (!state.employees.some((employee) => employee.sessionId === String(agent.id) && employee.status !== 'retired')) return
    await enqueue(agent.session.header.cwd)
  }
  for (const event of ['agent/created', 'agent/disposed'] as const) {
    ctx.on(event, ({ agent }) => {
      void wakeForEmployee(agent).catch((error) => ctx.logger.warn(`dsh-company employee lifecycle recovery failed: ${String(error)}`))
    })
  }

  return {
    kick: enqueue,
    defer,
    async dispose(): Promise<void> {
      if (!disposed) {
        disposed = true
        lifecycle.abort(new Error('dsh-company scheduler disposed'))
        for (const key of wakeups.keys()) clearWakeup(key)
        workspaceKeys.clear()
        cursors.clear()
        maintenanceCursors.clear()
        execution.dispose()
      }
      await Promise.allSettled([...queues.values()].map((pump) => pump.promise))
    },
  }
}

/** Supply only the assigned personnel facts; HR need not access private snapshots. */
function staffingAssessmentGuidance(state: CompanyState, request: StaffingRequest): string {
  const target = state.employees.find((employee) => employee.id === request.employeeId)
  const position = state.positions.find((candidate) => candidate.id === target?.positionId)
  const facts = {
    request_id: request.id,
    action: request.action,
    candidate_name: request.candidateName,
    employee_id: request.employeeId,
    work_profile: request.workProfile,
    constraints: request.constraints,
    ...(target === undefined ? {} : { current_employee: {
      id: target.id, name: target.name, role: target.role, org_unit_id: target.orgUnitId,
      position_title: position?.title,
      responsibilities: position?.responsibilities.slice(0, 16).map((item) => item.slice(0, 1024)),
      current_route: activeSelection(target.llm),
      monetary_authority: { currency: state.moneyBudget.currency, budget_micros: target.budgetMicros ?? 0, ...employeeMoneyTotals(state, target.id) },
    } }),
  }
  const contract = request.action === 'retire'
    ? 'Assess retirement difficulty, impact, and handoff rationale. The Host derives current staffing fields; omit provider/model, budget, org path, position, and responsibilities. No candidate comparison or replacement route is required for retirement.'
    : `Assess difficulty, provider/model, reasoning effort, monetary ceiling, multi-level org path, position, responsibilities, and any HR succession recommendation.\n${HR_ASSESSMENT_REMINDER}`
  return `Assigned personnel facts (data for this request, not approval or permission to expand your role):\n${JSON.stringify(facts)}\n\n${contract}\nSubmit through company_submit_staffing_assessment using the claimed attempt_id. You may cite Host-recorded rates and budget facts and propose an employee spending ceiling; never estimate actual token usage or monetary cost.`
}

function reserveEmployeeTurn(
  state: CompanyState,
  employee: Employee,
  subject: { workId?: string; messageId?: string; staffingRequestId?: string },
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
