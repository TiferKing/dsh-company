import { useEffect, useMemo, useRef, useState } from 'react'
import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot, SafeMoneyUsageView } from '../types.js'
import { ChartIcon, ChevronIcon, InfoIcon, PackageIcon, WalletIcon, WarningIcon } from '../icons.js'
import { decimalMoneyToUnits, microsToInput } from './OverviewView.js'
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
}

const SEGMENT_COLORS = ['#3964fe', '#7c5cff', '#138a58', '#c57900', '#d83b46', '#1887a8', '#8a5b2d', '#6b7280'] as const

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
  const [budgetError, setBudgetError] = useState<string>()
  const budgetDirty = useRef(false)
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
  const productBudgetTotal = snapshot.products.reduce((sum, product) => sum + (product.budget_micros ?? 0), 0)
  useEffect(() => {
    if (previousCompanyId.current !== snapshot.company.id) {
      previousCompanyId.current = snapshot.company.id
      budgetDirty.current = false
      draftRevision.current = snapshot.revision
    }
    if (!budgetDirty.current) {
      draftRevision.current = snapshot.revision
      setTotalBudgetDraft(microsToInput(budget.total_micros))
      setProductBudgetDrafts(Object.fromEntries(snapshot.products.map((product) => [product.id, microsToInput(product.budget_micros)])))
      setBudgetError(undefined)
    }
  }, [snapshot.revision, snapshot.company.id])
  const requestBudgetChange = async (): Promise<void> => {
    if (props.onRequestBudgetChange === undefined) return
    const totalBudgetUnits = decimalMoneyToUnits(totalBudgetDraft)
    const productBudgets = snapshot.products.map((product) => ({ id: product.id, budget: decimalMoneyToUnits(productBudgetDrafts[product.id] ?? '') }))
    if (totalBudgetUnits === undefined || productBudgets.some((product) => product.budget === undefined)) {
      setBudgetError(t('formation.invalidMoney', { field: t('audit.companyBudget') }))
      return
    }
    setBudgetError(undefined)
    const succeeded = await props.onRequestBudgetChange({
      total_budget: totalBudgetUnits,
      product_budgets: productBudgets.map((product) => ({ product_id: product.id, product_budget: product.budget })),
    }, draftRevision.current)
    if (succeeded) {
      budgetDirty.current = false
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
        <MoneyStat icon={<PackageIcon width="14" height="14" />} value={formatMoneyMicros(productBudgetTotal, budget.currency, locale)} label={t('audit.productBudget')} secondary={`${snapshot.products.length} ${t('tab.products')}`} />
        <MoneyStat icon={<ChartIcon width="14" height="14" />} value={formatMoneyMicros(budget.spent_micros, budget.currency, locale)} label={t('audit.spent')} secondary={`${spentPercent}%`} />
        <MoneyStat icon={<InfoIcon width="14" height="14" />} value={formatMoneyMicros(budget.reserved_micros, budget.currency, locale)} label={t('audit.reserved')} secondary={`${reservedPercent}%`} />
        <MoneyStat icon={<WalletIcon width="14" height="14" />} value={formatMoneyMicros(budget.available_micros, budget.currency, locale)} label={t('audit.available')} />
      </div>
      <div className="dsh-company-product-budget-list">
        <label><span>{t('audit.companyBudget')}</span>{props.canManageBudget ? <input inputMode="decimal" value={totalBudgetDraft} onChange={(event) => { budgetDirty.current = true; setTotalBudgetDraft(event.currentTarget.value) }} /> : <strong>{formatMoneyMicros(budget.total_micros, budget.currency, locale)}</strong>}</label>
        {snapshot.products.map((product) => <label key={product.id}><span>{product.name}</span>{props.canManageBudget ? <input inputMode="decimal" value={productBudgetDrafts[product.id] ?? ''} onChange={(event) => { budgetDirty.current = true; setProductBudgetDrafts((current) => ({ ...current, [product.id]: event.currentTarget.value })) }} /> : <strong>{formatMoneyMicros(product.budget_micros, budget.currency, locale)}</strong>}</label>)}
      </div>
      {budgetError === undefined ? null : <div className="dsh-company-banner dsh-company-section" data-tone="error" role="alert"><WarningIcon width="14" height="14" />{budgetError}</div>}
      {props.canManageBudget && props.onRequestBudgetChange !== undefined ? (
        <div className="dsh-company-inline-actions dsh-company-section">
          <button type="button" className="dsh-company-action" data-variant="primary" disabled={busy || !budgetDirty.current} onClick={() => void requestBudgetChange()}>{t('audit.requestBudgetChange')}</button>
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
