/**
 * What a compaction needs from this route: the summary and the handoff survive
 * a re-primed chat, and a summarizer that can only take one capped message
 * still sees ALL of what it condenses.
 *
 * Both failures were silent. The sidecar kept pinned messages but nothing here
 * pinned the checkpoint, so a re-prime dropped the one message that replaced
 * everything before it; and a summary request larger than one message reached
 * the model as its newest end, so the older work was never summarized at all.
 */

import { describe, expect, it } from 'vitest'
import { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, Message } from '@deepseek-ai/dsh-llm'
import { KilnAdapter, SUMMARIZER_SYSTEM, flattenMessage, planCompactionFold } from '@deepseek-ai/dsh-llm-kiln'
import type { KilnBridge, KilnStreamEvent, KilnStreamRequest } from '@deepseek-ai/dsh-llm-kiln'

/** The instruction every summarizer appends last. */
const INSTRUCTION = 'Condense the conversation ABOVE into a structured checkpoint.'

/** A long conversation: `turns` user/tool pairs of `size` characters each. */
function conversation(turns: number, size: number): Message[] {
  const out: Message[] = []
  for (let index = 0; index < turns; index += 1) {
    out.push(createUserMessage({ content: [{ type: 'text', text: `request ${index} ${'u'.repeat(size)}` }], source: { kind: 'user' } }))
    out.push(createToolResultMessage({ callId: ToolCallId(`c${index}`), content: [{ type: 'text', text: `result ${index} ${'r'.repeat(size)}` }], isError: false }))
  }
  return out
}

/** A compaction request over a conversation, closed by the instruction. */
function compactionRequest(messages: Message[], provider = 'kiln-deepseek'): GenerateOptions {
  return {
    provider,
    model: 'deepseek-expert',
    purpose: 'compaction',
    messages: [...messages, { role: 'user', content: [{ type: 'text', text: INSTRUCTION }] }],
  }
}

/** A bridge that records every request and answers each with a numbered summary. */
function recordingBridge(): { bridge: KilnBridge; requests: KilnStreamRequest[] } {
  const requests: KilnStreamRequest[] = []
  const bridge = {
    async *stream(request: KilnStreamRequest): AsyncIterable<KilnStreamEvent> {
      requests.push(request)
      yield { type: 'content', text: `summary after call ${requests.length}` }
      yield { type: 'meta', finish: 'stop' }
    },
  } as unknown as KilnBridge
  return { bridge, requests }
}

/** Collect the text an adapter streams back. */
async function textOf(adapter: KilnAdapter, options: GenerateOptions): Promise<string> {
  let text = ''
  for await (const chunk of adapter.stream(options)) {
    if (chunk.type === 'text-delta') text += chunk.text
  }
  return text
}

describe('messages a re-primed chat must keep', () => {
  it('pins the compaction checkpoint and the handoff, so a clip never drops them', () => {
    const checkpoint = createUserMessage({ content: [{ type: 'text', text: 'summary' }], source: { kind: 'compact-checkpoint' } as never })
    const handoff = createUserMessage({ content: [{ type: 'text', text: 'handoff' }], source: { kind: 'session-recovery' } as never })
    expect(flattenMessage(checkpoint)).toMatchObject({ pin: true })
    expect(flattenMessage(handoff)).toMatchObject({ pin: true })
  })
})

