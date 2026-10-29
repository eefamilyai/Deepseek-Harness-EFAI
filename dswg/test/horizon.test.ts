/**
 * A long conversation against a model that keeps degrading.
 *
 * The parser unit tests prove single replies. This proves the thing that
 * actually breaks in production: a context that grows over dozens of turns while
 * the model's output wanders — truncating, drifting out of the taught format,
 * narrating its own tool results, answering in prose where it meant to act — with
 * the site occasionally refusing a turn outright. Every turn is driven through
 * the public API the way an agent loop drives it, with the previous answer and
 * its tool result fed back in, so the prompt really does grow.
 *
 * Three properties are asserted on every turn: the client never receives raw
 * tool markup as prose, the client never receives a call it did not ask for, and
 * a refusal is retried rather than surfaced.
 *
 * @module dswg/test/horizon
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

/** One scripted upstream turn. */
type Script =
  | { kind: 'text'; text: string }
  | { kind: 'busy'; message?: string }
  | { kind: 'drop' }

/** What the client must see after consuming the scripted turns. */
type Expect = { kind: 'call'; name: string } | { kind: 'prose' } | { kind: 'error'; status: number }

/** One step of the campaign. */
interface Step {
  /** What the upstream does, in order, for this client turn. */
  upstream: Script[]
  /** What the client must end up with. */
  expect: Expect
  /** Why the step exists, for whoever reads a failure. */
  why: string
}

/**
 * Build the completion stream for one reply.
 * @param text - the model's reply.
 * @returns the raw SSE text.
 */
