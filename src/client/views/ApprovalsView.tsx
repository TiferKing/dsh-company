import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot, SafeApprovalView } from '../types.js'
import { ChevronIcon, InfoIcon, ShieldIcon } from '../icons.js'
import {
  approvalKindLabel,
  approvalStatusLabel,
  approvalTone,
  formatAbsolute,
  formatRelative,
  riskLabel,
  StatusBadge,
} from '../ui.js'

export interface ApprovalsViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
  locale: 'zh' | 'en'
  busy: boolean
  onDecision(approval: SafeApprovalView, decision: 'approved' | 'rejected'): void
}

function canResolve(snapshot: CompanySnapshot): boolean {
  if (snapshot.viewer.role !== 'founder') return false
  const permissions = snapshot.viewer.permissions
  return permissions.some((permission) =>
    permission === '*' ||
    permission === 'approval.resolve' ||
    permission === 'resolve_approval' ||
    permission === 'resolve_approvals' ||
    permission === 'company_resolve_approval' ||
    permission === 'approvals:resolve',
  )
}

function ApprovalCard(props: {
  approval: SafeApprovalView
  t: CompanyTranslate
  locale: 'zh' | 'en'
  allowDecision: boolean
  busy: boolean
  onDecision(decision: 'approved' | 'rejected'): void
}): React.JSX.Element {
  const { approval, t, locale } = props
  const pending = approval.status === 'pending'
  return (
    <article className="dsh-company-card dsh-company-approval" data-pending={pending || undefined}>
      <div className="dsh-company-card__title-row">
        <div>
          <h3 className="dsh-company-card__title">{approval.summary}</h3>
          <div className="dsh-company-approval__meta">
            <span>{approvalKindLabel(approval.kind, t)}</span>
            <span className="dsh-company-risk" data-risk={approval.risk}>
              {riskLabel(approval.risk, t)}
            </span>
          </div>
        </div>
        <StatusBadge tone={approvalTone(approval.status)}>
          {approvalStatusLabel(approval.status, t)}
        </StatusBadge>
      </div>

      {approval.detail === undefined ? null : (
        <div className="dsh-company-approval__content">
          <h4 className="dsh-company-approval__fold-label">{t('approvals.content')}</h4>
          <p>{approval.detail}</p>
        </div>
      )}

      {approval.payload_summary !== undefined ? (
        <details className="dsh-company-approval__fold">
          <summary>
            <ChevronIcon className="dsh-company-chevron" />
            <span>{t('approvals.payload')}</span>
          </summary>
          <div className="dsh-company-approval__payload">{approval.payload_summary}</div>
        </details>
      ) : null}

      <details className="dsh-company-approval__fold">
        <summary>
          <ChevronIcon className="dsh-company-chevron" />
          <span>{t('approvals.detailInfo')}</span>
        </summary>
        <div className="dsh-company-approval__detailinfo">
          <div className="dsh-company-approval__meta">
            <span>{approval.id}</span>
            <span>{t('approvals.requestedBy', { actor: approval.requested_by })}</span>
            <span title={formatAbsolute(approval.requested_at, locale)}>
              {t('approvals.requestedAt', { time: formatRelative(approval.requested_at, t) })}
            </span>
            {approval.expires_at === undefined ? null : (
              <span title={formatAbsolute(approval.expires_at, locale)}>
                {t('approvals.expires', { time: formatRelative(approval.expires_at, t) })}
              </span>
            )}
          </div>
          {approval.resolution !== undefined && approval.resolved_at !== undefined ? (
            <p className="dsh-company-card__copy">
              {t('approvals.resolved', {
                decision: t(`decision.${approval.resolution.decision}`),
                time: formatRelative(approval.resolved_at, t),
              })}
              {approval.resolution.note === undefined ? '' : ` · ${approval.resolution.note}`}
              {approval.resolution.human_statement === undefined ? '' : `\n${approval.resolution.human_statement}`}
            </p>
          ) : null}
        </div>
      </details>

      {pending && props.allowDecision ? (
        <div className="dsh-company-approval__actions">
          <button
            type="button"
            className="dsh-company-approval__button"
            data-decision="rejected"
            disabled={props.busy}
            onClick={() => props.onDecision('rejected')}
          >
            {t('approvals.reject')}
          </button>
          <button
            type="button"
            className="dsh-company-approval__button"
            data-decision="approved"
            disabled={props.busy}
            onClick={() => props.onDecision('approved')}
          >
            {t('approvals.approve')}
          </button>
        </div>
      ) : null}
    </article>
  )
}

export function ApprovalsView({ snapshot, t, locale, busy, onDecision }: ApprovalsViewProps): React.JSX.Element {
  const pending = snapshot.approvals
    .filter((approval) => approval.status === 'pending')
    .sort((left, right) => left.requested_at - right.requested_at)
  const history = snapshot.approvals
    .filter((approval) => approval.status !== 'pending')
    .sort((left, right) => (right.resolved_at ?? right.requested_at) - (left.resolved_at ?? left.requested_at))
  const allowDecision = canResolve(snapshot)

  return (
    <div className="dsh-company-view">
      <header>
        <h2 className="dsh-company-view__heading">{t('tab.approvals')}</h2>
        <p className="dsh-company-view__subheading">
          {t('approvals.pendingCount', { count: pending.length })}
        </p>
      </header>

      {snapshot.approvals.length === 0 ? (
        <p className="dsh-company-empty dsh-company-section"><ShieldIcon />{t('approvals.none')}</p>
      ) : (
        <div className="dsh-company-approval-groups">
          <section>
            <div className="dsh-company-section__head">
              <h3 className="dsh-company-section__title">{t('approvals.pending')}</h3>
              <span className="dsh-company-section__count">{pending.length}</span>
            </div>
            {pending.length === 0 ? (
              <p className="dsh-company-empty"><InfoIcon />{t('approvals.none')}</p>
            ) : (
              <div className="dsh-company-approvals">
                {pending.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    t={t}
                    locale={locale}
                    allowDecision={allowDecision}
                    busy={busy}
                    onDecision={(decision) => onDecision(approval, decision)}
                  />
                ))}
              </div>
            )}
          </section>

          {history.length > 0 ? (
            <section>
              <div className="dsh-company-section__head">
                <h3 className="dsh-company-section__title">{t('approvals.history')}</h3>
                <span className="dsh-company-section__count">{history.length}</span>
              </div>
              <div className="dsh-company-approvals">
                {history.map((approval) => (
                  <ApprovalCard
                    key={approval.id}
                    approval={approval}
                    t={t}
                    locale={locale}
                    allowDecision={false}
                    busy={busy}
                    onDecision={() => undefined}
                  />
                ))}
              </div>
            </section>
          ) : null}
        </div>
      )}
    </div>
  )
}