describe('planCompactionFold', () => {
  it('asks for one call when the conversation fits', () => {
    expect(planCompactionFold(compactionRequest(conversation(2, 100)), 30000)).toBeUndefined()
  })

  it('splits a long conversation into parts that each fit, in order, closed by the instruction', () => {
    const plan = planCompactionFold(compactionRequest(conversation(12, 4000)), 10000)
    expect(plan).toBeDefined()
    expect(plan?.instruction).toBe(INSTRUCTION)
    expect(plan?.parts.length).toBeGreaterThan(2)
    for (const part of plan?.parts ?? []) {
      expect(part.reduce((sum, turn) => sum + turn.content.length, 0)).toBeLessThanOrEqual(10000)
    }
    const flat = (plan?.parts ?? []).flat().map(turn => turn.content)
    expect(flat[0]?.startsWith('request 0')).toBe(true)
    expect(flat.at(-1)?.startsWith('OUTPUT:\nresult 11')).toBe(true)
  })

  it('cuts one turn larger than a part to its head and tail', () => {
    const plan = planCompactionFold(compactionRequest(conversation(3, 30000)), 10000)
    const turns = (plan?.parts ?? []).flat()
    expect(turns.every(turn => turn.content.length <= 10000)).toBe(true)
    expect(turns.some(turn => turn.content.includes('[cut to fit the summarizer]'))).toBe(true)
  })

  it('leaves system turns out: the summarizer statement replaces them', () => {
    const request = compactionRequest([
      { role: 'system', content: [{ type: 'text', text: 'SYSTEM'.repeat(10000) }], source: { kind: 'system-prompt' } } as never,
      ...conversation(1, 100),
    ])
    expect(planCompactionFold(request, 30000)).toBeUndefined()
  })
})

describe('summarizing on the message-capped route', () => {
  it('folds a conversation too large for one message, carrying the running summary forward', async () => {
    const { bridge, requests } = recordingBridge()
    const adapter = new KilnAdapter({ bridge, routes: () => new Map(), kilnId: () => 'deepseek', compactionFoldChars: 10000 })
    const text = await textOf(adapter, compactionRequest(conversation(12, 4000)))

    expect(requests.length).toBeGreaterThan(2)
    // Every call is the summarizer's own, each a fresh one-shot chat.
    for (const request of requests) {
      expect(request.messages[0]).toEqual({ role: 'system', content: SUMMARIZER_SYSTEM })
      expect(request.messages.at(-1)?.content).toContain(INSTRUCTION)
      expect(request.opts.conv_id).toEqual(expect.stringContaining('#compaction#'))
    }
    // Each call after the first carries the previous call's summary as a prior checkpoint.
    for (let index = 1; index < requests.length; index += 1) {
      expect(requests[index]?.messages[1]?.content).toBe(`<compacted-summary>\nsummary after call ${index}\n</compacted-summary>`)
    }
    // Every part of the conversation reached a summarizer.
    const seen = requests.flatMap(request => request.messages.map(message => message.content)).join('\n')
    for (let index = 0; index < 12; index += 1) expect(seen).toContain(`request ${index} `)
    // The caller receives the final call's summary.
    expect(text).toBe(`summary after call ${requests.length}`)
  })

  it('sends one call when the conversation fits, and never folds on other routes', async () => {
    const small = recordingBridge()
    await textOf(new KilnAdapter({ bridge: small.bridge, routes: () => new Map(), kilnId: () => 'deepseek' }), compactionRequest(conversation(2, 100)))
    expect(small.requests).toHaveLength(1)

    const other = recordingBridge()
    const adapter = new KilnAdapter({ bridge: other.bridge, routes: () => new Map(), kilnId: () => 'openrouter', compactionFoldChars: 10000 })
    await textOf(adapter, compactionRequest(conversation(12, 4000), 'kiln-openrouter'))
    expect(other.requests).toHaveLength(1)
  })

  it('falls back to one call when a part fails', async () => {
    const requests: KilnStreamRequest[] = []
    const bridge = {
      async *stream(request: KilnStreamRequest): AsyncIterable<KilnStreamEvent> {
        requests.push(request)
        if (requests.length === 1) {
          yield { type: 'meta', finish: 'error', error: 'server is busy' }
          return
        }
        yield { type: 'content', text: 'single-call summary' }
        yield { type: 'meta', finish: 'stop' }
      },
    } as unknown as KilnBridge
    const adapter = new KilnAdapter({ bridge, routes: () => new Map(), kilnId: () => 'deepseek', compactionFoldChars: 10000 })
    expect(await textOf(adapter, compactionRequest(conversation(12, 4000)))).toBe('single-call summary')
    expect(requests).toHaveLength(2)
  })
})
