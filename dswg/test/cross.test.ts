/**
 * The reply corpus, read through the gateway the way a client reads it.
 *
 * The unit tests check the reader directly. This checks the whole path a model
 * reply takes to a client — parse, salvage, envelope, adapter — for every reply
 * fixture in both API dialects, streaming and not. What it defends is the
 * pairing this gateway exists to serve: a client's own tool-call reader only
 * ever sees what this gateway emitted, so a reply that arrives here as prose is a
 * turn that client spends for nothing, and a reply that arrives as the wrong call
 * is an action nobody asked for.
 *
 * @module dswg/test/cross
 */

import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.ts'
import { start } from '../src/main.ts'
import type { BrowserPool } from '../src/browser/pool.ts'
import type { AccountRecord } from '../src/store/accounts.ts'
import { CALL_REPLIES, FIXTURE_TOOLS, PROSE_REPLIES, UNREADABLE_REPLIES, type ReplyFixture } from './fixtures/replies.ts'

/** The completion stream one reply produces, as the browser transport sees it. */
function streamFor(text: string): string {
  const lines = ['event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n']
  lines.push(`data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: '' }] } } })}\n`)
  // Several appends, so a call split across chunks is exercised too.
  const size = Math.max(1, Math.ceil(text.length / 3))
  for (let at = 0; at < text.length; at += size) {
    lines.push(`data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: text.slice(at, at + size) })}\n`)
  }
  lines.push(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n`)
  return lines.join('\n')
}

/** A pool double that answers every turn with the same reply. */
function replyPool(text: string): BrowserPool {
  const raw = streamFor(text)
  return {
    async turn(_account: AccountRecord, options: { onEvent: (event: unknown) => void; signal?: AbortSignal }) {
      for (let at = 0; at < raw.length; at += 128) {
        if (options.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }
        options.onEvent({ t: 'chunk', v: raw.slice(at, at + 128) })
      }
      options.onEvent({ t: 'session', sessionId: 's-1' })
      options.onEvent({ t: 'done', ok: true })
      return { ok: true, sessionId: 's-1' }
    },
    async browser() {
      return { deleteSession: async () => undefined, probe: async () => ({ ok: true, status: 200 }) }
    },
    isWarm: () => true,
    close: async () => undefined,
    closeAll: async () => undefined,
    evictIdle: async () => undefined,
    lease: async () => {
      throw new Error('not used')
    },
  } as unknown as BrowserPool
}

/** A running gateway for one reply. */
interface Harness {
  base: string
  key: string
}

/**
 * Run a body against a gateway whose upstream answers with one fixed reply.
 * @param text - the model's reply.
 * @param body - the test body.
 */
async function withReply(text: string, body: (harness: Harness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dswg-cross-'))
  const config = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 2, retryBudgetMs: 40, streamIdleTimeoutMs: 5000 })
  const handle = await start({ pool: replyPool(text), config, port: 0 })
  try {
    const account = handle.services.accounts.create({
      slug: 'a',
      label: 'main',
      email: 'a@b.c',
      token: 'token',
      status: 'active',
      deviceId: 'dev-1',
      did: 'did-1',
    })
    const created = handle.services.keys.create({ name: 'cross', accountIds: [account.id] })
    await body({ base: `http://127.0.0.1:${handle.port}`, key: created.secret })
  } finally {
    await handle.close()
    for (let attempt = 0; attempt < 5; attempt += 1) {
      try {
        rmSync(home, { recursive: true, force: true })
        break
      } catch {
        await new Promise((resolve) => setTimeout(resolve, 100))
      }
    }
  }
}

/** The OpenAI tool declarations for the fixture tools. */
const OPENAI_TOOLS = FIXTURE_TOOLS.map((name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: {} } },
}))

/** The same declarations, in Anthropic's spelling. */
const ANTHROPIC_TOOLS = FIXTURE_TOOLS.map((name) => ({ name, description: name, input_schema: { type: 'object', properties: {} } }))

