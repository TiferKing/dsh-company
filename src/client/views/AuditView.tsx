import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot, SafeMoneyUsageView, SnapshotQuery } from '../types.js'
import { EmployeeDirectoryControls } from '../directory.js'
import { ChartIcon, ChevronIcon, InfoIcon, PackageIcon, WalletIcon, WarningIcon } from '../icons.js'
import { decimalMoneyToMicros, decimalMoneyToUnits, microsToInput } from './OverviewView.js'
import {
  formatAbsolute,
  formatDecimal,
  formatMoneyMicros,
  formatRelative,
  percent,
  StatusBadge,
} from '../ui.js'

export interface AuditViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  busy?: boolean
  canManageBudget?: boolean
  onRequestBudgetChange?(payload: Record<string, unknown>, expectedRevision: number): Promise<boolean>
  onOpenApprovals?(): void
  onDirectoryQuery?(query: SnapshotQuery): void
}

const SEGMENT_COLORS = ['#3964fe', '#7c5cff', '#138a58', '#c57900', '#d83b46', '#1887a8', '#8a5b2d', '#6b7280'] as const

type BudgetDraftResult =
  | { ok: true; payload: Record<string, unknown> }
  | { ok: false; reason: 'invalidMoney' | 'budgetAboveTotal' | 'budgetBelowCommitted' | 'productTotal' | 'unchanged'; name?: string }

/** Compare currency drafts to approved ceilings; submit only changed allocations. */
export function budgetDraftPayload(snapshot: CompanySnapshot, total: string, products: Record<string, string>, employees: Record<string, string>): BudgetDraftResult {
  const totalMicros = decimalMoneyToMicros(total)
  if (totalMicros === undefined) return { ok: false, reason: 'invalidMoney' }
  if (totalMicros < snapshot.budget.spent_micros + snapshot.budget.reserved_micros) return { ok: false, reason: 'budgetBelowCommitted' }
  const payload: Record<string, unknown> = {}
  if (totalMicros !== snapshot.budget.total_micros) payload.total_budget = decimalMoneyToUnits(total)!
  let productTotal = 0n
  const productBudgets: Array<{ product_id: string; product_budget: string }> = []
  for (const product of snapshot.products.filter((item) => item.status !== 'cancelled' && item.status !== 'retired')) {
    const draft = products[product.id] ?? ''
    const amount = decimalMoneyToMicros(draft)
    if (amount === undefined) return { ok: false, reason: 'invalidMoney', name: product.name }
    if (amount > totalMicros) return { ok: false, reason: 'budgetAboveTotal', name: product.name }
    if (amount !== product.budget_micros && amount < (product.spent_micros ?? 0) + (product.reserved_micros ?? 0)) return { ok: false, reason: 'budgetBelowCommitted', name: product.name }
    productTotal += BigInt(amount)
    if (amount !== product.budget_micros) productBudgets.push({ product_id: product.id, product_budget: decimalMoneyToUnits(draft)! })
  }
  if (productTotal > BigInt(totalMicros)) return { ok: false, reason: 'productTotal' }
  const employeeBudgets: Array<{ employee_id: string; budget: string }> = []
  for (const employee of snapshot.employees.filter((item) => item.status !== 'retired')) {
    const draft = employees[employee.id] ?? ''
    const amount = decimalMoneyToMicros(draft)
    if (amount === undefined) return { ok: false, reason: 'invalidMoney', name: employee.name }
    if (amount > totalMicros) return { ok: false, reason: 'budgetAboveTotal', name: employee.name }
    if (amount !== (employee.budget_micros ?? 0) && amount < (employee.spent_micros ?? 0) + (employee.reserved_micros ?? 0)) return { ok: false, reason: 'budgetBelowCommitted', name: employee.name }
    if (amount !== (employee.budget_micros ?? 0)) employeeBudgets.push({ employee_id: employee.id, budget: decimalMoneyToUnits(draft)! })
  }
  if (productBudgets.length > 0) payload.product_budgets = productBudgets
  if (employeeBudgets.length > 0) payload.employee_budgets = employeeBudgets
  return Object.keys(payload).length === 0 ? { ok: false, reason: 'unchanged' } : { ok: true, payload }
}

function routeColor(provider: string, model: string): string {
  let hash = 2_166_136_261
  for (const character of `${provider}\u0000${model}`) {
    hash ^= character.codePointAt(0) ?? 0
    hash = Math.imul(hash, 16_777_619)
  }
  return SEGMENT_COLORS[(hash >>> 0) % SEGMENT_COLORS.length]!
}

