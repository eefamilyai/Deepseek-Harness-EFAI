/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-host-chromium-surface`.
 * @module @deepseek-ai/dsh-host-chromium-surface/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-host-chromium-surface'

/** Cordis companion plugin name. */
export const name = 'chromium-surface-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** No runtime invariant: the surface exposes no independent event stream. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
