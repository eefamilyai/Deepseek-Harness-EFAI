/**
 * Browser half of provider visibility: a switch inside every provider card of
 * the Models settings page, on when the provider shows in the model picker, and
 * a list at the end of the page for the providers no card shows (pooled account
 * logins, and a hidden provider whose card left with it).
 *
 * The footer list merges the picker's own catalog (which no longer carries hidden
 * providers) with the `model-visibility` row's hidden entries, which record each
 * hidden provider's name. A switch writes that row; the settings write makes the
 * picker reload its catalog, and the list reloads with it.
 *
 * The card slot is keyed by the card's settings namespace, so the switch is
 * registered under every namespace the provider directory declares, plus the
 * empty key a registered-but-undeclared provider's card dispatches with. It
 * registers at a low priority, so a namespace's own companion plugin shadows it.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import { createSnapshotStore } from '@deepseek-ai/dsh-client-store'
// Type-only: pulls ctx.locale, ctx.slots, ctx.configForms, and the Models footer slot into this program.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import type {} from '@deepseek-ai/dsh-client-ui-settings-models/client'
// Type-only: pulls ctx.remote.session and ctx.remote.$on.
import type {} from '@deepseek-ai/dsh-api-remotes/client'
import type { Config, HiddenProvider } from '../index.ts'
import { en, NS, zh } from './locales.ts'
import { providerRows, toggled, uncarded, type CatalogProvider, type VisibilityView } from './model.ts'
import { ProviderCardSwitch, type CardVisibility, type ProviderCardSwitchInjected } from './ProviderCardSwitch.tsx'
import { VisibilityList, type VisibilityListInjected } from './VisibilityList.tsx'

/** Settings namespace: this plugin's profile row id. */
const ENTRY_ID = 'model-visibility'

/** The row's fields as the browser reads them. */
type VisibilityFields = { [K in keyof Config]?: HiddenProvider[] }

/** Card-slot priority: above the default, so a namespace's own companion plugin renders instead. */
const CARD_PRIORITY = 100

/** Services required: slots, locale, settings forms, and the Remote gateway. */
export const inject = ['slots', 'locale', 'configForms', 'remote', 'remote.session', 'remote.llm']

/**
 * Keep the list current and register it in the Models page footer.
 * @param ctx - client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-model-visibility: dictionaries')
  const form = ctx.configForms.get<VisibilityFields>(ENTRY_ID)
  const visibility = createSnapshotStore<VisibilityView>({ kind: 'loading' })
  const saveFailed = createSnapshotStore(false)
  const cardVisibility = createSnapshotStore<CardVisibility>({ hidden: null, writable: false })
  /** Provider id → how many mounted cards show it. */
  const cards = new Map<string, number>()
  let catalog: readonly CatalogProvider[] | null = null
  let catalogError: string | null = null

  const publish = (): void => {
    const snapshot = form.getSnapshot()
    cardVisibility.set({
      hidden: snapshot.status === 'loading' || snapshot.status === 'unavailable' ? null : snapshot.value?.hidden ?? [],
      writable: snapshot.writable,
    })
    if (snapshot.status === 'unavailable') { visibility.set({ kind: 'unavailable' }); return }
    if (catalogError !== null) { visibility.set({ kind: 'error', message: catalogError }); return }
    if (snapshot.status === 'loading' || catalog === null) { visibility.set({ kind: 'loading' }); return }
    const rows = uncarded(providerRows(catalog, snapshot.value?.hidden ?? []), new Set(cards.keys()))
    visibility.set({ kind: 'ready', rows, writable: snapshot.writable })
  }
  let generation = 0
  const reload = (): void => {
    const current = ++generation
    void ctx.remote.session.modelCatalog().then((response) => {
      if (current !== generation) return
      if (response.ok) {
        catalog = [...response.value.groups, ...response.value.failures].map(({ id, name }) => ({ id, name }))
        catalogError = null
      } else {
        catalogError = response.error.message
      }
      publish()
    })
  }

  ctx.effect(() => form.subscribe(publish), 'ui-model-visibility: row')
  ctx.effect(() => ctx.remote.$on('settings/document-updated', reload), 'ui-model-visibility: settings')
  ctx.effect(() => ctx.remote.$on('llm/adapters-updated', reload), 'ui-model-visibility: providers')
  reload()

  const setVisible = (row: CatalogProvider, visible: boolean): void => {
    const hidden = toggled(form.getSnapshot().value?.hidden ?? [], row, visible)
    void form.set('hidden', hidden).then((saved) => { saveFailed.set(!saved) })
  }

  const carded = (id: string): (() => void) => {
    cards.set(id, (cards.get(id) ?? 0) + 1)
    publish()
    return () => {
      // The count is at least this registration's own while it is unreleased.
      const left = Number(cards.get(id)) - 1
      if (left > 0) cards.set(id, left)
      else cards.delete(id)
      publish()
    }
  }
  const cardFace: ProviderCardSwitchInjected = { hooks: { cardVisibility }, setVisible, carded }

  ctx.slots.inject('settings.models.provider-card', () => {
    const registered = new Map<string, () => void>()
    const add = (namespace: string): void => {
      if (registered.has(namespace)) return
      registered.set(namespace, ctx.slots.register({
        name: 'settings.models.provider-card',
        key: namespace,
        priority: CARD_PRIORITY,
        locale: NS,
        inject: (): ProviderCardSwitchInjected => cardFace,
      }, ProviderCardSwitch))
    }
    let alive = true
    const discover = (): void => {
      void ctx.remote.llm.listConfigurableProviders().then((response) => {
        if (!alive || !response.ok) return
        for (const entry of response.value) add(entry.settingsNs)
      })
    }
    add('')
    discover()
    const off = ctx.remote.$on('llm/adapters-updated', discover)
    return () => {
      alive = false
      off()
      for (const dispose of registered.values()) dispose()
      registered.clear()
    }
  })

  ctx.slots.inject('settings.models.footer', () => ctx.slots.register({
    name: 'settings.models.footer',
    id: 'model-visibility',
    order: 0,
    locale: NS,
    inject: (): VisibilityListInjected => ({ hooks: { visibility, saveFailed }, setVisible }),
  }, VisibilityList))
}
