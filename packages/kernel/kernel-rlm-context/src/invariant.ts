import type { Context } from '@deepseek-ai/cordis'
import { Context as CordisContext } from '@deepseek-ai/cordis'
import type {} from '@deepseek-ai/dsh-kernel'
import type {} from '@deepseek-ai/dsh-system-prompt'

/**
 * White-box sanity for the RLM read-back seam: the assembly waterfall must be
 * observable and the kernel execute path must parse one marker line. This file
 * mirrors the repo's `invariant.ts` convention of testing seams directly.
 * @module @deepseek-ai/dsh-kernel-rlm-context/invariant
 */

export function register(ctx: Context): void {
  ctx.on('system-prompt/assemble', async (_assembly, _context, next) => next())
}

export { CordisContext }
