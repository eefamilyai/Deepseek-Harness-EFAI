import { describe, it } from 'node:test'
import { browserUserAgent } from '../src/util/text.ts'
import { looksLikeChallenge } from '../src/upstream/verdict.ts'
import assert from 'node:assert/strict'
import { StreamDecoder } from '../src/upstream/stream.ts'
import { readVerdict, isWafChallenge } from '../src/upstream/verdict.ts'
import { buildPrompt, clipPrompt, OMIT_MARKER } from '../src/engine/prompt.ts'
import { resolveMode, MODES } from '../src/engine/models.ts'
import type { CanonicalRequest } from '../src/api/canonical.ts'

/** A plain turn exactly as the site streams it. */
const PLAIN = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'event: update_session',
  'data: {"updated_at":1792850293.4811828}',
  '',
  'data: {"v":{"response":{"message_id":2,"parent_id":1,"role":"ASSISTANT","status":"WIP","accumulated_token_usage":0,"fragments":[{"id":2,"type":"RESPONSE","content":"p","references":[],"stage_id":1}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":"ong"}',
  '',
  'data: {"p":"response","o":"BATCH","v":[{"p":"accumulated_token_usage","v":40},{"p":"quasi_status","v":"FINISHED"}]}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
  'event: title',
  'data: {"content":"Pong reply"}',
  '',
  'event: close',
  'data: {"click_behavior":"none","auto_resume":false}',
  '',
  '',
].join('\n')

/** A thinking turn that flips to a response fragment. */
const THINKING = [
  'event: ready',
  'data: {"request_message_id":1,"response_message_id":2,"model_type":"default"}',
  '',
  'data: {"v":{"response":{"status":"WIP","fragments":[{"id":2,"type":"THINK","content":"We need","references":[]}]}}}',
  '',
  'data: {"p":"response/fragments/-1/content","o":"APPEND","v":" 391"}',
  '',
  'data: {"p":"response/fragments","o":"APPEND","v":[{"id":3,"type":"RESPONSE","content":"17","references":[]}]}',
  '',
  'data: {"p":"response/fragments/-1/content","v":" x 23 = 391"}',
  '',
  'data: {"v":" done"}',
  '',
  'data: {"p":"response/status","o":"SET","v":"FINISHED"}',
  '',
].join('\n')

/**
 * Decode a whole stream string.
 * @param text - the raw SSE text.
 * @returns the events.
 */
function decode(text: string) {
  const decoder = new StreamDecoder()
  const events = []
  for (const chunk of text.match(/[\s\S]{1,7}/g) ?? []) events.push(...decoder.push(chunk))
  events.push(...decoder.end())
  return { events, decoder }
}

describe('completion stream', () => {
  it('reads ready, text and title from a plain turn', () => {
    const { events, decoder } = decode(PLAIN)
    assert.equal(decoder.text, 'pong')
    assert.equal(events.filter((event) => event.type === 'text').map((event) => event.text).join(''), 'pong')
    assert.ok(events.some((event) => event.type === 'title' && event.title === 'Pong reply'))
    assert.ok(events.some((event) => event.type === 'ready' && event.responseId === 2))
    assert.ok(events.some((event) => event.type === 'usage' && event.total === 40))
    assert.ok(events.some((event) => event.type === 'status' && event.status === 'FINISHED'))
  })

  it('separates thinking from the answer across a fragment switch', () => {
    const { events, decoder } = decode(THINKING)
    assert.equal(decoder.thinking, 'We need 391')
    assert.equal(decoder.text, '17 x 23 = 391 done')
    const thinking = events.filter((event) => event.type === 'think').map((event) => event.text).join('')
    assert.equal(thinking, 'We need 391')
  })

  it('reads search results', () => {
    const stream = [
      'data: {"v":{"response":{"status":"WIP","fragments":[{"id":2,"type":"SEARCH","status":"WIP","content":null,"queries":[{"query":"moon"}],"results":[]}]}}}',
      '',
      'data: {"p":"response/fragments/-1/results","v":[{"url":"https://example.com","title":"T","cite_index":1,"site_name":"S"}]}',
      '',
    ].join('\n')
    const { events } = decode(stream)
    assert.ok(events.some((event) => event.type === 'search' && event.queries[0] === 'moon'))
    assert.ok(events.some((event) => event.type === 'search' && event.results[0]?.url === 'https://example.com'))
  })

  it('surfaces an auth verdict that arrives as a bare envelope', () => {
    const stream = 'data: {"code":40003,"msg":"Authorization Failed (invalid token)","data":null}\n\n'
    const { events } = decode(stream)
    const error = events.find((event) => event.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.verdict.kind, 'auth')
  })

  it('surfaces a hint error event', () => {
    const stream = 'event: hint\ndata: {"type":"error","content":"The server is busy","finish_reason":"busy"}\n\n'
    const { events } = decode(stream)
    const error = events.find((event) => event.type === 'error')
    assert.ok(error && error.type === 'error')
    assert.equal(error.verdict.kind, 'busy')
  })
})