/** One call as an OpenAI client sees it. */
interface OpenAiCall {
  name: string
  arguments: Record<string, unknown>
}

/**
 * POST to one API path.
 * @param harness - the running gateway.
 * @param path - request path.
 * @param body - request body.
 * @returns the response.
 */
async function post(harness: Harness, path: string, body: unknown): Promise<Response> {
  return fetch(`${harness.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.key}` },
    body: JSON.stringify(body),
  })
}

/**
 * Read the calls out of an OpenAI completion.
 * @param body - the completion.
 * @returns the calls, with their arguments parsed as a client would.
 */
function openAiCalls(body: unknown): OpenAiCall[] {
  const record = body as { choices?: Array<{ message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }
  const calls = record.choices?.[0]?.message?.tool_calls ?? []
  return calls.map((call) => ({
    name: call.function?.name ?? '',
    arguments: JSON.parse(call.function?.arguments ?? '{}') as Record<string, unknown>,
  }))
}

/**
 * Read the calls out of an OpenAI stream.
 * @param text - the raw SSE body.
 * @returns the assembled calls.
 */
function openAiStreamCalls(text: string): OpenAiCall[] {
  const byIndex = new Map<number, { name: string; arguments: string }>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ') || line === 'data: [DONE]') continue
    const frame = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index?: number; function?: { name?: string; arguments?: string } }> } }> }
    for (const call of frame.choices?.[0]?.delta?.tool_calls ?? []) {
      const at = call.index ?? 0
      const entry = byIndex.get(at) ?? { name: '', arguments: '' }
      entry.name += call.function?.name ?? ''
      entry.arguments += call.function?.arguments ?? ''
      byIndex.set(at, entry)
    }
  }
  return [...byIndex.values()].map((entry) => ({ name: entry.name, arguments: JSON.parse(entry.arguments || '{}') as Record<string, unknown> }))
}

/**
 * Read the calls out of an Anthropic message.
 * @param body - the message.
 * @returns the calls, as `tool_use` blocks.
 */
function anthropicCalls(body: unknown): OpenAiCall[] {
  const record = body as { content?: Array<{ type?: string; name?: string; input?: unknown }> }
  return (record.content ?? [])
    .filter((block) => block.type === 'tool_use')
    .map((block) => ({ name: block.name ?? '', arguments: (block.input ?? {}) as Record<string, unknown> }))
}

/**
 * Read the calls out of an Anthropic stream.
 * @param text - the raw SSE body.
 * @returns the calls assembled from the deltas.
 */
function anthropicStreamCalls(text: string): OpenAiCall[] {
  const byIndex = new Map<number, { name: string; json: string }>()
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue
    const frame = JSON.parse(line.slice(6)) as { type?: string; index?: number; content_block?: { type?: string; name?: string }; delta?: { type?: string; partial_json?: string } }
    if (frame.type === 'content_block_start' && frame.content_block?.type === 'tool_use') {
      byIndex.set(frame.index ?? 0, { name: frame.content_block.name ?? '', json: '' })
    }
    if (frame.type === 'content_block_delta' && frame.delta?.type === 'input_json_delta') {
      const entry = byIndex.get(frame.index ?? 0)
      if (entry) entry.json += frame.delta.partial_json ?? ''
    }
  }
  return [...byIndex.values()].map((entry) => ({ name: entry.name, arguments: JSON.parse(entry.json || '{}') as Record<string, unknown> }))
}

/**
 * Assert the calls a reply produced.
 * @param fixture - the reply under test.
 * @param calls - what the client saw.
 * @param mode - which dialect and framing produced them.
 */
