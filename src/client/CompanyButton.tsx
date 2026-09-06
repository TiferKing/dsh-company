import type { CompanyButtonProps } from './contracts.js'
import { BuildingIcon } from './icons.js'
import { phaseLabel, useCompanyState, useLocaleSnapshot } from './ui.js'

/** Compact current-session company card in the additive header action row. */
export function CompanyButton({ sessionId, controller, locale, t }: CompanyButtonProps): React.JSX.Element | null {
  const state = useCompanyState(controller)
  useLocaleSnapshot(locale)

  if (state.sessionId !== sessionId || state.companyAbsent) return null
  const { snapshot } = state
  const pending = snapshot?.approvals.filter((approval) => approval.status === 'pending').length ?? 0
  const active = snapshot?.work.filter(
    (item) => item.status === 'claimed' || item.status === 'in_progress',
  ).length ?? 0
  const secondary = snapshot === undefined
    ? t(state.networkError === undefined ? 'button.loading' : 'button.unavailable')
    : pending > 0
      ? t('button.pending', { count: pending })
      : active > 0
        ? t('button.active', { count: active })
        : phaseLabel(snapshot.company.phase, t)
  const name = snapshot?.company.name ?? t('button.name')
  const accessible = `${t('button.open')}: ${name}, ${secondary}`

  return (
    <button
      type="button"
      className="dsh-company-button"
      aria-label={accessible}
      aria-haspopup="dialog"
      aria-expanded={state.open}
      title={accessible}
      onClick={(event) => controller.open(sessionId, event.currentTarget)}
    >
      <span className="dsh-company-button__mark">
        <BuildingIcon width="14" height="14" />
      </span>
      <span className="dsh-company-button__name">{name}</span>
      <span aria-hidden="true" className="dsh-company-button__phase">
        {secondary}
      </span>
      {pending > 0 ? <span className="dsh-company-button__count">{pending}</span> : null}
      {state.stale ? (
        <span className="dsh-company-button__stale" title={t('button.stale')} />
      ) : null}
    </button>
  )
}