describe('verdicts', () => {
  it('maps the auth codes', () => {
    for (const code of [40001, 40003]) {
      const verdict = readVerdict({ code, msg: '', data: null })
      assert.equal(verdict?.kind, 'auth')
    }
  })

  it('reads a nested business code', () => {
    const verdict = readVerdict({ code: 0, msg: '', data: { biz_code: 40003, biz_msg: 'Authorization Failed' } })
    assert.equal(verdict?.kind, 'auth')
  })

  it('reads a mute and derives its deadline', () => {
    const verdict = readVerdict({ code: 0, data: { biz_code: 7, biz_msg: 'Your account has been muted until 1791100000' } })
    assert.equal(verdict?.kind, 'muted')
    assert.equal(verdict?.muteUntil, 1791100000000)
  })

  it('reads a rate limit and a busy signal', () => {
    assert.equal(readVerdict({ code: 0, msg: 'Too many requests' })?.kind, 'rate_limit')
    assert.equal(readVerdict({ code: 0, msg: 'The server is busy, please retry' })?.kind, 'busy')
  })

  it('treats every wording of a temporary outage as retryable', () => {
    for (const message of [
      'Server is temporarily unavailable',
      'The server is busy',
      'Service unavailable, please try again later',
      '502 Bad Gateway',
      'Too many requests, please retry later',
      '服务器繁忙，请稍后再试',
    ]) {
      const verdict = readVerdict({ code: 0, msg: message })
      assert.ok(verdict, `expected a verdict for: ${message}`)
      assert.ok(['busy', 'rate_limit'].includes(verdict.kind), `unexpected kind ${verdict.kind} for: ${message}`)
    }
  })

  it('reads the device refusal code', () => {
    assert.equal(readVerdict({ code: 40029, msg: '' })?.kind, 'device_risk')
  })

  it('does not read success as a verdict', () => {
    assert.equal(readVerdict({ code: 0, msg: '', data: { biz_code: 0, biz_msg: '' } }), null)
    assert.equal(readVerdict({ v: 'text' }), null)
  })

  it('recognises the WAF interception', () => {
    assert.equal(isWafChallenge(202, 'challenge'), true)
    assert.equal(isWafChallenge(202, null), false)
    assert.equal(isWafChallenge(200, 'challenge'), false)
  })
})

