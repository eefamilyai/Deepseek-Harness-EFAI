/**
 * Interaction polish, browser half.
 *
 * One injected stylesheet and one document observer: every rule selects on a contract
 * that outlives a component — design tokens, ARIA roles and states, the app frame's
 * state attributes, element selectors — so the layer keeps working across the whole
 * component tree without knowing any of it. The observer adds the two affordances a
 * stylesheet cannot express: the provider groups' keys and the account pool's row of
 * choices.
 *
 * The sheet is a client-bundle asset rather than a theme layer: the theme service writes
 * `--dsw-*` values, and this layer also retunes the shell's `--ds-*` motion scale, paints
 * materials, and animates overlays — none of which the token registry expresses.
 */
// Tagged style injection owned by the client bundle: imported for its effect,
// deduplicated by the build's `data-plugin-css` tag.
import './polish.css'
import type { Context as ClientContext } from '@deepseek-ai/cordis'
// Type-only: pulls the ctx.locale service and this plugin's LocaleNamespaceMap merge.
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { installModelGroups } from './model-groups.ts'
import { en, zh } from './locales.ts'

/** Dictionary namespace owned by this plugin. */
const NS = 'polish'

/**
 * Required services. The sheet arrives with this module, so it is on the page whether
 * or not the fiber waits; the observer needs the dictionaries for the account choices,
 * and the sheet arms its group contraction on the observer's own marker, so a
 * deployment without this service falls back to upstream's rendered menu.
 */
export const inject = ['locale']

/**
 * The body: evaluate the stylesheet, register the dictionaries, and install the
 * model menu's affordances.
 *
 * Evaluating this module is what injects the sheet. The enhancer is one document
 * observer with no further service to wait for, so it installs here too and its
 * disposer goes on the caller's fiber — a client row that is unloaded must leave no
 * observer behind.
 * @param ctx - client root context, used for the dictionaries and to scope the observer to this row.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-polish: model menu dictionaries')
  const t = ctx.locale.bind(NS)
  ctx.effect(
    () => installModelGroups({ legend: t('polish.account.legend'), auto: t('polish.account.auto') }),
    'ui-polish: model menu affordances',
  )
}
