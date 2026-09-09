/**
 * ToolRow's family-accent wiring as CSS text. jsdom resolves no cascade, so
 * these read the module directly: a variant with no `--dsh-row-accent`
 * silently falls back to the neutral tone, a rebind that lands on `.root`
 * instead of `.row` leaks the parent's hue into every nested subcall row, and
 * the cordis tool override only wins its equal-specificity tie by appearing
 * later.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VARIANT_TITLE_KEYS, type ToolRowVariant } from '../src/client/tool/models/tool-call-model.ts'

const css = readFileSync(
  fileURLToPath(new URL('../src/client/tool/components/ToolRow.module.css', import.meta.url)),
  'utf8',
)
const declarationText = css.replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Rules that rebind the accent, in source order, with their selector text. */
const rebinds = [...declarationText.matchAll(
  /([^{}]*?)\{\s*--dsh-row-accent: var\((--dsw-alias-[\w-]+)\);\s*\}/g,
)].map(([, selectors, token]) => ({ selectors: selectors!, token: token! }))

/** Variant -> accent token; a later rule for the same variant wins, as in the cascade. */
const accents = new Map<string, string>()
for (const { selectors, token } of rebinds) {
  for (const [, variant] of selectors.matchAll(/\[data-variant='([\w-]+)'\]/g)) {
    accents.set(variant!, token)
  }
}

describe('ToolRow.module.css family accents', () => {
  it('gives every variant a flow accent, including the unclassified one', () => {
    const variants = Object.keys(VARIANT_TITLE_KEYS) as ToolRowVariant[]
    expect(Object.fromEntries(variants.map(v => [v, accents.get(v) ?? null]))).toEqual({
      search: '--dsw-alias-flow-search',
      read: '--dsw-alias-flow-read',
      write: '--dsw-alias-flow-mutate',
      edit: '--dsw-alias-flow-mutate',
      bash: '--dsw-alias-flow-shell',
      code: '--dsw-alias-flow-code',
      others: '--dsw-alias-flow-generic',
    })
  })

  it('rebinds on the row, never on the root that also holds nested subcalls', () => {
    for (const { selectors } of rebinds) {
      expect(selectors.trim(), 'a `.root` rebind inherits into every nested subcall row').toMatch(/\.row\s*$/)
    }
  })

  it('carries the accent onto the hover chevron and the separator dot', () => {
    // The glyph and title come from DisclosureRow's own rebinding contract;
    // these two parts are ToolRow's own and must follow the same hue.
    expect(declarationText).toMatch(/\.chevron\s*\{\s*color: var\(--dsh-row-accent, var\(--dsw-alias-label-secondary\)\);/)
    expect(declarationText).toMatch(/background: var\(--dsh-row-accent, var\(--dsw-alias-label-caption\)\);/)
  })

  it('orders the cordis tool override after the variant rules it overrides', () => {
    // Equal specificity (one class, one attribute, one class); only source order
    // breaks the tie, and cordis_package_inspect is also a `read` variant.
    const lastVariant = declarationText.lastIndexOf("[data-variant='")
    const cordis = declarationText.indexOf("[data-tool^='cordis_'] .row {")
    expect(lastVariant).toBeGreaterThan(-1)
    expect(cordis).toBeGreaterThan(lastVariant)
  })
})
