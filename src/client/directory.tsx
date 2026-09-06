import { useEffect, useState } from 'react'
import type { CompanyTranslate } from './locales.js'
import type { CompanySnapshot, SnapshotPage, SnapshotQuery } from './types.js'

export function DirectoryPage(props: { page: SnapshotPage; label: string; busy?: boolean; t: CompanyTranslate; onOffset?(offset: number): void }): React.JSX.Element {
  const { page, t } = props
  return <nav className="dsh-company-inline-actions dsh-company-section" aria-label={props.label}>
    <span>{props.label} · {t('directory.range', { start: page.returned === 0 ? 0 : page.offset + 1, end: page.offset + page.returned, total: page.filtered_total })}</span>
    <button type="button" className="dsh-company-action" disabled={props.busy || page.offset === 0 || props.onOffset === undefined} onClick={() => props.onOffset?.(Math.max(0, page.offset - page.limit))}>{t('directory.previous')}</button>
    <button type="button" className="dsh-company-action" disabled={props.busy || page.next_offset === null || props.onOffset === undefined} onClick={() => { if (page.next_offset !== null) props.onOffset?.(page.next_offset) }}>{t('directory.next')}</button>
  </nav>
}

export function EmployeeDirectoryControls(props: { snapshot: CompanySnapshot; busy?: boolean; t: CompanyTranslate; onQuery?(query: SnapshotQuery): void }): React.JSX.Element | null {
  const page = props.snapshot.directory?.employees
  const [search, setSearch] = useState(page?.query.employeeSearch ?? '')
  useEffect(() => setSearch(page?.query.employeeSearch ?? ''), [page?.query.employeeSearch])
  if (page === undefined) return null
  const { query } = page
  return <div className="dsh-company-section">
    <form className="dsh-company-inline-actions" onSubmit={(event) => { event.preventDefault(); props.onQuery?.({ ...query, employeeOffset: 0, employeeSearch: search, employeeId: undefined }) }}>
      <input aria-label={props.t('directory.search')} placeholder={props.t('directory.search')} value={search} maxLength={256} disabled={props.busy} onChange={(event) => setSearch(event.currentTarget.value)} />
      <select aria-label={props.t('directory.status')} value={query.employeeStatus ?? 'all'} disabled={props.busy} onChange={(event) => props.onQuery?.({ ...query, employeeOffset: 0, employeeExactStatus: undefined, employeeStatus: event.currentTarget.value as SnapshotQuery['employeeStatus'] })}>
        {(['all', 'active', 'retired', 'running'] as const).map((status) => <option key={status} value={status}>{props.t(`directory.${status}`)}</option>)}
      </select>
      <button type="submit" className="dsh-company-action" disabled={props.busy || props.onQuery === undefined}>{props.t('directory.searchAction')}</button>
      <button type="button" className="dsh-company-action" disabled={props.busy || props.onQuery === undefined} onClick={() => props.onQuery?.({ ...query, employeeOffset: 0, employeeSearch: undefined, employeeId: undefined, employeeOrgUnitId: undefined, employeePositionId: undefined, employeeStatus: 'all', employeeExactStatus: undefined })}>{props.t('directory.clear')}</button>
    </form>
    {query.employeeOrgUnitId === undefined && query.employeePositionId === undefined && query.employeeId === undefined ? null : <p className="dsh-company-formation__hint">{props.t('directory.scope')}: {query.employeeOrgUnitId ?? query.employeePositionId ?? query.employeeId}</p>}
    <DirectoryPage page={page} label={props.t('organization.employees')} busy={props.busy} t={props.t} onOffset={(employeeOffset) => props.onQuery?.({ ...query, employeeOffset })} />
  </div>
}
