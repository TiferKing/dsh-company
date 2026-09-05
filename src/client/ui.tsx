import { useSyncExternalStore, type ReactNode } from 'react'
import type { CompanyTranslate, CompanyLocaleKey } from './locales.js'
import type { LocaleLike, LocaleSnapshotLike } from './contracts.js'
import type {
  ApprovalKind,
  ApprovalStatus,
  CompanyPhase,
  EmployeeStatus,
  ProductStatus,
  RiskLevel,
  SafeEmployeeView,
  WorkKind,
  WorkStatus,
} from './types.js'
import type { CompanyUiController, CompanyUiState } from './store.js'

export function useCompanyState(controller: CompanyUiController): CompanyUiState {
  return useSyncExternalStore(controller.subscribe, controller.getSnapshot, controller.getSnapshot)
}

export function useLocaleSnapshot(locale: LocaleLike): LocaleSnapshotLike {
  return useSyncExternalStore(
    (listener) => locale.subscribe(listener),
    () => locale.getSnapshot(),
    () => locale.getSnapshot(),
  )
}

export function phaseLabel(phase: CompanyPhase, t: CompanyTranslate): string {
  return t(`phase.${phase}` as CompanyLocaleKey)
}

export function employeeStatusLabel(status: EmployeeStatus, t: CompanyTranslate): string {
  return t(`status.employee.${status}` as CompanyLocaleKey)
}

export function productStatusLabel(status: ProductStatus, t: CompanyTranslate): string {
  return t(`status.product.${status}` as CompanyLocaleKey)
}

export function workStatusLabel(status: WorkStatus, t: CompanyTranslate): string {
  return t(`status.work.${status}` as CompanyLocaleKey)
}

export function approvalStatusLabel(status: ApprovalStatus, t: CompanyTranslate): string {
  return t(`status.approval.${status}` as CompanyLocaleKey)
}

export function workKindLabel(kind: WorkKind, t: CompanyTranslate): string {
  return t(`kind.${kind}` as CompanyLocaleKey)
}

export function approvalKindLabel(kind: ApprovalKind, t: CompanyTranslate): string {
  return t(`approvalKind.${kind}` as CompanyLocaleKey)
}

export function riskLabel(risk: RiskLevel, t: CompanyTranslate): string {
  return t(`risk.${risk}` as CompanyLocaleKey)
}

export type StatusTone = 'success' | 'warning' | 'danger' | 'active' | 'neutral'

export function phaseTone(phase: CompanyPhase): StatusTone {
  switch (phase) {
    case 'operating':
      return 'success'
    case 'provisioning':
      return 'active'
    case 'staged':
    case 'paused':
      return 'warning'
    case 'provisioning_failed':
    case 'halted':
      return 'danger'
    case 'archived':
      return 'neutral'
  }
}

export function employeeTone(status: EmployeeStatus): StatusTone {
  switch (status) {
    case 'working':
    case 'provisioning':
      return 'active'
    case 'idle':
      return 'success'
    case 'planned':
    case 'paused':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'retired':
      return 'neutral'
  }
}

export function productTone(status: ProductStatus): StatusTone {
  switch (status) {
    case 'active':
    case 'released':
      return 'success'
    case 'validating':
      return 'active'
    case 'proposed':
    case 'approved':
    case 'paused':
      return 'warning'
    case 'cancelled':
      return 'danger'
    case 'retired':
      return 'neutral'
  }
}

export function workTone(status: WorkStatus): StatusTone {
  switch (status) {
    case 'completed':
      return 'success'
    case 'claimed':
    case 'in_progress':
      return 'active'
    case 'pending':
      return 'warning'
    case 'failed':
      return 'danger'
    case 'cancelled':
      return 'neutral'
  }
}

export function approvalTone(status: ApprovalStatus): StatusTone {
  switch (status) {
    case 'approved':
      return 'success'
    case 'pending':
      return 'warning'
    case 'rejected':
      return 'danger'
    case 'cancelled':
    case 'expired':
      return 'neutral'
  }
}

export function StatusBadge(props: { tone: StatusTone; children: ReactNode }): React.JSX.Element {
  return (
    <span className="dsh-company-status" data-tone={props.tone}>
      {props.children}
    </span>
  )
}

export function formatMoneyMicros(micros: number | undefined, currency: string, locale: 'zh' | 'en'): string {
  if (micros === undefined || !Number.isFinite(micros)) return '—'
  const value = micros / 1_000_000
  const language = locale === 'zh' ? 'zh-CN' : 'en'
  try {
    return new Intl.NumberFormat(language, {
      style: 'currency',
      currency,
      currencyDisplay: 'code',
      minimumFractionDigits: 2,
      maximumFractionDigits: 6,
    }).format(value)
  } catch {
    return `${currency} ${value.toLocaleString(language, { minimumFractionDigits: 2, maximumFractionDigits: 6 })}`
  }
}

export function formatDecimal(value: number, locale: 'zh' | 'en', maximumFractionDigits = 2): string {
  return value.toLocaleString(locale === 'zh' ? 'zh-CN' : 'en', { maximumFractionDigits })
}

export function formatRelative(timestamp: number | undefined, t: CompanyTranslate, now = Date.now()): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return t('time.unknown')
  const elapsed = Math.max(0, now - timestamp)
  const minutes = Math.floor(elapsed / 60_000)
  if (minutes < 1) return t('time.now')
  if (minutes < 60) return t('time.minutesAgo', { count: minutes })
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return t('time.hoursAgo', { count: hours })
  return t('time.daysAgo', { count: Math.floor(hours / 24) })
}

export function formatAbsolute(timestamp: number | undefined, locale: 'zh' | 'en'): string {
  if (timestamp === undefined || !Number.isFinite(timestamp)) return '—'
  return new Intl.DateTimeFormat(locale === 'zh' ? 'zh-CN' : 'en', {
    dateStyle: 'medium',
    timeStyle: 'short',
  }).format(new Date(timestamp))
}

export function initials(name: string): string {
  const parts = name.trim().split(/\s+/u).filter(Boolean)
  if (parts.length === 0) return 'AI'
  if (parts.length === 1) return [...(parts[0] ?? '')].slice(0, 2).join('').toUpperCase()
  return `${[...(parts[0] ?? '')][0] ?? ''}${[...(parts.at(-1) ?? '')][0] ?? ''}`.toUpperCase()
}

export function employeeDisplayName(id: string | undefined, employees: SafeEmployeeView[], t: CompanyTranslate): string {
  if (id === undefined) return t('work.unassigned')
  if (id === 'founder') return t('work.founder')
  return employees.find((employee) => employee.id === id)?.name ?? id
}

export function isTerminalWork(status: WorkStatus): boolean {
  return status === 'completed' || status === 'failed' || status === 'cancelled'
}

export function completedWorkCount(statuses: readonly WorkStatus[]): number {
  return statuses.filter((status) => status === 'completed').length
}

export function percent(numerator: number, denominator: number): number {
  if (denominator <= 0) return 0
  return Math.max(0, Math.min(100, Math.round((numerator / denominator) * 100)))
}
