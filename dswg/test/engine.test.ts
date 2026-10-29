import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { loadConfig, type Config } from '../src/config.ts'
import { openDatabase, type Db } from '../src/store/db.ts'
import { AccountRepo, type AccountRecord } from '../src/store/accounts.ts'
import { SecretBox } from '../src/util/crypto.ts'
import { TurnEngine } from '../src/engine/turn.ts'
import type { BrowserPool } from '../src/browser/pool.ts'
import type { CanonicalRequest } from '../src/api/canonical.ts'
import type { ApiKey } from '../src/store/keys.ts'

/** One scripted upstream turn. */
interface Script {
  /** Assistant text, delivered as one RESPONSE fragment in pieces. */
  pieces?: string[]
  /** Raw SSE text to send instead of `pieces`. */
  raw?: string[]
  /** Fail the turn with this upstream failure. */
  fail?: { kind: string; message?: string; body?: string; status?: number }
}

/**
 * Build the SSE a completion produces for a run of text pieces.
 * @param pieces - successive pieces of one RESPONSE fragment.
 * @returns the raw stream text.
 */
function streamFor(pieces: string[]): string {
  const lines: string[] = []
  lines.push('event: ready\ndata: {"request_message_id":1,"response_message_id":2,"model_type":"default"}\n')
  const first = pieces[0] ?? ''
  lines.push(
    `data: ${JSON.stringify({ v: { response: { status: 'WIP', fragments: [{ id: 2, type: 'RESPONSE', content: first }] } } })}\n`,
  )
  for (const piece of pieces.slice(1)) {
    lines.push(`data: ${JSON.stringify({ p: 'response/fragments/-1/content', o: 'APPEND', v: piece })}\n`)
  }
  lines.push(`data: ${JSON.stringify({ p: 'response/status', o: 'SET', v: 'FINISHED' })}\n`)
  return lines.join('\n')
}

/**
 * One upstream frame carrying a bare verdict envelope.
 * @param verdict - the envelope object.
 * @returns the raw stream text.
 */
function verdictFor(verdict: Record<string, unknown>): string {
  return `data: ${JSON.stringify(verdict)}\n\n`
}

/**
 * Build a pool double that answers from a script, in order.
 * @param scripts - one entry per upstream turn.
 * @returns the pool double plus the prompts it saw.
 */
function fakePool(scripts: Script[]): { pool: BrowserPool; prompts: string[]; calls: () => number } {
  let index = 0
  const prompts: string[] = []
  const pool = {
    async turn(_account: AccountRecord, options: { onEvent: (event: unknown) => void; prompt: string }) {
      prompts.push(options.prompt)
      const script = scripts[Math.min(index, scripts.length - 1)] ?? {}
      index += 1
      if (script.fail) return { ok: false, failure: script.fail }
      const raw = script.raw ?? [streamFor(script.pieces ?? [])]
      for (const chunk of raw) options.onEvent({ t: 'chunk', v: chunk })
      options.onEvent({ t: 'session', sessionId: 'session-1' })
      options.onEvent({ t: 'done', ok: true })
      return { ok: true, sessionId: 'session-1' }
    },
    async browser() {
      return { deleteSession: async () => undefined }
    },
    isWarm: () => false,
    close: async () => undefined,
    closeAll: async () => undefined,
    evictIdle: async () => undefined,
  } as unknown as BrowserPool
  return { pool, prompts, calls: () => index }
}

/** A minimal key. */
function key(accountIds: string[] = []): ApiKey {
  return { id: 'key-1', name: 'test', prefix: 'sk-dswg-x', accountIds, models: [], rpm: null, createdAt: 0, lastUsedAt: null, revokedAt: null, notes: null }
}

/** A minimal request. */
function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
  return {
    model: 'deepseek-chat',
    messages: [{ role: 'user', content: 'hello' }],
    tools: [],
    toolChoice: 'auto',
    requiredTool: null,
    temperature: null,
    maxTokens: null,
    stop: [],
    stream: true,
    thinking: false,
    search: false,
    sessionKey: null,
    correction: null,
    ...overrides,
  }
}

