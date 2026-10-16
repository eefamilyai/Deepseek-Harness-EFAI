/**
 * The `profileHub` Remote namespace, mounted by the package that owns it, and
 * the three surfaces that call it: a landing page in the frame's overlay, a
 * page in the main column, and the sidebar entry that opens it.
 *
 * This half mounts its own namespace instead of extending a shared assembly, so
 * no Remote assembly has to know the surface exists. The namespace is then read
 * with `ctx.get` rather than a declared injection: a fiber that declared
 * `remote.profileHub` would wait for a service only this half provides, so the
 * mount is complete before the first call and the read needs no inject.
 *
 * @module @deepseek-ai/dsh-profile-hub/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Client `remote` service declaration this half mounts into.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
// Type-only: pulls the `ctx.remote` merge and its fixed Host facts.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
// Type-only: pulls ctx.locale into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
// Type-only: the `main` panel key and the `shell.overlay` seat, declared by ui-layout.
import type { MainPanelId } from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-layout/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
// Type-only: the `sidebar.panellist` seat this half registers an entry into.
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import type { RemoteResult, TypertRemoteNamespaceMap } from '@deepseek-ai/dsh-typert-protocol'
import type { OpenProfileTarget, ProfileHubState } from '@deepseek-ai/dsh-profile-hub/types'
import contribution from '@deepseek-ai/dsh-profile-hub/remote'
import { ProfilesLanding, ProfilesPanel, ProfilesPanelIcon } from './ProfilesSurface.tsx'
import type { ProfilesLoad, ProfilesOpenResult, ProfilesSurfaceInjected } from './ProfilesSurface.tsx'
import { en, zh } from './locales.ts'

export type { ProfileHubKey } from './locales.ts'
export type {
  ProfilesLandingProps,
  ProfilesLoad,
  ProfilesOpenResult,
  ProfilesPanelProps,
  ProfilesSurfaceInjected,
} from './ProfilesSurface.tsx'

/** Dictionary namespace owned by this plugin. */
const NS = 'profileHub'

/** The panel id shared by the sidebar entry and the page it opens. */
const PANEL_ID = 'profiles' as MainPanelId

/** Where the entry sits among the sidebar's panels. */
const PANEL_ORDER = 5

/** Required service: the typed Client Remote mount point, the slot ledger, and the locale seat. */
export const inject = ['slots', 'locale', 'remote']

/** The message of any thrown value, for a call that never reached the Host. */
function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error)
}

/**
 * Mount this package's Remote namespace, then contribute its three surfaces.
 * @param ctx - the browser plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'profile-hub: dictionaries')
  const t = ctx.locale.bind(NS)

  /** The mounted namespace; absent only before this half's own mount completes. */
  const namespace = (): TypertRemoteNamespaceMap['profileHub'] | undefined =>
    ctx.get('remote.profileHub') as TypertRemoteNamespaceMap['profileHub'] | undefined

  /**
   * Run one call that answers with the machine's state.
   * @param call - the Remote call to make against the mounted namespace.
   * @returns the state, or the reason the call could not answer it.
   */
  const loadState = async (
    call: (hub: TypertRemoteNamespaceMap['profileHub']) => Promise<RemoteResult<ProfileHubState>>,
  ): Promise<ProfilesLoad> => {
    const hub = namespace()
    if (hub === undefined) return { ok: false, message: t('profileHub.missing') }
    try {
      const result = await call(hub)
      return result.ok ? { ok: true, state: result.value } : { ok: false, message: result.error.message }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  /**
   * Enter one profile on the surface the caller chose.
   * @param name - the profile to open.
   * @param target - a second Desktop window, or a Web Host reached by URL.
   * @returns whether the launch was accepted, and the reason when it was not.
   */
  const open = async (name: string, target: OpenProfileTarget): Promise<ProfilesOpenResult> => {
    const hub = namespace()
    if (hub === undefined) return { ok: false, message: t('profileHub.missing') }
    try {
      const result = await hub.openProfile(name, target)
      if (!result.ok) return { ok: false, message: result.error.message }
      // A Web Host is a different origin with its own one-boot token, so entering
      // one is a navigation. A Desktop window brings its own.
      if (result.value.opened === 'browser' && result.value.url !== undefined) {
        window.location.assign(result.value.url)
      }
      return { ok: true, opened: result.value.opened }
    } catch (error) {
      return { ok: false, message: messageOf(error) }
    }
  }

  const face = (): ProfilesSurfaceInjected => ({
    load: async () => await loadState(async hub => await hub.listProfiles()),
    create: async request => await loadState(async hub => await hub.createProfile(request)),
    remove: async name => await loadState(async hub => await hub.removeProfile(name)),
    stop: async name => await loadState(async hub => await hub.stopProfile(name)),
    makeLauncher: async name => await loadState(async hub => await hub.setLauncherProfile(name)),
    openInApp: async name => await open(name, 'app'),
    openInBrowser: async name => await open(name, 'browser'),
  })

  // The startup landing: shown only by the profile that is the launcher.
  ctx.slots.inject('shell.overlay', () => ctx.slots.register({
    name: 'shell.overlay',
    id: 'profile-hub.landing',
    locale: NS,
    inject: face,
  }, ProfilesLanding))

  // The same list as a page in the main column, reached from the sidebar.
  ctx.slots.inject('main', () => ctx.slots.register({
    name: 'main',
    key: PANEL_ID,
    locale: NS,
    inject: face,
  }, ProfilesPanel))

  ctx.slots.inject('sidebar.panellist', () => ctx.slots.register({
    name: 'sidebar.panellist',
    id: PANEL_ID,
    order: PANEL_ORDER,
    label: () => t('profileHub.panel'),
    locale: NS,
  }, ProfilesPanelIcon))
}
