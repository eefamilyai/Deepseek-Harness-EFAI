/**
 * The `aiAccounts` Remote namespace, mounted by the package that owns it.
 *
 * Every other Host Remote surface is mounted by the shared `dsh-api-remotes`
 * assembly. This one mounts itself, so the namespace a settings page calls is
 * owned end to end by this package: the Host service, the generated
 * descriptors, and the Client mount are all shipped and versioned together,
 * and no assembly has to know this surface exists.
 *
 * @module @deepseek-ai/dsh-ai-accounts/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Client `remote` service declaration this half injects.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import contribution from '@deepseek-ai/dsh-ai-accounts/remote'

export type {} from '@deepseek-ai/dsh-ai-accounts/remote'

/** Required service: the typed Client Remote mount point. */
export const inject = ['remote']

/**
 * Mount this package's Remote namespace.
 * @param ctx - Client plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
}
