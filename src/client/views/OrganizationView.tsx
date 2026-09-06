import { useEffect, useId, useMemo, useState } from 'react'
import type { CompanyTranslate } from '../locales.js'
import type {
  CompanySnapshot,
  SafeEmployeeView,
  SafeOrgUnitView,
  SafePositionView,
  SafeTemporaryAuthorizationView,
} from '../types.js'
import { BuildingIcon, ChevronIcon, ExternalIcon, InfoIcon, LoadIcon, ShieldIcon, TasksIcon, UsersIcon, WarningIcon } from '../icons.js'
import { departmentLoadPresentation } from '../load.js'
import {
  employeeStatusLabel,
  employeeTone,
  formatAbsolute,
  formatDecimal,
  formatMoneyMicros,
  formatRelative,
  initials,
  StatusBadge,
} from '../ui.js'

export interface OrganizationViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  busy?: boolean
  canManageAuthorization?: boolean
  navigateToSession(targetSessionId: string, founderSessionId?: string): Promise<void>
  onGrantAuthorization?(employeeName: string, payload: Record<string, unknown>): void
  onRevokeAuthorization?(employeeName: string, authorizationId: string, reason: string): void
  /** Start with every org unit expanded (tests / future preference). Defaults to collapsed. */
  initialExpanded?: boolean
  /** Start with this unit's detail statistics panel open (tests / future preference). */
  initialDetailUnitId?: string
}

const OPEN_STATUSES = new Set(['pending', 'claimed', 'in_progress'])
const EXPIRY_PRESETS = [15 * 60_000, 60 * 60_000, 4 * 60 * 60_000, 24 * 60 * 60_000] as const
const ROUTE_COLORS = ['#3964fe', '#7c5cff', '#138a58', '#c57900', '#d83b46', '#1887a8'] as const

function DetailCard(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return <section className="dsh-company-detail-card"><h5 className="dsh-company-detail-card__label">{props.label}</h5><div className="dsh-company-detail-card__body">{props.children}</div></section>
}

function authorizationStatusLabel(status: SafeTemporaryAuthorizationView['status'], t: CompanyTranslate): string {
  switch (status) {
    case 'scheduled': return t('authorization.scheduled')
    case 'active': return t('authorization.active')
    case 'expired': return t('authorization.expired')
    case 'revoked': return t('authorization.revoked')
  }
}

function authorizationTone(status: SafeTemporaryAuthorizationView['status']): 'success' | 'warning' | 'neutral' | 'active' {
  switch (status) {
    case 'active': return 'success'
    case 'scheduled': return 'active'
    case 'expired': return 'warning'
    case 'revoked': return 'neutral'
  }
}

