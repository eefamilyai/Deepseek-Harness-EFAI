/**
 * Delivery of the system prompt as a provider file: the reuse rule, the
 * re-upload rule, and the inline fallback that must hold on every failure path.
 */

import { mkdtemp, rm } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, beforeEach, describe, expect, it } from 'vitest'
import { LlmAdapter, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk } from '@deepseek-ai/dsh-llm'
import {
  SystemPromptFileAdapter,
  SystemPromptFileStore,
  SystemPromptUploadIndex,
  promptFilename,
  supportsSystemFile,
} from '../src/index.ts'

const PROMPT = 'You are a careful agent.\n\nAlways verify before claiming success.'
const CONNECTION = { schema: 'openai', baseURL: 'https://api.example/v1', apiKey: 'sk-test' }

/**
 * Frozen clock and a lifetime comfortably longer than the default refresh
 * margin. The real wall clock would expire the fixture mid-test, which would
 * make every reuse assertion pass or fail by when the suite happens to run.
 */
const NOW = 1_700_000_000_000
const CREATED_AT = Math.floor(NOW / 1_000)
const EXPIRES_AT = CREATED_AT + 2_592_000

/** Every store in this suite reads the same frozen clock. */
const CLOCK = { now: () => NOW }

let dir: string
let index: SystemPromptUploadIndex
let uploads: number

beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'dsh-system-file-'))
  index = new SystemPromptUploadIndex(join(dir, 'files-v1.json'))
  uploads = 0
})

afterEach(async () => {
  await rm(dir, { recursive: true, force: true })
})

/** Upload transport that counts calls and returns one deterministic file object. */
function transport(): typeof fetch {
  return (async () => {
    uploads += 1
    return new Response(JSON.stringify({
      id: `file-${uploads}`,
      object: 'file',
      bytes: 128,
      created_at: CREATED_AT,
      expires_at: EXPIRES_AT,
      filename: 'system_prompt.md',
      purpose: 'user_data',
    }), { status: 200, headers: { 'content-type': 'application/json' } })
  }) as unknown as typeof fetch
}

describe('capability', () => {
  it('accepts only schemas whose system slot can carry a file', () => {
    expect(supportsSystemFile('openai')).toBe(true)
    expect(supportsSystemFile('anthropic')).toBe(true)
    expect(supportsSystemFile('gemini')).toBe(false)
    expect(supportsSystemFile('unknown')).toBe(false)
  })

  it('names one file per prompt revision', () => {
    expect(promptFilename('openai', PROMPT)).toBe(promptFilename('openai', PROMPT))
    expect(promptFilename('openai', PROMPT)).not.toBe(promptFilename('openai', `${PROMPT}!`))
  })
})

describe('inline fallback', () => {
  it('keeps the prompt inline for a schema with no file-capable system slot', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const delivery = await store.deliver(PROMPT, { ...CONNECTION, schema: 'gemini' })
    expect(delivery.text).toBe(PROMPT)
    expect(delivery.fileId).toBeUndefined()
    expect(uploads).toBe(0)
  })

  it('keeps the prompt inline when the endpoint is empty', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const delivery = await store.deliver(PROMPT, { ...CONNECTION, baseURL: '' })
    expect(delivery.text).toBe(PROMPT)
    expect(uploads).toBe(0)
  })

  it('keeps the prompt inline when the upload fails', async () => {
    const store = new SystemPromptFileStore({
      ...CLOCK,
      index,
      fetch: (async () => new Response('nope', { status: 500 })) as unknown as typeof fetch,
    })
    const delivery = await store.deliver(PROMPT, CONNECTION)
    expect(delivery.text).toBe(PROMPT)
    expect(delivery.fileId).toBeUndefined()
  })

  it('keeps the prompt inline when the upload response is malformed', async () => {
    const store = new SystemPromptFileStore({
      ...CLOCK,
      index,
      fetch: (async () => new Response('{"id":""}', { status: 200 })) as unknown as typeof fetch,
    })
    const delivery = await store.deliver(PROMPT, CONNECTION)
    expect(delivery.text).toBe(PROMPT)
  })

  it('never throws when the transport rejects', async () => {
    const store = new SystemPromptFileStore({
      ...CLOCK,
      index,
      fetch: (async () => { throw new Error('offline') }) as unknown as typeof fetch,
    })
    await expect(store.deliver(PROMPT, CONNECTION)).resolves.toEqual({ text: PROMPT })
  })
})

