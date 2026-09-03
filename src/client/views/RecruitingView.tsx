import { useEffect, useRef, useState } from 'react'
import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot } from '../types.js'
import { InfoIcon, RefreshIcon, WarningIcon } from '../icons.js'
import { enablePreset } from '../model-presets.js'
import { buildPriceDrafts, decimalMoneyToUnits, mergeModelPriceDrafts, ModelPriceMatrix, modelPriceDraftPayload, type PriceDraft } from './OverviewView.js'
import { formatRelative } from '../ui.js'

export interface RecruitingViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  busy?: boolean
  canManage?: boolean
  onRequestModelPrices?(payload: Record<string, unknown>): Promise<boolean>
  onReprobe?(): Promise<boolean>
  onOpenApprovals?(): void
}

/** HR-facing model enabling: switch a route on, give it three rates, submit.
 * Hiring recommendations may only pick enabled (three-rate priced) routes. */
export function RecruitingView(props: RecruitingViewProps): React.JSX.Element {
  const { snapshot, t, busy = false, canManage = false } = props
  const [priceRows, setPriceRows] = useState<PriceDraft[]>(() => buildPriceDrafts(snapshot))
  const [error, setError] = useState<string>()
  const pricesDirty = useRef(false)
  const previousCompanyId = useRef(snapshot.company.id)

  useEffect(() => {
    if (previousCompanyId.current !== snapshot.company.id) {
      previousCompanyId.current = snapshot.company.id
      pricesDirty.current = false
    }
    const fresh = buildPriceDrafts(snapshot)
    setPriceRows((current) => pricesDirty.current ? mergeModelPriceDrafts(current, fresh) : fresh)
  }, [snapshot.revision, snapshot.company.id])

  const enabledCount = priceRows.filter((row) => row.enabled).length

  const updatePrice = (key: string, field: 'miss' | 'hit' | 'output', value: string): void => {
    pricesDirty.current = true
    setPriceRows((rows) => rows.map((row) => `${row.provider}\u0000${row.model}` === key ? { ...row, [field]: value } : row))
  }
  const togglePrice = (key: string, enabled: boolean): void => {
    pricesDirty.current = true
    setPriceRows((rows) => rows.map((row) => `${row.provider}\u0000${row.model}` === key
      ? {
          ...row,
          enabled,
          ...(enabled
            ? enablePreset(row.provider, row.model, snapshot.budget.currency, row) ?? {}
            : { miss: '', hit: '', output: '' }),
        }
      : row))
  }

  const submit = async (): Promise<void> => {
    if (props.onRequestModelPrices === undefined) return
    const modelPrices = modelPriceDraftPayload(priceRows)
    if (modelPrices === undefined) {
      const invalid = priceRows.find((row) => row.enabled && (['miss', 'hit', 'output'] as const).some((field) => decimalMoneyToUnits(row[field]) === undefined))
      setError(t('formation.invalidMoney', { field: invalid === undefined ? t('formation.prices') : `${invalid.provider}/${invalid.model}` }))
      return
    }
    setError(undefined)
    pricesDirty.current = false
    const succeeded = await props.onRequestModelPrices({
      model_prices: modelPrices,
      expected_pricing_revision: snapshot.budget.pricing_revision,
    })
    if (succeeded) props.onOpenApprovals?.()
    else pricesDirty.current = true
  }

  return (
    <div className="dsh-company-view">
      <header>
        <h2 className="dsh-company-view__heading">{t('recruiting.heading')}</h2>
        <p className="dsh-company-view__subheading">{t('recruiting.subheading')}</p>
      </header>

      <div className="dsh-company-chip-list dsh-company-section">
        <span className="dsh-company-chip" data-tone={enabledCount > 0 ? 'success' : 'warning'}>{t('recruiting.enabledCount', { enabled: enabledCount, total: priceRows.length })}</span>
        <span className="dsh-company-chip">{snapshot.model_catalog.models.length} {t('formation.detected')}</span>
        {snapshot.model_catalog.probed_at === undefined ? null : <span className="dsh-company-chip">{t('formation.probeAt', { time: formatRelative(snapshot.model_catalog.probed_at, t) })}</span>}
        {snapshot.model_catalog.errors.length > 0 ? <span className="dsh-company-chip" data-tone="warning">{t('formation.probePartial')}</span> : null}
      </div>

      <section className="dsh-company-section">
        <div className="dsh-company-section__head">
          <div>
            <h3 className="dsh-company-section__title">{t('recruiting.heading')}</h3>
            <p className="dsh-company-view__subheading">{t('formation.priceHint')}</p>
          </div>
          <div className="dsh-company-section__head-meta">
            {props.canManage && props.onReprobe !== undefined ? <button type="button" className="dsh-company-action" disabled={busy} onClick={() => void props.onReprobe?.()}><RefreshIcon width="13" height="13" />{t('formation.reprobe')}</button> : null}
            <span className="dsh-company-section__count">{enabledCount}/{priceRows.length}</span>
          </div>
        </div>
        <div className="dsh-company-banner dsh-company-section" role="status"><InfoIcon width="15" height="15" /><span>{t('recruiting.hint')}</span></div>
        {priceRows.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('formation.probeEmpty')}</p> : (
          <ModelPriceMatrix rows={priceRows} currency={snapshot.budget.currency} t={t} canEdit={canManage} onChange={updatePrice} onToggle={togglePrice} />
        )}
        {error === undefined ? null : <div className="dsh-company-banner dsh-company-section" data-tone="error" role="alert"><WarningIcon width="14" height="14" />{error}</div>}
        {props.canManage && props.onRequestModelPrices !== undefined ? (
          <div className="dsh-company-inline-actions dsh-company-section">
            <button type="button" className="dsh-company-action" data-variant="primary" disabled={busy} onClick={() => void submit()}>{t('recruiting.submit')}</button>
          </div>
        ) : null}
      </section>
    </div>
  )
}
