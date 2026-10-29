import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig } from '../src/config.ts'
import { start } from '../src/main.ts'
import type { BrowserPool } from '../src/browser/pool.ts'
import type { AccountRecord } from '../src/store/accounts.ts'
import type { Services } from '../src/api/services.ts'

/** What the scripted upstream does for one turn. */
type Script =
  | { kind: 'text'; pieces: string[] }
  | { kind: 'block'; ms: number }
  | { kind: 'fail'; failure: { kind: string; message?: string; status?: number; body?: string } }

/**
 * Build the SSE a completion produces for a run of text.
 * @param pieces - successive pieces of one RESPONSE fragment.
 * @returns the raw stream text.
 */
function streamFor(pieces: string[]): string {
  const lines = ['event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n']
  lines.push(`data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: pieces[0] ?? '' }] } } })}\n`)
  for (const piece of pieces.slice(1)) {
    lines.push(`data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: piece })}\n`)
  }
  lines.push(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n`)
  return lines.join('\n')
}

/** A pool double that answers from a fixed list of scripts, cycling the last. */
function scriptedPool(scripts: Script[], prompts: string[] = []): BrowserPool {
  let index = 0
  return {
    async turn(_account: AccountRecord, options: { onEvent: (event: unknown) => void; prompt: string; signal?: AbortSignal }) {
      prompts.push(options.prompt)
      const script = scripts[Math.min(index, scripts.length - 1)] ?? { kind: 'text', pieces: [''] }
      index += 1
      if (script.kind === 'fail') return { ok: false, failure: script.failure }
      if (script.kind === 'block') {
        await new Promise((resolve) => setTimeout(resolve, script.ms))
        return { ok: true, sessionId: 's-1' }
      }
      const raw = streamFor(script.pieces)
      for (let at = 0; at < raw.length; at += 64) {
        if (options.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }
        options.onEvent({ t: 'chunk', v: raw.slice(at, at + 64) })
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

/** A running gateway plus the handles a test needs. */
interface Harness {
  base: string
  services: Services
  key: string
  prompts: string[]
}

/**
 * Run a test body against a freshly booted gateway.
 * @param scripts - what the scripted upstream should answer, in order.
 * @param body - the test body.
 */
async function withHarness(
  scripts: Script[],
  body: (harness: Harness) => Promise<void>,
  overrides: Partial<Parameters<typeof loadConfig>[0] extends never ? never : Record<string, unknown>> = {},
): Promise<void> {
  const home = mkdtempSync(join(tmpdir(), 'dswg-http-'))
  const config = loadConfig({
    home,
    accountMinGapMs: 0,
    accountRpm: 1000,
    retryBaseMs: 1,
    retryMaxMs: 2,
    retryBudgetMs: 40,
    streamIdleTimeoutMs: 5000,
    ...overrides,
  } as Parameters<typeof loadConfig>[0])
  const prompts: string[] = []
  const handle = await start({ pool: scriptedPool(scripts, prompts), config, port: 0 })
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
    const created = handle.services.keys.create({ name: 'test', accountIds: [account.id] })
    await body({ base: `http://127.0.0.1:${handle.port}`, services: handle.services, key: created.secret, prompts })
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
 * POST JSON to a harness.
 * @param harness - the running gateway.
 * @param path - request path.
 * @param body - JSON body or raw text.
 * @param headers - extra headers.
 * @returns the response.
 */
async function post(harness: Harness, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Response> {
  return fetch(`${harness.base}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.key}`, ...headers },
    body: typeof body === 'string' ? body : JSON.stringify(body),
  })
}

/** A one-message chat body. */
function chat(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return { model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }], ...overrides }
}

