/**
 * The accent binding sheet as CSS text: which families it rebinds, that the
 * read stays scoped so unaccented rows keep upstream's own rest and hover
 * colours, and that every selector is keyed on an attribute upstream emits
 * rather than on a hashed CSS-module class. jsdom resolves no cascade across
 * bundles, and these rules exist precisely because the rows ship in a bundle
 * this package does not build, so the sheet is the artifact under test.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'
import { VARIANT_TITLE_KEYS } from '@deepseek-ai/dsh-client-ui-tool/src/client/tool/models/tool-call-model.ts'
import { FLOW_ACCENT_TOKENS } from '../src/client/tokens.ts'

const sheet = readFileSync(fileURLToPath(new URL('../src/client/accents.css', import.meta.url)), 'utf8')
  .replace(/\/\*[\s\S]*?\*\//g, ' ')

/** Every `--dsh-row-accent: var(--dsw-alias-…)` binding, with its selector text. */
const bindings = [...sheet.matchAll(/([^{}]*?)\{\s*--dsh-row-accent: var\((--dsw-alias-[\w-]+)\)/g)]
  .map(([, selectors, token]) => ({ selectors: selectors!.trim(), token: token! }))

describe('flow-accent binding sheet', () => {
  it('binds each tool variant upstream classifies', () => {
    const bound = bindings.map(binding => binding.selectors).join(' ')
    for (const variant of Object.keys(VARIANT_TITLE_KEYS)) {
      expect(bound, `variant ${variant} has no binding`).toContain(`[data-variant='${variant}']`)
    }
  })

  it('binds every hue the palette declares, and no hue it does not', () => {
    // Token NAMES: each palette entry carries a light and a dark value.
    const declared = new Set(Object.keys(FLOW_ACCENT_TOKENS))
    const used = new Set(bindings.map(binding => binding.token))
    const declaredFlow = new Set([...declared].filter(token => token.startsWith('--dsw-alias-flow-')))
    expect([...declaredFlow].filter(token => !used.has(token)), 'declared but never bound').toEqual([])
    // The cordis tool binding takes an upstream product accent rather than a
    // flow hue; nothing else may bind a token this package does not declare.
    expect([...used].filter(token => !declared.has(token)))
      .toEqual(['--dsw-alias-state-business-primary'])
  })

  it('keys the keyed bash view and the instruction rows on their own markers', () => {
    const selectors = bindings.map(binding => binding.selectors)
    expect(selectors.some(text => text.includes("[data-sample='bash']"))).toBe(true)
    expect(selectors.some(text => text.includes("[data-chat-node-key='system-prompt']"))).toBe(true)
    expect(selectors.some(text => text.includes(':has([data-context-source])'))).toBe(true)
  })

  it('orders the cordis tool binding after the variant bindings it overrides', () => {
    // Equal specificity (one attribute selector each); only source order breaks
    // the tie, and a cordis lifecycle tool is also a `read` variant.
    const lastVariant = sheet.lastIndexOf("[data-variant='")
    const cordis = sheet.indexOf("[data-tool^='cordis_']")
    expect(lastVariant).toBeGreaterThan(-1)
    expect(cordis).toBeGreaterThan(lastVariant)
  })

  it('scopes the read to family rows so every other disclosure keeps upstream colours', () => {
    const readRules = [...sheet.matchAll(/([^{}]*?)\{\s*color: var\(--dsh-row-accent[^}]*\}/g)]
      .map(([, selectors]) => selectors!.trim())
    expect(readRules.length).toBeGreaterThan(0)
    for (const rule of readRules) {
      for (const selector of rule.split(',').map(part => part.trim())) {
        expect(selector, 'a bare row selector would override upstream hover').not.toBe('[data-disclosure-row]')
        expect(selector).toMatch(/\[data-variant\]|\[data-chat-node-key|\[data-sample|:has\(/)
      }
    }
  })

  it('never matches a hashed CSS-module class', () => {
    // The whole point of the sheet: module class names are hashed per bundle,
    // and this stylesheet is injected from a bundle upstream does not build.
    expect(sheet).not.toMatch(/\[class[\^$*~|]?=/)
    for (const { selectors } of bindings) expect(selectors).not.toContain('.')
  })

  it('colours the separator dot through the attribute upstream marks it with', () => {
    const dot = [...sheet.matchAll(/([^{}]*?)\{\s*background: var\(--dsh-row-accent\)/g)]
      .map(([, selectors]) => selectors!.trim())
    expect(dot.length).toBeGreaterThan(0)
    for (const rule of dot) expect(rule).toContain('[data-shimmer-decoration]')
  })
})
