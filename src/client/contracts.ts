import type { SessionId, SessionListState } from '@deepseek-ai/dsh-client-runtime/client'
import type { CompanyTranslate } from './locales.js'
import type { CompanyUiController } from './store.js'

export interface LocaleSnapshotLike {
  active: 'zh' | 'en'
  revision: number
}

export interface LocaleLike {
  getSnapshot(): LocaleSnapshotLike
  subscribe(listener: () => void): () => void
}

export type UseSessions = <Selected>(selector: (state: SessionListState) => Selected) => Selected

export interface CompanyClientInjected {
  controller: CompanyUiController
  locale: LocaleLike
  t: CompanyTranslate
  navigateToSession(targetSessionId: string, founderSessionId?: string): Promise<void>
}

/** Structural public props for the rc.2 session-scoped header seat. */
export interface CompanyButtonProps extends CompanyClientInjected {
  sessionId: SessionId
}

/** Structural public props for the rc.2 root-scoped overlay seat. */
export interface CompanyOverlayProps extends CompanyClientInjected {
  useSessions: UseSessions
}