const weatherTool = {
  name: 'get_weather',
  description: 'Get the weather.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}

describe('turn engine', () => {
  let home: string
  let db: Db
  let accounts: AccountRepo
  let config: Config

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dswg-test-'))
    config = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 5, retryBudgetMs: 3000 })
    db = openDatabase(home)
    accounts = new AccountRepo(db, new SecretBox(join(home, 'secret.key')))
  })

  afterEach(() => {
    db.sql.close()
    rmSync(home, { recursive: true, force: true })
  })

  /**
   * Store a usable account.
   * @param label - display name.
   * @returns the record.
   */
  function account(label: string): AccountRecord {
    return accounts.create({ slug: label, label, email: `${label}@example.com`, token: 'token-value', status: 'active' })
  }

  it('streams text and reports a stop', async () => {
    const one = account('one')
    const { pool } = fakePool([{ pieces: ['hel', 'lo'] }])
    const engine = new TurnEngine(config, accounts, pool)
    const seen: string[] = []
    const outcome = await engine.run({ request: request(), key: key(), hooks: { onText: (text) => seen.push(text) } })
    assert.equal(outcome.text, 'hello')
    assert.equal(outcome.finishReason, 'stop')
    assert.equal(outcome.accountId, one.id)
    assert.equal(seen.join(''), 'hello')
    assert.notEqual(accounts.get(one.id)?.lastUsedAt, null)
  })

  it('turns a taught tool block into a tool call', async () => {
    account('one')
    const block = '<tool_call>\n{"name":"get_weather","arguments":{"city":"Paris"}}\n</tool_call>'
    const { pool } = fakePool([{ pieces: [block.slice(0, 20), block.slice(20)] }])
    const engine = new TurnEngine(config, accounts, pool)
    const seen: string[] = []
    const outcome = await engine.run({
      request: request({ tools: [weatherTool] }),
      key: key(),
      hooks: { onToolCall: (call) => seen.push(`${call.name}:${JSON.stringify(call.arguments)}`) },
    })
    assert.equal(outcome.finishReason, 'tool_calls')
    assert.equal(outcome.toolCalls.length, 1)
    assert.equal(outcome.toolCalls[0]?.name, 'get_weather')
    assert.deepEqual(outcome.toolCalls[0]?.arguments, { city: 'Paris' })
    assert.deepEqual(seen, ['get_weather:{"city":"Paris"}'])
  })

  it('keeps prose that surrounds a tool call', async () => {
    account('one')
    const { pool } = fakePool([
      { pieces: ['Checking now.\n<tool_call>{"name":"get_weather","arguments":{"city":"Rome"}}</tool_call>'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const outcome = await engine.run({ request: request({ tools: [weatherTool] }), key: key(), hooks: {} })
    assert.equal(outcome.text.trim(), 'Checking now.')
    assert.equal(outcome.toolCalls[0]?.arguments.city, 'Rome')
  })

  it('fails over to the next account when a token is dead', async () => {
    const first = account('one')
    const second = account('two')
    const { pool, calls } = fakePool([
      { raw: [verdictFor({ code: 40003, msg: 'Authorization Failed (invalid token)', data: null })] },
      { pieces: ['second'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const outcome = await engine.run({ request: request(), key: key(), hooks: {} })
    assert.equal(outcome.text, 'second')
    assert.equal(outcome.accountId, second.id)
    assert.equal(accounts.get(first.id)?.status, 'reauth')
    assert.equal(calls(), 2)
  })

  it('marks a muted account and uses the other one', async () => {
    const first = account('one')
    account('two')
    const { pool, calls } = fakePool([
      { raw: [verdictFor({ code: 0, data: { biz_code: 7, biz_msg: 'Your account has been muted until 1791100000' } })] },
      { pieces: ['ok'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const outcome = await engine.run({ request: request(), key: key(), hooks: {} })
    assert.equal(outcome.text, 'ok')
    const muted = accounts.get(first.id)
    assert.equal(muted?.status, 'muted')
    assert.equal(muted?.mutedUntil, 1791100000000)
    assert.equal(calls(), 2)
  })

  it('retries once when the tool markup could not be parsed', async () => {
    account('one')
    const { pool, prompts } = fakePool([
      { pieces: ['<tool_call>not json</tool_call>'] },
      { pieces: ['<tool_call>{"name":"ping","arguments":{}}</tool_call>'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const outcome = await engine.run({
      request: request({ tools: [{ name: 'ping', parameters: { type: 'object', properties: {} } }] }),
      key: key(),
      hooks: {},
    })
    assert.equal(prompts.length, 2)
    assert.match(prompts[1] ?? '', /# Format correction/)
    assert.equal(outcome.toolCalls[0]?.name, 'ping')
  })

  it('does not retry when prose was already streamed', async () => {
    account('one')
    const { pool, prompts } = fakePool([{ pieces: ['Here you go. <tool_call>broken</tool_call>'] }])
    const engine = new TurnEngine(config, accounts, pool)
    // A hook means the caller is streaming: the prose is already out, and a
    // second attempt would duplicate it.
    const outcome = await engine.run({ request: request({ tools: [weatherTool] }), key: key(), hooks: { onText: () => undefined } })
    assert.equal(prompts.length, 1)
    assert.equal(outcome.finishReason, 'stop')
    assert.equal(outcome.text.includes('Here you go.'), true)
  })

  it('retries a broken call the client has not seen yet', async () => {
    account('one')
    const { pool, prompts } = fakePool([
      { pieces: ['Here you go. <tool_call>broken</tool_call>'] },
      { pieces: ['<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    // No hook: the reply is assembled before the client sees anything, so a
    // broken call can still be replaced by a repaired one.
    const outcome = await engine.run({ request: request({ tools: [weatherTool] }), key: key(), hooks: {} })
    assert.equal(prompts.length, 2)
    assert.match(prompts[1] ?? '', /# Format correction/)
    assert.equal(outcome.toolCalls[0]?.name, 'get_weather')
  })

  it('refuses when the key names no usable account', async () => {
    account('one')
    const { pool } = fakePool([{ pieces: [] }])
    const engine = new TurnEngine(config, accounts, pool)
    await assert.rejects(
      () => engine.run({ request: request(), key: key(['missing-account']), hooks: {} }),
      (error: unknown) => (error as { status?: number }).status === 403,
    )
  })

  it('reports a busy upstream after every account is tried', async () => {
    account('one')
    const { pool } = fakePool([{ raw: ['event: hint\ndata: {"type":"error","content":"The server is busy"}\n\n'] }])
    const engine = new TurnEngine(config, accounts, pool)
    await assert.rejects(
      () => engine.run({ request: request(), key: key(), hooks: {} }),
      (error: unknown) => (error as { kind?: string }).kind === 'busy',
    )
  })

  it('retries a busy account on the same account and then succeeds', async () => {
    const one = account('one')
    const { pool, calls } = fakePool([
      { raw: ['event: hint\ndata: {"type":"error","content":"Server is temporarily unavailable"}\n\n'] },
      { pieces: ['recovered'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const outcome = await engine.run({ request: request(), key: key(), hooks: {} })
    assert.equal(outcome.text, 'recovered')
    assert.equal(outcome.accountId, one.id)
    assert.equal(calls(), 2)
  })

  it('retries a rate-limited account before giving up', async () => {
    const one = account('one')
    const { pool, calls } = fakePool([
      { raw: ['data: {"code":0,"msg":"Too many requests, please try again later"}\n\n'] },
      { raw: ['data: {"code":0,"msg":"Too many requests, please try again later"}\n\n'] },
      { pieces: ['finally'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const outcome = await engine.run({ request: request(), key: key(), hooks: {} })
    assert.equal(outcome.text, 'finally')
    assert.equal(outcome.accountId, one.id)
    assert.equal(calls(), 3)
  })

  it('keeps retrying past the old two-attempt limit for a long window', async () => {
    const cfg = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 2, retryBudgetMs: 5000, transientRetries: 6 })
    const one = account('one')
    const busy = { raw: ['event: hint\ndata: {"type":"error","content":"Server is temporarily unavailable"}\n\n'] }
    const { pool, calls } = fakePool([busy, busy, busy, busy, busy, { pieces: ['sixth time lucky'] }])
    const engine = new TurnEngine(cfg, accounts, pool)
    const outcome = await engine.run({ request: request(), key: key(), hooks: {} })
    assert.equal(outcome.text, 'sixth time lucky')
    assert.equal(outcome.accountId, one.id)
    assert.equal(calls(), 6)
  })

  it('widens an account cooldown as busy refusals repeat', async () => {
    const one = account('one')
    const cfg = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 1, retryBudgetMs: 5, transientRetries: 1 })
    const { pool } = fakePool([{ raw: ['event: hint\ndata: {"type":"error","content":"The server is busy"}\n\n'] }])
    const engine = new TurnEngine(cfg, accounts, pool)
    let previous = 0
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      accounts.update(one.id, { cooldownUntil: null, status: 'active' })
      const started = Date.now()
      await assert.rejects(() => engine.run({ request: request(), key: key(), hooks: {} }))
      const updated = accounts.get(one.id) as AccountRecord
      const cooldown = (updated.cooldownUntil ?? 0) - started
      assert.ok(cooldown >= previous, `cooldown should not shrink: ${cooldown} < ${previous}`)
      previous = cooldown
    }
    assert.ok(previous >= 40_000, `expected an escalated cooldown, got ${previous}`)
  })

  it('does not retry once text has reached the client', async () => {
    const one = account('one')
    const { pool, calls } = fakePool([
      {
        raw: [
          'data: {"v":{"response":{"status":"WIP","fragments":[{"id":2,"type":"RESPONSE","content":"partial answer"}]}}}\n\n',
          'event: hint\ndata: {"type":"error","content":"Server is temporarily unavailable"}\n\n',
        ],
      },
      { pieces: ['should never appear'] },
    ])
    const engine = new TurnEngine(config, accounts, pool)
    const seen: string[] = []
    await assert.rejects(
      () => engine.run({ request: request(), key: key(), hooks: { onText: (text) => seen.push(text) } }),
      (error: unknown) => (error as { kind?: string }).kind === 'busy',
    )
    assert.equal(seen.join(''), 'partial answer')
    assert.equal(calls(), 1)
    void one
  })

  it('honours a stop sequence while streaming', async () => {
    account('one')
    const { pool } = fakePool([{ pieces: ['alpha STOP beta'] }])
    const engine = new TurnEngine(config, accounts, pool)
    const seen: string[] = []
    const outcome = await engine.run({ request: request({ stop: ['STOP'] }), key: key(), hooks: { onText: (text) => seen.push(text) } })
    assert.equal(outcome.text, 'alpha ')
    assert.equal(seen.join('').includes('beta'), false)
  })


  describe('account state after a retry', () => {
    it('clears the cooldown its own busy retry created', async () => {
      account('one')
      const { pool } = fakePool([
        { raw: ['event: hint\ndata: {"type":"error","content":"The server is busy"}\n\n'] },
        { pieces: ['<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>'] },
      ])
      const engine = new TurnEngine(config, accounts, pool)
      const outcome = await engine.run({ request: request({ tools: [weatherTool] }), key: key(), hooks: {} })
      assert.equal(outcome.toolCalls[0]?.name, 'get_weather')
      const after = accounts.list()[0]
      assert.equal(after?.cooldownUntil, null, 'a recovered account must not stay parked')
      assert.equal(after?.status, 'active')
    })
  })
})


describe('a key whose only account is resting', () => {
  let home: string
  let db: Db
  let accounts: AccountRepo
  let config: Config

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dswg-wait-'))
    config = loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 5, retryBudgetMs: 1000 })
    db = openDatabase(home)
    accounts = new AccountRepo(db, new SecretBox(join(home, 'secret.key')))
  })

  afterEach(() => {
    db.sql.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('waits out a cooldown that ends inside the budget, then answers', async () => {
    const one = accounts.create({ slug: 'one', label: 'one', email: 'one@example.com', token: 't', status: 'active' })
    accounts.update(one.id, { cooldownUntil: Date.now() + 400 })
    const { pool } = fakePool([{ pieces: ['hello'] }])
    const engine = new TurnEngine(loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 5, retryBudgetMs: 1000, waitForAccountMs: 5000 }), accounts, pool)
    const started = Date.now()
    const outcome = await engine.run({ request: request(), key: key(), hooks: {} })
    assert.equal(outcome.text, 'hello')
    assert.ok(Date.now() - started >= 400, 'the request must actually wait for the window')
  })

  it('refuses at once when the cooldown outlasts the budget', async () => {
    const one = accounts.create({ slug: 'one', label: 'one', email: 'one@example.com', token: 't', status: 'active' })
    accounts.update(one.id, { cooldownUntil: Date.now() + 60_000 })
    const engine = new TurnEngine(loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 5, waitForAccountMs: 200 }), accounts, fakePool([{ pieces: ['x'] }]).pool)
    await assert.rejects(
      () => engine.run({ request: request(), key: key(), hooks: {} }),
      (error: unknown) => {
        const gateway = error as { status?: number; code?: string; retryAfterMs?: number }
        assert.equal(gateway.status, 429)
        assert.equal(gateway.code, 'no_account_available')
        assert.ok((gateway.retryAfterMs ?? 0) > 1000, 'the client must be told how long to wait')
        return true
      },
    )
  })

  it('never waits on an account that needs a human', async () => {
    accounts.create({ slug: 'one', label: 'one', email: 'one@example.com', token: 't', status: 'reauth' })
    const engine = new TurnEngine(loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 5, waitForAccountMs: 60_000 }), accounts, fakePool([{ pieces: ['x'] }]).pool)
    const started = Date.now()
    await assert.rejects(() => engine.run({ request: request(), key: key(), hooks: {} }), (error: unknown) => (error as { status?: number }).status === 429)
    assert.ok(Date.now() - started < 2000, 'a re-login is not a wait')
  })

  it('stops waiting when the client disconnects', async () => {
    const one = accounts.create({ slug: 'one', label: 'one', email: 'one@example.com', token: 't', status: 'active' })
    accounts.update(one.id, { cooldownUntil: Date.now() + 60_000 })
    const engine = new TurnEngine(loadConfig({ home, accountMinGapMs: 0, accountRpm: 1000, retryBaseMs: 1, retryMaxMs: 5, waitForAccountMs: 60_000 }), accounts, fakePool([{ pieces: ['x'] }]).pool)
    const abort = new AbortController()
    const started = Date.now()
    setTimeout(() => abort.abort(), 150)
    await assert.rejects(() => engine.run({ request: request(), key: key(), hooks: {}, signal: abort.signal }), (error: unknown) => (error as { kind?: string }).kind === 'cancelled')
    assert.ok(Date.now() - started < 5000)
  })
})
