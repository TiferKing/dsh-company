import { useState } from 'react'
import type { CompanyLocaleKey, CompanyTranslate } from '../locales.js'
import type { CompanySnapshot, SafeTicketView, TicketSeverity, TicketStatus } from '../types.js'
import { InfoIcon, TicketIcon, WarningIcon } from '../icons.js'
import { formatAbsolute, formatRelative, StatusBadge } from '../ui.js'

export interface TicketsViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  busy?: boolean
  canFile?: boolean
  onFileTicket?(payload: Record<string, unknown>): Promise<boolean>
}

const SEVERITY_TONE: Record<TicketSeverity, 'success' | 'warning' | 'danger' | 'active'> = {
  low: 'success',
  medium: 'active',
  high: 'warning',
  urgent: 'danger',
}

const STATUS_TONE: Record<TicketStatus, 'warning' | 'active' | 'neutral' | 'success'> = {
  filed: 'warning',
  triaged: 'active',
  dispatched: 'active',
  resolved: 'success',
  closed: 'neutral',
}

const GROUPS: Array<{ statuses: TicketStatus[]; key: CompanyLocaleKey }> = [
  { statuses: ['filed'], key: 'tickets.group.awaitingTriage' },
  { statuses: ['triaged'], key: 'tickets.group.awaitingDispatch' },
  { statuses: ['dispatched'], key: 'tickets.group.dispatched' },
  { statuses: ['resolved'], key: 'tickets.group.resolved' },
  { statuses: ['closed'], key: 'tickets.group.closed' },
]

function severityLabel(severity: TicketSeverity | undefined, t: CompanyTranslate): string {
  return severity === undefined ? t('tickets.severity.unset') : t(`tickets.severity.${severity}`)
}

function TicketRow(props: { ticket: SafeTicketView; snapshot: CompanySnapshot; t: CompanyTranslate; locale: 'zh' | 'en' }): React.JSX.Element {
  const { ticket, snapshot, t, locale } = props
  const product = snapshot.products.find((candidate) => candidate.id === ticket.product_id)
  const assignee = snapshot.employees.find((candidate) => candidate.id === ticket.assignee_id)
  const work = ticket.work_item_id === undefined ? undefined : snapshot.work.find((candidate) => candidate.id === ticket.work_item_id)
  return (
    <li className="dsh-company-compact-list">
      <div className="dsh-company-ticket">
        <div className="dsh-company-ticket__head">
          <span className="dsh-company-ticket__title">{ticket.title}</span>
          <span className="dsh-company-ticket__badges">
            <span className="dsh-company-chip" data-tone={ticket.severity === undefined ? undefined : SEVERITY_TONE[ticket.severity]}>{severityLabel(ticket.severity, t)}</span>
            <StatusBadge tone={STATUS_TONE[ticket.status]}>{t(`tickets.status.${ticket.status}`)}</StatusBadge>
          </span>
        </div>
        <div className="dsh-company-ticket__meta">
          <span>{ticket.id} · {product?.name ?? ticket.product_id}</span>
          {assignee === undefined ? null : <span>{t('tickets.assignee')}: {assignee.name}</span>}
          {work === undefined ? null : <span>{t('tickets.work')}: {work.id} · {t(`status.work.${work.status}`)}</span>}
          <span title={formatAbsolute(ticket.reported_at, locale)}>{t('tickets.reportedAt', { time: formatRelative(ticket.reported_at, t) })}</span>
        </div>
        {ticket.status === 'closed' && ticket.reply !== undefined ? (
          <p className="dsh-company-ticket__reply">{ticket.reply}</p>
        ) : null}
      </div>
    </li>
  )
}

export function TicketsView(props: TicketsViewProps): React.JSX.Element {
  const { snapshot, t, locale, busy = false, canFile = false } = props
  const [productId, setProductId] = useState(snapshot.products[0]?.id ?? '')
  const [title, setTitle] = useState('')
  const [description, setDescription] = useState('')
  const [error, setError] = useState<string>()
  const awaiting = snapshot.tickets.filter((ticket) => ['filed', 'triaged', 'resolved'].includes(ticket.status)).length

  const submit = async (): Promise<void> => {
    if (props.onFileTicket === undefined) return
    if (productId === '') { setError(t('tickets.error.product')); return }
    if (title.trim() === '') { setError(t('tickets.error.title')); return }
    if (description.trim() === '') { setError(t('tickets.error.description')); return }
    setError(undefined)
    const succeeded = await props.onFileTicket({ product_id: productId, title: title.trim(), description: description.trim() })
    if (succeeded) {
      setTitle('')
      setDescription('')
    }
  }

  return (
    <div className="dsh-company-view">
      <header>
        <h2 className="dsh-company-view__heading">{t('tickets.heading')}</h2>
        <p className="dsh-company-view__subheading">{t('tickets.subheading')}</p>
      </header>

      {canFile && props.onFileTicket !== undefined && snapshot.products.length > 0 ? (
        <section className="dsh-company-card dsh-company-section">
          <div className="dsh-company-section__head"><h3 className="dsh-company-section__title"><TicketIcon width="14" height="14" />{t('tickets.file')}</h3></div>
          <div className="dsh-company-formation-grid">
            <label className="dsh-company-field" data-span="4"><span>{t('tickets.product')}</span>
              <select value={productId} onChange={(event) => setProductId(event.currentTarget.value)}>
                {snapshot.products.map((product) => <option value={product.id} key={product.id}>{product.name}</option>)}
              </select>
            </label>
            <label className="dsh-company-field" data-span="8"><span>{t('tickets.titleLabel')}</span>
              <input value={title} maxLength={200} onChange={(event) => setTitle(event.currentTarget.value)} />
            </label>
            <label className="dsh-company-field" data-span="12"><span>{t('tickets.descriptionLabel')}</span>
              <textarea rows={4} value={description} onChange={(event) => setDescription(event.currentTarget.value)} />
            </label>
          </div>
          {error === undefined ? null : <div className="dsh-company-banner dsh-company-section" data-tone="error" role="alert"><WarningIcon width="14" height="14" />{error}</div>}
          <div className="dsh-company-inline-actions dsh-company-section">
            <button type="button" className="dsh-company-action" data-variant="primary" disabled={busy} onClick={() => void submit()}>{t('tickets.submit')}</button>
          </div>
        </section>
      ) : null}

      {GROUPS.map((group) => {
        const rows = snapshot.tickets.filter((ticket) => group.statuses.includes(ticket.status))
        if (rows.length === 0) return null
        return (
          <section className="dsh-company-section" key={group.key}>
            <div className="dsh-company-section__head">
              <h3 className="dsh-company-section__title">{t(group.key)}</h3>
              <span className="dsh-company-section__count">{rows.length}</span>
            </div>
            <ul className="dsh-company-ticket-list">
              {rows.map((ticket) => <TicketRow key={ticket.id} ticket={ticket} snapshot={snapshot} t={t} locale={locale} />)}
            </ul>
          </section>
        )
      })}

      {snapshot.tickets.length === 0 ? (
        <p className="dsh-company-empty dsh-company-section"><InfoIcon />{t('tickets.none')}</p>
      ) : null}
      {awaiting > 0 ? (
        <div className="dsh-company-banner dsh-company-section" role="status">
          <InfoIcon width="15" height="15" />
          <span>{t('tickets.awaitingDecisions', { count: awaiting })}</span>
        </div>
      ) : null}
    </div>
  )
}
