import { useEffect, useId, useMemo, useRef, useState } from 'react'
import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot, SafeCharterClauseView, SafeModelPriceView } from '../types.js'
import { ChevronIcon, InfoIcon, RefreshIcon, UsersIcon, WalletIcon, WarningIcon } from '../icons.js'
import { enablePreset, formatModelPricePreset, modelPricePreset } from '../model-presets.js'
import {
  completedWorkCount,
  employeeStatusLabel,
  employeeTone,
  formatAbsolute,
  formatMoneyMicros,
  formatRelative,
  percent,
  StatusBadge,
} from '../ui.js'

export interface OverviewViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  canEditFormation?: boolean
  canRequestGovernance?: boolean
  canReprobe?: boolean
  busy?: boolean
  /** Charter clause paths (`'0'`, `'0/1'`, …) that start expanded (tests / future preference). */
  initialExpandedClauses?: readonly string[]
  onEditFormation?(payload: Record<string, unknown>): Promise<boolean>
  onRequestGovernance?(payload: Record<string, unknown>): Promise<boolean>
  onReprobe?(): Promise<boolean>
  onOpenApprovals?(): void
}

export type PriceDraft = {
  provider: string
  model: string
  name: string
  source: SafeModelPriceView['source'] | 'catalog'
  advertised: boolean
  available: boolean
  needsReview: boolean
  /** The switch state, independent of rate completeness: on = this route is
   * enabled for hiring and must carry complete three rates before saving. */
  enabled: boolean
  miss: string
  hit: string
  output: string
}

const PRICE_FIELDS = ['miss', 'hit', 'output'] as const

export function microsToInput(value: number | undefined): string {
  if (value === undefined) return ''
  const whole = Math.floor(value / 1_000_000)
  const fraction = String(value % 1_000_000).padStart(6, '0').replace(/0+$/u, '')
  return fraction.length === 0 ? String(whole) : `${whole}.${fraction}`
}

/** Exact decimal-to-micro conversion; never routes money through binary floating-point arithmetic. */
export function decimalMoneyToMicros(value: string): number | undefined {
  const normalized = value.trim()
  const match = /^(0|[1-9]\d*)(?:\.(\d{1,6}))?$/u.exec(normalized)
  if (match === null) return undefined
  const whole = BigInt(match[1] ?? '0')
  const fraction = BigInt((match[2] ?? '').padEnd(6, '0'))
  const micros = whole * 1_000_000n + fraction
  if (micros > BigInt(Number.MAX_SAFE_INTEGER)) return undefined
  return Number(micros)
}

/** Validated public-action amount in human currency units (at most six decimals), kept textual until the Host boundary. */
export function decimalMoneyToUnits(value: string): string | undefined {
  const normalized = value.trim()
  return decimalMoneyToMicros(normalized) === undefined ? undefined : normalized
}

export function governanceDraftProblem(slogan: string, mission: string, charter: string): 'slogan' | 'mission' | 'charter' | undefined {
  if (slogan.trim().length === 0 || slogan.trim().length > 160) return 'slogan'
  if (mission.trim().length === 0) return 'mission'
  if (charter.trim().length === 0) return 'charter'
  return undefined
}

export function buildPriceDrafts(snapshot: CompanySnapshot): PriceDraft[] {
  const prices = new Map(snapshot.budget.prices.map((price) => [`${price.provider}\u0000${price.model}`, price]))
  const catalog = new Map(snapshot.model_catalog.models.map((model) => [`${model.provider}\u0000${model.model}`, model]))
  for (const employee of snapshot.employees) {
    if (employee.llm === undefined) continue
    const key = `${employee.llm.provider}\u0000${employee.llm.model}`
    if (!catalog.has(key)) {
      catalog.set(key, {
        provider: employee.llm.provider,
        model: employee.llm.model,
        name: employee.llm.model,
        advertised: false,
        available: false,
      })
    }
  }
  for (const price of snapshot.budget.prices) {
    const key = `${price.provider}\u0000${price.model}`
    if (!catalog.has(key)) catalog.set(key, { provider: price.provider, model: price.model, name: price.model, advertised: false, available: false })
  }
  return [...catalog.values()]
    .sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
    .map((model) => {
      const price = prices.get(`${model.provider}\u0000${model.model}`)
        ?? (model.model === '*' ? undefined : prices.get(`${model.provider}\u0000*`))
      return {
        provider: model.provider,
        model: model.model,
        name: model.name,
        source: price?.source ?? 'catalog',
        advertised: model.advertised,
        available: model.available,
        needsReview: snapshot.budget.migration_required && price?.source === 'legacy',
        enabled: price?.input_cache_miss_micros_per_million !== undefined,
        miss: microsToInput(price?.input_cache_miss_micros_per_million),
        hit: microsToInput(price?.input_cache_hit_micros_per_million),
        output: microsToInput(price?.output_micros_per_million),
      }
    })
}