function DetailCard(props: { label: string; children: React.ReactNode }): React.JSX.Element {
  return (
    <section className="dsh-company-detail-card">
      <h4 className="dsh-company-detail-card__label">{props.label}</h4>
      <div className="dsh-company-detail-card__body">{props.children}</div>
    </section>
  )
}

function MoneyStat(props: { icon?: React.JSX.Element; value: string; label: string; secondary?: string }): React.JSX.Element {
  return (
    <div className="dsh-company-money-stat">
      {props.icon === undefined ? null : <span className="dsh-company-stat__icon">{props.icon}</span>}
      <span className="dsh-company-money-stat__value">{props.value}</span>
      <span className="dsh-company-money-stat__label">{props.label}</span>
      {props.secondary === undefined ? null : <span className="dsh-company-money-stat__secondary">{props.secondary}</span>}
    </div>
  )
}

function UsageEvent(props: {
  item: SafeMoneyUsageView
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  open: boolean
  onToggle(): void
}): React.JSX.Element {
  const { item, snapshot, t, locale } = props
  const employee = snapshot.employees.find((candidate) => candidate.id === item.employee_id)
  const work = item.work_id === undefined ? undefined : snapshot.work.find((candidate) => candidate.id === item.work_id)
  const route = `${item.provider}/${item.model}`
  const costLabel = item.priced
    ? formatMoneyMicros(item.cost_micros, snapshot.budget.currency, locale)
    : t('audit.unknownCost')
  const bodyId = `dsh-company-audit-${item.id.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
  const references = [
    `usage:${item.id}`,
    item.work_id === undefined ? undefined : `work:${item.work_id}`,
    item.product_id === undefined ? undefined : `product:${item.product_id}`,
    item.authorization_id === undefined ? undefined : `authorization:${item.authorization_id}`,
  ].filter((value): value is string => value !== undefined)

  return (
    <article className="dsh-company-audit-event">
      <button
        type="button"
        className="dsh-company-audit-event__toggle"
        aria-expanded={props.open}
        aria-controls={bodyId}
        onClick={props.onToggle}
      >
        <ChevronIcon className="dsh-company-chevron" />
        <span className="dsh-company-audit-event__identity">
          <span className="dsh-company-audit-event__title">{route} · {costLabel}</span>
          <span className="dsh-company-audit-event__meta">
            {employee?.name ?? item.employee_id} · {work?.subject ?? item.work_id ?? t('common.none')} · {formatRelative(item.at, t)}
          </span>
        </span>
        <StatusBadge tone={item.priced ? 'success' : 'warning'}>
          {item.priced ? t('formation.priced') : t('formation.unpriced')}
        </StatusBadge>
      </button>
      <div className="dsh-company-audit-event__body" id={bodyId} hidden={!props.open}>
        <DetailCard label={t('audit.tokensSecondary')}>
          {t('formation.cacheMiss')}: {item.input_cache_miss_tokens.toLocaleString(locale)} · {t('formation.cacheHit')}: {item.input_cache_hit_tokens.toLocaleString(locale)} · {t('formation.output')}: {item.output_tokens.toLocaleString(locale)}{item.reasoning_tokens > 0 ? ` · reasoning ${item.reasoning_tokens.toLocaleString(locale)}` : ''}{` · total ${item.total_tokens.toLocaleString(locale)}`}
        </DetailCard>
        <DetailCard label={t('audit.references')}>
          {references.join('\n')}
        </DetailCard>
        <DetailCard label={t('audit.details')}>
          {`route ${route}\npricing revision ${item.pricing_revision}${item.matched_price_key === undefined ? '' : `\nmatched price ${item.matched_price_key}`}\n${formatAbsolute(item.at, locale)}`}
        </DetailCard>
      </div>
    </article>
  )
}

export function AuditView(props: AuditViewProps): React.JSX.Element {
  const { snapshot, t, locale, busy = false } = props
  const { budget } = snapshot
  const [openUsageId, setOpenUsageId] = useState<string>()
  const [totalBudgetDraft, setTotalBudgetDraft] = useState(() => microsToInput(budget.total_micros))
  const [productBudgetDrafts, setProductBudgetDrafts] = useState<Record<string, string>>(() => Object.fromEntries(snapshot.products.map((product) => [product.id, microsToInput(product.budget_micros)])))
  const [employeeBudgetDrafts, setEmployeeBudgetDrafts] = useState<Record<string, string>>(() => Object.fromEntries(snapshot.employees.filter((employee) => employee.status !== 'retired').map((employee) => [employee.id, microsToInput(employee.budget_micros ?? 0)])))
  const [budgetError, setBudgetError] = useState<string>()
  const [budgetDirty, setBudgetDirty] = useState(false)
  const draftSnapshot = useRef(snapshot)
  const markBudgetDirty = (): void => {
    if (!budgetDirty) {
      draftSnapshot.current = snapshot
      draftRevision.current = snapshot.revision
    }
    setBudgetDirty(true)
  }
  const draftRevision = useRef(snapshot.revision)
  const previousCompanyId = useRef(snapshot.company.id)
  const lifetime = useMemo(
    () => [...budget.provider_model_aggregates].sort((left, right) => right.cost_micros - left.cost_micros || `${left.provider}/${left.model}`.localeCompare(`${right.provider}/${right.model}`)),
    [budget.provider_model_aggregates],
  )
  const usage = useMemo(
    () => [...budget.usage_detail.items].sort((left, right) => right.at - left.at || left.id.localeCompare(right.id)),
    [budget.usage_detail.items],
  )
  // Full-ledger Host aggregates are the complete rendered set; never derive this from the bounded detail window.
  const totalModelCost = lifetime.reduce((sum, item) => sum + item.cost_micros, 0)
  const unpricedCalls = lifetime.reduce((sum, item) => sum + item.unpriced_calls, 0)
  const spentPercent = percent(budget.spent_micros, budget.total_micros)
  const reservedPercent = percent(budget.reserved_micros, budget.total_micros)
  // Freeze the edited page and its revision until submission or discard. A
  // pagination request already in flight must not replace the draft's owners.
  const editingSnapshot = budgetDirty ? draftSnapshot.current : snapshot
  const activeProducts = editingSnapshot.products.filter((product) => product.status !== 'cancelled' && product.status !== 'retired')
  const activeEmployees = editingSnapshot.employees.filter((employee) => employee.status !== 'retired')
  const productBudgetTotal = activeProducts.reduce((sum, product) => sum + product.budget_micros, 0)
  useEffect(() => {
    const companyChanged = previousCompanyId.current !== snapshot.company.id
    if (companyChanged) {
      previousCompanyId.current = snapshot.company.id
      setBudgetDirty(false)
      draftSnapshot.current = snapshot
      draftRevision.current = snapshot.revision
    }
    if (!budgetDirty || companyChanged) {
      draftSnapshot.current = snapshot
      draftRevision.current = snapshot.revision
      setTotalBudgetDraft(microsToInput(budget.total_micros))
      setProductBudgetDrafts(Object.fromEntries(snapshot.products.map((product) => [product.id, microsToInput(product.budget_micros)])))
      setEmployeeBudgetDrafts(Object.fromEntries(snapshot.employees.filter((employee) => employee.status !== 'retired').map((employee) => [employee.id, microsToInput(employee.budget_micros ?? 0)])))
      setBudgetError(undefined)
    }
  }, [snapshot.revision, snapshot.company.id, snapshot.employees, budgetDirty])
  const requestBudgetChange = async (): Promise<void> => {
    if (props.onRequestBudgetChange === undefined) return
    const draft = budgetDraftPayload(draftSnapshot.current, totalBudgetDraft, productBudgetDrafts, employeeBudgetDrafts)
    if (!draft.ok) {
      setBudgetError(draft.reason === 'productTotal'
        ? t('audit.productBudgetAboveTotal')
        : draft.reason === 'unchanged'
          ? t('audit.budgetUnchanged')
          : t(`formation.${draft.reason}`, { field: draft.name ?? t('audit.companyBudget') }))
      return
    }
    setBudgetError(undefined)
    const succeeded = await props.onRequestBudgetChange(draft.payload, draftRevision.current)
    if (succeeded) {
      setBudgetDirty(false)
      props.onOpenApprovals?.()
    }
  }
  const windowEnd = budget.usage_detail.offset + budget.usage_detail.returned
  const windowLabel = budget.usage_detail.returned === 0
    ? t('audit.emptyWindow', { offset: budget.usage_detail.offset })
    : budget.usage_detail.offset === 0
      ? t('audit.latest', { count: budget.usage_detail.returned })
      : `${budget.usage_detail.offset + 1}–${windowEnd}`

  return (
    <div className="dsh-company-view">
      <header>
        <h2 className="dsh-company-view__heading">{t('audit.heading')}</h2>
        <p className="dsh-company-view__subheading">{t('audit.subheading')}</p>
      </header>

      <div className="dsh-company-budget-callout dsh-company-section">
        <InfoIcon width="17" height="17" />
        <span>{t('audit.programmatic')}</span>
      </div>

      {budget.warning || budget.migration_required ? (
        <div className="dsh-company-banner dsh-company-section" role="status">
          <WarningIcon width="16" height="16" />
          <span>{budget.migration_required ? t('formation.needsReview') : t('budget.warning')}</span>
        </div>
      ) : null}

      <div className="dsh-company-audit-grid">
        <MoneyStat icon={<WalletIcon width="14" height="14" />} value={formatMoneyMicros(budget.total_micros, budget.currency, locale)} label={t('audit.companyBudget')} secondary={`${budget.currency} · revision ${budget.pricing_revision}`} />
        <MoneyStat icon={<PackageIcon width="14" height="14" />} value={formatMoneyMicros(productBudgetTotal, budget.currency, locale)} label={t('audit.productBudget')} secondary={`${activeProducts.length} ${t('tab.products')}`} />
        <MoneyStat icon={<ChartIcon width="14" height="14" />} value={formatMoneyMicros(budget.spent_micros, budget.currency, locale)} label={t('audit.spent')} secondary={`${spentPercent}%`} />
        <MoneyStat icon={<InfoIcon width="14" height="14" />} value={formatMoneyMicros(budget.reserved_micros, budget.currency, locale)} label={t('audit.reserved')} secondary={`${reservedPercent}%`} />
        <MoneyStat icon={<WalletIcon width="14" height="14" />} value={formatMoneyMicros(budget.available_micros, budget.currency, locale)} label={t('audit.available')} />
      </div>
      <div className="dsh-company-product-budget-list">
        <label><span>{t('audit.companyBudget')}</span>{props.canManageBudget ? <input inputMode="decimal" value={totalBudgetDraft} onChange={(event) => { markBudgetDirty(); setTotalBudgetDraft(event.currentTarget.value) }} /> : <strong>{formatMoneyMicros(budget.total_micros, budget.currency, locale)}</strong>}</label>
        {activeProducts.map((product) => <label key={product.id}><span>{product.name}</span>{props.canManageBudget ? <input inputMode="decimal" value={productBudgetDrafts[product.id] ?? ''} onChange={(event) => { const value = event.currentTarget.value; markBudgetDirty(); setProductBudgetDrafts((current) => ({ ...current, [product.id]: value })) }} /> : <strong>{formatMoneyMicros(product.budget_micros, budget.currency, locale)}</strong>}</label>)}
      </div>
      <section className="dsh-company-section">
        <div className="dsh-company-section__head"><h3 className="dsh-company-section__title">{t('audit.employeeBudgets')}</h3><span className="dsh-company-section__count">{budget.currency}</span></div>
        <p className="dsh-company-formation__hint">{t('formation.budgetHint')}</p>
        <EmployeeDirectoryControls snapshot={editingSnapshot} t={t} busy={busy || budgetDirty} onQuery={props.onDirectoryQuery} />
        {snapshot.directory === undefined || !budgetDirty ? null : <p className="dsh-company-formation__hint">{t('directory.unsaved')} <button type="button" className="dsh-company-action" disabled={busy} onClick={() => {
          setBudgetDirty(false); draftRevision.current = snapshot.revision
          setTotalBudgetDraft(microsToInput(budget.total_micros))
          setProductBudgetDrafts(Object.fromEntries(snapshot.products.map((product) => [product.id, microsToInput(product.budget_micros)])))
          setEmployeeBudgetDrafts(Object.fromEntries(activeEmployees.map((employee) => [employee.id, microsToInput(employee.budget_micros ?? 0)])))
          setBudgetError(undefined)
        }}>{t('directory.discard')}</button></p>}
        <div className="dsh-company-product-budget-list">
          {activeEmployees.map((employee) => <label key={employee.id}><span>{employee.name}{employee.is_hr ? ' · HR' : ''}</span>{props.canManageBudget ? <input inputMode="decimal" value={employeeBudgetDrafts[employee.id] ?? ''} onChange={(event) => { const value = event.currentTarget.value; markBudgetDirty(); setEmployeeBudgetDrafts((current) => ({ ...current, [employee.id]: value })) }} /> : <strong>{formatMoneyMicros(employee.budget_micros ?? 0, budget.currency, locale)}</strong>}</label>)}
        </div>
      </section>
      {budgetError === undefined ? null : <div className="dsh-company-banner dsh-company-section" data-tone="error" role="alert"><WarningIcon width="14" height="14" />{budgetError}</div>}
      {props.canManageBudget && props.onRequestBudgetChange !== undefined ? (
        <div className="dsh-company-inline-actions dsh-company-section">
          <button type="button" className="dsh-company-action" data-variant="primary" disabled={busy || !budgetDirty} onClick={() => void requestBudgetChange()}>{t('audit.requestBudgetChange')}</button>
        </div>
      ) : null}

      <section className="dsh-company-card dsh-company-section">
        <div className="dsh-company-section__head">
          <h3 className="dsh-company-section__title">{t('audit.scopeUsage')}</h3>
          <span className="dsh-company-section__count">{spentPercent}% + {reservedPercent}%</span>
        </div>
        <div className="dsh-company-budget-bar" role="img" aria-label={`${t('audit.spent')} ${spentPercent}%; ${t('audit.reserved')} ${reservedPercent}%`}>
          <span className="dsh-company-budget-bar__spent" style={{ width: `${spentPercent}%` }} />
          <span className="dsh-company-budget-bar__reserved" style={{ width: `${reservedPercent}%` }} />
        </div>
      </section>

      <section className="dsh-company-card dsh-company-section">
        <div className="dsh-company-section__head">
          <div>
            <h3 className="dsh-company-section__title"><ChartIcon width="14" height="14" /> {t('audit.lifetimeModels')}</h3>
            <p className="dsh-company-view__subheading">{t('audit.lifetimeCaption')}</p>
          </div>
          <span className="dsh-company-section__count">{lifetime.length}</span>
        </div>
        {lifetime.length === 0 ? <p className="dsh-company-empty"><ChartIcon />{t('audit.noModelCosts')}</p> : (
          <>
            {totalModelCost > 0 ? (
              <div className="dsh-company-cost-bar" role="img" aria-label={`${t('audit.knownSubtotal')}: ${formatMoneyMicros(totalModelCost, budget.currency, locale)}`}>
                {lifetime.filter((item) => item.cost_micros > 0).map((item) => (
                  <span
                    className="dsh-company-cost-segment"
                    key={`${item.provider}/${item.model}`}
                    title={`${item.provider}/${item.model} · ${formatMoneyMicros(item.cost_micros, budget.currency, locale)}`}
                    style={{ width: `${(item.cost_micros / totalModelCost) * 100}%`, background: routeColor(item.provider, item.model) }}
                  />
                ))}
              </div>
            ) : null}
            <div className="dsh-company-cost-legend" role="list">
              {lifetime.map((item) => {
                const knownCost = formatMoneyMicros(item.cost_micros, budget.currency, locale)
                const cost = item.unpriced_calls === 0
                  ? `${knownCost} · ${totalModelCost <= 0 ? '0' : formatDecimal((item.cost_micros / totalModelCost) * 100, locale, 1)}%`
                  : item.priced_calls === 0
                    ? t('audit.unknownCost')
                    : `${t('audit.knownSubtotal')}: ${knownCost} + ${t('audit.unknownCost')}`
                return (
                  <div className="dsh-company-cost-legend__row" role="listitem" key={`${item.provider}/${item.model}`}>
                    <span className="dsh-company-cost-legend__swatch" style={{ background: routeColor(item.provider, item.model) }} />
                    <span className="dsh-company-cost-legend__route">{item.provider}/{item.model} · {item.calls.toLocaleString(locale)} calls</span>
                    <span>{cost}</span>
                  </div>
                )
              })}
            </div>
          </>
        )}
        {unpricedCalls > 0 ? (
          <div className="dsh-company-banner dsh-company-section" role="status">
            <WarningIcon width="15" height="15" />
            <span>{t('audit.unpricedUsage')} ({unpricedCalls.toLocaleString(locale)} calls)</span>
          </div>
        ) : null}
      </section>

      <section className="dsh-company-section">
        <div className="dsh-company-section__head">
          <h3 className="dsh-company-section__title">{t('audit.details')}</h3>
          <span className="dsh-company-section__count">{budget.usage_detail.returned}/{budget.usage_detail.total}</span>
        </div>
        <div className="dsh-company-audit-window" role="status">
          <span>{t('audit.window', { shown: budget.usage_detail.returned, total: budget.usage_detail.total, label: windowLabel })}</span>
          {budget.usage_detail.truncated ? <strong>{t('audit.truncated')}</strong> : null}
        </div>
        {usage.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('audit.noDetails')}</p> : (
          <div className="dsh-company-audit-events">
            {usage.map((item) => (
              <UsageEvent
                key={item.id}
                item={item}
                snapshot={snapshot}
                t={t}
                locale={locale}
                open={openUsageId === item.id}
                onToggle={() => setOpenUsageId((current) => current === item.id ? undefined : item.id)}
              />
            ))}
          </div>
        )}
      </section>
    </div>
  )
}
