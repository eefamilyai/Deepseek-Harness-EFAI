import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
import css from './Brand.module.css'

/** The product name as the sidebar prints it. */
export const BRAND_NAME = 'DeepSeek Harness'

/**
 * Render the brand mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the whale mark.
 */
export function EfaiBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

/**
 * Render the product name as live text carrying the specular sweep. Live text
 * rather than a name artwork, because the highlight has to travel through the
 * glyphs; the sweep is decoration and degrades to the plain wordmark.
 * @returns the shimmering product name.
 */
export function EfaiBrandName() {
  return <span className={css.shimmer}>{BRAND_NAME}</span>
}