describe('prompt building', () => {
  /** A minimal request. */
  function request(overrides: Partial<CanonicalRequest> = {}): CanonicalRequest {
    return {
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: 'hi' }],
      tools: [],
      toolChoice: 'auto',
      requiredTool: null,
      temperature: null,
      maxTokens: null,
      stop: [],
      stream: false,
      thinking: false,
      search: false,
      sessionKey: null,
      correction: null,
      ...overrides,
    }
  }

  it('labels turns and ends with an assistant cue', () => {
    const prompt = buildPrompt(request({ messages: [{ role: 'system', content: 'be brief' }, { role: 'user', content: 'hi' }] }))
    assert.match(prompt, /^be brief/)
    assert.match(prompt, /User:\nhi/)
    assert.match(prompt, /Assistant:\n$/)
  })

  it('renders an assistant tool call in the taught envelope', () => {
    const prompt = buildPrompt(
      request({
        messages: [
          { role: 'user', content: 'weather?' },
          { role: 'assistant', content: '', toolCalls: [{ id: 'c1', name: 'get_weather', arguments: { city: 'Paris' } }] },
          { role: 'tool', content: '{"temp":18}', name: 'get_weather', toolCallId: 'c1' },
        ],
      }),
    )
    assert.match(prompt, /<tool_call>\n\{"name":"get_weather","arguments":\{"city":"Paris"\}\}\n<\/tool_call>/)
    assert.match(prompt, /Tool result \(get_weather\):\n\{"temp":18\}/)
  })

  it('appends the protocol prompt only when tools are declared', () => {
    const withTools = buildPrompt(request({ tools: [{ name: 'x', parameters: { type: 'object' } }] }))
    assert.match(withTools, /# Calling tools/)
    assert.doesNotMatch(buildPrompt(request()), /# Calling tools/)
  })

  it('clips an oversized prompt and keeps the head and tail', () => {
    const huge = 'A'.repeat(50_000) + 'MIDDLE' + 'B'.repeat(50_000)
    const result = clipPrompt(huge, 20_000)
    assert.equal(result.clipped, true)
    assert.ok(result.prompt.includes(OMIT_MARKER))
    assert.ok(result.prompt.startsWith('AAAA'))
    assert.ok(result.prompt.endsWith('BBBB'))
    assert.ok(result.prompt.length <= 20_000 + OMIT_MARKER.length)
  })
})

describe('model resolution', () => {
  it('resolves the advertised ids', () => {
    for (const mode of MODES) assert.equal(resolveMode(mode.id).id, mode.id)
  })

  it('resolves aliases and provider prefixes', () => {
    assert.equal(resolveMode('deepseek-reasoner').thinking, true)
    assert.equal(resolveMode('deepseek-r1').id, 'deepseek-reasoner')
    assert.equal(resolveMode('deepseek/deepseek-chat').id, 'deepseek-chat')
    assert.equal(resolveMode('unknown-model').id, 'deepseek-chat')
    assert.equal(resolveMode(null).default, true)
  })
})


describe('wording that outranks a numeric code', () => {
  it('reads a temporary outage as busy even under an authorization code', () => {
    const verdict = readVerdict({ code: 40003, msg: 'Server is temporarily unavailable' })
    assert.equal(verdict?.kind, 'busy')
  })

  it('still reads a genuine authorization failure as auth', () => {
    assert.equal(readVerdict({ code: 40003, msg: 'Authorization Failed (invalid token)' })?.kind, 'auth')
    assert.equal(readVerdict({ code: 40003 })?.kind, 'auth')
  })

  it('reads a mute before the code that carries it', () => {
    assert.equal(readVerdict({ code: 40003, msg: 'Your account has been muted until 1792894199' })?.kind, 'muted')
  })
})


describe('what the browser tells the site', () => {
  it('removes the headless token from the user agent', () => {
    assert.equal(
      browserUserAgent('Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) HeadlessChrome/155.0.0.0 Safari/537.36'),
      'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/155.0.0.0 Safari/537.36',
    )
  })

  it('leaves an ordinary user agent alone', () => {
    const ua = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/155.0.0.0 Safari/537.36'
    assert.equal(browserUserAgent(ua), ua)
    assert.equal(browserUserAgent(null), null)
    assert.equal(browserUserAgent('HeadlessChrome/155.0.0.0'), 'Chrome/155.0.0.0')
  })

  it('recognises a human-verification page whatever it arrives in', () => {
    assert.equal(looksLikeChallenge('<html><body><div class="g-recaptcha"></div></body></html>'), true)
    assert.equal(looksLikeChallenge('{"data":{"msg":"请完成验证"}}'), true)
    assert.equal(looksLikeChallenge('{"code":0,"data":{"biz_data":{"id":"x"}}}'), false)
    assert.equal(looksLikeChallenge(''), false)
  })
})
