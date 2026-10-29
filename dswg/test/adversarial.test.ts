import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { parseOpenAiRequest } from '../src/api/openai.ts'
import { parseAnthropicRequest } from '../src/api/anthropic.ts'
import { buildPrompt, clipPrompt } from '../src/engine/prompt.ts'
import { estimateTokens } from '../src/engine/prompt.ts'
import { StopFilter } from '../src/util/stop.ts'
import { resolveMode } from '../src/engine/models.ts'
import { repairJson } from '../src/tools/repair.ts'
import { ToolCallExtractor } from '../src/tools/envelope.ts'
import { salvageCalls } from '../src/tools/salvage.ts'
import type { CanonicalRequest } from '../src/api/canonical.ts'
import type { ToolDefinition } from '../src/tools/protocol.ts'

/** A minimal canonical request. */
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

const weather: ToolDefinition = {
  name: 'get_weather',
  description: 'Weather.',
  parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
}

describe('adversarial input', () => {
  it('keeps unicode, newlines and code fences intact through the prompt', () => {
    const text = '日本語テキスト — emoji 🚀 — tab\there\n```js\nconst a = 1\n```'
    const prompt = buildPrompt(request({ messages: [{ role: 'user', content: text }] }))
    assert.ok(prompt.includes('日本語テキスト'))
    assert.ok(prompt.includes('🚀'))
    assert.ok(prompt.includes('```js'))
  })

  it('handles a message that is only whitespace', () => {
    const parsed = parseOpenAiRequest({ model: 'deepseek-chat', messages: [{ role: 'user', content: '   ' }] })
    assert.equal(parsed.messages[0]?.content, '   ')
  })

  it('rejects an unknown role and a non-array message list', () => {
    assert.throws(() => parseOpenAiRequest({ model: 'x', messages: [{ role: 'wizard', content: 'hi' }] }))
    assert.throws(() => parseOpenAiRequest({ model: 'x', messages: 'nope' }))
  })

  it('accepts array content with several text parts', () => {
    const parsed = parseOpenAiRequest({
      model: 'deepseek-chat',
      messages: [{ role: 'user', content: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }] }],
    })
    assert.equal(parsed.messages[0]?.content, 'a\nb')
  })

  it('maps tool_choice variants', () => {
    const none = parseOpenAiRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [], tool_choice: 'none' })
    assert.equal(none.toolChoice, 'none')
    const required = parseOpenAiRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tool_choice: 'required' })
    assert.equal(required.toolChoice, 'required')
    const named = parseOpenAiRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tool_choice: { type: 'function', function: { name: 'f' } } })
    assert.equal(named.requiredTool, 'f')
  })

  it('drops tool definitions with no name instead of failing', () => {
    const parsed = parseOpenAiRequest({ model: 'x', messages: [{ role: 'user', content: 'hi' }], tools: [{ type: 'function', function: {} }] })
    assert.equal(parsed.tools.length, 0)
  })

  it('accepts an Anthropic system string and block array', () => {
    const asString = parseAnthropicRequest({ model: 'x', max_tokens: 8, system: 'be brief', messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(asString.messages[0]?.content, 'be brief')
    const asBlocks = parseAnthropicRequest({ model: 'x', max_tokens: 8, system: [{ type: 'text', text: 'a' }, { type: 'text', text: 'b' }], messages: [{ role: 'user', content: 'hi' }] })
    assert.equal(asBlocks.messages[0]?.content, 'a\n\nb')
  })

  it('splits an Anthropic user turn that mixes text and tool results', () => {
    const parsed = parseAnthropicRequest({
      model: 'x',
      max_tokens: 8,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'and now?' }, { type: 'tool_result', tool_use_id: 't1', content: 'done' }] }],
    })
    assert.equal(parsed.messages.filter((message) => message.role === 'tool').length, 1)
    assert.equal(parsed.messages.filter((message) => message.role === 'user').length, 1)
  })

  it('clips a pathological prompt without splitting the head marker', () => {
    const prompt = 'H'.repeat(100) + 'B'.repeat(2_000_000)
    const clipped = clipPrompt(prompt, 10_000)
    assert.equal(clipped.clipped, true)
    assert.ok(clipped.prompt.length <= 11_000)
  })

  it('estimates tokens for CJK and latin text', () => {
    assert.ok(estimateTokens('こんにちは世界') > 0)
    assert.ok(estimateTokens('hello world') > 0)
    assert.equal(estimateTokens(''), 0)
  })

  it('honours stop sequences that straddle a chunk boundary', () => {
    const filter = new StopFilter(['END'])
    assert.equal(filter.push('abc EN'), 'abc ')
    assert.equal(filter.push('D tail'), '')
    assert.equal(filter.stopped, true)
    assert.equal(filter.flush(), '')
  })

  it('flushes held text when the stream ends without a stop', () => {
    const filter = new StopFilter(['ENDING'])
    assert.equal(filter.push('abc EN'), 'abc ')
    assert.equal(filter.flush(), 'EN')
  })

  it('resolves every advertised alias', () => {
    for (const alias of ['deepseek-chat', 'deepseek-reasoner', 'deepseek-search', 'deepseek-reasoner-search', 'deepseek-v3', 'deepseek-r1', 'deepseek/chat']) {
      assert.ok(resolveMode(alias).id.startsWith('deepseek-'))
    }
  })

  it('repairs JSON with nested quotes and escapes', () => {
    const result = repairJson('{"a": "he said \\"hi\\"", "b": [1,2,]}')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { a: 'he said "hi"', b: [1, 2] })
  })

  it('does not treat a huge non-call JSON blob as a call', () => {
    const blob = JSON.stringify({ rows: Array.from({ length: 500 }, (_unused, index) => ({ id: index, name: `row-${index}` })) })
    const events = [...new ToolCallExtractor([weather]).push(blob)]
    assert.equal(events.filter((event) => event.type === 'call').length, 0)
    assert.equal(salvageCalls(blob, [weather]).calls.length, 0)
  })

  it('handles an empty completion and a whitespace-only reply', () => {
    const extractor = new ToolCallExtractor([weather])
    assert.deepEqual([...extractor.push('   '), ...extractor.finish()].filter((event) => event.type === 'call'), [])
  })

  it('survives a tool call with deeply nested arguments', () => {
    const args = { city: 'X', options: { a: { b: { c: [1, 2, { d: true }] } } } }
    const text = `<tool_call>${JSON.stringify({ name: 'get_weather', arguments: args })}</tool_call>`
    const calls = salvageCalls(text, [weather]).calls
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.arguments, args)
  })

  it('rejects a call whose name is an empty string', () => {
    const result = salvageCalls('<tool_call>{"name":"","arguments":{}}</tool_call>', [weather])
    assert.equal(result.calls.length, 0)
  })
})
