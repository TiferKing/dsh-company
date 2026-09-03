import { useMemo, useState } from 'react'
import type { CompanyTranslate } from '../locales.js'
import type { CompanySnapshot, SafeWorkView } from '../types.js'
import { InfoIcon } from '../icons.js'
import {
  employeeDisplayName,
  isTerminalWork,
  StatusBadge,
  workKindLabel,
  workStatusLabel,
  workTone,
} from '../ui.js'

export interface WorkViewProps {
  snapshot: CompanySnapshot
  t: CompanyTranslate
}

type WorkFilter = 'all' | 'active' | 'blocked' | 'done'

function matchesFilter(item: SafeWorkView, filter: WorkFilter, blocked: boolean): boolean {
  switch (filter) {
    case 'all':
      return true
    case 'active':
      return !isTerminalWork(item.status)
    case 'blocked':
      return blocked
    case 'done':
      return isTerminalWork(item.status)
  }
}

function EvidenceList(props: { title: string; values: string[] }): React.JSX.Element | null {
  if (props.values.length === 0) return null
  return (
    <section>
      <h4>{props.title}</h4>
      <ul className="dsh-company-criteria">
        {props.values.map((value, index) => <li key={`${index}-${value}`}>{value}</li>)}
      </ul>
    </section>
  )
}