function streamFor(text: string): string {
  const lines = ['event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n']
  lines.push(`data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: '' }] } } })}\n`)
  const size = Math.max(1, Math.ceil(text.length / 4))
  for (let at = 0; at < text.length; at += size) {
    lines.push(`data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: text.slice(at, at + size) })}\n`)
  }
  lines.push(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n`)
  return lines.join('\n')
}

/**
 * A pool that plays whatever the campaign queued for the current client turn.
 *
 * A turn can reach the upstream more than once — a refusal is retried, and an
 * unreadable reply is sent again with a correction — so a queue that ran out
 * repeats its last entry rather than bleeding into the next turn's script.
 * @param source - reads the current turn's scripts.
 * @param log - receives every prompt sent upstream.
 * @returns the pool.
 */
function planPool(source: () => Script[], log: string[]): BrowserPool {
  let script = 0
  let current: Script[] | null = null
  return {
    async turn(_account: AccountRecord, options: { onEvent: (event: unknown) => void; prompt: string; signal?: AbortSignal }) {
      const queue = source()
      if (queue !== current) {
        current = queue
        script = 0
      }
      const next = queue[Math.min(script, queue.length - 1)] ?? { kind: 'text', text: '' }
      script += 1
      log.push(options.prompt)
      if (next.kind === 'busy') {
        return { ok: false, failure: { kind: 'busy', status: 503, body: JSON.stringify({ code: 40003, msg: next.message ?? 'Server is temporarily unavailable' }), message: next.message ?? 'Server is temporarily unavailable' } }
      }
      if (next.kind === 'drop') return { ok: false, failure: { kind: 'network', message: 'connection reset' } }
      const raw = streamFor(next.text)
      for (let at = 0; at < raw.length; at += 96) {
        if (options.signal?.aborted) return { ok: false, failure: { kind: 'aborted' } }
        options.onEvent({ t: 'chunk', v: raw.slice(at, at + 96) })
      }
      options.onEvent({ t: 'session', sessionId: `s-${script}` })
      options.onEvent({ t: 'done', ok: true })
      return { ok: true, sessionId: `s-${script}` }
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

/** The tools the campaign's client declares. */
const TOOLS = ['read', 'write', 'edit', 'glob', 'grep', 'kernel', 'pwsh', 'todo_write'].map((name) => ({
  type: 'function',
  function: { name, description: name, parameters: { type: 'object', properties: { path: { type: 'string' } } } },
}))

/** A call the model makes, in the taught envelope. */
function call(name: string, args: Record<string, unknown>): string {
  return `<tool_call>\n${JSON.stringify({ name, arguments: args })}\n</tool_call>`
}

/**
 * The campaign.
 *
 * The order matters: it walks the same reply through the good path first, then
 * through every way that path degrades, so a failure names the shape that broke.
 * @returns the steps.
 */
function campaign(): Step[] {
  const steps: Step[] = [
    { upstream: [{ kind: 'text', text: `Listing first.\n${call('glob', { path: '**/*.ts' })}` }], expect: { kind: 'call', name: 'glob' }, why: 'a clean taught call' },
    { upstream: [{ kind: 'text', text: `<tool_call>{"name":"read","arguments":{"path":"a.ts"}}</tool_call>` }], expect: { kind: 'call', name: 'read' }, why: 'a call with no prose' },
    { upstream: [{ kind: 'text', text: '```json\n{"name":"grep","arguments":{"path":"src"}}\n```\n' }], expect: { kind: 'call', name: 'grep' }, why: 'a fenced call' },
    { upstream: [{ kind: 'text', text: '<｜｜DSML｜｜tool_calls>\n<｜｜DSML｜｜invoke name="read">\n<｜｜DSML｜｜parameter name="path" string="true">b.ts</｜｜DSML｜｜parameter>\n</｜｜DSML｜｜invoke>\n</｜｜DSML｜｜tool_calls>' }], expect: { kind: 'call', name: 'read' }, why: 'DSML framing' },
    { upstream: [{ kind: 'text', text: '<invoke name="write">\n<parameter name="path">c.ts</parameter>\n<content>export {}\n</parameter>\n</invoke>\n' }], expect: { kind: 'call', name: 'write' }, why: 'an invoke whose wrapper was lost' },
    { upstream: [{ kind: 'text', text: '<tool_calls><parameter name="path">d.ts</parameter>' }, { kind: 'text', text: 'Nothing to change.' }], expect: { kind: 'prose' }, why: 'a headerless payload is re-asked, then answered' },
    { upstream: [{ kind: 'text', text: 'The file already contains the export.' }], expect: { kind: 'prose' }, why: 'an ordinary answer' },
    { upstream: [{ kind: 'busy' }, { kind: 'text', text: `${call('read', { path: 'e.ts' })}` }], expect: { kind: 'call', name: 'read' }, why: 'a busy refusal, then the same turn' },
    { upstream: [{ kind: 'drop' }], expect: { kind: 'error', status: 503 }, why: 'a dropped connection' },
    { upstream: [{ kind: 'text', text: 'Tool result:\nconst x = 1\nexport {}\n' }], expect: { kind: 'error', status: 502 }, why: 'a narrated tool result' },
    { upstream: [{ kind: 'text', text: 'Tool result:\nnothing here\n' }, { kind: 'text', text: `${call('kernel', { path: 'x' })}` }], expect: { kind: 'call', name: 'kernel' }, why: 'roleplay corrected on the retry' },
    { upstream: [{ kind: 'text', text: '<tool_call>{"name":"read","arguments":{"path":' }], expect: { kind: 'call', name: 'read' }, why: 'truncated JSON' },
    { upstream: [{ kind: 'text', text: `${call('todo_write', { path: 'x' })}\n${call('todo_write', { path: 'y' })}` }], expect: { kind: 'call', name: 'todo_write' }, why: 'two calls in one reply' },
    { upstream: [{ kind: 'text', text: '````\n<tool_call>{"name":"read","arguments":{"path":"f"}}</tool_call>\n````' }], expect: { kind: 'call', name: 'read' }, why: 'four-backtick fencing' },
    { upstream: [{ kind: 'text', text: 'I will run grep(path="src") now.' }], expect: { kind: 'call', name: 'grep' }, why: 'call syntax' },
    { upstream: [{ kind: 'text', text: '```ts\nconst x = 1\n```\nDone.' }], expect: { kind: 'prose' }, why: 'a code answer' },
  ]
  return steps
}

describe('long horizon', () => {
  it('holds every property across a growing conversation', async () => {
    const steps = campaign()
    const prompts: string[] = []
    let queue: Script[] = []
    const home = mkdtempSync(join(tmpdir(), 'dswg-horizon-'))
    const config = loadConfig({
      home,
      accountMinGapMs: 0,
      accountRpm: 1000,
      retryBaseMs: 1,
      retryMaxMs: 2,
      retryBudgetMs: 200,
      streamIdleTimeoutMs: 5000,
    })
    const handle = await start({ pool: planPool(() => queue, prompts), config, port: 0 })
    try {
      const account = handle.services.accounts.create({ slug: 'a', label: 'main', email: 'a@b.c', token: 'token', status: 'active', deviceId: 'dev-1', did: 'did-1' })
      const created = handle.services.keys.create({ name: 'horizon', accountIds: [account.id] })
      const base = `http://127.0.0.1:${handle.port}`
      const messages: Array<Record<string, unknown>> = [{ role: 'system', content: 'You are a coding agent.' }, { role: 'user', content: 'Start.' }]

      for (const [index, step] of steps.entries()) {
        queue = [...step.upstream]
        const response = await fetch(`${base}/v1/chat/completions`, {
          method: 'POST',
          headers: { 'content-type': 'application/json', authorization: `Bearer ${created.secret}` },
          body: JSON.stringify({ model: 'deepseek-chat', messages, tools: TOOLS }),
        })
        const label = `turn ${index + 1} (${step.why})`
        if (step.expect.kind === 'error') {
          assert.equal(response.status, step.expect.status, `${label}: status`)
          // The refusal parked the only account, which is the gateway behaving
          // correctly. This campaign is about what a reply turns into, so the
          // cooldown is cleared and the conversation continues.
          handle.services.accounts.update(account.id, { cooldownUntil: null, status: 'active', lastError: null })
          continue
        }
        assert.equal(response.status, 200, `${label}: status ${response.status}: ${await response.clone().text()}`)
        const body = (await response.json()) as {
          choices?: Array<{ message?: { content?: string; tool_calls?: Array<{ id: string; function: { name: string; arguments: string } }> }; finish_reason?: string }>
        }
        const choice = body.choices?.[0]
        const text = choice?.message?.content ?? ''
        const calls = choice?.message?.tool_calls ?? []

        // No raw markup may survive into the text a client would show.
        for (const marker of ['<tool_call>', '<invoke', '</tool_calls>', '<parameter']) {
          assert.ok(!text.includes(marker), `${label}: leaked ${marker} into the reply text`)
        }
        for (const toolCall of calls) {
          assert.deepEqual(JSON.parse(toolCall.function.arguments), JSON.parse(toolCall.function.arguments), `${label}: arguments must parse`)
          assert.ok(toolCall.id.length > 0, `${label}: a call needs an id`)
        }
        assert.equal(new Set(calls.map((toolCall) => toolCall.id)).size, calls.length, `${label}: call ids must be unique`)

        if (step.expect.kind === 'call') {
          assert.ok(calls.length > 0, `${label}: expected a call, got prose: ${text.slice(0, 120)}`)
          assert.equal(calls[0]?.function.name, step.expect.name, `${label}: tool name`)
          assert.equal(choice?.finish_reason, 'tool_calls', `${label}: finish_reason`)
          messages.push({
            role: 'assistant',
            content: text,
            tool_calls: calls.map((toolCall) => ({ id: toolCall.id, type: 'function', function: toolCall.function })),
          })
          messages.push({ role: 'tool', tool_call_id: calls[0]?.id ?? '', name: calls[0]?.function.name ?? '', content: `result ${index} `.repeat(20) })
        } else {
          assert.equal(calls.length, 0, `${label}: expected prose, got [${calls.map((c) => c.function.name).join(',')}]`)
          messages.push({ role: 'assistant', content: text })
          messages.push({ role: 'user', content: `Continue ${index}.` })
        }
        messages.push({ role: 'user', content: `Next: ${'detail '.repeat(30)}` })
      }

      // The prompt really did grow, so the campaign exercised a long context
      // rather than a repeated short one.
      const last = prompts[prompts.length - 1] ?? ''
      assert.ok(last.length > 2000, `the final prompt should be long, was ${last.length}`)
      assert.ok(last.length < config.maxPromptChars, 'the prompt must stay inside the limit')
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
  })
})