function AuthorizationPanel(props: {
  employee: SafeEmployeeView
  authorizations: SafeTemporaryAuthorizationView[]
  currency: string
  locale: 'zh' | 'en'
  t: CompanyTranslate
  busy: boolean
  canManage: boolean
  onGrant?(employeeName: string, payload: Record<string, unknown>): void
  onRevoke?(employeeName: string, authorizationId: string, reason: string): void
}): React.JSX.Element {
  const { employee, t, locale } = props
  const formId = `${useId()}-authorization-form`
  const errorId = `${formId}-error`
  const orderedAuthorizations = [...props.authorizations].sort((left, right) => right.created_at - left.created_at)
  const liveAuthorization = orderedAuthorizations.find((item) => item.status === 'active' || item.status === 'scheduled')
  const statusAuthorization = liveAuthorization ?? orderedAuthorizations[0]
  const live = liveAuthorization !== undefined
  const [showGrant, setShowGrant] = useState(false)
  const [reason, setReason] = useState('')
  const [expiryMs, setExpiryMs] = useState<number>(60 * 60_000)
  const [formError, setFormError] = useState<string>()

  const submit = (): void => {
    if (reason.trim() === '') {
      setFormError(t('authorization.reasonPlaceholder'))
      return
    }
    setFormError(undefined)
    props.onGrant?.(employee.name, {
      employee_id: employee.id,
      reason: reason.trim(),
      expires_at: Date.now() + expiryMs,
    })
  }

  return (
    <section className="dsh-company-auth">
      <div className="dsh-company-auth__head">
        <span className="dsh-company-auth__title"><ShieldIcon width="15" height="15" />{t('organization.authorization')}</span>
        {statusAuthorization === undefined ? <StatusBadge tone="neutral">{t('authorization.none')}</StatusBadge> : <StatusBadge tone={authorizationTone(statusAuthorization.status)}>{authorizationStatusLabel(statusAuthorization.status, t)}</StatusBadge>}
      </div>
      <div className="dsh-company-chip-list" aria-label={t('authorization.fixedScopes')}>
        <span className="dsh-company-chip" data-tone="active">{t('authorization.scopeBudget')}</span>
        <span className="dsh-company-chip" data-tone="active">{t('authorization.scopeInternalApprovals')}</span>
      </div>
      {orderedAuthorizations.length === 0 ? null : (
        <div className="dsh-company-auth-history">
          {orderedAuthorizations.map((authorization) => {
            const revocable = authorization.status === 'active' || authorization.status === 'scheduled'
            return (
              <article className="dsh-company-detail-stack" key={authorization.id}>
                <div className="dsh-company-auth__head">
                  <span className="dsh-company-route">{t('authorization.auditRef', { id: authorization.id })}</span>
                  <StatusBadge tone={authorizationTone(authorization.status)}>{authorizationStatusLabel(authorization.status, t)}</StatusBadge>
                </div>
                <DetailCard label={t('authorization.reason')}>{authorization.reason}</DetailCard>
                <DetailCard label={t('authorization.expiry')}><time dateTime={new Date(authorization.expires_at).toISOString()} title={formatAbsolute(authorization.expires_at, locale)}>{formatAbsolute(authorization.expires_at, locale)}</time></DetailCard>
                <DetailCard label={t('authorization.uses')}>{authorization.uses.length === 0 ? t('authorization.noUses') : authorization.uses.map((use) => `${use.id} · ${t('authorization.work')}: ${use.work_id}${use.approval_ids.length === 0 ? '' : ` · ${t('authorization.approvals')}: ${use.approval_ids.join(', ')}`}${use.amount_micros === undefined || use.unknown_cost ? '' : ` · ${formatMoneyMicros(use.amount_micros, props.currency, locale)}`}${use.unknown_cost ? ` · ${t('audit.unknownCost')}` : ''}`).join('\n')}</DetailCard>
                {props.canManage && revocable && props.onRevoke !== undefined ? <div className="dsh-company-inline-actions"><button type="button" className="dsh-company-action" data-variant="danger" disabled={props.busy} onClick={() => props.onRevoke?.(employee.name, authorization.id, t('authorization.revokeReason'))}>{t('authorization.revoke')}</button></div> : null}
              </article>
            )
          })}
        </div>
      )}
      <p className="dsh-company-auth__boundary"><strong>{t('authorization.boundaryTitle')}.</strong> {t('authorization.boundary')}</p>
      <p className="dsh-company-auth__boundary"><WarningIcon width="14" height="14" /> {t('authorization.unknownCostBoundary')}</p>
      {props.canManage && !live && props.onGrant !== undefined ? (
        <>
          <div className="dsh-company-inline-actions"><button type="button" className="dsh-company-action" disabled={props.busy} aria-expanded={showGrant} aria-controls={showGrant ? formId : undefined} onClick={() => setShowGrant((value) => !value)}>{t('authorization.grant')}</button></div>
          {showGrant ? (
            <div className="dsh-company-auth-form" id={formId}>
              <label><span>{t('authorization.reason')}</span><textarea rows={3} value={reason} placeholder={t('authorization.reasonPlaceholder')} aria-invalid={formError !== undefined || undefined} aria-describedby={formError === undefined ? undefined : errorId} onChange={(event) => { setReason(event.currentTarget.value); if (formError !== undefined) setFormError(undefined) }} /></label>
              <label><span>{t('authorization.expiry')}</span><select value={expiryMs} onChange={(event) => setExpiryMs(Number(event.currentTarget.value))}>{EXPIRY_PRESETS.map((value, index) => <option value={value} key={value}>{t(index === 0 ? 'authorization.expiryPreset.15m' : index === 1 ? 'authorization.expiryPreset.1h' : index === 2 ? 'authorization.expiryPreset.4h' : 'authorization.expiryPreset.24h')}</option>)}</select></label>
              {formError === undefined ? null : <div className="dsh-company-banner" id={errorId} data-tone="error" role="alert"><WarningIcon width="14" height="14" />{formError}</div>}
              <div className="dsh-company-inline-actions"><button type="button" className="dsh-company-action" data-variant="primary" disabled={props.busy} onClick={submit}>{t('authorization.grant')}</button></div>
            </div>
          ) : null}
        </>
      ) : null}
    </section>
  )
}

