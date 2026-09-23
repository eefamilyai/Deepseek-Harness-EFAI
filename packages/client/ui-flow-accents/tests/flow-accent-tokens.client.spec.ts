/**
 * The `--dsw-alias-flow-*` accent group as a theme override layer.
 *
 * The failure this pins is silent: a flow accent declared for one palette
 * only, or pointing at a static step nobody declares, renders as an unset
 * custom property and drops the row back to its neutral tone — no error, just
 * a grey transcript. The layer is plain data, so the check is exhaustive
 * rather than a sample.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { FLOW_ACCENT_TOKENS, apply, inject } from '../src/client/index.ts'

const FAMILIES = [
  '--dsw-alias-flow-code',
  '--dsw-alias-flow-generic',
  '--dsw-alias-flow-instruct',
  '--dsw-alias-flow-mutate',
  '--dsw-alias-flow-read',
  '--dsw-alias-flow-search',
  '--dsw-alias-flow-shell',
  '--dsw-alias-flow-think',
]

/** Token names in the layer that start with `prefix`. */
function named(prefix: string): string[] {
  return Object.keys(FLOW_ACCENT_TOKENS).filter(name => name.startsWith(prefix)).sort()
}

describe('the flow-accent layer', () => {
  it('declares all eight family accents', () => {
    expect(named('--dsw-alias-flow-')).toEqual(FAMILIES)
  })

  it('gives every token a value in both palettes', () => {
    for (const [name, modes] of Object.entries(FLOW_ACCENT_TOKENS)) {
      expect(modes.light, `${name} light`).toMatch(/\S/)
      expect(modes.dark, `${name} dark`).toMatch(/\S/)
    }
  })

  it('points every alias at a static step the same layer declares', () => {
    const steps = new Set(named('--dsw-static-'))
    for (const family of FAMILIES) {
      for (const mode of ['light', 'dark'] as const) {
        const value = FLOW_ACCENT_TOKENS[family]![mode]
        const referenced = /^var\((--[\w-]+)\)$/.exec(value)?.[1]
        expect(referenced, `${family} ${mode} should reference a step`).toBeDefined()
        expect(steps.has(referenced!), `${family} ${mode} references ${referenced!}`).toBe(true)
      }
    }
  })

  it('keeps the two palettes on different steps, which is the point of two palettes', () => {
    for (const family of FAMILIES) {
      const token = FLOW_ACCENT_TOKENS[family]!
      expect(token.light, family).not.toBe(token.dark)
    }
  })

  it('borrows no state ramp: an accent on error red or warn amber reads as a failed row', () => {
    for (const modes of Object.values(FLOW_ACCENT_TOKENS)) {
      for (const value of [modes.light, modes.dark]) {
        expect(value).not.toContain('--dsw-alias-state-')
      }
    }
  })
})

describe('the plugin', () => {
  it('registers exactly one layer, under its own package id, and retracts it on dispose', async () => {
    const ctx = new Context()
    const layers: { source: string; tokens: unknown }[] = []
    ctx.provide('theme', {
      overrideTokens: (source: string, tokens: unknown) => {
        const layer = { source, tokens }
        layers.push(layer)
        return () => { layers.splice(layers.indexOf(layer), 1) }
      },
    })

    const fiber = await ctx.plugin({ name: 'ui-flow-accents', inject, apply })
    expect(layers).toHaveLength(1)
    expect(layers[0]!.source).toBe('@deepseek-ai/dsh-client-ui-flow-accents')
    expect(layers[0]!.tokens).toBe(FLOW_ACCENT_TOKENS)

    await fiber.dispose()
    expect(layers).toHaveLength(0)
    await ctx.fiber.dispose()
  })
})