function assertCalls(fixture: ReplyFixture, calls: OpenAiCall[], mode: string): void {
  assert.deepEqual(
    calls.map((call) => call.name),
    fixture.expect,
    `${fixture.name} (${mode}): expected [${fixture.expect.join(',')}], got [${calls.map((call) => call.name).join(',')}]`,
  )
  for (const call of calls) {
    assert.equal(typeof call.arguments, 'object', `${fixture.name} (${mode}): arguments must be an object`)
    assert.ok(call.arguments !== null && !Array.isArray(call.arguments), `${fixture.name} (${mode}): arguments must be a JSON object`)
  }
}

describe('reply corpus through the API', () => {
  for (const fixture of CALL_REPLIES) {
    it(`reads ${fixture.name} in every dialect`, async () => {
      await withReply(fixture.text, async (harness) => {
        const oneShot = await post(harness, '/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'go' }],
          tools: OPENAI_TOOLS,
        })
        assert.equal(oneShot.status, 200, `${fixture.name}: OpenAI one-shot status`)
        const oneShotBody = (await oneShot.json()) as { choices?: Array<{ finish_reason?: string }> }
        assertCalls(fixture, openAiCalls(oneShotBody), 'openai')
        assert.equal(oneShotBody.choices?.[0]?.finish_reason, 'tool_calls', `${fixture.name}: finish_reason`)

        const streamed = await post(harness, '/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'go' }],
          tools: OPENAI_TOOLS,
          stream: true,
        })
        assertCalls(fixture, openAiStreamCalls(await streamed.text()), 'openai stream')

        const message = await post(harness, '/v1/messages', {
          model: 'deepseek-chat',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'go' }],
          tools: ANTHROPIC_TOOLS,
        })
        assert.equal(message.status, 200, `${fixture.name}: Anthropic status`)
        const messageBody = (await message.json()) as { stop_reason?: string }
        assertCalls(fixture, anthropicCalls(messageBody), 'anthropic')
        assert.equal(messageBody.stop_reason, 'tool_use', `${fixture.name}: stop_reason`)

        const messageStream = await post(harness, '/v1/messages', {
          model: 'deepseek-chat',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'go' }],
          tools: ANTHROPIC_TOOLS,
          stream: true,
        })
        assertCalls(fixture, anthropicStreamCalls(await messageStream.text()), 'anthropic stream')
      })
    })
  }

  for (const fixture of UNREADABLE_REPLIES) {
    it(`reports ${fixture.name} instead of executing or answering it`, async () => {
      await withReply(fixture.text, async (harness) => {
        const response = await post(harness, '/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'go' }],
          tools: OPENAI_TOOLS,
        })
        assert.equal(response.status, 502, `${fixture.name}: an unreadable call must fail the turn`)
        const body = (await response.json()) as { error?: { type?: string; code?: string } }
        assert.equal(body.error?.code, 'upstream_protocol_error', `${fixture.name}: the failure must name the protocol`)
      })
    })
  }

  for (const fixture of PROSE_REPLIES) {
    it(`leaves ${fixture.name} as prose`, async () => {
      await withReply(fixture.text, async (harness) => {
        const oneShot = await post(harness, '/v1/chat/completions', {
          model: 'deepseek-chat',
          messages: [{ role: 'user', content: 'go' }],
          tools: OPENAI_TOOLS,
        })
        const body = (await oneShot.json()) as { choices?: Array<{ finish_reason?: string }> }
        assertCalls(fixture, openAiCalls(body), 'openai')
        assert.equal(body.choices?.[0]?.finish_reason, 'stop', `${fixture.name}: finish_reason must stay stop`)

        const message = await post(harness, '/v1/messages', {
          model: 'deepseek-chat',
          max_tokens: 512,
          messages: [{ role: 'user', content: 'go' }],
          tools: ANTHROPIC_TOOLS,
        })
        const messageBody = (await message.json()) as { stop_reason?: string }
        assertCalls(fixture, anthropicCalls(messageBody), 'anthropic')
        assert.equal(messageBody.stop_reason, 'end_turn', `${fixture.name}: stop_reason must stay end_turn`)
      })
    })
  }
})
