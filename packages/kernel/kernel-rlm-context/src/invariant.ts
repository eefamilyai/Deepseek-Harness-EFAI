/**
 * Invariant companion for the RLM read-back seam.
 *
 * No runtime invariant: the package contributes one runtime-context read per
 * assembly and holds no state that could drift between two live services.
 * @module @deepseek-ai/dsh-kernel-rlm-context/invariant
 */
/* jscpd:ignore-start */
import type { Context } from '@deepseek-ai/cordis'
import type { InvariantInstaller } from '@deepseek-ai/dsh-invariants'

const PACKAGE_NAME = '@deepseek-ai/dsh-kernel-rlm-context'

export const name = 'kernel-rlm-context-invariant'
export const inject = ['invariants']

const install: InvariantInstaller = () => {}

/**
 * Register this package's invariant companion.
 * @param ctx - Cordis context carrying the invariant service.
 * @returns the registration disposer.
 */
export const apply = (ctx: Context): Promise<() => void> =>
  Promise.resolve(ctx.invariants.register(PACKAGE_NAME, install))
/* jscpd:ignore-end */
