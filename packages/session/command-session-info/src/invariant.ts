/**
 * Package-owned invariant companion for `@deepseek-ai/dsh-command-session-info`.
 * @module @deepseek-ai/dsh-command-session-info/invariant
 */

/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-command-session-info'

/** Cordis companion plugin name. */
export const name = 'command-session-info-invariant'
/** Service required before the companion can reserve package ownership. */
export const inject = ['invariants']

/** This read-only command owns no state or event stream. */
const install: InvariantInstaller = () => {}

/** Register this package's invariant companion. */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