function priceState(row: Pick<PriceDraft, 'miss' | 'hit' | 'output'>): 'priced' | 'unpriced' | 'partial' {
  const count = PRICE_FIELDS.filter((field) => row[field].trim().length > 0).length
  return count === 0 ? 'unpriced' : count === PRICE_FIELDS.length ? 'priced' : 'partial'
}

export function mergeModelPriceDrafts<T extends { provider: string; model: string; enabled: boolean; miss: string; hit: string; output: string }>(current: readonly T[], fresh: readonly T[]): T[] {
  const dirty = new Map(current.map((row) => [`${row.provider}\u0000${row.model}`, row]))
  const merged = fresh.map((row) => {
    const prior = dirty.get(`${row.provider}\u0000${row.model}`)
    if (prior === undefined) return { ...row }
    dirty.delete(`${row.provider}\u0000${row.model}`)
    return { ...row, enabled: prior.enabled, miss: prior.miss, hit: prior.hit, output: prior.output }
  })
  return [...merged, ...dirty.values()].sort((left, right) => left.provider.localeCompare(right.provider) || left.model.localeCompare(right.model))
}

export function modelPriceDraftPayload(rows: ReadonlyArray<Pick<PriceDraft, 'provider' | 'model' | 'enabled' | 'miss' | 'hit' | 'output'>>): Array<Record<string, unknown>> | undefined {
  const result: Array<Record<string, unknown>> = []
  for (const row of rows) {
    const item: Record<string, unknown> = { provider: row.provider, model: row.model }
    if (row.enabled) {
      // An enabled route must carry complete, valid three rates before the
      // payload can be saved; incomplete enabling blocks the whole submit.
      const miss = decimalMoneyToUnits(row.miss)
      const hit = decimalMoneyToUnits(row.hit)
      const output = decimalMoneyToUnits(row.output)
      if (miss === undefined || hit === undefined || output === undefined) return undefined
      item.input_cache_miss_per_million = miss
      item.input_cache_hit_per_million = hit
      item.output_per_million = output
    }
    result.push(item)
  }
  return result
}

/** Accessible on/off switch: a real checkbox carrying role="switch". */
function ModelSwitch(props: {
  checked: boolean
  disabled?: boolean
  label: string
  onChange(checked: boolean): void
}): React.JSX.Element {
  return (
    <span className="dsh-company-switch">
      <input
        type="checkbox"
        role="switch"
        checked={props.checked}
        disabled={props.disabled}
        aria-label={props.label}
        onChange={(event) => props.onChange(event.currentTarget.checked)}
      />
      <span className="dsh-company-switch__track" aria-hidden="true" />
    </span>
  )
}

/**
 * Model list where each row is enabled by a switch (default off = 未启用).
 * Only an enabled row expands its three-rate price matrix; disabled rows
 * carry no rates and are therefore excluded from HR hiring choices.
 */
