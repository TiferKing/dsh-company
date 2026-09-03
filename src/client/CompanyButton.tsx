import { useEffect } from 'react'
import type { CompanyButtonProps } from './contracts.js'
import { BuildingIcon } from './icons.js'
import { phaseLabel, useCompanyState, useLocaleSnapshot } from './ui.js'

/** Compact current-session company card in the additive header action row. */
export function CompanyButton({ sessionId, controller, locale, t }: CompanyButtonProps): React.JSX.Element | null {
  const state = useCompanyState(controller)
  useLocaleSnapshot(locale)

  useEffect(() => {
    controller.setCurrentSession(sessionId)
  }, [controller, sessionId])

  if (state.sessionId !== sessionId || state.snapshot === undefined) return null
  const { snapshot } = state
  const pending = snapshot.approvals.filter((approval) => approval.status === 'pending').length
  const active = snapshot.work.filter(
    (item) => item.status === 'claimed' || item.status === 'in_progress',
  ).length
  const secondary = pending > 0
    ? t('button.pending', { count: pending })
    : active > 0
      ? t('button.active', { count: active })
      : phaseLabel(snapshot.company.phase, t)
  const accessible = `${t('button.open')}: ${snapshot.company.name}, ${secondary}`

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
      <span className="dsh-company-button__name">{snapshot.company.name}</span>
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