describe('http surface', () => {
  it('answers /health and a JSON 404 for an unknown route', async () => {
    await withHarness([], async (harness) => {
      const health = await fetch(`${harness.base}/health`)
      assert.equal(health.status, 200)
      assert.equal(((await health.json()) as { ok: boolean }).ok, true)
      const missing = await fetch(`${harness.base}/nope`)
      assert.equal(missing.status, 404)
      assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'not_found')
    })
  })

  it('rejects a request with no key, and answers one with a key', async () => {
    await withHarness([{ kind: 'text', pieces: ['ok'] }], async (harness) => {
      const anonymous = await fetch(`${harness.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(chat()),
      })
      assert.equal(anonymous.status, 401)
      assert.equal(((await anonymous.json()) as { error: { code: string } }).error.code, 'invalid_api_key')

      const withKey = await post(harness, '/v1/chat/completions', chat(), { authorization: '', 'x-api-key': harness.key })
      assert.equal(withKey.status, 200)
    })
  })

  it('guards /v1/models and lists the catalogue', async () => {
    await withHarness([], async (harness) => {
      assert.equal((await fetch(`${harness.base}/v1/models`)).status, 401)
      const response = await fetch(`${harness.base}/v1/models`, { headers: { authorization: `Bearer ${harness.key}` } })
      const body = (await response.json()) as { data: Array<{ id: string }> }
      assert.equal(response.status, 200)
      assert.ok(body.data.some((model) => model.id === 'deepseek-chat'))
      assert.ok(body.data.some((model) => model.id === 'deepseek-reasoner'))
    })
  })

  it('completes a non-streaming turn', async () => {
    await withHarness([{ kind: 'text', pieces: ['hel', 'lo'] }], async (harness) => {
      const response = await post(harness, '/v1/chat/completions', chat())
      assert.equal(response.status, 200)
      const body = (await response.json()) as {
        object: string
        choices: Array<{ message: { role: string; content: string }; finish_reason: string }>
        usage: { prompt_tokens: number; completion_tokens: number; total_tokens: number }
      }
      assert.equal(body.object, 'chat.completion')
      assert.equal(body.choices[0]?.message.role, 'assistant')
      assert.equal(body.choices[0]?.message.content, 'hello')
      assert.equal(body.choices[0]?.finish_reason, 'stop')
      assert.ok(body.usage.total_tokens >= body.usage.completion_tokens)
    })
  })

  it('streams chat.completion.chunk frames and ends with [DONE]', async () => {
    await withHarness([{ kind: 'text', pieces: ['a', 'b', 'c'] }], async (harness) => {
      const response = await post(harness, '/v1/chat/completions', chat({ stream: true }))
      const text = await response.text()
      assert.match(text, /"object":"chat\.completion\.chunk"/)
      assert.ok(text.trimEnd().endsWith('data: [DONE]'))
      const content = text
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => {
          const parsed = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }
          return parsed.choices?.[0]?.delta?.content ?? ''
        })
        .join('')
      assert.equal(content, 'abc')
    })
  })

  it('streams usage when stream_options.include_usage is set', async () => {
    await withHarness([{ kind: 'text', pieces: ['x'] }], async (harness) => {
      const response = await post(harness, '/v1/chat/completions', chat({ stream: true, stream_options: { include_usage: true } }))
      const text = await response.text()
      const usageFrame = text
        .split('\n')
        .filter((line) => line.startsWith('data: {'))
        .map((line) => JSON.parse(line.slice(6)) as { usage?: { total_tokens: number } })
        .find((frame) => frame.usage !== undefined)
      assert.ok(usageFrame, 'expected a usage frame')
      assert.ok((usageFrame?.usage?.total_tokens ?? 0) > 0)
    })
  })

  it('emits tool_calls for a taught block', async () => {
    await withHarness([{ kind: 'text', pieces: ['<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>'] }], async (harness) => {
      const response = await post(harness, '/v1/chat/completions', chat({
        tools: [{ type: 'function', function: { name: 'get_weather', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } } }],
      }))
      const body = (await response.json()) as {
        choices: Array<{ finish_reason: string; message: { tool_calls?: Array<{ type: string; function: { name: string; arguments: string } }> } }>
      }
      assert.equal(body.choices[0]?.finish_reason, 'tool_calls')
      const call = body.choices[0]?.message.tool_calls?.[0]
      assert.equal(call?.type, 'function')
      assert.equal(call?.function.name, 'get_weather')
      assert.deepEqual(JSON.parse(call?.function.arguments ?? '{}'), { city: 'Paris' })
    })
  })

  it('rejects a malformed body and an empty message list', async () => {
    await withHarness([], async (harness) => {
      const malformed = await post(harness, '/v1/chat/completions', '{not json')
      assert.equal(malformed.status, 400)
      assert.equal(((await malformed.json()) as { error: { type: string } }).error.type, 'invalid_request_error')
      assert.equal((await post(harness, '/v1/chat/completions', { model: 'deepseek-chat', messages: [] })).status, 400)
    })
  })

  it('enforces a key model allow-list', async () => {
    await withHarness([], async (harness) => {
      const { secret } = harness.services.keys.create({ name: 'restricted', models: ['deepseek-reasoner'] })
      const response = await post(harness, '/v1/chat/completions', chat(), { authorization: `Bearer ${secret}` })
      assert.equal(response.status, 403)
      assert.equal(((await response.json()) as { error: { code: string } }).error.code, 'model_not_allowed')
    })
  })

  it('answers Anthropic clients, streaming and not', async () => {
    await withHarness([{ kind: 'text', pieces: ['hello'] }, { kind: 'text', pieces: ['hello'] }], async (harness) => {
      const oneShot = await post(harness, '/v1/messages', { model: 'deepseek-chat', max_tokens: 64, messages: [{ role: 'user', content: 'hi' }] }, {
        authorization: '',
        'x-api-key': harness.key,
      })
      assert.equal(oneShot.status, 200)
      const body = (await oneShot.json()) as { type: string; content: Array<{ type: string; text: string }>; stop_reason: string }
      assert.equal(body.type, 'message')
      assert.equal(body.content[0]?.type, 'text')
      assert.equal(body.content[0]?.text, 'hello')
      assert.equal(body.stop_reason, 'end_turn')

      const streamed = await post(harness, '/v1/messages', { model: 'deepseek-chat', max_tokens: 64, stream: true, messages: [{ role: 'user', content: 'hi' }] }, {
        authorization: '',
        'x-api-key': harness.key,
      })
      const text = await streamed.text()
      for (const event of ['message_start', 'content_block_start', 'content_block_delta', 'content_block_stop', 'message_delta', 'message_stop']) {
        assert.ok(text.includes(`event: ${event}`), `missing ${event}`)
      }
    })
  })

  it('renders an upstream failure in the OpenAI envelope', async () => {
    const fail: Script = { kind: 'fail', failure: { kind: 'busy', message: 'Server is temporarily unavailable' } }
    await withHarness([fail], async (harness) => {
      const response = await post(harness, '/v1/chat/completions', chat())
      assert.equal(response.status, 503)
      const body = (await response.json()) as { error: { code: string; type: string } }
      assert.equal(body.error.code, 'upstream_busy')
      assert.equal(body.error.type, 'api_error')
      assert.ok(response.headers.get('retry-after'), 'a busy refusal must say when to come back')
    })
  })

  it('renders an upstream failure in the Anthropic envelope', async () => {
    const fail: Script = { kind: 'fail', failure: { kind: 'busy', message: 'Server is temporarily unavailable' } }
    await withHarness([fail], async (harness) => {
      const response = await post(harness, '/v1/messages', { model: 'deepseek-chat', max_tokens: 8, messages: [{ role: 'user', content: 'hi' }] }, {
        authorization: '',
        'x-api-key': harness.key,
      })
      assert.equal(response.status, 503)
      const body = (await response.json()) as { type: string; error: { type: string } }
      assert.equal(body.type, 'error')
      assert.equal(body.error.type, 'overloaded_error')
    })
  })

  it('returns 429 with an account reason when waiting is switched off', async () => {
    const fail: Script = { kind: 'fail', failure: { kind: 'busy', message: 'Server is temporarily unavailable' } }
    // DSWG_WAIT_FOR_ACCOUNT_MS=0 is the fail-fast deployment: the client is told
    // to come back rather than held.
    await withHarness(
      [fail],
      async (harness) => {
        await post(harness, '/v1/chat/completions', chat())
        const second = await post(harness, '/v1/chat/completions', chat())
        assert.equal(second.status, 429)
        const body = (await second.json()) as { error: { code: string; message: string } }
        assert.equal(body.error.code, 'no_account_available')
        assert.match(body.error.message, /cooling down|muted|disabled/)
        assert.ok(second.headers.get('retry-after'))
      },
      { waitForAccountMs: 0 },
    )
  })

  it('holds the request until the only account is out of its cooldown', async () => {
    await withHarness([{ kind: 'text', pieces: ['answered'] }], async (harness) => {
      const account = harness.services.accounts.list()[0]
      assert.ok(account)
      harness.services.accounts.update(account.id, { cooldownUntil: Date.now() + 400 })
      const started = Date.now()
      const response = await post(harness, '/v1/chat/completions', chat())
      assert.equal(response.status, 200)
      const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
      assert.equal(body.choices?.[0]?.message?.content, 'answered')
      assert.ok(Date.now() - started >= 400, 'the request must wait out the window, not fail')
    }, { waitForAccountMs: 5000 })
  })

  it('retries a transient refusal and then answers', async () => {
    await withHarness(
      [
        { kind: 'fail', failure: { kind: 'busy', message: 'The server is busy' } },
        { kind: 'text', pieces: ['recovered'] },
      ],
      async (harness) => {
        const response = await post(harness, '/v1/chat/completions', chat())
        assert.equal(response.status, 200)
        const body = (await response.json()) as { choices: Array<{ message: { content: string } }> }
        assert.equal(body.choices[0]?.message.content, 'recovered')
      },
    )
  })

  it('survives a client that disconnects mid-stream', async () => {
    await withHarness([{ kind: 'text', pieces: ['x'.repeat(400)] }, { kind: 'text', pieces: ['ok'] }], async (harness) => {
      const controller = new AbortController()
      const response = await fetch(`${harness.base}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: `Bearer ${harness.key}` },
        body: JSON.stringify(chat({ stream: true })),
        signal: controller.signal,
      })
      const reader = response.body?.getReader()
      await reader?.read()
      controller.abort()
      await new Promise((resolve) => setTimeout(resolve, 100))
      assert.equal((await fetch(`${harness.base}/health`)).status, 200)
      const after = await post(harness, '/v1/chat/completions', chat())
      assert.equal(after.status, 200)
    })
  })

  it('serves concurrent requests', async () => {
    await withHarness([{ kind: 'text', pieces: ['ok'] }], async (harness) => {
      const responses = await Promise.all(Array.from({ length: 8 }, () => post(harness, '/v1/chat/completions', chat())))
      assert.equal(responses.filter((response) => response.status === 200).length, 8)
    })
  })

  it('enforces a key requests-per-minute limit', async () => {
    await withHarness([{ kind: 'text', pieces: ['ok'] }], async (harness) => {
      const { secret } = harness.services.keys.create({ name: 'slow', rpm: 1 })
      const first = await post(harness, '/v1/chat/completions', chat(), { authorization: `Bearer ${secret}` })
      const second = await post(harness, '/v1/chat/completions', chat(), { authorization: `Bearer ${secret}` })
      assert.equal(first.status, 200)
      assert.equal(second.status, 429)
      assert.equal(((await second.json()) as { error: { code: string } }).error.code, 'rate_limit_exceeded')
      assert.ok(second.headers.get('retry-after'))
    })
  })

  it('serves the dashboard, its assets and the admin API', async () => {
    await withHarness([], async (harness) => {
      const page = await fetch(`${harness.base}/admin`)
      assert.equal(page.status, 200)
      assert.match(await page.text(), /DeepSeek Web Gateway/)
      assert.equal((await fetch(`${harness.base}/admin/app.js`)).status, 200)
      assert.equal((await fetch(`${harness.base}/admin/styles.css`)).status, 200)
      const overview = await fetch(`${harness.base}/admin/api/overview`)
      assert.equal(overview.status, 200)
      assert.equal(((await overview.json()) as { accounts: { total: number } }).accounts.total, 1)
      const usage = await fetch(`${harness.base}/admin/api/usage?hours=24`)
      assert.equal(usage.status, 200)
    })
  })

  it('returns a JSON envelope, not a hang, when an admin route rejects', async () => {
    await withHarness([], async (harness) => {
      const missing = await fetch(`${harness.base}/admin/api/accounts/does-not-exist/check`, { method: 'POST' })
      assert.equal(missing.status, 404)
      assert.equal(((await missing.json()) as { error: { code: string } }).error.code, 'not_found')
      assert.equal((await fetch(`${harness.base}/admin/api/accounts/does-not-exist/screenshot`)).status, 404)
    })
  })
})
