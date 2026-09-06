import type { ClientContext, SessionId } from '@deepseek-ai/dsh-client-runtime/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import { CompanyButton } from './CompanyButton.js'
import { CompanyDrawer } from './CompanyDrawer.js'
import { CompanyUiController } from './store.js'
import {
  COMPANY_LOCALE_NAMESPACE,
  en,
  zh,
  type CompanyTranslate,
} from './locales.js'
import { installCompanyStyles } from './styles.js'

/** Browser services required by the official slot, locale, and navigation seams. */
export const inject = ['slots', 'sessions', 'locale']

/** Mount the additive company header card and root overlay. */
export function apply(ctx: ClientContext): void {
  const controller = new CompanyUiController()

  ctx.effect(() => {
    const disposeZh = ctx.locale.register(COMPANY_LOCALE_NAMESPACE, 'zh', zh)
    const disposeEn = ctx.locale.register(COMPANY_LOCALE_NAMESPACE, 'en', en)
    return () => {
      disposeEn()
      disposeZh()
    }
  }, 'dsh-company: client dictionaries')
  ctx.effect(() => installCompanyStyles(), 'dsh-company: client styles')
  ctx.effect(() => () => controller.dispose(), 'dsh-company: client controller')

  ctx.on('connection/reset', () => {
    controller.connectionReset()
  })

  ctx.effect(() => {
    const updateVisibility = (): void => {
      controller.setVisible(document.visibilityState !== 'hidden')
    }
    document.addEventListener('visibilitychange', updateVisibility)
    updateVisibility()
    return () => document.removeEventListener('visibilitychange', updateVisibility)
  }, 'dsh-company: visibility-aware polling')

  // Discovery belongs to the plugin lifecycle. The header must not depend on
  // the root overlay being mounted before its first state request can run.
  ctx.effect(() => {
    const syncSession = (): void => controller.setCurrentSession(ctx.sessions.list.getSnapshot().current)
    const unsubscribe = ctx.sessions.list.subscribe(syncSession)
    syncSession()
    return unsubscribe
  }, 'dsh-company: current session discovery')

  const navigateToSession = async (
    targetSessionId: string,
    founderSessionId?: string,
  ): Promise<void> => {
    const target = targetSessionId as SessionId
    const before = ctx.sessions.list.getSnapshot()
    if (before.current === target) {
      controller.close(false)
      return
    }

    let address = ctx.sessions.subagentAddress(target)
    if (address === undefined) {
      const current = before.current
      const currentSummary = current === undefined ? undefined : before.byId[current]
      const parent = founderSessionId ?? currentSummary?.parentId ?? current
      if (parent !== undefined) {
        await ctx.sessions.refreshSubagents(parent as SessionId)
        address = ctx.sessions.subagentAddress(target)
      }
    }

    if (address !== undefined) ctx.sessions.openSubagent(address)
    else ctx.sessions.open(target)
    controller.close(false)
  }

  const translate = ctx.locale.bind(COMPANY_LOCALE_NAMESPACE)
  const t: CompanyTranslate = (key, params) => translate(key, params)
  const injected = () => ({
    controller,
    locale: ctx.locale,
    t,
    navigateToSession,
  })

  ctx.slots.inject('conversation.session.header.actions', () =>
    ctx.slots.register(
      {
        name: 'conversation.session.header.actions',
        id: 'dsh-company-card',
        order: 60,
        inject: injected,
      },
      CompanyButton,
    ),
  )

  ctx.slots.inject('shell.overlay', () =>
    ctx.slots.register(
      {
        name: 'shell.overlay',
        id: 'dsh-company-drawer',
        order: 60,
        inject: injected,
      },
      CompanyDrawer,
    ),
  )
}
