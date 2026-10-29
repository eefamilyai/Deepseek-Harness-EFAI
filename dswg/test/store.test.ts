import { describe, it, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { mkdtempSync, rmSync } from 'node:fs'
import { join } from 'node:path'
import { tmpdir } from 'node:os'
import { openDatabase, type Db, metaGet, metaSet, SCHEMA_VERSION } from '../src/store/db.ts'
import { AccountRepo } from '../src/store/accounts.ts'
import { KeyRepo, KEY_PREFIX } from '../src/store/keys.ts'
import { UsageRepo } from '../src/store/usage.ts'
import { SecretBox } from '../src/util/crypto.ts'
import { slug, safeEqual, sha256 } from '../src/util/ids.ts'
import { parseOpenAiRequest } from '../src/api/openai.ts'
import { parseAnthropicRequest } from '../src/api/anthropic.ts'

describe('secret box', () => {
  it('round-trips a value and refuses a tampered one', () => {
    const home = mkdtempSync(join(tmpdir(), 'dswg-box-'))
    try {
      const box = new SecretBox(join(home, 'key'))
      const sealed = box.seal('token-123')
      assert.notEqual(sealed, 'token-123')
      assert.equal(box.open(sealed), 'token-123')
      const parts = sealed.split(':')
      const tampered = [parts[0], parts[1], parts[2], Buffer.from('nope').toString('base64url')].join(':')
      assert.throws(() => box.open(tampered))
      const second = new SecretBox(join(home, 'key'))
      assert.equal(second.open(sealed), 'token-123')
    } finally {
      rmSync(home, { recursive: true, force: true })
    }
  })
})

describe('identifiers', () => {
  it('makes a stable, filesystem-safe slug', () => {
    const first = slug('deepseek.ee.1+10@gmail.com')
    assert.equal(first, slug('deepseek.ee.1+10@gmail.com'))
    assert.match(first, /^[A-Za-z0-9._-]+$/)
    assert.notEqual(first, slug('deepseek.ee.1+11@gmail.com'))
  })

  it('compares without leaking and hashes deterministically', () => {
    assert.equal(safeEqual('abc', 'abc'), true)
    assert.equal(safeEqual('abc', 'abd'), false)
    assert.equal(sha256('x'), sha256('x'))
  })
})

describe('storage', () => {
  let home: string
  let db: Db
  let box: SecretBox

  beforeEach(() => {
    home = mkdtempSync(join(tmpdir(), 'dswg-store-'))
    db = openDatabase(home)
    box = new SecretBox(join(home, 'secret.key'))
  })

  afterEach(() => {
    db.sql.close()
    rmSync(home, { recursive: true, force: true })
  })

  it('records the schema version', () => {
    assert.equal(metaGet(db, 'schema_version'), String(SCHEMA_VERSION))
    metaSet(db, 'greeting', 'hi')
    assert.equal(metaGet(db, 'greeting'), 'hi')
  })

  it('stores credentials sealed and reads them back', () => {
    const repo = new AccountRepo(db, box)
    const created = repo.create({ slug: 'a', label: 'A', email: 'a@b.c', token: 'tok', cookie: 'c=1', password: 'pw' })
    const raw = db.sql.prepare('SELECT token_sealed, cookie_sealed, password_sealed FROM accounts WHERE id = ?').get(created.id) as {
      token_sealed: string
      cookie_sealed: string
      password_sealed: string
    }
    assert.equal(raw.token_sealed.includes('tok'), false)
    const loaded = repo.get(created.id)
    assert.equal(loaded?.token, 'tok')
    assert.equal(loaded?.cookie, 'c=1')
    assert.equal(loaded?.password, 'pw')
  })

  it('updates and deletes an account', () => {
    const repo = new AccountRepo(db, box)
    const created = repo.create({ slug: 'a', label: 'A' })
    const updated = repo.update(created.id, { label: 'B', status: 'muted', mutedUntil: 42, disabled: true })
    assert.equal(updated?.label, 'B')
    assert.equal(updated?.status, 'muted')
    assert.equal(updated?.disabled, true)
    assert.equal(repo.delete(created.id), true)
    assert.equal(repo.get(created.id), null)
  })

  it('authenticates, scopes, and revokes a key', () => {
    const repo = new KeyRepo(db)
    const { key, secret } = repo.create({ name: 'k', accountIds: ['acc-1'], rpm: 5 })
    assert.ok(secret.startsWith(KEY_PREFIX))
    assert.equal(key.prefix, secret.slice(0, KEY_PREFIX.length + 6))
    assert.equal(repo.authenticate(secret)?.id, key.id)
    assert.equal(repo.authenticate('sk-dswg-nope'), null)
    assert.deepEqual(repo.authenticate(secret)?.accountIds, ['acc-1'])
    repo.update(key.id, { accountIds: ['acc-2', 'acc-3'], rpm: 9 })
    const patched = repo.authenticate(secret)
    assert.deepEqual(patched?.accountIds, ['acc-2', 'acc-3'])
    assert.equal(patched?.rpm, 9)
    assert.equal(repo.revoke(key.id), true)
    assert.equal(repo.authenticate(secret), null)
    assert.equal(repo.revoke(key.id), false)
  })

  it('summarises usage', () => {
    const repo = new UsageRepo(db)
    const base = {
      ts: Date.now(),
      keyId: 'k',
      accountId: 'a',
      endpoint: '/v1/chat/completions',
      model: 'deepseek-chat',
      status: 'ok',
      httpStatus: 200,
      errorKind: null,
      promptChars: 10,
      outputChars: 5,
      toolCalls: 1,
      latencyMs: 100,
      ttfbMs: 50,
      stream: true,
    }
    repo.record(base)
    repo.record({ ...base, status: 'error', httpStatus: 429, errorKind: 'rate_limit', toolCalls: 0 })
    const summary = repo.summary(24)
    assert.equal(summary.requests, 2)
    assert.equal(summary.errors, 1)
    assert.equal(summary.toolCalls, 1)
    assert.equal(summary.byAccount[0]?.requests, 2)
    assert.equal(repo.recent(10).length, 2)
  })
})

describe('request parsing', () => {
  it('converts an OpenAI request with tools and a tool result', () => {
    const request = parseOpenAiRequest({
      model: 'deepseek-reasoner',
      messages: [
        { role: 'system', content: 'be brief' },
        { role: 'user', content: [{ type: 'text', text: 'hi' }] },
        { role: 'assistant', content: null, tool_calls: [{ id: 'c1', type: 'function', function: { name: 'f', arguments: '{"a":1}' } }] },
        { role: 'tool', tool_call_id: 'c1', name: 'f', content: 'result' },
      ],
      tools: [{ type: 'function', function: { name: 'f', description: 'd', parameters: { type: 'object', properties: { a: { type: 'number' } } } } }],
      stream: true,
      stop: 'END',
    })
    assert.equal(request.thinking, true)
    assert.equal(request.stream, true)
    assert.deepEqual(request.stop, ['END'])
    assert.equal(request.tools[0]?.name, 'f')
    assert.deepEqual(request.messages[2]?.toolCalls?.[0]?.arguments, { a: 1 })
    assert.equal(request.messages[3]?.role, 'tool')
  })

  it('drops tools when tool_choice is none', () => {
    const request = parseOpenAiRequest({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [{ type: 'function', function: { name: 'f' } }],
      tool_choice: 'none',
    })
    assert.equal(request.tools.length, 0)
    assert.equal(request.toolChoice, 'none')
  })

  it('notes images it cannot forward', () => {
    const request = parseOpenAiRequest({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'look' }, { type: 'image_url', image_url: { url: 'x' } }] }],
    })
    assert.equal(request.messages[0]?.droppedParts?.length, 1)
  })

  it('rejects a body with no messages', () => {
    assert.throws(() => parseOpenAiRequest({ model: 'x', messages: [] }), /messages must be a non-empty array/)
    assert.throws(() => parseOpenAiRequest(null), /JSON object/)
  })

  it('converts an Anthropic request with tool_use and tool_result', () => {
    const request = parseAnthropicRequest({
      model: 'deepseek-chat',
      max_tokens: 100,
      system: [{ type: 'text', text: 'sys' }],
      messages: [
        { role: 'user', content: 'weather?' },
        { role: 'assistant', content: [{ type: 'text', text: 'checking' }, { type: 'tool_use', id: 'tu1', name: 'get_weather', input: { city: 'Paris' } }] },
        { role: 'user', content: [{ type: 'tool_result', tool_use_id: 'tu1', content: [{ type: 'text', text: '18C' }] }] },
      ],
      tools: [{ name: 'get_weather', description: 'w', input_schema: { type: 'object', properties: { city: { type: 'string' } } } }],
      tool_choice: { type: 'any' },
      stop_sequences: ['END'],
    })
    assert.equal(request.messages[0]?.role, 'system')
    assert.equal(request.messages[0]?.content, 'sys')
    assert.equal(request.messages[2]?.toolCalls?.[0]?.name, 'get_weather')
    assert.equal(request.messages[3]?.role, 'tool')
    assert.equal(request.messages[3]?.content, '18C')
    assert.equal(request.toolChoice, 'required')
    assert.deepEqual(request.stop, ['END'])
  })

  it('reads an Anthropic tool_choice naming one tool', () => {
    const request = parseAnthropicRequest({
      model: 'deepseek-chat',
      max_tokens: 10,
      messages: [{ role: 'user', content: 'go' }],
      tools: [{ name: 'f', input_schema: { type: 'object' } }],
      tool_choice: { type: 'tool', name: 'f' },
    })
    assert.equal(request.requiredTool, 'f')
  })
})
