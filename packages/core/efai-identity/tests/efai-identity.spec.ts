/**
 * The identity opener.
 *
 * Three cases decide whether this plugin is correct, and none of them is
 * visible by inspection: the shipped opener present (must be replaced, not
 * doubled), absent (must appear anyway), and the opener suppressed on purpose
 * by an empty text (must be gone).
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import SystemPrompt, { renderPrompt } from '@deepseek-ai/dsh-system-prompt'
import { Config, DEFAULT_IDENTITY, IDENTITY_SECTION, apply, withIdentity } from '../src/index.ts'

describe('withIdentity', () => {
  it('replaces the shipped opener rather than adding beside it', () => {
    const out = withIdentity([
      { name: IDENTITY_SECTION, text: 'You are an AI agent powered by DeepSeek Harness.' },
      { name: 'deployment:persona-prefix', text: 'persona' },
    ], 'fork opener')
    expect(out).toEqual([
      { name: IDENTITY_SECTION, text: 'fork opener' },
      { name: 'deployment:persona-prefix', text: 'persona' },
    ])
  })

  it('adds the opener when the harness was configured without one', () => {
    const out = withIdentity([{ name: 'deployment:persona-prefix', text: 'persona' }], 'fork opener')
    expect(out[0]).toEqual({ name: IDENTITY_SECTION, text: 'fork opener' })
    expect(out).toHaveLength(2)
  })

  it('keeps the opener first, which is what order -1000 buys', () => {
    const out = withIdentity([
      { name: 'tool:bash', text: 'bash guidance' },
      { name: IDENTITY_SECTION, text: 'shipped' },
    ], 'fork opener')
    expect(out.map(section => section.name)).toEqual([IDENTITY_SECTION, 'tool:bash'])
  })

  it('removes the opener entirely for an empty text', () => {
    const out = withIdentity([{ name: IDENTITY_SECTION, text: 'shipped' }], '')
    expect(out).toEqual([])
  })
})

describe('the plugin over a real assembly', () => {
  it('puts the fork opener at the top of the rendered prompt', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, { personaPrefix: 'You are a coding agent.' })
    await ctx.plugin({ name: 'efai-identity', inject: ['systemPrompt'], apply, Config }, {})

    const rendered = renderPrompt(await ctx.systemPrompt.assemble({}))
    expect(rendered.startsWith(DEFAULT_IDENTITY)).toBe(true)
    expect(rendered).toContain('You are a coding agent.')
    // The shipped opener is gone, not merely outranked.
    expect(rendered).not.toContain('powered by DeepSeek Harness')
    await ctx.fiber.dispose()
  })

  it('restores the shipped opener when the fork plugin unmounts', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    const fiber = await ctx.plugin({ name: 'efai-identity', inject: ['systemPrompt'], apply, Config }, {})
    expect(renderPrompt(await ctx.systemPrompt.assemble({}))).toContain(DEFAULT_IDENTITY)

    await fiber.dispose()
    const rendered = renderPrompt(await ctx.systemPrompt.assemble({}))
    expect(rendered).toContain('powered by DeepSeek Harness')
    expect(rendered).not.toContain(DEFAULT_IDENTITY)
    await ctx.fiber.dispose()
  })

  it('takes the opener from configuration when one is given', async () => {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt, {})
    await ctx.plugin({ name: 'efai-identity', inject: ['systemPrompt'], apply, Config }, { text: 'configured opener' })
    expect(renderPrompt(await ctx.systemPrompt.assemble({}))).toContain('configured opener')
    await ctx.fiber.dispose()
  })
})
