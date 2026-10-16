/**
 * The Skills tab: the `skillsStudio` Remote namespace, mounted by the package
 * that owns it, a sidebar entry beside Plugins, Profiles, and Automation
 * tasks, and the page it opens with the embedded Skill Builder chat.
 *
 * The namespace is read with `ctx.get` after this half's own mount completes,
 * so the fiber does not wait on a service only it provides.
 *
 * @module @deepseek-ai/dsh-skills-studio/client
 */

import type { Context } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { SessionReference } from '@deepseek-ai/dsh-api-session-controller/client'
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-session/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type {} from '@deepseek-ai/dsh-client-ui-workspace/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import contribution from '@deepseek-ai/dsh-skills-studio/remote'
import { SkillBuilder } from './builder.ts'
import { BuilderConversation } from './BuilderConversation.tsx'
import { en, NS, zh } from './locales.ts'
import { SkillsPage, SkillsPanelIcon, type Answer, type SkillsPageInjected } from './SkillsPage.tsx'

export type { SkillsStudioKey } from './locales.ts'
export type { Answer, SkillsPageInjected, SkillsPageProps } from './SkillsPage.tsx'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface SlotMap {
    /** The Skill Builder's Conversation inside the Skills page, bound to the page's Session. */
    'skillsStudio.builder.conversation': { kind: 'single'; scope: 'session' }
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    skillsStudio: unknown
  }
}

/** The panel id shared by the sidebar entry and the page it opens. */
const PANEL_ID = 'skills' as MainPanelId

/** After Profiles (5) and Automation tasks (10). */
const PANEL_ORDER = 15

/** Where the embedded builder's Session is remembered between visits. */
const BUILDER_KEY = 'dsh.skillsStudio.builderSession'

/** Required services: the slot ledger, locale, the Remote mount point, Sessions, conversation input, and navigation. */
export const inject = ['slots', 'locale', 'remote', 'sessions', 'conversation', 'uiWorkspace', 'workspaces']

/**
 * The message of any thrown value.
 * @param error - the value.
 * @returns its message.
 */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Read a remembered value, tolerating a storage that refuses.
 * @returns the stored Session id, or null.
 */
function remembered(): string | null {
  try {
    return globalThis.localStorage.getItem(BUILDER_KEY)
  } catch {
    return null
  }
}

/**
 * Store or clear the remembered Session, tolerating a storage that refuses.
 * @param sessionId - the id, or null to forget.
 */
function remember(sessionId: string | null): void {
  try {
    if (sessionId === null) globalThis.localStorage.removeItem(BUILDER_KEY)
    else globalThis.localStorage.setItem(BUILDER_KEY, sessionId)
  } catch {
    // A refused storage only means the next visit starts a new chat.
  }
}

/**
 * Mount the namespace, then contribute the sidebar entry, the page, and the embedded conversation.
 * @param ctx - the browser plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'skills-studio: dictionaries')
  const t = ctx.locale.bind(NS)
  const namespace = (): TypertRemoteNamespaceMap['skillsStudio'] | undefined =>
    ctx.get('remote.skillsStudio') as TypertRemoteNamespaceMap['skillsStudio'] | undefined

  /**
   * Make one call and fold its outcome for the page.
   * @param call - the Remote call.
   * @returns the value, or the reason.
   */
  const ask = async <T>(call: (studio: TypertRemoteNamespaceMap['skillsStudio']) => Promise<RemoteResult<T>>): Promise<Answer<T>> => {
    const studio = namespace()
    if (studio === undefined) return { ok: false, message: 'the skills service is not loaded' }
    try {
      const result = await call(studio)
      return result.ok ? { ok: true, value: result.value } : { ok: false, message: result.error.message }
    } catch (error: unknown) {
      return { ok: false, message: messageOf(error) }
    }
  }

  const builder = new SkillBuilder<{ ctx: Context }, SessionReference>({
    start: async () => {
      const answer = await ask(async studio => await studio.startBuilder())
      if (!answer.ok) throw new Error(answer.message)
      return answer.value
    },
    // A Session outside every Workspace opens on the workspace chooser with a locked composer,
    // so the skills folder becomes a Workspace (idempotent) that groups the builder's chats.
    create: async (cwd) => {
      const workspace = await ctx.workspaces.create({ path: cwd })
      return await ctx.sessions.create({ workspaceId: workspace.workspaceId })
    },
    retain: sessionId => ctx.sessions.retain(sessionId as SessionId, { source: 'skillsStudio' }),
    setDraft: (binding, draft) => { ctx.conversation.input.for(binding.ctx).setDraft(draft) },
    show: (sessionId) => { ctx.uiWorkspace.openSession(sessionId as SessionId) },
    remembered,
    remember,
  })
  ctx.effect(() => () => { builder.dispose() }, 'skills-studio: builder session')

  const face = (): SkillsPageInjected => ({
    hooks: { builder: builder.view },
    load: async () => await ask(async studio =>
      await studio.listSkills(ctx.workspaces.list.getSnapshot().items.map(workspace => workspace.path))),
    read: async file => await ask(async studio => await studio.readSkill(file)),
    save: async request => await ask(async studio => await studio.saveSkill(request)),
    remove: async file => await ask(async studio => await studio.trashSkill(file)),
    openBuilder: () => { builder.open() },
    freshBuilder: () => { builder.fresh() },
    closeBuilder: () => { builder.close() },
    launchBuilder: async () => await builder.launch(),
  })

  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: face,
    children: { 'skillsStudio.builder.conversation': { kind: 'single', scope: 'session' } },
  }, SkillsPage))

  ctx.slots.inject('skillsStudio.builder.conversation', () => ctx.slots.register({
    name: 'skillsStudio.builder.conversation',
  }, BuilderConversation))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => t('panel'),
    locale: NS,
  }, SkillsPanelIcon))
}
