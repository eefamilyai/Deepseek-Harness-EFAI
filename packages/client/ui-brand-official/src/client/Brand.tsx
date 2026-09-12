import { FishLogo } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SidebarBrandMarkOwnerProps } from '@deepseek-ai/dsh-client-ui-sidebar/client'
// DSH-FORK(brand): the sidebar brand is the fork's in every build profile, so
// the name is live text this package styles rather than the upstream name
// artwork. EXIT: a fork-owned client package owns the sidebar chrome.
import css from './Brand.module.css'

/** The product name as the sidebar prints it. */
export const BRAND_NAME = 'DeepSeek Harness'

/**
 * Render the official mark with the presentation requested by its host surface.
 * @param props - Host-supplied mark presentation.
 * @returns the official whale mark.
 */
export function OfficialBrandMark({ size }: SidebarBrandMarkOwnerProps) {
  return <FishLogo size={size} />
}

// DSH-FORK(brand): the specular sweep has to travel through the glyphs, so the
// name is live text rather than the upstream `BrandWordmark` artwork.
// EXIT: upstream ships a wordmark whose highlight moves through its glyphs.
/**
 * Render the product name as live text carrying the specular sweep. Live text
 * rather than the name artwork, because the highlight has to travel through the
 * glyphs; the sweep is decoration and degrades to the plain wordmark.
 * @returns the shimmering product name.
 */
export function OfficialBrandName() {
  return <span className={css.shimmer}>{BRAND_NAME}</span>
}
