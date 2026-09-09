/**
 * ToolRow's family-accent wiring as CSS text. jsdom resolves no cascade, so
 * these read the module directly: a classified variant with no
 * `--dsh-row-accent` silently falls back to the neutral tone, and the cordis
 * tool override only wins its equal-specificity tie by appearing later.
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

/** Variant -> accent token, read off the `--dsh-row-accent` rules in source order. */
const accents = new Map<string, string>()
for (const [, selectors, token] of declarationText.matchAll(
  /([^{}]*?)\{\s*--dsh-row-accent: var\((--dsw-alias-[\w-]+)\);\s*\}/g,
)) {
  for (const [, variant] of selectors!.matchAll(/\[data-variant='([\w-]+)'\]/g)) {
    accents.set(variant!, token!)
  }
}

describe('ToolRow.module.css family accents', () => {
  it('gives every classified variant a flow accent and leaves others neutral', () => {
    const variants = Object.keys(VARIANT_TITLE_KEYS) as ToolRowVariant[]
    expect(Object.fromEntries(variants.map(v => [v, accents.get(v) ?? null]))).toEqual({
      search: '--dsw-alias-flow-search',
      read: '--dsw-alias-flow-read',
      write: '--dsw-alias-flow-mutate',
      edit: '--dsw-alias-flow-mutate',
      bash: '--dsw-alias-flow-shell',
      code: '--dsw-alias-flow-code',
      others: null,
    })
  })

  it('applies the accent to the glyph, the title, the chevron, and the dot', () => {
    for (const selector of ['.root .leading', '.root .title', '.chevron']) {
      expect(declarationText).toMatch(
        new RegExp(`${selector.replace(/[.]/g, '\\.')}\\s*\\{\\s*color: var\\(--dsh-row-accent, var\\(--dsw-alias-label-\\w+\\)\\);`),
      )
    }
    expect(declarationText).toMatch(/background: var\(--dsh-row-accent, var\(--dsw-alias-label-caption\)\);/)
  })

  it('orders the cordis tool override after the variant rules it overrides', () => {
    // Both are one class plus one attribute; only source order breaks the tie.
    const lastVariant = declarationText.lastIndexOf("[data-variant='")
    const cordis = declarationText.indexOf("[data-tool^='cordis_'] {")
    expect(lastVariant).toBeGreaterThan(-1)
    expect(cordis).toBeGreaterThan(lastVariant)
  })
})