/** One employee row: avatar + identity on the left, status/route/budget on the right, info button toggles the detail body. */
function EmployeeRow(props: {
  employee: SafeEmployeeView
  snapshot: CompanySnapshot
  position: SafePositionView | undefined
  open: boolean
  busy: boolean
  canManageAuthorization: boolean
  t: CompanyTranslate
  locale: 'zh' | 'en'
  onToggle(): void
  navigateToSession(targetSessionId: string, founderSessionId?: string): Promise<void>
  onNavigationError(message: string): void
  onGrantAuthorization?(employeeName: string, payload: Record<string, unknown>): void
  onRevokeAuthorization?(employeeName: string, authorizationId: string, reason: string): void
}): React.JSX.Element {
  const { employee, snapshot, t, locale } = props
  const id = useId()
  const bodyId = `${id}-employee-body`
  const assignedWork = snapshot.work.filter((item) => item.assignee_id === employee.id && OPEN_STATUSES.has(item.status))
  const authorizations = snapshot.temporary_authorizations.filter((item) => item.employee_id === employee.id)
  const activity = employee.status === 'idle' || employee.status === 'working' ? employee.activity?.state : undefined
  const statusLabel = activity === undefined ? employeeStatusLabel(employee.status, t) : t(`activity.${activity}`)
  const statusTone = activity === undefined ? employeeTone(employee.status)
    : activity === 'running' ? 'active' : activity === 'idle' ? 'success' : activity === 'unavailable' ? 'warning' : 'neutral'
  const route = employee.llm
  const lifecycle = [
    employee.joined_at === undefined ? undefined : `${t('organization.joined')}: ${formatAbsolute(employee.joined_at, locale)}`,
    employee.retired_at === undefined ? undefined : `${t('organization.retiredAt')}: ${formatAbsolute(employee.retired_at, locale)}`,
  ].filter((value): value is string => value !== undefined).join('\n')
  const usageCost = employee.token_usage === undefined
    ? undefined
    : employee.token_usage.unpriced_calls === 0
      ? formatMoneyMicros(employee.token_usage.cost_micros, snapshot.budget.currency, locale)
      : employee.token_usage.priced_calls === 0
        ? t('audit.unknownCost')
        : `${t('audit.knownSubtotal')}: ${formatMoneyMicros(employee.token_usage.cost_micros, snapshot.budget.currency, locale)} + ${t('audit.unknownCost')}`
  const openSession = async (): Promise<void> => {
    if (employee.session_id === undefined) return
    try { await props.navigateToSession(employee.session_id, snapshot.company.founder_session_id) }
    catch (error) { props.onNavigationError(error instanceof Error ? error.message : String(error)) }
  }
  return (
    <article className="dsh-company-employee-row" data-open={props.open || undefined}>
      <div className="dsh-company-employee-row__head">
        <div className="dsh-company-employee-row__identity">
          <span className="dsh-company-avatar" aria-hidden="true">{initials(employee.name)}</span>
          <span className="dsh-company-employee-row__fields">
            <span className="dsh-company-employee-row__name">{employee.name}{employee.is_hr ? ' · HR' : ''}</span>
            <span className="dsh-company-employee-row__role">{employee.role}</span>
            <span className="dsh-company-employee-row__department">{employee.department ?? props.position?.title ?? t('organization.unassigned')} · {assignedWork.length} {t('organization.openMetric')}</span>
          </span>
        </div>
        <span className="dsh-company-employee-row__meta">
          <StatusBadge tone={statusTone}>{statusLabel}</StatusBadge>
          <span className="dsh-company-employee-row__route">{route === undefined ? t('common.unknown') : `${route.provider}/${route.model}`}</span>
          <span className="dsh-company-employee-row__budget">{formatMoneyMicros(employee.budget_micros, snapshot.budget.currency, locale)}</span>
          {(employee.token_usage?.unpriced_calls ?? 0) > 0 ? <span className="dsh-company-chip" data-tone="warning">{employee.token_usage?.priced_calls === 0 ? t('audit.unknownCost') : t('audit.knownSubtotal')}</span> : null}
        </span>
        <button type="button" className="dsh-company-employee-row__info" aria-expanded={props.open} aria-controls={props.open ? bodyId : undefined} aria-label={t('organization.employeeDetails')} title={t('organization.employeeDetails')} onClick={props.onToggle}>
          <InfoIcon />
        </button>
      </div>
      {props.open ? (
        <div className="dsh-company-employee-row__body" id={bodyId}>
          <div className="dsh-company-detail-stack">
            <DetailCard label={t('organization.currentWork')}>{assignedWork.length === 0 ? t('organization.noOpenWork') : assignedWork.map((item) => `${item.id} · ${item.subject} · ${item.status}`).join('\n')}</DetailCard>
            <DetailCard label={t('organization.responsibilities')}>{props.position?.responsibilities.length ? props.position.responsibilities.join('\n') : t('organization.noResponsibilities')}</DetailCard>
            {lifecycle === '' ? null : <DetailCard label={t('organization.lifecycle')}>{lifecycle}</DetailCard>}
            <DetailCard label={t('organization.modelRoute')}>{route === undefined ? t('common.unknown') : `${route.provider}/${route.model}${route.reasoning_effort === undefined ? '' : ` · ${route.reasoning_effort}`}${route.fallback === undefined ? '' : `\n${t('organization.fallback', route.fallback)}`}`}</DetailCard>
            <DetailCard label={t('organization.moneyAnalytics')}>{`${t('audit.companyBudget')}: ${formatMoneyMicros(employee.budget_micros, snapshot.budget.currency, locale)}\n${t('audit.spent')}: ${formatMoneyMicros(employee.spent_micros, snapshot.budget.currency, locale)} · ${t('audit.reserved')}: ${formatMoneyMicros(employee.reserved_micros, snapshot.budget.currency, locale)} · ${t('audit.available')}: ${formatMoneyMicros(employee.available_micros, snapshot.budget.currency, locale)}${employee.token_usage === undefined ? '' : `\n${employee.token_usage.total.toLocaleString(locale)} tokens · ${usageCost}`}`}</DetailCard>
            {employee.operational_block === undefined && employee.failure === undefined ? null : <DetailCard label={t('overview.blocked')}>{employee.operational_block?.message ?? employee.failure}</DetailCard>}
          </div>
          <AuthorizationPanel employee={employee} authorizations={authorizations} currency={snapshot.budget.currency} locale={locale} t={t} busy={props.busy} canManage={props.canManageAuthorization} onGrant={props.onGrantAuthorization} onRevoke={props.onRevokeAuthorization} />
          {employee.session_id === undefined ? null : <div className="dsh-company-inline-actions"><button type="button" className="dsh-company-action" onClick={() => void openSession()}><ExternalIcon width="14" height="14" />{t('organization.openSession', { name: employee.name })}</button></div>}
        </div>
      ) : null}
    </article>
  )
}