describe('upload once, reuse the id', () => {
  it('uploads on the first delivery and reuses the id afterwards', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const first = await store.deliver(PROMPT, CONNECTION)
    const second = await store.deliver(PROMPT, CONNECTION)
    expect(uploads).toBe(1)
    expect(first.fileId).toBe('file-1')
    expect(second.fileId).toBe('file-1')
    expect(first.text).toContain('file-1')
  })

  it('reuses a mapping written by an earlier store instance', async () => {
    const first = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    await first.deliver(PROMPT, CONNECTION)
    const second = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const reused = await second.deliver(PROMPT, CONNECTION)
    expect(uploads).toBe(1)
    expect(reused.fileId).toBe('file-1')
  })

  it('uploads again when the prompt revision changes', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    await store.deliver(PROMPT, CONNECTION)
    await store.deliver(`${PROMPT}\nA new rule.`, CONNECTION)
    expect(uploads).toBe(2)
  })

  it('uploads again for a different endpoint', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    await store.deliver(PROMPT, CONNECTION)
    await store.deliver(PROMPT, { ...CONNECTION, baseURL: 'https://other.example/v1' })
    expect(uploads).toBe(2)
  })
})

describe('re-upload on provider error', () => {
  it('uploads again after the rejected id is invalidated', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const first = await store.deliver(PROMPT, CONNECTION)
    expect(await store.invalidate(CONNECTION, PROMPT, first.fileId!)).toBe(true)
    const second = await store.deliver(PROMPT, CONNECTION)
    expect(uploads).toBe(2)
    expect(second.fileId).toBe('file-2')
  })

  it('reports no removal for an id it does not hold', async () => {
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    await store.deliver(PROMPT, CONNECTION)
    expect(await store.invalidate(CONNECTION, PROMPT, 'file-other' as never)).toBe(false)
  })
})


describe('adapter', () => {
  /** An inner adapter that records the exact request it was handed. */
  class RecordingAdapter extends LlmAdapter {
    seen: GenerateOptions | undefined

    async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
      this.seen = options
      yield { type: 'text', text: 'ok' } as unknown as StreamChunk
    }
  }

  const BASE: GenerateOptions = {
    provider: 'openai',
    model: 'gpt-x',
    messages: [createUserMessage({
      content: [{ type: 'text', text: 'hi' }],
      source: { kind: 'plugin', plugin: 'test' },
    })],
    system: PROMPT,
  }

  async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
    const chunks: StreamChunk[] = []
    for await (const chunk of stream) chunks.push(chunk)
    return chunks
  }

  it('replaces the inline prompt with a file instruction', async () => {
    const inner = new RecordingAdapter()
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const adapter = new SystemPromptFileAdapter({ inner, store, connectionFor: () => CONNECTION })

    expect(await drain(adapter.stream(BASE))).toHaveLength(1)
    expect(inner.seen?.system).toContain("attached as a file named '")
    expect(inner.seen?.system).not.toContain('Always verify before claiming success.')
    expect(inner.seen?.messages).toEqual(BASE.messages)
  })

  it('uploads once across turns and reuses the same file id', async () => {
    const first = new RecordingAdapter()
    const second = new RecordingAdapter()
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const adapter = new SystemPromptFileAdapter({ inner: first, store, connectionFor: () => CONNECTION })

    await drain(adapter.stream(BASE))
    const afterFirst = uploads
    const reuse = new SystemPromptFileAdapter({ inner: second, store, connectionFor: () => CONNECTION })
    await drain(reuse.stream(BASE))

    expect(afterFirst).toBe(1)
    expect(uploads).toBe(1)
    expect(second.seen?.system).toBe(first.seen?.system)
  })

  it('passes a provider with no file route through untouched', async () => {
    const inner = new RecordingAdapter()
    const adapter = new SystemPromptFileAdapter({ inner, connectionFor: () => undefined })
    await drain(adapter.stream(BASE))
    expect(inner.seen).toBe(BASE)
    expect(uploads).toBe(0)
  })

  it('passes a request with no system slot through untouched', async () => {
    const inner = new RecordingAdapter()
    const store = new SystemPromptFileStore({ ...CLOCK, index, fetch: transport() })
    const adapter = new SystemPromptFileAdapter({ inner, store, connectionFor: () => CONNECTION })
    const noSystem = { provider: 'openai', model: 'gpt-x', messages: BASE.messages }
    await drain(adapter.stream(noSystem))
    expect(inner.seen).toBe(noSystem)
    expect(uploads).toBe(0)
  })

  it('forwards provider metadata to the wrapped adapter', async () => {
    const inner = new RecordingAdapter()
    const adapter = new SystemPromptFileAdapter({ inner })
    expect(adapter.providerInfo('openai').id).toBe('openai')
    expect(adapter.providerRetryPolicy('openai')).toBeUndefined()
  })
})