export function ModelPriceMatrix(props: {
  rows: PriceDraft[]
  currency: string
  t: CompanyTranslate
  canEdit?: boolean
  onChange(key: string, field: (typeof PRICE_FIELDS)[number], value: string): void
  onToggle(key: string, enabled: boolean): void
}): React.JSX.Element {
  const baseId = useId()
  return (
    <div className="dsh-company-price-list">
      {props.rows.map((row) => {
        const key = `${row.provider}\u0000${row.model}`
        const state = priceState(row)
        const enabled = row.enabled
        const open = enabled
        const bodyId = `${baseId}-${key.replace(/[^a-zA-Z0-9_-]/gu, '-')}`
        const summary = state === 'priced'
          ? `${props.t('formation.cacheMiss')} ${row.miss} · ${props.t('formation.cacheHit')} ${row.hit} · ${props.t('formation.output')} ${row.output}`
          : props.t('formation.partialPrice', { route: `${row.provider}/${row.model}` })
        return (
          <div className="dsh-company-price" data-enabled={enabled || undefined} data-invalid={enabled && state !== 'priced' || undefined} key={key}>
            <div className="dsh-company-price__head">
              <ModelSwitch
                checked={enabled}
                disabled={!props.canEdit}
                label={`${props.t('formation.enableModel')}: ${row.provider}/${row.model}`}
                onChange={(next) => props.onToggle(key, next)}
              />
              <span className="dsh-company-price__identity">
                <span className="dsh-company-price__route">{row.provider}/{row.model}</span>
                {enabled ? <span className="dsh-company-price__summary">{summary}</span> : null}
              </span>
              <span className="dsh-company-price__badges">
                <span className="dsh-company-chip" data-tone={enabled ? (state === 'priced' ? 'success' : 'danger') : undefined}>
                  {props.t(!enabled ? 'formation.notEnabled' : state === 'priced' ? 'formation.priced' : 'formation.needsReview')}
                </span>
                <span className="dsh-company-chip">{row.advertised ? props.t('formation.detected') : props.t('formation.configuredRoute')}</span>
                {!enabled ? (() => {
                  const preset = modelPricePreset(row.provider, row.model, props.currency)
                  return preset === undefined ? null : (
                    <span className="dsh-company-chip" data-tone="active" title={`${props.t('formation.hasPreset')} ${formatModelPricePreset(preset)} ${props.currency}/M`}>
                      {props.t('formation.hasPreset')} {formatModelPricePreset(preset)}
                    </span>
                  )
                })() : null}
                {!row.available ? <span className="dsh-company-chip" data-tone="warning">{props.t('formation.unavailable')}</span> : null}
                {row.needsReview ? <span className="dsh-company-chip" data-tone="warning">{props.t('formation.needsReview')}</span> : null}
              </span>
            </div>
            {open ? (
              <div className="dsh-company-price__body" id={bodyId}>
                <div className="dsh-company-price__fields">
                  {PRICE_FIELDS.map((field) => (
                    <label className="dsh-company-price-field" key={field}>
                      <span>{props.t(field === 'miss' ? 'formation.cacheMiss' : field === 'hit' ? 'formation.cacheHit' : 'formation.output')}</span>
                      <input
                        type="text"
                        inputMode="decimal"
                        value={row[field]}
                        disabled={!props.canEdit}
                        aria-invalid={enabled && state !== 'priced' || undefined}
                        onChange={(event) => props.onChange(key, field, event.currentTarget.value)}
                      />
                      <span className="dsh-company-field__hint">{props.t('formation.perMillion', { currency: props.currency })}</span>
                    </label>
                  ))}
                </div>
                <span className="dsh-company-formation__hint">{props.t('formation.priceHint')}</span>
              </div>
            ) : null}
          </div>
        )
      })}
    </div>
  )
}

/** Numbered clauses keep their marker: `1` renders as `1. `, `1.2` as `1.2 `. */
function clauseHeading(clause: SafeCharterClauseView): string {
  if (clause.number === undefined) return clause.title
  return `${clause.number}${clause.number.includes('.') ? ' ' : '. '}${clause.title}`
}

/** One clause row: the same row language as the blocked-work list. The
 * chevron expands the clause's body text and sub-clauses, which indent on the
 * org-tree guideline. The Host already parsed the charter text into this
 * outline; the Web side renders it verbatim. */
function CharterRow(props: {
  clause: SafeCharterClauseView
  path: string
  expanded: ReadonlySet<string>
  onToggle(path: string): void
}): React.JSX.Element {
  const { clause } = props
  const open = props.expanded.has(props.path)
  const hasChildren = clause.children.length > 0
  const expandable = hasChildren || clause.body.length > 0
  return (
    <li className="dsh-company-charter-item">
      {expandable ? (
        <button type="button" className="dsh-company-charter-item__row" aria-expanded={open} onClick={() => props.onToggle(props.path)}>
          <ChevronIcon className="dsh-company-chevron" />
          <span className="dsh-company-charter-item__title">{clauseHeading(clause)}</span>
          {hasChildren ? <span className="dsh-company-charter-item__count">{clause.children.length}</span> : null}
        </button>
      ) : (
        <div className="dsh-company-charter-item__row dsh-company-charter-item__row--leaf">
          <span className="dsh-company-charter-item__title">{clauseHeading(clause)}</span>
        </div>
      )}
      {open ? (
        <div className="dsh-company-charter-item__body">
          {clause.body.length > 0 ? <p className="dsh-company-charter-item__text">{clause.body.join('\n')}</p> : null}
          {hasChildren ? (
            <ul className="dsh-company-charter-list">
              {clause.children.map((child, index) => (
                <CharterRow key={`${index}-${child.title}`} clause={child} path={`${props.path}/${index}`} expanded={props.expanded} onToggle={props.onToggle} />
              ))}
            </ul>
          ) : null}
        </div>
      ) : null}
    </li>
  )
}

