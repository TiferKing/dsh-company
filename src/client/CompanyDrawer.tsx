import {
  useEffect,
  useId,
  useRef,
  useState,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from 'react'
import type { CompanyOverlayProps } from './contracts.js'
import type { CompanyTranslate } from './locales.js'
import type { CompanyPhase, SafeApprovalView } from './types.js'
import {
  ArchiveIcon,
  BuildingIcon,
  ChartIcon,
  CheckIcon,
  CloseIcon,
  LoadIcon,
  PackageIcon,
  PauseIcon,
  PlayIcon,
  RefreshIcon,
  ShieldIcon,
  TasksIcon,
  TrashIcon,
  TicketIcon,
  UsersIcon,
  WarningIcon,
} from './icons.js'
import {
  formatAbsolute,
  formatRelative,
  phaseLabel,
  phaseTone,
  StatusBadge,
  useCompanyState,
  useLocaleSnapshot,
} from './ui.js'
import { OverviewView } from './views/OverviewView.js'
import { OrganizationView } from './views/OrganizationView.js'
import { ProductsView } from './views/ProductsView.js'
import { WorkView } from './views/WorkView.js'
import { TicketsView } from './views/TicketsView.js'
import { RecruitingView } from './views/RecruitingView.js'
import { AuditView } from './views/AuditView.js'
import { ApprovalsView } from './views/ApprovalsView.js'

type CompanyTab = 'overview' | 'organization' | 'products' | 'work' | 'tickets' | 'recruiting' | 'audit' | 'approvals'

type Confirmation = {
  title: string
  body: string
  warning?: string
  confirmLabel: string
  variant: 'primary' | 'danger'
  run(): Promise<boolean>
}

const FOUNDER_AUTHORIZATION_PERMISSIONS = ['authorization.manage', 'employee.manage'] as const

const TABS: CompanyTab[] = ['overview', 'organization', 'products', 'work', 'tickets', 'recruiting', 'audit', 'approvals']

const TAB_ICONS: Record<CompanyTab, (props: { width?: string; height?: string }) => React.JSX.Element> = {
  overview: BuildingIcon,
  organization: LoadIcon,
  products: PackageIcon,
  work: TasksIcon,
  tickets: TicketIcon,
  recruiting: UsersIcon,
  audit: ChartIcon,
  approvals: ShieldIcon,
}
const FOCUSABLE = [
  'a[href]',
  'button:not([disabled])',
  'input:not([disabled])',
  'select:not([disabled])',
  'textarea:not([disabled])',
  '[tabindex]:not([tabindex="-1"])',
].join(',')

function focusableWithin(container: HTMLElement): HTMLElement[] {
  return [...container.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((element) =>
    element.getAttribute('aria-hidden') !== 'true' && element.offsetParent !== null,
  )
}

function hasFounderControl(role: 'founder' | 'employee'): boolean {
  return role === 'founder'
}

export function CompanyActions(props: {
  phase: CompanyPhase
  founder: boolean
  archived: boolean
  hasOperationalBlocks?: boolean
  archiveApprovalId?: string
  permissions: readonly string[]
  busy: boolean
  t: CompanyTranslate
  controller: CompanyOverlayProps['controller']
  ask(confirmation: Confirmation): void
}): React.JSX.Element | null {
  const {
    phase,
    founder,
    archived,
    hasOperationalBlocks = false,
    archiveApprovalId,
    permissions,
    busy,
    t,
    controller,
    ask,
  } = props
  if (!founder || archived) return null

  const can = (...accepted: string[]): boolean => permissions.some((permission) =>
    permission === '*' || accepted.includes(permission),
  )
  const confirm = (
    title: Parameters<CompanyTranslate>[0],
    body: Parameters<CompanyTranslate>[0],
    confirmLabel: Parameters<CompanyTranslate>[0],
    variant: Confirmation['variant'],
    run: Confirmation['run'],
  ): void => ask({ title: t(title), body: t(body), confirmLabel: t(confirmLabel), variant, run })

  if (phase === 'staged' || phase === 'provisioning_failed') {
    return (
      <div className="dsh-company-actionbar">
        <div className="dsh-company-actionbar__group">
          {can('bootstrap.approve') ? (
            <button
              type="button"
              className="dsh-company-action"
              data-variant="primary"
              disabled={busy}
              onClick={() => confirm(
                'confirm.approveStart.title',
                'confirm.approveStart.body',
                'action.approveStart',
                'primary',
                () => controller.performAction('approve_bootstrap', {
                  confirmation: t('action.statement.bootstrap'),
                }),
              )}
            >
              <CheckIcon width="15" height="15" />
              {busy ? t('action.working') : t('action.approveStart')}
            </button>
          ) : null}
          <button type="button" className="dsh-company-action" onClick={() => controller.close()}>
            {t('action.returnChat')}
          </button>
        </div>
        <div className="dsh-company-actionbar__group">
          {phase === 'staged' && can('company.archive') ? (
            <button
              type="button"
              className="dsh-company-action"
              data-variant="danger"
              disabled={busy}
              onClick={() => confirm(
                'confirm.discard.title',
                'confirm.discard.body',
                'action.discard',
                'danger',
                () => controller.performAction('discard_staged', {
                  reason: t('action.reason.discard'),
                }),
              )}
            >
              <TrashIcon width="15" height="15" />
              {t('action.discard')}
            </button>
          ) : null}
        </div>
      </div>
    )
  }

  const controls: React.ReactNode[] = []
  if (phase === 'operating' && can('company.pause')) {
    controls.push(
      <button
        type="button"
        className="dsh-company-action"
        disabled={busy}
        key="pause"
        onClick={() => confirm(
          'confirm.pause.title',
          'confirm.pause.body',
          'action.pause',
          'primary',
          () => controller.performAction('pause', { reason: t('action.reason.pause') }),
        )}
      >
        <PauseIcon width="15" height="15" />
        {t('action.pause')}
      </button>,
    )
  }
  if ((phase === 'paused' || phase === 'halted' || (phase === 'operating' && hasOperationalBlocks)) && can('company.resume')) {
    controls.push(
      <button
        type="button"
        className="dsh-company-action"
        data-variant="primary"
        disabled={busy}
        key="resume"
        onClick={() => confirm(
          'confirm.resume.title',
          'confirm.resume.body',
          'action.resume',
          'primary',
          () => controller.performAction('resume', { reason: t('action.reason.resume') }),
        )}
      >
        <PlayIcon width="15" height="15" />
        {t('action.resume')}
      </button>,
    )
  }
  if (
    (phase === 'operating' || phase === 'paused' || phase === 'halted') &&
    can('company.archive')
  ) {
    controls.push(
      <button
        type="button"
        className="dsh-company-action"
        data-variant="danger"
        disabled={busy}
        key="archive"
        onClick={() => confirm(
          'confirm.archive.title',
          'confirm.archive.body',
          'action.archive',
          'danger',
          () => controller.performAction('archive', {
            reason: t('action.reason.archive'),
            ...(archiveApprovalId === undefined ? {} : { approval_id: archiveApprovalId }),
          }),
        )}
      >
        <ArchiveIcon width="15" height="15" />
        {t('action.archive')}
      </button>,
    )
  }

  return controls.length === 0 ? null : (
    <div className="dsh-company-actionbar">
      <div className="dsh-company-actionbar__group">{controls}</div>
      <button type="button" className="dsh-company-action" onClick={() => controller.close()}>
        {t('action.returnChat')}
      </button>
    </div>
  )
}

function ConfirmDialog(props: {
  confirmation: Confirmation
  busy: boolean
  t: CompanyTranslate
  dialogRef: React.RefObject<HTMLDivElement>
  cancelRef: React.RefObject<HTMLButtonElement>
  onCancel(): void
  onConfirm(): void
}): React.JSX.Element {
  const titleId = useId()
  const bodyId = useId()
  return (
    <div className="dsh-company-confirm-layer">
      <div
        className="dsh-company-confirm"
        role="alertdialog"
        aria-modal="true"
        aria-labelledby={titleId}
        aria-describedby={bodyId}
        ref={props.dialogRef}
      >
        <h2 className="dsh-company-confirm__title" id={titleId}>{props.confirmation.title}</h2>
        <p className="dsh-company-confirm__body" id={bodyId}>{props.confirmation.body}</p>
        {props.confirmation.warning !== undefined ? (
          <p className="dsh-company-confirm__warning">
            <WarningIcon width="15" height="15" /> {props.confirmation.warning}
          </p>
        ) : null}
        <div className="dsh-company-confirm__actions">
          <button
            type="button"
            className="dsh-company-action"
            disabled={props.busy}
            ref={props.cancelRef}
            onClick={props.onCancel}
          >
            {props.t('confirm.cancel')}
          </button>
          <button
            type="button"
            className="dsh-company-action"
            data-variant={props.confirmation.variant}
            disabled={props.busy}
            onClick={props.onConfirm}
          >
            {props.busy ? props.t('action.working') : props.confirmation.confirmLabel}
          </button>
        </div>
      </div>
    </div>
  )
}

/** Root-scoped responsive company activity panel. */
export function CompanyDrawer({
  useSessions,
  controller,
  locale,
  navigateToSession,
  t,
}: CompanyOverlayProps): React.JSX.Element | null {
  const currentSessionId = useSessions((sessions) => sessions.current)
  const state = useCompanyState(controller)
  const localeState = useLocaleSnapshot(locale)
  const [activeTab, setActiveTab] = useState<CompanyTab>('overview')
  const [confirmation, setConfirmation] = useState<Confirmation>()
  const [confirming, setConfirming] = useState(false)
  const drawerRef = useRef<HTMLDivElement>(null)
  const confirmRef = useRef<HTMLDivElement>(null)
  const cancelRef = useRef<HTMLButtonElement>(null)
  const closeRef = useRef<HTMLButtonElement>(null)
  const tabsRef = useRef<HTMLDivElement>(null)
  const titleId = useId()
  const panelId = useId()

  useEffect(() => {
    controller.setCurrentSession(currentSessionId)
  }, [controller, currentSessionId])

  useEffect(() => {
    setActiveTab('overview')
    setConfirmation(undefined)
    setConfirming(false)
  }, [state.sessionId, state.snapshot?.company.id])

  useEffect(() => {
    if (!state.open) return
    const frame = window.requestAnimationFrame(() => closeRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [state.open])

  useEffect(() => {
    if (confirmation === undefined) return
    const frame = window.requestAnimationFrame(() => cancelRef.current?.focus())
    return () => window.cancelAnimationFrame(frame)
  }, [confirmation])

  if (!state.open || state.sessionId !== currentSessionId) return null

  const snapshot = state.snapshot
  const pendingCount = snapshot?.approvals.filter((approval) => approval.status === 'pending').length ?? 0
  const ticketPendingCount = snapshot?.tickets.filter((ticket) => ['filed', 'triaged', 'resolved'].includes(ticket.status)).length ?? 0
  const archiveApprovalId = snapshot?.approvals.find((approval) =>
    approval.kind === 'forced_archive' && approval.status === 'approved',
  )?.id
  const busy = state.action !== undefined || confirming
  const canManageAuthorization = snapshot?.viewer.role === 'founder' && !state.archived
    && snapshot?.viewer.permissions.some((permission) => permission === '*' || FOUNDER_AUTHORIZATION_PERMISSIONS.includes(permission as (typeof FOUNDER_AUTHORIZATION_PERMISSIONS)[number]))

  const onOverlayMouseDown = (event: ReactMouseEvent<HTMLDivElement>): void => {
    if (event.currentTarget === event.target && confirmation === undefined) controller.close()
  }

  const onKeyDown = (event: ReactKeyboardEvent<HTMLDivElement>): void => {
    if (event.key === 'Escape') {
      event.preventDefault()
      if (confirmation !== undefined && !busy) setConfirmation(undefined)
      else {
        setConfirmation(undefined)
        controller.close()
      }
      return
    }
    if (event.key !== 'Tab') return
    const container = confirmation === undefined ? drawerRef.current : confirmRef.current
    if (container === null) return
    const focusable = focusableWithin(container)
    if (focusable.length === 0) {
      event.preventDefault()
      container.focus()
      return
    }
    const first = focusable[0]
    const last = focusable.at(-1)
    if (event.shiftKey && document.activeElement === first) {
      event.preventDefault()
      last?.focus()
    } else if (!event.shiftKey && document.activeElement === last) {
      event.preventDefault()
      first?.focus()
    }
  }

  const onTabKeyDown = (event: ReactKeyboardEvent<HTMLButtonElement>, tab: CompanyTab): void => {
    const index = TABS.indexOf(tab)
    let next: number | undefined
    if (event.key === 'ArrowRight') next = (index + 1) % TABS.length
    else if (event.key === 'ArrowLeft') next = (index - 1 + TABS.length) % TABS.length
    else if (event.key === 'Home') next = 0
    else if (event.key === 'End') next = TABS.length - 1
    if (next === undefined) return
    event.preventDefault()
    const nextTab = TABS[next]
    if (nextTab === undefined) return
    setActiveTab(nextTab)
    tabsRef.current?.querySelectorAll<HTMLButtonElement>('[role="tab"]')[next]?.focus()
  }

  const decideApproval = (approval: SafeApprovalView, decision: 'approved' | 'rejected'): void => {
    const approved = decision === 'approved'
    setConfirmation({
      title: t(approved ? 'confirm.approvalApprove.title' : 'confirm.approvalReject.title'),
      body: t(approved ? 'confirm.approvalApprove.body' : 'confirm.approvalReject.body'),
      ...(approval.risk === 'high' ? { warning: t('confirm.highRisk') } : {}),
      confirmLabel: t(approved ? 'approvals.approve' : 'approvals.reject'),
      variant: approved ? 'primary' : 'danger',
      run: () => controller.performAction('resolve_approval', {
        approval_id: approval.id,
        decision,
        human_statement: t(approved ? 'action.statement.approve' : 'action.statement.reject'),
      }),
    })
  }

  const requestGrantAuthorization = (employeeName: string, payload: Record<string, unknown>): void => {
    const requestedDuration = typeof payload.expires_at === 'number' ? Math.max(1, payload.expires_at - Date.now()) : 0
    setConfirmation({
      title: t('authorization.grant'),
      body: `${t('authorization.confirmGrant', { name: employeeName })}\n\n${t('authorization.fixedScopes')}: ${t('authorization.scopeBudget')}; ${t('authorization.scopeInternalApprovals')}.\n\n${t('authorization.boundaryTitle')}: ${t('authorization.boundary')}`,
      warning: t('authorization.unknownCostBoundary'),
      confirmLabel: t('authorization.grant'),
      variant: 'primary',
      run: async () => {
        const succeeded = await controller.performAction('grant_temporary_authorization', {
          ...payload,
          expires_at: Date.now() + requestedDuration,
        })
        if (succeeded) setActiveTab('approvals')
        return succeeded
      },
    })
  }

  const requestRevokeAuthorization = (employeeName: string, authorizationId: string, reason: string): void => {
    setConfirmation({
      title: t('authorization.revoke'),
      body: `${t('authorization.confirmRevoke')}\n${employeeName} · ${authorizationId}`,
      confirmLabel: t('authorization.revoke'),
      variant: 'danger',
      run: async () => {
        const succeeded = await controller.performAction('revoke_temporary_authorization', {
          authorization_id: authorizationId,
          reason,
        })
        if (succeeded) setActiveTab('approvals')
        return succeeded
      },
    })
  }

  const runConfirmation = async (): Promise<void> => {
    if (confirmation === undefined || confirming) return
    setConfirming(true)
    try {
      const succeeded = await confirmation.run()
      if (succeeded) setConfirmation(undefined)
    } finally {
      setConfirming(false)
    }
  }

  const view = snapshot === undefined ? null : (() => {
    switch (activeTab) {
      case 'overview':
        return <OverviewView
          snapshot={snapshot}
          t={t}
          locale={localeState.active}
          canEditFormation={!state.archived && snapshot.viewer.role === 'founder' && (snapshot.company.phase === 'staged' || snapshot.company.phase === 'provisioning_failed')}
          canRequestGovernance={!state.archived && snapshot.viewer.role === 'founder' && snapshot.company.formation_status === 'approved'}
          canReprobe={!state.archived && snapshot.viewer.role === 'founder'}
          busy={busy}
          onEditFormation={(payload, expectedRevision) => controller.performAction('edit_formation', payload, expectedRevision)}
          onRequestGovernance={(payload, expectedRevision) => controller.performAction('request_governance_change', payload, expectedRevision)}
          onReprobe={() => controller.performAction('reprobe_models', {})}
          onOpenApprovals={() => setActiveTab('approvals')}
        />
      case 'organization':
        return <OrganizationView
          snapshot={snapshot}
          t={t}
          locale={localeState.active}
          busy={busy}
          canManageAuthorization={canManageAuthorization}
          navigateToSession={navigateToSession}
          onGrantAuthorization={requestGrantAuthorization}
          onRevokeAuthorization={requestRevokeAuthorization}
        />
      case 'products':
        return <ProductsView snapshot={snapshot} t={t} locale={localeState.active} />
      case 'work':
        return <WorkView snapshot={snapshot} t={t} />
      case 'tickets':
        return (
          <TicketsView
            snapshot={snapshot}
            t={t}
            locale={localeState.active}
            busy={busy}
            canFile={!state.archived && snapshot.viewer.role === 'founder' && snapshot.company.phase === 'operating'}
            onFileTicket={(payload) => controller.performAction('file_ticket', payload)}
          />
        )
      case 'recruiting':
        return <RecruitingView
          snapshot={snapshot}
          t={t}
          locale={localeState.active}
          busy={busy}
          canManage={!state.archived && snapshot.viewer.role === 'founder'}
          onRequestModelPrices={(payload, expectedRevision) => controller.performAction('request_budget_change', payload, expectedRevision)}
          onReprobe={() => controller.performAction('reprobe_models', {})}
          onOpenApprovals={() => setActiveTab('approvals')}
        />
      case 'audit':
        return <AuditView
          snapshot={snapshot}
          t={t}
          locale={localeState.active}
          busy={busy}
          canManageBudget={!state.archived && snapshot.viewer.role === 'founder'}
          onRequestBudgetChange={(payload, expectedRevision) => controller.performAction('request_budget_change', payload, expectedRevision)}
          onOpenApprovals={() => setActiveTab('approvals')}
        />
      case 'approvals':
        return (
          <ApprovalsView
            snapshot={snapshot}
            t={t}
            locale={localeState.active}
            busy={busy}
            onDecision={decideApproval}
          />
        )
    }
  })()

  return (
    <div
      className="dsh-company-overlay"
      onMouseDown={onOverlayMouseDown}
      onKeyDown={onKeyDown}
    >
      <div
        className="dsh-company-drawer"
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        ref={drawerRef}
        tabIndex={-1}
      >
        <header className="dsh-company-drawer__header">
          <div className="dsh-company-drawer__identity">
            <p className="dsh-company-drawer__eyebrow"><BuildingIcon />{t('drawer.eyebrow')}</p>
            <div className="dsh-company-drawer__title-row">
              <h1 className="dsh-company-drawer__title" id={titleId}>
                {snapshot?.company.name ?? t('drawer.loading')}
              </h1>
              {snapshot !== undefined ? (
                <StatusBadge tone={phaseTone(snapshot.company.phase)}>
                  {phaseLabel(snapshot.company.phase, t)}
                </StatusBadge>
              ) : null}
              {state.archived ? <StatusBadge tone="neutral">{t('drawer.archived')}</StatusBadge> : null}
            </div>
            {snapshot !== undefined ? (
              <div className="dsh-company-drawer__meta">
                <span title={formatAbsolute(snapshot.company.updated_at, localeState.active)}>
                  {t('drawer.updated', { time: formatRelative(snapshot.company.updated_at, t) })}
                </span>
                <span>{t('drawer.revision', { revision: snapshot.revision })}</span>
                <span>{snapshot.viewer.role === 'founder' ? t('organization.founder') : snapshot.viewer.participant_id}</span>
              </div>
            ) : null}
          </div>
          <div className="dsh-company-drawer__header-actions">
            <button
              type="button"
              className="dsh-company-icon-button"
              aria-label={t('drawer.refresh')}
              title={t('drawer.refresh')}
              disabled={state.loading || busy}
              onClick={() => void controller.refresh('manual')}
            >
              <RefreshIcon className={state.loading ? 'dsh-company-spin' : undefined} />
            </button>
            <button
              type="button"
              className="dsh-company-icon-button"
              aria-label={t('drawer.close')}
              title={t('drawer.close')}
              ref={closeRef}
              onClick={() => controller.close()}
            >
              <CloseIcon />
            </button>
          </div>

          {snapshot !== undefined ? (
            <div className="dsh-company-tabs" role="tablist" aria-label={t('tabs.aria')} ref={tabsRef}>
              {TABS.map((tab) => {
                const TabIcon = TAB_ICONS[tab]
                return (
                  <button
                    type="button"
                    className="dsh-company-tab"
                    role="tab"
                    id={`${panelId}-${tab}-tab`}
                    aria-controls={panelId}
                    aria-selected={activeTab === tab}
                    tabIndex={activeTab === tab ? 0 : -1}
                    key={tab}
                    onClick={() => setActiveTab(tab)}
                    onKeyDown={(event) => onTabKeyDown(event, tab)}
                  >
                    <TabIcon />
                    {t(`tab.${tab}`)}
                    {tab === 'approvals' && pendingCount > 0 ? (
                      <span className="dsh-company-tab__count">{pendingCount}</span>
                    ) : null}
                    {tab === 'tickets' && ticketPendingCount > 0 ? (
                      <span className="dsh-company-tab__count">{ticketPendingCount}</span>
                    ) : null}
                  </button>
                )
              })}
            </div>
          ) : null}
        </header>

        <div className="dsh-company-banner-stack" aria-live="polite">
          {state.stale ? (
            <div className="dsh-company-banner" role="status">{t('drawer.stale')}</div>
          ) : null}
          {state.networkError !== undefined ? (
            <div className="dsh-company-banner" data-tone="error" role="alert">
              {t('drawer.networkError', { message: state.networkError })}
            </div>
          ) : null}
          {state.actionError !== undefined ? (
            <div className="dsh-company-banner" data-tone="error" role="alert">
              {t('drawer.actionError', { message: state.actionError })}
            </div>
          ) : null}
        </div>

        {snapshot !== undefined ? (
          <CompanyActions
            phase={snapshot.company.phase}
            founder={hasFounderControl(snapshot.viewer.role)}
            archived={state.archived}
            hasOperationalBlocks={snapshot.employees.some((employee) => employee.operational_block !== undefined)}
            {...(archiveApprovalId === undefined ? {} : { archiveApprovalId })}
            permissions={snapshot.viewer.permissions}
            busy={busy}
            t={t}
            controller={controller}
            ask={setConfirmation}
          />
        ) : null}

        <main
          className="dsh-company-drawer__body"
          role={snapshot === undefined ? undefined : 'tabpanel'}
          id={panelId}
          aria-labelledby={snapshot === undefined ? undefined : `${panelId}-${activeTab}-tab`}
          tabIndex={snapshot === undefined ? undefined : 0}
        >
          {snapshot === undefined ? (
            state.loading ? (
              <div className="dsh-company-loading" role="status">
                <div className="dsh-company-loading__inner">
                  <span className="dsh-company-loading__mark" />
                  <span>{t('drawer.loading')}</span>
                </div>
              </div>
            ) : (
              <div className="dsh-company-no-company">{t('drawer.empty')}</div>
            )
          ) : view}
        </main>

        {confirmation !== undefined ? (
          <ConfirmDialog
            confirmation={confirmation}
            busy={confirming || state.action !== undefined}
            t={t}
            dialogRef={confirmRef}
            cancelRef={cancelRef}
            onCancel={() => setConfirmation(undefined)}
            onConfirm={() => void runConfirmation()}
          />
        ) : null}
      </div>
    </div>
  )
}
