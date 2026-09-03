export const DEPARTMENT_LOAD_BANDS = ['very_idle', 'normal', 'busy', 'pressure'] as const
export type DepartmentLoadBand = (typeof DEPARTMENT_LOAD_BANDS)[number]
export type DepartmentLoadTone = 'neutral' | 'success' | 'warning' | 'danger'

const PRESENTATION = {
  zh: {
    very_idle: { label: '非常空闲', tone: 'neutral' },
    normal: { label: '正常运转', tone: 'success' },
    busy: { label: '较为繁忙', tone: 'warning' },
    pressure: { label: '压力巨大', tone: 'danger' },
  },
  en: {
    very_idle: { label: 'Very idle', tone: 'neutral' },
    normal: { label: 'Operating normally', tone: 'success' },
    busy: { label: 'Busy', tone: 'warning' },
    pressure: { label: 'Under severe pressure', tone: 'danger' },
  },
} as const satisfies Record<'zh' | 'en', Record<DepartmentLoadBand, { label: string; tone: DepartmentLoadTone }>>

/** Stable Web-only mapping; the Host-projected band remains authoritative. */
export function departmentLoadPresentation(band: DepartmentLoadBand, locale: string): { label: string; tone: DepartmentLoadTone } {
  const table = PRESENTATION[locale as 'zh' | 'en'] ?? PRESENTATION.en
  return table[band]
}