function CharterList(props: {
  nodes: SafeCharterClauseView[]
  expanded: ReadonlySet<string>
  onToggle(path: string): void
}): React.JSX.Element {
  return (
    <ul className="dsh-company-charter-list">
      {props.nodes.map((clause, index) => (
        <CharterRow key={`${index}-${clause.title}`} clause={clause} path={`${index}`} expanded={props.expanded} onToggle={props.onToggle} />
      ))}
    </ul>
  )
}

export function OverviewView(props: OverviewViewProps): React.JSX.Element {
  const { snapshot, t, locale, busy = false } = props
  const firstProduct = snapshot.products[0]
  const [name, setName] = useState(snapshot.company.name)
  const [slogan, setSlogan] = useState(snapshot.company.slogan)
  const [mission, setMission] = useState(snapshot.company.mission)
  const [charter, setCharter] = useState(snapshot.company.charter)
  const [productName, setProductName] = useState(firstProduct?.name ?? '')
  const [productSummary, setProductSummary] = useState(firstProduct?.summary ?? '')
  const [productRoot, setProductRoot] = useState(firstProduct?.product_root ?? '')
  const [criteria, setCriteria] = useState((firstProduct?.success_criteria ?? []).join('\n'))
  const [productBudget, setProductBudget] = useState(microsToInput(firstProduct?.budget_micros))
  const [totalBudget, setTotalBudget] = useState(microsToInput(snapshot.budget.total_micros))
  const [currency, setCurrency] = useState(snapshot.budget.currency)
  const [priceRows, setPriceRows] = useState<PriceDraft[]>(() => buildPriceDrafts(snapshot))
  const [editError, setEditError] = useState<string>()
  const [governanceEditing, setGovernanceEditing] = useState(false)
  const [missionOpen, setMissionOpen] = useState(false)
  const [expandedClauses, setExpandedClauses] = useState<Set<string>>(() => new Set(props.initialExpandedClauses ?? []))
  const missionDetailId = useId()
  const formationDirty = useRef(false)
  const pricesDirty = useRef(false)
  const previousCompanyId = useRef(snapshot.company.id)

  useEffect(() => {
    const product = snapshot.products[0]
    // Switching to a different company invalidates drafts typed against the
    // previous one, even when the revision integer happens to be equal.
    if (previousCompanyId.current !== snapshot.company.id) {
      previousCompanyId.current = snapshot.company.id
      formationDirty.current = false
      pricesDirty.current = false
      setExpandedClauses(new Set())
    }
    if (!formationDirty.current) {
      setName(snapshot.company.name)
      setSlogan(snapshot.company.slogan)
      setMission(snapshot.company.mission)
      setCharter(snapshot.company.charter)
      setProductName(product?.name ?? '')
      setProductSummary(product?.summary ?? '')
      setProductRoot(product?.product_root ?? '')
      setCriteria((product?.success_criteria ?? []).join('\n'))
      setProductBudget(microsToInput(product?.budget_micros))
      setTotalBudget(microsToInput(snapshot.budget.total_micros))
      setCurrency(snapshot.budget.currency)
      setEditError(undefined)
    }
    const freshPrices = buildPriceDrafts(snapshot)
    setPriceRows((current) => pricesDirty.current ? mergeModelPriceDrafts(current, freshPrices) : freshPrices)
  }, [snapshot.revision, snapshot.company.id])

  const priceProblems = priceRows.filter((row) => row.enabled && priceState(row) !== 'priced')
  const markFormationDirty = (): void => { formationDirty.current = true }
  const toggleClause = (path: string): void => {
    setExpandedClauses((current) => {
      const next = new Set(current)
      if (next.has(path)) next.delete(path)
      else next.add(path)
      return next
    })
  }
  const updatePrice = (key: string, field: (typeof PRICE_FIELDS)[number], value: string): void => {
    formationDirty.current = true
    pricesDirty.current = true
    setPriceRows((rows) => rows.map((row) => `${row.provider}\u0000${row.model}` === key ? { ...row, [field]: value } : row))
  }
  const togglePrice = (key: string, enabled: boolean): void => {
    formationDirty.current = true
    pricesDirty.current = true
    setPriceRows((rows) => rows.map((row) => `${row.provider}\u0000${row.model}` === key
      ? {
          ...row,
          enabled,
          ...(enabled
            ? enablePreset(row.provider, row.model, currency, row) ?? {}
            : { miss: '', hit: '', output: '' }),
        }
      : row))
  }

  const submitFormation = async (): Promise<void> => {
    if (props.onEditFormation === undefined || firstProduct === undefined) return
    const totalBudgetUnits = decimalMoneyToUnits(totalBudget)
    const productBudgetUnits = decimalMoneyToUnits(productBudget)
    if (totalBudgetUnits === undefined) { setEditError(t('formation.invalidMoney', { field: t('formation.companyBudget') })); return }
    if (productBudgetUnits === undefined) { setEditError(t('formation.invalidMoney', { field: t('formation.productBudget') })); return }
    if (slogan.trim().length === 0 || slogan.trim().length > 160) { setEditError(t('formation.invalidSlogan')); return }
    if (priceProblems.length > 0) {
      const row = priceProblems[0]
      if (row !== undefined) {
        setEditError(t('formation.partialPrice', { route: `${row.provider}/${row.model}` }))
      }
      return
    }
    const modelPrices = modelPriceDraftPayload(priceRows)
    if (modelPrices === undefined) {
      const invalid = priceRows.find((row) => row.enabled && PRICE_FIELDS.some((field) => decimalMoneyToUnits(row[field]) === undefined))
      setEditError(t('formation.invalidMoney', { field: invalid === undefined ? t('formation.prices') : `${invalid.provider}/${invalid.model}` }))
      return
    }
    setEditError(undefined)
    formationDirty.current = false
    pricesDirty.current = false
    const succeeded = await props.onEditFormation({
      name,
      slogan,
      mission,
      charter,
      total_budget: totalBudgetUnits,
      currency,
      model_prices: modelPrices,
      first_product: {
        name: productName,
        summary: productSummary,
        product_root: productRoot,
        success_criteria: criteria.split('\n').map((row) => row.trim()).filter(Boolean),
        product_budget: productBudgetUnits,
      },
    })
    if (!succeeded) {
      formationDirty.current = true
      pricesDirty.current = true
    }
  }

  const submitGovernance = async (): Promise<void> => {
    if (props.onRequestGovernance === undefined) return
    const problem = governanceDraftProblem(slogan, mission, charter)
    if (problem !== undefined) {
      setEditError(problem === 'slogan' ? t('formation.invalidSlogan') : t('overview.invalidGovernance', { field: t(problem === 'mission' ? 'formation.mission' : 'formation.charter') }))
      return
    }
    setEditError(undefined)
    formationDirty.current = false
    const succeeded = await props.onRequestGovernance({
      slogan,
      mission,
      charter,
      expected_governance_revision: snapshot.company.governance_revision,
    })
    if (succeeded) setGovernanceEditing(false)
    else formationDirty.current = true
  }

  const done = completedWorkCount(snapshot.work.map((item) => item.status))
  const total = snapshot.work.length
  const blocked = snapshot.work.filter((item) => item.blocked)
  const activeEmployees = snapshot.employees.filter((employee) => employee.status === 'working' || employee.activity?.state === 'running')
  const pendingApprovals = snapshot.approvals.filter((approval) => approval.status === 'pending')
  const governancePending = pendingApprovals.some((approval) => approval.kind === 'governance_change')
  const messages = snapshot.inbox.filter((message) => message.delivery_state !== 'read').sort((left, right) => right.created_at - left.created_at).slice(0, 5)

  return (
    <div className="dsh-company-view dsh-company-overview">
      <div className="dsh-company-overview__main">
        <header>
          <h2 className="dsh-company-view__heading">{t('overview.heading')}</h2>
          <p className="dsh-company-view__subheading">{t('overview.subheading')}</p>
        </header>
        <div className="dsh-company-governance-grid">
          <section className="dsh-company-card dsh-company-governance-card" data-kind="slogan" style={{ gridColumn: '1 / -1' }}>
            <button type="button" className="dsh-company-governance-card__toggle" aria-expanded={missionOpen} aria-controls={missionDetailId} onClick={() => setMissionOpen((value) => !value)}>
              <ChevronIcon className="dsh-company-chevron" />
              <span className="dsh-company-governance-card__body"><blockquote>{snapshot.company.slogan}</blockquote></span>
              <span className="dsh-company-section__count">{t('overview.governanceRevision', { revision: snapshot.company.governance_revision })}</span>
            </button>
            <div id={missionDetailId} className="dsh-company-governance-card__detail" hidden={!missionOpen}><h2 className="dsh-company-section__title">{t('overview.mission')}</h2><p className="dsh-company-governance-copy">{snapshot.company.mission}</p></div>
          </section>
          <section className="dsh-company-card" style={{ gridColumn: '1 / -1' }}>
            <div className="dsh-company-section__head">
              <h2 className="dsh-company-section__title">{t('overview.charter')}</h2>
              <span className="dsh-company-section__head-meta">
                {governancePending ? <StatusBadge tone="warning">{t('overview.governancePending')}</StatusBadge> : null}
                <span className="dsh-company-section__count">{snapshot.company.charter_outline.length}</span>
              </span>
            </div>
            {snapshot.company.charter_outline.length === 0 ? (
              <p className="dsh-company-empty">{t('overview.noCharter')}</p>
            ) : (
              <CharterList nodes={snapshot.company.charter_outline} expanded={expandedClauses} onToggle={toggleClause} />
            )}
            {props.canRequestGovernance ? (
              <div className="dsh-company-charter-actions">
                <button type="button" className="dsh-company-action" disabled={busy || governancePending} onClick={() => setGovernanceEditing((value) => !value)}>{t('overview.requestGovernance')}</button>
                {governancePending && props.onOpenApprovals !== undefined ? <button type="button" className="dsh-company-action" onClick={props.onOpenApprovals}>{t('tab.approvals')}</button> : null}
              </div>
            ) : null}
          </section>
        </div>

        {governanceEditing ? (
          <section className="dsh-company-card dsh-company-section">
            <div className="dsh-company-formation-grid">
              <label className="dsh-company-field" data-span="12"><span>{t('formation.slogan')}</span><input value={slogan} maxLength={160} onChange={(event) => { markFormationDirty(); setSlogan(event.currentTarget.value) }} /></label>
              <label className="dsh-company-field" data-span="12"><span>{t('formation.mission')}</span><textarea rows={5} value={mission} onChange={(event) => { markFormationDirty(); setMission(event.currentTarget.value) }} /></label>
              <label className="dsh-company-field" data-span="12"><span>{t('formation.charter')}</span><textarea rows={7} value={charter} onChange={(event) => { markFormationDirty(); setCharter(event.currentTarget.value) }} /></label>
            </div>
            {editError === undefined ? null : <div className="dsh-company-banner" data-tone="error" role="alert"><WarningIcon width="15" height="15" />{editError}</div>}
            <div className="dsh-company-formation__footer">
              <button type="button" className="dsh-company-action" disabled={busy} onClick={() => setGovernanceEditing(false)}>{t('common.close')}</button>
              <button type="button" className="dsh-company-action" data-variant="primary" disabled={busy} onClick={() => void submitGovernance()}>{t('overview.requestGovernance')}</button>
            </div>
          </section>
        ) : null}

        {props.canEditFormation && firstProduct !== undefined ? (
          <section className="dsh-company-card dsh-company-section">
            <div className="dsh-company-section__head"><h2 className="dsh-company-section__title">{t('formation.title')}</h2></div>
            <form className="dsh-company-formation" onSubmit={(event) => { event.preventDefault(); void submitFormation() }}>
              <fieldset className="dsh-company-fieldset">
                <legend>{t('formation.identity')}</legend>
                <div className="dsh-company-formation-grid">
                  <label className="dsh-company-field" data-span="8"><span>{t('formation.companyName')}</span><input value={name} onChange={(event) => { markFormationDirty(); setName(event.currentTarget.value) }} /></label>
                  <label className="dsh-company-field" data-span="4"><span>{t('formation.currency')}</span><input value={currency} maxLength={16} onChange={(event) => { markFormationDirty(); setCurrency(event.currentTarget.value.toUpperCase()) }} /></label>
                  <label className="dsh-company-field" data-span="12"><span>{t('formation.slogan')}</span><input value={slogan} maxLength={160} onChange={(event) => { markFormationDirty(); setSlogan(event.currentTarget.value) }} /></label>
                  <label className="dsh-company-field" data-span="12"><span>{t('formation.mission')}</span><textarea rows={5} value={mission} onChange={(event) => { markFormationDirty(); setMission(event.currentTarget.value) }} /></label>
                  <label className="dsh-company-field" data-span="12"><span>{t('formation.charter')}</span><textarea rows={7} value={charter} onChange={(event) => { markFormationDirty(); setCharter(event.currentTarget.value) }} /></label>
                </div>
              </fieldset>
              <fieldset className="dsh-company-fieldset">
                <legend>{t('formation.product')}</legend>
                <div className="dsh-company-formation-grid">
                  <label className="dsh-company-field"><span>{t('formation.productName')}</span><input value={productName} onChange={(event) => { markFormationDirty(); setProductName(event.currentTarget.value) }} /></label>
                  <label className="dsh-company-field"><span>{t('formation.productRoot')}</span><input value={productRoot} onChange={(event) => { markFormationDirty(); setProductRoot(event.currentTarget.value) }} /></label>
                  <label className="dsh-company-field" data-span="12"><span>{t('formation.productSummary')}</span><textarea rows={3} value={productSummary} onChange={(event) => { markFormationDirty(); setProductSummary(event.currentTarget.value) }} /></label>
                  <label className="dsh-company-field" data-span="12"><span>{t('formation.criteria')}</span><textarea rows={4} value={criteria} onChange={(event) => { markFormationDirty(); setCriteria(event.currentTarget.value) }} /></label>
                </div>
              </fieldset>
              <fieldset className="dsh-company-fieldset">
                <legend>{t('formation.money')}</legend>
                <div className="dsh-company-formation-grid">
                  <label className="dsh-company-field"><span>{t('formation.companyBudget')}</span><input type="text" inputMode="decimal" value={totalBudget} onChange={(event) => { markFormationDirty(); setTotalBudget(event.currentTarget.value) }} /><span className="dsh-company-field__hint">{currency}</span></label>
                  <label className="dsh-company-field"><span>{t('formation.productBudget')}</span><input type="text" inputMode="decimal" value={productBudget} onChange={(event) => { markFormationDirty(); setProductBudget(event.currentTarget.value) }} /><span className="dsh-company-field__hint">{currency}</span></label>
                  <div className="dsh-company-field" data-span="12">
                    <div className="dsh-company-section__head">
                      <div><span>{t('formation.prices')}</span><p className="dsh-company-formation__hint">{t('formation.priceHint')}</p></div>
                      {props.canReprobe && props.onReprobe !== undefined ? <button type="button" className="dsh-company-action" disabled={busy} onClick={() => void props.onReprobe?.()}><RefreshIcon width="13" height="13" />{t('formation.reprobe')}</button> : null}
                    </div>
                    <div className="dsh-company-chip-list">
                      <span className="dsh-company-chip">{snapshot.model_catalog.models.length} {t('formation.detected')}</span>
                      {snapshot.model_catalog.probed_at === undefined ? null : <span className="dsh-company-chip">{t('formation.probeAt', { time: formatRelative(snapshot.model_catalog.probed_at, t) })}</span>}
                      {snapshot.model_catalog.errors.length > 0 ? <span className="dsh-company-chip" data-tone="warning">{t('formation.probePartial')}</span> : null}
                    </div>
                    {priceRows.length === 0 ? <p className="dsh-company-empty">{t('formation.probeEmpty')}</p> : <ModelPriceMatrix rows={priceRows} currency={currency} t={t} canEdit onChange={updatePrice} onToggle={togglePrice} />}
                  </div>
                </div>
              </fieldset>
              {editError === undefined ? null : <div className="dsh-company-banner" data-tone="error" role="alert"><WarningIcon width="15" height="15" />{editError}</div>}
              <div className="dsh-company-formation__footer"><button type="submit" className="dsh-company-action" data-variant="primary" disabled={busy}>{t('formation.save')}</button></div>
            </form>
          </section>
        ) : null}

        <section className="dsh-company-section">
          <div className="dsh-company-stats">
            <div className="dsh-company-stat"><div className="dsh-company-stat__head"><span className="dsh-company-stat__icon"><UsersIcon /></span><span className="dsh-company-stat__label">{t('overview.activePeople')}</span></div><strong className="dsh-company-stat__value">{activeEmployees.length}</strong></div>
            <div className="dsh-company-stat"><div className="dsh-company-stat__head"><span className="dsh-company-stat__icon"><WarningIcon /></span><span className="dsh-company-stat__label">{t('overview.pendingApprovals')}</span></div><strong className="dsh-company-stat__value">{pendingApprovals.length}</strong></div>
            <div className="dsh-company-stat"><div className="dsh-company-stat__head"><span className="dsh-company-stat__icon"><WalletIcon /></span><span className="dsh-company-stat__label">{t('overview.availableMoney')}</span></div><strong className="dsh-company-stat__value">{formatMoneyMicros(snapshot.budget.available_micros, snapshot.budget.currency, locale)}</strong></div>
          </div>
        </section>

        <section className="dsh-company-card dsh-company-section">
          <div className="dsh-company-section__head"><h2 className="dsh-company-section__title">{t('overview.blocked')}</h2><span className="dsh-company-section__count">{blocked.length}</span></div>
          {blocked.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('overview.noBlocked')}</p> : <ul className="dsh-company-compact-list">{blocked.map((item) => <li key={item.id}><strong>{item.subject}</strong><span>{item.blocked_reasons.join(' · ')}</span></li>)}</ul>}
        </section>
      </div>

      <aside className="dsh-company-overview__aside">
        <section className="dsh-company-card">
          <div className="dsh-company-section__head"><h2 className="dsh-company-section__title"><UsersIcon width="14" height="14" />{t('overview.activity')}</h2><span className="dsh-company-section__count">{activeEmployees.length}</span></div>
          {activeEmployees.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('overview.activityEmpty')}</p> : <ul className="dsh-company-compact-list">{activeEmployees.map((employee) => <li key={employee.id}><div><strong>{employee.name}</strong><span>{employee.activity?.subject ?? employee.role}</span></div><StatusBadge tone={employeeTone(employee.status)}>{employeeStatusLabel(employee.status, t)}</StatusBadge></li>)}</ul>}
        </section>
        {snapshot.warnings.length > 0 ? <section className="dsh-company-card dsh-company-section"><div className="dsh-company-section__head"><h2 className="dsh-company-section__title">{t('overview.warnings')}</h2><span className="dsh-company-section__count">{snapshot.warnings.length}</span></div><ul className="dsh-company-warning-list">{snapshot.warnings.map((warning, index) => <li key={`${index}-${warning}`}>{warning}</li>)}</ul></section> : null}
        <section className="dsh-company-card dsh-company-section"><div className="dsh-company-section__head"><h2 className="dsh-company-section__title">{t('overview.inbox')}</h2><span className="dsh-company-section__count">{messages.length}</span></div>{messages.length === 0 ? <p className="dsh-company-empty"><InfoIcon />{t('overview.inboxEmpty')}</p> : <ul className="dsh-company-message-list">{messages.map((message) => <li key={message.id}><div className="dsh-company-message-list__meta"><span>{t('overview.from', { sender: message.from })}</span><time dateTime={new Date(message.created_at).toISOString()} title={formatAbsolute(message.created_at, locale)}>{formatRelative(message.created_at, t)}</time></div><p>{message.content}</p></li>)}</ul>}</section>
        <section className="dsh-company-card dsh-company-section"><h2 className="dsh-company-section__title">{t('overview.lastUpdate')}</h2><p className="dsh-company-card__copy" title={formatAbsolute(snapshot.company.updated_at, locale)}>{formatRelative(snapshot.company.updated_at, t)}</p><div className="dsh-company-progress-row"><div className="dsh-company-progress-row__labels"><span>{t('overview.progress')}</span><span>{percent(done, total)}%</span></div><progress className="dsh-company-progress" max={100} value={percent(done, total)} /></div></section>
      </aside>
    </div>
  )
}
