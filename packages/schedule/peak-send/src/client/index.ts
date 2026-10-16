/**
 * The `peakSend` Remote namespace, mounted by the package that owns it, so no
 * shared assembly has to know the surface exists.
 *
 * @module @deepseek-ai/dsh-peak-send/client
 */

import type { Context } from '@deepseek-ai/cordis'
// Type-only: pulls the Client `remote` service declaration this half injects.
import type {} from '@deepseek-ai/dsh-api-gateway/client'
import contribution from '@deepseek-ai/dsh-peak-send/remote'

export type {} from '@deepseek-ai/dsh-peak-send/remote'

/** Required service: the typed Client Remote mount point. */
export const inject = ['remote']

/**
 * Mount this package's Remote namespace.
 * @param ctx - Client plugin context.
 */
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
}