export function WorkView({ snapshot, t }: WorkViewProps): React.JSX.Element {
  const [filter, setFilter] = useState<WorkFilter>('all')
  const workById = useMemo(
    () => new Map(snapshot.work.map((item) => [item.id, item])),
    [snapshot.work],
  )
  const productById = useMemo(
    () => new Map(snapshot.products.map((product) => [product.id, product])),
    [snapshot.products],
  )

  const rows = useMemo(() => snapshot.work
    .map((item) => {
      const incomplete = item.dependencies
        .map((id) => workById.get(id))
        .filter((dependency): dependency is SafeWorkView => dependency !== undefined && dependency.status !== 'completed')
      return { item, incomplete, blocked: item.blocked || incomplete.length > 0 }
    })
    .filter((row) => matchesFilter(row.item, filter, row.blocked))
    .sort((left, right) => {
      const leftTerminal = isTerminalWork(left.item.status)
      const rightTerminal = isTerminalWork(right.item.status)
      if (leftTerminal !== rightTerminal) return leftTerminal ? 1 : -1
      return (left.item.created_at ?? 0) - (right.item.created_at ?? 0) || left.item.id.localeCompare(right.item.id)
    }), [filter, snapshot.work, workById])

  const filters: WorkFilter[] = ['all', 'active', 'blocked', 'done']

  return (
    <div className="dsh-company-view">
      <header>
        <h2 className="dsh-company-view__heading">{t('tab.work')}</h2>
      </header>

      <div className="dsh-company-filters" role="group" aria-label={t('work.filter.aria')}>
        {filters.map((value) => (
          <button
            type="button"
            className="dsh-company-filter"
            aria-pressed={filter === value}
            key={value}
            onClick={() => setFilter(value)}
          >
            {t(`work.filter.${value}`)}
          </button>
        ))}
      </div>

      {rows.length === 0 ? (
        <p className="dsh-company-empty dsh-company-section"><InfoIcon />{t('work.none')}</p>
      ) : (
        <div className="dsh-company-work-list">
          {rows.map(({ item, incomplete, blocked }) => {
            const product = productById.get(item.product_id)
            const hasDetails = item.objective !== undefined || item.output_summary !== undefined ||
              item.findings.length > 0 || item.evidence !== undefined
            return (
              <article
                className="dsh-company-card dsh-company-work"
                data-blocked={blocked || undefined}
                data-terminal={isTerminalWork(item.status) || undefined}
                key={item.id}
              >
                <div className="dsh-company-card__title-row">
                  <div>
                    <h3 className="dsh-company-card__title">{item.subject}</h3>
                    <div className="dsh-company-work__meta">
                      <span>{item.id}</span>
                      <span>{workKindLabel(item.kind, t)}</span>
                      {product !== undefined ? <span>{product.name}</span> : null}
                      <span>{t('work.owner')}: {employeeDisplayName(item.assignee_id, snapshot.employees, t)}</span>
                      {item.attempt !== undefined && item.attempt > 0 ? (
                        <span>{t('work.attempt', { attempt: item.attempt })}</span>
                      ) : null}
                    </div>
                  </div>
                  <StatusBadge tone={blocked && item.status === 'pending' ? 'warning' : workTone(item.status)}>
                    {blocked && item.status === 'pending' ? t('work.blocked') : workStatusLabel(item.status, t)}
                  </StatusBadge>
                </div>

                <div className="dsh-company-dependencies" aria-label={t('work.dependencies')}>
                  <strong className="dsh-company-section__count">{t('work.dependencies')}:</strong>
                  {item.dependencies.length === 0 ? (
                    <span className="dsh-company-section__count">{t('work.noDependencies')}</span>
                  ) : item.dependencies.map((dependencyId) => {
                    const dependency = workById.get(dependencyId)
                    const complete = dependency?.status === 'completed'
                    return (
                      <span className="dsh-company-dependency" key={dependencyId}>
                        <span className="dsh-company-dependency__state" data-complete={complete || undefined} />
                        {dependency?.subject ?? dependencyId}
                      </span>
                    )
                  })}
                </div>

                {item.approval_dependencies.length > 0 ? (
                  <div className="dsh-company-dependencies" aria-label={t('work.approvals')}>
                    <strong className="dsh-company-section__count">{t('work.approvals')}:</strong>
                    {item.approval_dependencies.map((approvalId) => (
                      <span className="dsh-company-dependency" key={approvalId}>{approvalId}</span>
                    ))}
                  </div>
                ) : null}

                {blocked ? (
                  <div className="dsh-company-banner dsh-company-section">
                    {(item.blocked_reasons.length > 0
                      ? item.blocked_reasons
                      : incomplete.map((dependency) => dependency.subject)
                    ).join(' · ') || t('work.blocked')}
                  </div>
                ) : null}

                {hasDetails ? (
                  <details className="dsh-company-details">
                    <summary>{t('common.expand')}</summary>
                    <div className="dsh-company-details__body">
                      {item.objective !== undefined ? (
                        <section>
                          <h4>{t('work.objective')}</h4>
                          <p>{item.objective}</p>
                        </section>
                      ) : null}
                      {item.output_summary !== undefined ? (
                        <section>
                          <h4>{t('work.result')}</h4>
                          <p>{item.output_summary}</p>
                        </section>
                      ) : null}
                      {item.evidence !== undefined ? (
                        <section>
                          <h4>{t('work.evidence')}</h4>
                          <EvidenceList title={t('work.paths')} values={item.evidence.changed_paths} />
                          <EvidenceList title={t('work.acceptance')} values={item.evidence.acceptance_results} />
                          <EvidenceList title={t('work.commands')} values={item.evidence.commands_run} />
                          <EvidenceList title={t('work.deliverables')} values={item.evidence.deliverables} />
                        </section>
                      ) : null}
                      {item.findings.length > 0 ? (
                        <section>
                          <h4>{t('work.findings')}</h4>
                          <ul className="dsh-company-findings">
                            {item.findings.map((finding) => (
                              <li
                                className="dsh-company-finding"
                                data-severity={finding.severity}
                                key={finding.id}
                              >
                                <strong>{finding.severity}</strong>
                                {finding.file !== undefined ? ` · ${finding.file}${finding.line === undefined ? '' : `:${finding.line}`}` : ''}
                                <div>{finding.problem}</div>
                                <div>{finding.required_fix}</div>
                              </li>
                            ))}
                          </ul>
                        </section>
                      ) : null}
                    </div>
                  </details>
                ) : null}
              </article>
            )
          })}
        </div>
      )}
    </div>
  )
}
