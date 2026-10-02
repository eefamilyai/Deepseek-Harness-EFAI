/**
 * The fork's brand occupants for the generic browser-brand slots.
 *
 * Upstream's `dsh-client-ui-brand-official` registers the same two occupants
 * only when the client is built with `DSH_CLIENT_BUILD_PROFILE=official`, so
 * every other build falls through to the shell's "DSH Local Build" fallback and
 * its version badge. This package registers them unconditionally, which is what
 * a deployment whose identity IS DeepSeek Harness wants — and it is a package
 * the official Desktop's `app.asar` does not ship, so the fork's brand is the
 * one that renders there.
 *
 * The conversation hero keeps its declaring package's animated fish: this
 * package registers nothing into `conversation.hero.brand.mark`.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client'
import type {} from '@deepseek-ai/dsh-client-ui-sidebar/client'
import { EfaiBrandMark, EfaiBrandName } from './Brand.tsx'

export { BRAND_NAME, EfaiBrandMark, EfaiBrandName } from './Brand.tsx'

/** Required service: the UI slot registry. */
export const inject = ['slots']

/**
 * Fill the sidebar brand slots as one declaration-aware registration set.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.slots.inject('sidebar.brand.mark', () =>
    ctx.slots.inject('sidebar.brand.name', function* () {
      yield ctx.slots.register({ name: 'sidebar.brand.mark' }, EfaiBrandMark)
      yield ctx.slots.register({ name: 'sidebar.brand.name' }, EfaiBrandName)
    }))
}