/** One org row: the chevron area expands the unit's people and child units, the right-side info button toggles the detail statistics panel. */
function OrgNode(props: {
  unit: SafeOrgUnitView
  level: number
  snapshot: CompanySnapshot
  childrenByParent: Map<string, SafeOrgUnitView[]>
  positionsByUnit: Map<string, SafePositionView[]>
  employeesByUnit: Map<string, SafeEmployeeView[]>
  expandedUnits: Set<string>
  detailUnits: Set<string>
  openEmployeeIds: Set<string>
  busy: boolean
  canManageAuthorization: boolean
  t: CompanyTranslate
  locale: 'zh' | 'en'
  onToggleUnit(id: string): void
  onToggleDetail(id: string): void
  onToggleEmployee(id: string): void
  navigateToSession(targetSessionId: string, founderSessionId?: string): Promise<void>
  onNavigationError(message: string): void
  onGrantAuthorization?(employeeName: string, payload: Record<string, unknown>): void
  onRevokeAuthorization?(employeeName: string, authorizationId: string, reason: string): void
}): React.JSX.Element {
  const { unit, snapshot, t, locale } = props
  const treeOpen = props.expandedUnits.has(unit.id)
  const detailOpen = props.detailUnits.has(unit.id)
  const childUnits = props.childrenByParent.get(unit.id) ?? []
  const positions = props.positionsByUnit.get(unit.id) ?? []
  const directEmployees = (props.employeesByUnit.get(unit.id) ?? []).filter((employee) => employee.status !== 'retired')
  const subtreeUnitIds = new Set<string>()
  const collect = (id: string): void => { if (subtreeUnitIds.has(id)) return; subtreeUnitIds.add(id); for (const child of props.childrenByParent.get(id) ?? []) collect(child.id) }
  collect(unit.id)
  const subtreeEmployees = snapshot.employees.filter((employee) => employee.status !== 'retired' && employee.org_unit_id !== undefined && subtreeUnitIds.has(employee.org_unit_id))
  const employeeBudget = subtreeEmployees.reduce((sum, employee) => sum + (employee.budget_micros ?? 0), 0)
  const employeeSpent = subtreeEmployees.reduce((sum, employee) => sum + (employee.spent_micros ?? 0), 0)
  const employeeAvailable = subtreeEmployees.reduce((sum, employee) => sum + (employee.available_micros ?? 0), 0)
  const spentPercent = employeeBudget <= 0 ? 0 : Math.max(0, Math.min(100, Math.round((employeeSpent / employeeBudget) * 100)))
  const routeCounts = new Map<string, number>()
  for (const employee of subtreeEmployees) { const route = employee.llm === undefined ? t('common.unknown') : `${employee.llm.provider}/${employee.llm.model}`; routeCounts.set(route, (routeCounts.get(route) ?? 0) + 1) }
  const routeDistribution = [...routeCounts].sort((a, b) => b[1] - a[1] || a[0].localeCompare(b[0]))
  const safeUnitSuffix = unit.id.replace(/[^a-zA-Z0-9_-]/gu, '-')
  const treeBodyId = `dsh-company-org-${safeUnitSuffix}`
  const detailBodyId = `dsh-company-org-detail-${safeUnitSuffix}`
  const peopleBodyId = `dsh-company-org-people-${safeUnitSuffix}`
  const loadPresentation = departmentLoadPresentation(unit.load.band, locale)
  const average = unit.load.people === 0 ? '—' : formatDecimal(unit.load.average, locale, 2)
  const leaf = childUnits.length === 0
  // Any unit with direct people or child units expands like a file tree; empty
  // leaves stay static rows.
  const expandable = childUnits.length > 0 || directEmployees.length > 0
  const managerName = unit.manager_employee_id === undefined
    ? undefined
    : snapshot.employees.find((employee) => employee.id === unit.manager_employee_id)?.name
  // One wrapping meta line under the name keeps the row's right side fixed —
  // load badge + info button only — so nothing stacks or overflows when the
  // drawer narrows.
  const meta = [
    t(`organization.kind.${unit.kind}`),
    managerName === undefined ? undefined : `${t('organization.lead')}: ${managerName}`,
    t(unit.load.people === 1 ? 'common.person' : 'common.people', { count: unit.load.people }),
    t(unit.load.open_work === 1 ? 'common.openWorkItem' : 'common.openWork', { count: unit.load.open_work }),
  ].filter((part): part is string => part !== undefined).join(' · ')
  return (
    <li className="dsh-company-org-node" role="treeitem" aria-level={props.level} aria-expanded={expandable ? treeOpen : undefined}>
      {/* Row and its detail panel live in one connected card so the detail is
       * always visually anchored to its own unit, never to the subtree below. */}
      <div className="dsh-company-org-node__shell">
        <div className="dsh-company-org-node__row">
          {expandable ? (
            <button type="button" className="dsh-company-org-node__toggle" aria-expanded={treeOpen} aria-controls={treeOpen ? (leaf ? peopleBodyId : treeBodyId) : undefined} onClick={() => props.onToggleUnit(unit.id)}>
              <ChevronIcon className="dsh-company-chevron" />
              <span className="dsh-company-org-node__identity">
                <span className="dsh-company-org-node__name">{unit.name}</span>
                <span className="dsh-company-org-node__meta">{meta}</span>
              </span>
            </button>
          ) : (
            <span className="dsh-company-org-node__identity dsh-company-org-node__identity--leaf">
              <span className="dsh-company-org-node__name">{unit.name}</span>
              <span className="dsh-company-org-node__meta">{meta}</span>
            </span>
          )}
          <span className="dsh-company-org-node__summary">
            <span className="dsh-company-load-badge" data-tone={loadPresentation.tone}><LoadIcon />{loadPresentation.label}</span>
          </span>
          <button type="button" className="dsh-company-org-node__info" aria-expanded={detailOpen} aria-controls={detailOpen ? detailBodyId : undefined} aria-label={t('organization.unitDetails')} title={t('organization.unitDetails')} onClick={() => props.onToggleDetail(unit.id)}>
            <InfoIcon />
          </button>
        </div>
        {detailOpen ? (
          <div className="dsh-company-org-node__detail" id={detailBodyId}>
            <div className="dsh-company-load-metrics">
              <div className="dsh-company-load-metric"><strong>{unit.load.people}</strong><span>{t('organization.peopleMetric')}</span></div>
              <div className="dsh-company-load-metric"><strong>{unit.load.open_work}</strong><span>{t('organization.openMetric')}</span></div>
              <div className="dsh-company-load-metric"><strong>{unit.load.effective_sum}</strong><span>{t('organization.effectiveMetric')}</span></div>
              <div className="dsh-company-load-metric"><strong>{average}</strong><span>{t('organization.averageMetric')} · max {unit.load.max_effective}</span></div>
            </div>
            {unit.description === undefined ? null : <p className="dsh-company-card__copy">{unit.description}</p>}
            <div className="dsh-company-department-analytics">
              <section className="dsh-company-detail-card">
                <h5 className="dsh-company-detail-card__label">{t('organization.subtreeMoney')}</h5>
                <div className="dsh-company-detail-card__body">
                  <div className="dsh-company-money-lines">
                    <span>{t('audit.companyBudget')}: {formatMoneyMicros(employeeBudget, snapshot.budget.currency, locale)}</span>
                    <span>{t('audit.spent')}: {formatMoneyMicros(employeeSpent, snapshot.budget.currency, locale)}</span>
                    <span>{t('audit.available')}: {formatMoneyMicros(employeeAvailable, snapshot.budget.currency, locale)}</span>
                  </div>
                  <progress className="dsh-company-progress" data-tone={spentPercent >= 100 ? 'danger' : spentPercent >= 80 ? 'warning' : undefined} max={100} value={spentPercent} />
                </div>
              </section>
              <section className="dsh-company-detail-card">
                <h5 className="dsh-company-detail-card__label">{t('organization.modelDistribution')}</h5>
                <div className="dsh-company-detail-card__body">
                  {routeDistribution.length === 0 ? t('common.none') : <div className="dsh-company-route-chart"><div className="dsh-company-route-chart__bar" role="img" aria-label={routeDistribution.map(([route, count]) => `${route}: ${count}`).join('; ')}>{routeDistribution.map(([route, count], index) => <span key={route} style={{ width: `${(count / subtreeEmployees.length) * 100}%`, background: ROUTE_COLORS[index % ROUTE_COLORS.length] }} />)}</div><div className="dsh-company-route-chart__legend">{routeDistribution.map(([route, count], index) => <span key={route}><i style={{ background: ROUTE_COLORS[index % ROUTE_COLORS.length] }} />{route} · {count} · {formatDecimal((count / subtreeEmployees.length) * 100, locale, 1)}%</span>)}</div></div>}
                </div>
              </section>
            </div>
            {positions.length === 0 ? null : <DetailCard label={t('organization.positionsAndResponsibilities')}>{positions.map((position) => `${position.title}${position.responsibilities.length === 0 ? '' : `\n  ${position.responsibilities.join('\n  ')}`}`).join('\n\n')}</DetailCard>}
          </div>
        ) : null}
      </div>
      {treeOpen && directEmployees.length > 0 ? (
        <div className="dsh-company-org-node__people-list" id={leaf ? peopleBodyId : undefined} role="group">
          {directEmployees.map((employee) => <EmployeeRow key={employee.id} employee={employee} snapshot={snapshot} position={positions.find((position) => position.id === employee.position_id)} open={props.openEmployeeIds.has(employee.id)} busy={props.busy} canManageAuthorization={props.canManageAuthorization} t={t} locale={locale} onToggle={() => props.onToggleEmployee(employee.id)} navigateToSession={props.navigateToSession} onNavigationError={props.onNavigationError} onGrantAuthorization={props.onGrantAuthorization} onRevokeAuthorization={props.onRevokeAuthorization} />)}
        </div>
      ) : null}
      {treeOpen && !leaf ? (
        <ul role="group" id={treeBodyId}>
          {childUnits.map((child) => <OrgNode key={child.id} {...props} unit={child} level={props.level + 1} />)}
        </ul>
      ) : null}
    </li>
  )
}

