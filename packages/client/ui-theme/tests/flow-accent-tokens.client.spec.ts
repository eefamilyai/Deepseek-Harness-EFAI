/**
 * The --dsw-alias-flow-* accent group as CSS text. jsdom resolves no cascade,
 * so these read design-platform.css directly: a flow accent that exists in one
 * theme only, or points at a static step nobody declared, renders as an unset
 * custom property and silently drops the row back to its neutral tone.
 */
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { describe, expect, it } from 'vitest'

const css = readFileSync(fileURLToPath(new URL('../src/styles/design-platform.css', import.meta.url)), 'utf8')

/** The four top-level rule bodies: light statics, dark statics, light aliases, dark aliases. */
const blocks = [...css.matchAll(/^(body(?:\[data-ds-dark-theme\])?) \{\n([\s\S]*?)^\}/gm)]
  .map(([, selector, body]) => ({ dark: selector!.includes('dark'), body: body! }))

function declared(prefix: string, dark: boolean): Map<string, string> {
  const found = new Map<string, string>()
  for (const block of blocks.filter(entry => entry.dark === dark)) {
    for (const [, name, value] of block.body.matchAll(/^ {2}(--[\w-]+): (.+);$/gm)) {
      if (name!.startsWith(prefix)) found.set(name!, value!)
    }
  }
  return found
}

describe('design-platform.css flow accents', () => {
  it('declares the same six family accents in both themes', () => {
    const light = [...declared('--dsw-alias-flow-', false).keys()].sort()
    expect(light).toEqual([
      '--dsw-alias-flow-code',
      '--dsw-alias-flow-mutate',
      '--dsw-alias-flow-read',
      '--dsw-alias-flow-search',
      '--dsw-alias-flow-shell',
      '--dsw-alias-flow-think',
    ])
    expect([...declared('--dsw-alias-flow-', true).keys()].sort()).toEqual(light)
  })

  it('gives each theme its own step of the family hue', () => {
    const light = declared('--dsw-alias-flow-', false)
    const dark = declared('--dsw-alias-flow-', true)
    for (const [name, value] of light) {
      expect(dark.get(name)).not.toBe(value)
    }
  })

  it('resolves every accent to a static step that theme declares', () => {
    for (const dark of [false, true]) {
      const statics = declared('--dsw-static-', dark)
      for (const [name, value] of declared('--dsw-alias-flow-', dark)) {
        const step = /^var\((--dsw-static-[\w-]+)\)$/.exec(value)?.[1]
        expect(step, `${name} must reference a static step, got ${value}`).toBeDefined()
        expect(statics.has(step!), `${step!} is undeclared for dark=${String(dark)}`).toBe(true)
      }
    }
  })

  it('keeps the accents off the failure hues', () => {
    // ToolRow swaps the leading glyph for a red or amber StateDot on a failed
    // or interrupted call, so a family accent drawn from those two ramps would
    // read as run state rather than as the kind of call.
    for (const dark of [false, true]) {
      for (const [name, value] of declared('--dsw-alias-flow-', dark)) {
        expect(value, `${name} must avoid the error and warn ramps`).not.toMatch(/--dsw-static-(?:red|amber)-/)
      }
    }
  })
})
