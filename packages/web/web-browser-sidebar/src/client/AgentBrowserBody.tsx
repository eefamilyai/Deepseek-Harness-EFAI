/**
 * The AI Browser tab: a toolbar over the viewport the agent's page is laid on.
 *
 * The page itself is not a child of this component — it is a webview in a root-level
 * layer that the injected `attach` lays over the viewport while the tab is visible — so
 * the component only reports when its viewport can be covered and renders the
 * page's navigation state.
 *
 * @module @deepseek-ai/dsh-web-browser-sidebar/AgentBrowserBody
 */

import { useEffect, useId, useLayoutEffect, useState, type FormEvent, type ReactNode } from 'react'
import {
  IconChevronLeftOutlineRegular,
  IconChevronRightOutlineRegular,
  IconGlobeOutlineRegular,
  IconRefreshOutlineRegular,
  IconRightUpOutlineRegular,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import css from './AgentBrowser.module.css'
import type { AgentTabState } from './pages.ts'

/** Injected face: the shown page's state and the commands the toolbar sends it. */
export interface AgentBrowserInjected {
  readonly hooks: { readonly agentPage: SnapshotStore<AgentTabState> }
  /** @param viewportId - the mounted viewport element's id. @returns ends the attachment. */
  readonly attach: (viewportId: string) => () => void
  /** @param url - an address the operator typed. */
  readonly load: (url: string) => void
  /** @param command - a toolbar history or reload command. */
  readonly command: (command: 'back' | 'forward' | 'reload') => void
}

/** Full body props: runtime share, locale seat, and the injected face. */
export type AgentBrowserBodyProps =
  PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'agentBrowser'> & InjectFace<AgentBrowserInjected>

/** Full title props: runtime share, locale seat, and the injected face. */
export type AgentBrowserTitleProps =
  PropsRuntime<'sidebar.right.pane.tab.title'> & PropsLocale<'agentBrowser'> & InjectFace<AgentBrowserInjected>

/** An address the operator typed, completed to HTTPS when it names no scheme. */
function typedAddress(value: string): string | undefined {
  const trimmed = value.trim()
  if (trimmed === '') return undefined
  const candidate = /^[a-z][a-z\d+.-]*:/iu.test(trimmed) ? trimmed : `https://${trimmed}`
  return /^https?:\/\//iu.test(candidate) && URL.canParse(candidate) ? candidate : undefined
}

/**
 * Render the AI Browser tab.
 * @param props - the tab occurrence, copy, and the shown page.
 * @returns the toolbar, the status line, and the viewport.
 */
export function AgentBrowserBody({ t, useTabInfo, useAgentPage, attach, load, command }: AgentBrowserBodyProps): ReactNode {
  const { tab } = useTabInfo()
  const page = useAgentPage(state => state)
  const viewportId = useId()
  const hasPage = page.pageId !== undefined
  const [draft, setDraft] = useState<{ readonly for: string; readonly value: string } | undefined>()
  const address = draft?.for === page.url ? draft.value : page.url

  useLayoutEffect(() => (tab.visible && hasPage ? attach(viewportId) : undefined), [tab.visible, hasPage, viewportId, attach])
  useEffect(() => tab.actions.bindCommands({ refresh: () => { command('reload') } }), [tab.actions, command])

  const submit = (event: FormEvent): void => {
    event.preventDefault()
    const url = typedAddress(address)
    if (url !== undefined) { load(url); setDraft(undefined) }
  }

  return (
    <div className={css.root}>
      <form className={css.toolbar} onSubmit={submit}>
        <button type="button" className={css.tool} aria-label={t('back')} title={t('back')} disabled={!page.canGoBack} onClick={() => { command('back') }}><IconChevronLeftOutlineRegular /></button>
        <button type="button" className={css.tool} aria-label={t('forward')} title={t('forward')} disabled={!page.canGoForward} onClick={() => { command('forward') }}><IconChevronRightOutlineRegular /></button>
        <button type="button" className={css.tool} aria-label={t('reload')} title={t('reload')} disabled={!hasPage || page.url === ''} onClick={() => { command('reload') }}><IconRefreshOutlineRegular /></button>
        <input
          className={css.address}
          value={address}
          aria-label={t('address')}
          placeholder={t('address')}
          spellCheck={false}
          disabled={!hasPage}
          onChange={(event) => { setDraft({ for: page.url, value: event.currentTarget.value }) }}
        />
        <button type="button" className={css.tool} aria-label={t('external')} title={t('external')} disabled={page.url === ''}
          onClick={() => { window.open(page.url, '_blank', 'noopener,noreferrer') }}
        ><IconRightUpOutlineRegular size={14} /></button>
      </form>
      {hasPage && (
        <div className={css.status} role="status" data-busy={page.busy !== undefined && page.busy !== 'hello' && page.busy !== 'close'}>
          <span className={css.dot} aria-hidden />
          {page.busy === undefined || page.busy === 'hello' || page.busy === 'close' ? t('status.idle') : t(`status.${page.busy}`)}
        </div>
      )}
      {hasPage
        ? <div id={viewportId} className={css.viewport} aria-label={page.title || t('type.label')} aria-busy={page.loading} />
        : <div className={css.empty}>{t('empty')}</div>}
    </div>
  )
}

/**
 * Render the tab chip: the globe and the page's title.
 * @param props - the tab occurrence, copy, and the shown page.
 * @returns the chip content.
 */
export function AgentBrowserTitle({ t, useAgentPage }: AgentBrowserTitleProps): ReactNode {
  const title = useAgentPage(state => state.title)
  return <><IconGlobeOutlineRegular className={css.titleIcon} />{title === '' ? t('type.label') : `${t('type.label')} · ${title}`}</>
}
