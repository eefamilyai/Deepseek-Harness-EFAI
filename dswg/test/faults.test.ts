/**
 * The upstream misbehaving in every way the transport allows.
 *
 * A completion arrives as a stream of JSON-document patches, delivered through a
 * browser fetch that can stop at any byte. Everything here is a way that stream
 * can be wrong without an error code: a character split across two chunks, a
 * patch that is not JSON, a stream that ends early, a payload that contains the
 * token that is supposed to end it. None of them may hang a request, duplicate
 * text, or turn into a call that was never written.
 *
 * @module dswg/test/faults
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

/** How the scripted upstream delivers one turn. */
type Delivery =
  | { kind: 'raw'; chunks: string[]; done?: boolean }
  | { kind: 'fail'; failure: { kind: string; message?: string; status?: number; body?: string } }
  | { kind: 'stall'; ms: number }

/**
 * A pool that delivers one scripted response per call.
 * @param deliveries - what to deliver, repeated from the last entry.
 * @returns the pool.
 */
function deliveryPool(deliveries: Delivery[]): BrowserPool {
  let index = 0
  return {
    async turn(_account: AccountRecord, options: { onEvent: (event: unknown) => void; signal?: AbortSignal }) {
      const delivery = deliveries[Math.min(index, deliveries.length - 1)] ?? { kind: 'raw', chunks: [] }
      index += 1
      if (delivery.kind === 'fail') return { ok: false, failure: delivery.failure }
      if (delivery.kind === 'stall') {
        await new Promise((resolve) => setTimeout(resolve, delivery.ms))
        return { ok: true, sessionId: 's-1' }
      }
      for (const chunk of delivery.chunks) {
        if (options.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }
        options.onEvent({ t: 'chunk', v: chunk })
      }
      if (delivery.done !== false) {
        options.onEvent({ t: 'session', sessionId: 's-1' })
        options.onEvent({ t: 'done', ok: true })
      }
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

/**
 * The SSE a completion produces for one reply, as separate chunks.
 * @param text - the reply.
 * @param size - characters per chunk in the initial document.
 * @returns the raw chunks.
 */
function patchChunks(text: string, size = 4096): string[] {
  const head = `event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n`
  const first = `data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: text.slice(0, size) }] } } })}\n`
  const chunks = [head + first]
  for (let at = size; at < text.length; at += size) {
    chunks.push(`data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: text.slice(at, at + size) })}\n`)
  }
  chunks.push(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n`)
  return chunks
}

/** A running gateway for one delivery script. */
interface Harness {
  base: string
  key: string
}

/**
 * Run a body against a gateway whose upstream follows one script.
 * @param deliveries - the upstream script.
 * @param body - the test body.
 */
async function withDelivery(deliveries: Delivery[], body: (harness: Harness) => Promise<void>): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dswg-faults-'))
  const config = loadConfig({
    home,
    accountMinGapMs: 0,
    accountRpm: 1000,
    retryBaseMs: 1,
    retryMaxMs: 2,
    retryBudgetMs: 60,
    streamIdleTimeoutMs: 400,
    turnTimeoutMs: 4000,
  })
  const handle = await start({ pool: deliveryPool(deliveries), config, port: 0 })
  try {
    const account = handle.services.accounts.create({ slug: 'a', label: 'main', email: 'a@b.c', token: 'token', status: 'active', deviceId: 'dev-1', did: 'did-1' })
    const created = handle.services.keys.create({ name: 'faults', accountIds: [account.id] })
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

/**
 * Ask for one completion.
 * @param harness - the running gateway.
 * @param overrides - request fields to change.
 * @returns the response.
 */
async function ask(harness: Harness, overrides: Record<string, unknown> = {}): Promise<Response> {
  return fetch(`${harness.base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.key}` },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'go' }], ...overrides }),
  })
}

/** The tool declaration these tests use. */
const TOOLS = [{ type: 'function', function: { name: 'write', parameters: { type: 'object', properties: { path: { type: 'string' }, content: { type: 'string' } } } } }]

describe('damaged upstream streams', () => {
  it('reassembles a character split across two chunks', async () => {
    const text = 'naïve café — 日本語 🎉 end'
    const raw = patchChunks(text, 1024).join('')
    // Split inside the multi-byte sequence — three bytes into the emoji.
    const at = raw.indexOf('🎉') + 2
    await withDelivery([{ kind: 'raw', chunks: [raw.slice(0, at), raw.slice(at)] }], async (harness) => {
      const body = (await (await ask(harness)).json()) as { choices?: Array<{ message?: { content?: string } }> }
      assert.equal(body.choices?.[0]?.message?.content, text)
    })
  })

  it('ignores a patch that is not JSON and keeps reading', async () => {
    const chunks = patchChunks('hello world')
    chunks.splice(1, 0, 'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"X"\n')
    await withDelivery([{ kind: 'raw', chunks }], async (harness) => {
      const body = (await (await ask(harness)).json()) as { choices?: Array<{ message?: { content?: string } }> }
      assert.equal(body.choices?.[0]?.message?.content, 'hello world')
    })
  })

  it('answers with the text it got when the stream stops early', async () => {
    const chunks = patchChunks('partial answer here', 8)
    // The last patch is dropped, so no FINISHED status ever arrives.
    await withDelivery([{ kind: 'raw', chunks: chunks.slice(0, -1) }], async (harness) => {
      const response = await ask(harness)
      assert.equal(response.status, 200)
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      assert.match(body.choices?.[0]?.message?.content ?? '', /partial/)
    })
  })

  it('does not hang when the upstream never sends a byte', async () => {
    await withDelivery([{ kind: 'raw', chunks: [], done: false }], async (harness) => {
      const started = Date.now()
      const response = await ask(harness)
      assert.ok(Date.now() - started < 3000, 'the idle watchdog must end the turn')
      assert.ok(response.status >= 400, `expected a failure, got ${response.status}`)
    })
  })

  it('keeps a tool call whose content holds the closing token', async () => {
    const content = 'line one\n</tool_call>\nline three'
    const text = `<tool_call>${JSON.stringify({ name: 'write', arguments: { path: 'a.txt', content } })}</tool_call>`
    await withDelivery([{ kind: 'raw', chunks: patchChunks(text, 16) }], async (harness) => {
      const body = (await (await ask(harness, { tools: TOOLS })).json()) as {
        choices?: Array<{ message?: { tool_calls?: Array<{ function: { name: string; arguments: string } }> } }>
      }
      const call = body.choices?.[0]?.message?.tool_calls?.[0]
      assert.ok(call, 'the call must survive')
      assert.equal(call?.function.name, 'write')
      assert.deepEqual(JSON.parse(call?.function.arguments ?? '{}'), { path: 'a.txt', content })
    })
  })

  it('numbers many streamed calls without collision', async () => {
    const calls = Array.from({ length: 40 }, (_, index) => `<tool_call>{"name":"write","arguments":{"path":"f${index}"}}</tool_call>`).join('\n')
    await withDelivery([{ kind: 'raw', chunks: patchChunks(calls, 512) }], async (harness) => {
      const response = await ask(harness, { tools: TOOLS, stream: true })
      const text = await response.text()
      const indices = new Set<number>()
      let assembled = ''
      for (const line of text.split('\n')) {
        if (!line.startsWith('data: {')) continue
        const frame = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { tool_calls?: Array<{ index: number; id: string; function?: { arguments?: string } }> } }> }
        for (const call of frame.choices?.[0]?.delta?.tool_calls ?? []) {
          indices.add(call.index)
          assembled += call.function?.arguments ?? ''
        }
      }
      assert.equal(indices.size, 40, 'every call needs its own index')
      const parsed = assembled.split(/(?<=\})(?=\{)/).map((piece) => JSON.parse(piece) as unknown)
      assert.equal(parsed.length, 40)
    })
  })

  it('surfaces a retry delay when the site is busy', async () => {
    await withDelivery([{ kind: 'fail', failure: { kind: 'busy', status: 503, body: JSON.stringify({ code: 50001, msg: 'Server is temporarily unavailable' }), message: 'Server is temporarily unavailable' } }], async (harness) => {
      const response = await ask(harness)
      assert.equal(response.status, 503)
      assert.ok(response.headers.get('retry-after') !== null, 'a busy answer must say how long to wait')
    })
  })

  it('reports an edge interception instead of an empty answer', async () => {
    await withDelivery([{ kind: 'fail', failure: { kind: 'http', status: 202, body: '<html>challenge</html>', message: 'blocked by the edge' } }], async (harness) => {
      const response = await ask(harness)
      assert.ok(response.status >= 400, `expected a failure, got ${response.status}`)
      const body = (await response.json()) as { error?: { message?: string } }
      assert.ok((body.error?.message ?? '').length > 0, 'the failure must explain itself')
    })
  })
})
