/**
 * Which messages survive the sidecar's prompt budget.
 *
 * `ds_direct` sends DeepSeek only what its chat has not seen, clipped to
 * `DS_PROMPT_MAX`, and `_clip_body` keeps a message unconditionally only when it
 * is pinned. Everything else yields oldest-first. So `pin` is not cosmetic: it
 * is the difference between the recovery affordance reaching the model and
 * being silently dropped in transit.
 *
 * The cases below are the three that must never be clipped. The skill ones are
 * the subtle pair — `tool-skill` re-publishes the catalog and re-injects an
 * always-load body precisely when compaction has pruned them, so they arrive on
 * the turn that most needs them and are then the only durable record that
 * recovery is possible.
 */
import { describe, expect, it } from 'vitest'
import type { Message } from '@deepseek-ai/dsh-llm'
import { flattenMessage } from '@deepseek-ai/dsh-llm-kiln'

function turn(kind: string, extra: Record<string, unknown> = {}): Message {
  return {
    role: 'user',
    content: [{ type: 'text', text: 'body' }],
    source: { kind, ...extra },
  } as unknown as Message
}

describe('pinned message sources', () => {
  it('pins a genuine user turn so the request is never clipped away', () => {
    expect(flattenMessage(turn('user'))?.pin).toBe(true)
  })

  it('pins the skill catalog, whose republication is the recovery trigger', () => {
    const catalog = turn('skill-catalog', {
      form: 'catalog',
      update: true,
      entries: [{ name: 'dsh-session-history', description: 'Read session history' }],
    })
    expect(flattenMessage(catalog)?.pin).toBe(true)
  })

  it('pins an injected skill body, which carries the recovery procedure itself', () => {
    const body = turn('skill-invocation', { name: 'dsh-session-history', form: 'instructions' })
    expect(flattenMessage(body)?.pin).toBe(true)
  })

  it('leaves ordinary injected context unpinned', () => {
    // Workspace instructions and runtime snapshots ride every turn and are
    // large; pinning them would evict the conversation they exist to serve.
    expect(flattenMessage(turn('plugin', { plugin: 'test' }))?.pin).toBeUndefined()
    expect(flattenMessage(turn('model', { provider: 'p', model: 'm' }))?.pin).toBeUndefined()
    expect(flattenMessage(turn('tool', { callId: 'c1' }))?.pin).toBeUndefined()
  })

  it('does not pin on a missing kind', () => {
    // A source is structurally required, but a resumed or externally written
    // seed is not guaranteed to carry one; an absent kind must not throw and
    // must not silently pin.
    expect(flattenMessage({ role: 'user', content: [{ type: 'text', text: 'x' }], source: {} } as never)?.pin)
      .toBeUndefined()
  })
})