export function OrganizationView(props: OrganizationViewProps): React.JSX.Element {
  const { snapshot, t, locale, busy = false, canManageAuthorization = false, initialExpanded = false, initialDetailUnitId } = props
  const [navigationError, setNavigationError] = useState<string>()
  const roots = useMemo(() => snapshot.org_units.filter((unit) => unit.parent_id === undefined || !snapshot.org_units.some((candidate) => candidate.id === unit.parent_id)), [snapshot.org_units])
  // All three expansion axes are independent multi-open sets: expanding one
  // unit, one detail panel, or one employee never silently closes another.
  const [expandedUnits, setExpandedUnits] = useState<Set<string>>(() => initialExpanded ? new Set(snapshot.org_units.map((unit) => unit.id)) : new Set())
  const [detailUnits, setDetailUnits] = useState<Set<string>>(() => initialDetailUnitId === undefined ? new Set() : new Set([initialDetailUnitId]))
  const [openEmployeeIds, setOpenEmployeeIds] = useState<Set<string>>(() => new Set())
  const childrenByParent = useMemo(() => {
    const map = new Map<string, SafeOrgUnitView[]>()
    for (const unit of snapshot.org_units) {
      if (unit.parent_id === undefined) continue
      const children = map.get(unit.parent_id) ?? []
      children.push(unit)
      map.set(unit.parent_id, children)
    }
    for (const children of map.values()) children.sort((left, right) => left.name.localeCompare(right.name))
    return map
  }, [snapshot.org_units])
  const positionsByUnit = useMemo(() => {
    const map = new Map<string, SafePositionView[]>()
    for (const position of snapshot.positions) {
      const positions = map.get(position.org_unit_id) ?? []
      positions.push(position)
      map.set(position.org_unit_id, positions)
    }
    return map
  }, [snapshot.positions])
  const employeesByUnit = useMemo(() => {
    const map = new Map<string, SafeEmployeeView[]>()
    for (const employee of snapshot.employees) {
      if (employee.org_unit_id === undefined) continue
      const employees = map.get(employee.org_unit_id) ?? []
      employees.push(employee)
      map.set(employee.org_unit_id, employees)
    }
    return map
  }, [snapshot.employees])
  const unassigned = snapshot.employees.filter((employee) => employee.status !== 'retired' && (employee.org_unit_id === undefined || !snapshot.org_units.some((unit) => unit.id === employee.org_unit_id)))
  const retired = snapshot.employees.filter((employee) => employee.status === 'retired')
  const orgIds = snapshot.org_units.map((unit) => unit.id).join('\u0000')
  const employeeIds = snapshot.employees.map((employee) => employee.id).join('\u0000')

  useEffect(() => {
    const unitIdSet = new Set(snapshot.org_units.map((unit) => unit.id))
    const employeeIdSet = new Set(snapshot.employees.map((employee) => employee.id))
    setExpandedUnits((current) => new Set([...current].filter((id) => unitIdSet.has(id))))
    setDetailUnits((current) => new Set([...current].filter((id) => unitIdSet.has(id))))
    setOpenEmployeeIds((current) => new Set([...current].filter((id) => employeeIdSet.has(id))))
  }, [orgIds, employeeIds])

  const toggleSetMember = (setter: React.Dispatch<React.SetStateAction<Set<string>>>) => (id: string): void =>
    setter((current) => { const next = new Set(current); if (next.has(id)) next.delete(id); else next.add(id); return next })

  const common = {
    snapshot,
    childrenByParent,
    positionsByUnit,
    employeesByUnit,
    expandedUnits,
    detailUnits,
    openEmployeeIds,
    busy,
    canManageAuthorization,
    t,
    locale,
    onToggleUnit: toggleSetMember(setExpandedUnits),
    onToggleDetail: toggleSetMember(setDetailUnits),
    onToggleEmployee: toggleSetMember(setOpenEmployeeIds),
    navigateToSession: props.navigateToSession,
    onNavigationError: setNavigationError,
    onGrantAuthorization: props.onGrantAuthorization,
    onRevokeAuthorization: props.onRevokeAuthorization,
  }

  return (
    <div className="dsh-company-view">
      <header><h2 className="dsh-company-view__heading">{t('tab.organization')}</h2><p className="dsh-company-view__subheading">{t('organization.summary')}</p></header>
      <div className="dsh-company-summary-grid dsh-company-section">
        <div className="dsh-company-stat"><div className="dsh-company-stat__head"><span className="dsh-company-stat__icon"><BuildingIcon /></span><span className="dsh-company-stat__label">{t('organization.units')}</span></div><strong className="dsh-company-stat__value">{snapshot.org_units.length}</strong></div>
        <div className="dsh-company-stat"><div className="dsh-company-stat__head"><span className="dsh-company-stat__icon"><TasksIcon /></span><span className="dsh-company-stat__label">{t('organization.positions')}</span></div><strong className="dsh-company-stat__value">{snapshot.positions.length}</strong></div>
        <div className="dsh-company-stat"><div className="dsh-company-stat__head"><span className="dsh-company-stat__icon"><UsersIcon /></span><span className="dsh-company-stat__label">{t('organization.employees')}</span></div><strong className="dsh-company-stat__value">{snapshot.employees.filter((employee) => employee.status !== 'retired').length}</strong></div>
      </div>
      {navigationError === undefined ? null : <div className="dsh-company-banner dsh-company-section" data-tone="error" role="alert">{t('organization.openSessionError', { message: navigationError })}</div>}
      <section className="dsh-company-section">
        <div className="dsh-company-section__head"><h3 className="dsh-company-section__title"><BuildingIcon width="14" height="14" />{t('organization.tree')}</h3><span className="dsh-company-section__count">{snapshot.org_units.length}</span></div>
        {roots.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('organization.noUnits')}</p> : <ul className="dsh-company-org-tree" role="tree">{roots.map((unit) => <OrgNode key={unit.id} {...common} unit={unit} level={1} />)}</ul>}
      </section>
      {unassigned.length === 0 ? null : <section className="dsh-company-card dsh-company-section"><div className="dsh-company-section__head"><h3 className="dsh-company-section__title">{t('organization.unassigned')}</h3><span className="dsh-company-section__count">{unassigned.length}</span></div><div className="dsh-company-employee-list">{unassigned.map((employee) => <EmployeeRow key={employee.id} employee={employee} snapshot={snapshot} position={undefined} open={openEmployeeIds.has(employee.id)} busy={busy} canManageAuthorization={canManageAuthorization} t={t} locale={locale} onToggle={() => toggleSetMember(setOpenEmployeeIds)(employee.id)} navigateToSession={props.navigateToSession} onNavigationError={setNavigationError} onGrantAuthorization={props.onGrantAuthorization} onRevokeAuthorization={props.onRevokeAuthorization} />)}</div></section>}
      {retired.length === 0 ? null : (
        <details className="dsh-company-card dsh-company-section dsh-company-former">
          <summary className="dsh-company-section__head">
            <span className="dsh-company-section__title"><ChevronIcon className="dsh-company-chevron" />{t('organization.former')}</span>
            <span className="dsh-company-section__count">{retired.length}</span>
          </summary>
          <div className="dsh-company-employee-list">{retired.map((employee) => <EmployeeRow key={employee.id} employee={employee} snapshot={snapshot} position={snapshot.positions.find((position) => position.id === employee.position_id)} open={openEmployeeIds.has(employee.id)} busy={busy} canManageAuthorization={false} t={t} locale={locale} onToggle={() => toggleSetMember(setOpenEmployeeIds)(employee.id)} navigateToSession={props.navigateToSession} onNavigationError={setNavigationError} />)}</div>
        </details>
      )}
      <section className="dsh-company-section"><div className="dsh-company-section__head"><h3 className="dsh-company-section__title">{t('organization.staffing')}</h3><span className="dsh-company-section__count">{snapshot.staffing_requests.length}</span></div>{snapshot.staffing_requests.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('organization.noStaffing')}</p> : <div className="dsh-company-ledger">{snapshot.staffing_requests.map((request) => <div className="dsh-company-ledger__row" key={request.id}><span className="dsh-company-ledger__kind">{request.id} · {request.action}</span><span className="dsh-company-ledger__reason">{request.candidate_name ?? request.employee_id ?? ''} · {request.status}</span><time className="dsh-company-ledger__time" dateTime={new Date(request.updated_at).toISOString()}>{formatRelative(request.updated_at, t)}</time></div>)}</div>}</section>
    </div>
  )
}
