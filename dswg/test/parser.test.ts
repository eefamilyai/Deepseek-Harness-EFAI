import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { salvageCalls } from '../src/tools/salvage.ts'
import { looksLikeRoleplay } from '../src/tools/roleplay.ts'
import { ToolCallExtractor } from '../src/tools/envelope.ts'
import { repairJson } from '../src/tools/repair.ts'
import type { ToolDefinition } from '../src/tools/protocol.ts'

const tools: ToolDefinition[] = [
  {
    name: 'get_weather',
    description: 'Get the current weather for a city.',
    parameters: { type: 'object', properties: { city: { type: 'string' }, days: { type: 'integer' } }, required: ['city'] },
  },
  { name: 'read_file', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
]

/**
 * Feed chunks through an extractor and return every event.
 * @param chunks - model text pieces.
 * @param declared - tool declarations.
 * @returns the events.
 */
function run(chunks: string[], declared: ToolDefinition[] = tools) {
  const extractor = new ToolCallExtractor(declared)
  const events = []
  for (const chunk of chunks) events.push(...extractor.push(chunk))
  events.push(...extractor.finish())
  return events
}

/**
 * Collect the calls from an event list.
 * @param events - extractor events.
 * @returns the calls.
 */
function calls(events: ReturnType<typeof run>) {
  return events.filter((event) => event.type === 'call').map((event) => (event as { call: { name: string; arguments: Record<string, unknown>; missing: string[]; unknownName: boolean } }).call)
}

/**
 * Collect the prose from an event list.
 * @param events - extractor events.
 * @returns the joined text.
 */
function text(events: ReturnType<typeof run>) {
  return events.filter((event) => event.type === 'text').map((event) => (event as { text: string }).text).join('')
}

describe('tool call envelopes', () => {
  it('reads the taught envelope and keeps surrounding prose', () => {
    const events = run(['Let me check. ', '<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>', ' Done.'])
    assert.equal(calls(events).length, 1)
    assert.equal(calls(events)[0]?.name, 'get_weather')
    assert.deepEqual(calls(events)[0]?.arguments, { city: 'Paris' })
    assert.equal(text(events), 'Let me check.  Done.')
  })

  it('reads a call split across arbitrary chunk boundaries', () => {
    const pieces = '<tool_call>{"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'.match(/.{1,3}/g) ?? []
    const events = run(pieces)
    assert.equal(calls(events).length, 1)
    assert.deepEqual(calls(events)[0]?.arguments, { path: 'a.txt' })
  })

  it('reads several calls in one reply', () => {
    const events = run([
      '<tool_call>{"name":"read_file","arguments":{"path":"a"}}</tool_call>',
      '<tool_call>{"name":"read_file","arguments":{"path":"b"}}</tool_call>',
    ])
    assert.deepEqual(calls(events).map((call) => call.arguments.path), ['a', 'b'])
  })

  it('reads DeepSeek special-token framing', () => {
    const events = run(['<｜tool_call｜>{"name":"read_file","arguments":{"path":"x"}}<｜/tool_call｜>'])
    assert.equal(calls(events)[0]?.name, 'read_file')
  })

  it('reads a DSML invoke block', () => {
    const events = run(['<tool_calls>\n<invoke name="get_weather">\n<parameter name="city">Rome</parameter>\n</invoke>\n</tool_calls>'])
    assert.equal(calls(events)[0]?.name, 'get_weather')
    assert.deepEqual(calls(events)[0]?.arguments, { city: 'Rome' })
  })

  it('reads a bare JSON call at line start', () => {
    const events = run(['\n{"name":"get_weather","arguments":{"city":"Oslo"}}'])
    assert.equal(calls(events)[0]?.name, 'get_weather')
  })

  it('does not fire on JSON prose that names no declared tool', () => {
    const events = run(['Here is a config: {"name":"something_else","arguments":{}}'])
    assert.equal(calls(events).length, 0)
    assert.match(text(events), /something_else/)
  })

  it('does not fire on a fenced example naming no declared tool', () => {
    const events = run(['Example:\n```json\n{"name":"unknown_tool","arguments":{}}\n```\nThat is all.'])
    assert.equal(calls(events).length, 0)
  })

  it('salvages a call whose JSON was cut off by the length limit', () => {
    const events = run(['<tool_call>{"name":"get_weather","arguments":{"city":"Par'])
    assert.equal(calls(events).length, 1)
    assert.equal(calls(events)[0]?.arguments.city, 'Par')
    assert.ok(events.some((event) => event.type === 'call' && (event as { call: { repairs: string[] } }).call.repairs.includes('salvaged-truncated')))
  })

  it('resolves a camelCase tool name onto the declared snake_case one', () => {
    const events = run(['<tool_call>{"name":"getWeather","arguments":{"city":"Lima"}}</tool_call>'])
    assert.equal(calls(events)[0]?.name, 'get_weather')
    assert.equal(calls(events)[0]?.unknownName, false)
  })

  it('reports a call missing a required argument', () => {
    const events = run(['<tool_call>{"name":"read_file","arguments":{}}</tool_call>'])
    assert.deepEqual(calls(events)[0]?.missing, ['path'])
  })

  it('coerces a numeric string for an integer parameter', () => {
    const events = run(['<tool_call>{"name":"get_weather","arguments":{"city":"X","days":"3"}}</tool_call>'])
    assert.equal(calls(events)[0]?.arguments.days, 3)
  })

  it('reports malformed markup instead of silently dropping it', () => {
    const events = run(['<tool_call>not json at all</tool_call>'])
    assert.equal(calls(events).length, 0)
    assert.ok(events.some((event) => event.type === 'malformed'))
  })

  it('passes plain prose through untouched', () => {
    const events = run(['Hello, there is nothing to call here.'])
    assert.equal(calls(events).length, 0)
    assert.equal(text(events), 'Hello, there is nothing to call here.')
  })

  it('handles an empty tool list without inventing calls', () => {
    const events = run(['<tool_call>{"name":"get_weather","arguments":{}}</tool_call>'], [])
    assert.equal(calls(events).length, 1)
    assert.equal(calls(events)[0]?.unknownName, false)
  })
})

describe('json repair', () => {
  it('parses clean JSON', () => {
    const result = repairJson('{"a":1}')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { a: 1 })
  })

  it('strips a code fence', () => {
    const result = repairJson('```json\n{"a": 1}\n```')
    assert.equal(result.ok, true)
    assert.ok(result.repairs.includes('fence'))
  })

  it('removes a trailing comma', () => {
    const result = repairJson('{"a": 1,}')
    assert.equal(result.ok, true)
    assert.ok(result.repairs.includes('trailing-comma'))
  })

  it('escapes a raw newline inside a string', () => {
    const result = repairJson('{"a": "line1\nline2"}')
    assert.equal(result.ok, true)
    assert.equal((result.value as { a: string }).a, 'line1\nline2')
  })

  it('closes a truncated object', () => {
    const result = repairJson('{"a": {"b": "c')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { a: { b: 'c' } })
  })

  it('quotes bare keys', () => {
    const result = repairJson('{a: 1, b: "x"}')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { a: 1, b: 'x' })
  })

  it('normalises smart quotes', () => {
    const result = repairJson('{\u201ca\u201d: \u201cb\u201d}')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { a: 'b' })
  })

  it('extracts an object surrounded by prose', () => {
    const result = repairJson('sure: {"a": 1} hope that helps')
    assert.equal(result.ok, true)
    assert.deepEqual(result.value, { a: 1 })
  })

  it('fails loudly on something that is not JSON', () => {
    const result = repairJson('definitely not json')
    assert.equal(result.ok, false)
    assert.ok(result.error)
  })
})


describe('a call the reply quotes rather than makes', () => {
  it('does not execute markup inside a fenced code listing', () => {
    const text = 'Here is the test:\n\n```ts\nconst events = run(\'<tool_calls><invoke name="skill"><parameter name="name">x</parameter></invoke></tool_calls>\')\n```\n'
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push(text), ...extractor.finish()]
    assert.equal(events.filter((event) => event.type === 'call').length, 0)
  })

  it('still executes a call whose fence holds nothing else', () => {
    const text = 'Format:\n\n```\n<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>\n```\n'
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push(text), ...extractor.finish()]
    const calls = events.filter((event) => event.type === 'call') as Array<{ call: { name: string } }>
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.call.name, 'get_weather')
  })

  it('does not execute markup nested in a value the model is writing', () => {
    const text = '<tool_calls>\n<invoke name="read_file">\n<parameter name="content">const x = \'<tool_call>{"name":"get_weather","arguments":{}}</tool_call>\'</parameter>\n</invoke>\n</tool_calls>'
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push(text), ...extractor.finish()]
    const calls = events.filter((event) => event.type === 'call') as Array<{ call: { name: string; arguments: Record<string, unknown> } }>
    assert.deepEqual(calls.map((event) => event.call.name), ['read_file'])
    assert.equal(calls[0]?.call.arguments.content, 'const x = \'<tool_call>{"name":"get_weather","arguments":{}}</tool_call>\'')
  })
})

describe('reading a whole reply', () => {
  it('reads every block in one chunk', () => {
    const text = Array.from({ length: 12 }, (_, index) => `<tool_call>{"name":"get_weather","arguments":{"city":"c${index}"}}</tool_call>`).join('\n')
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push(text), ...extractor.finish()]
    assert.equal(events.filter((event) => event.type === 'call').length, 12)
  })

  it('keeps a payload that contains the closing token, at any chunk size', () => {
    const content = 'one\n</tool_call>\ntwo'
    const text = `<tool_call>${JSON.stringify({ name: 'get_weather', arguments: { city: 'Paris', note: content } })}</tool_call>`
    for (const size of [3, 5, 16, 64]) {
      const extractor = new ToolCallExtractor([...tools, { name: 'get_weather', parameters: { type: 'object', properties: { note: { type: 'string' } } } }], [])
      const collected: Array<{ type: string; call?: { arguments: Record<string, unknown> } }> = []
      for (let at = 0; at < text.length; at += size) collected.push(...extractor.push(text.slice(at, at + size)))
      collected.push(...extractor.finish())
      const calls = collected.filter((event) => event.type === 'call')
      assert.equal(calls.length, 1, `chunk size ${size}`)
      assert.equal(calls[0]?.call?.arguments.note, content, `chunk size ${size}`)
    }
  })

  it('reports a call it had to close itself', () => {
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push('<tool_call>{"name":"get_weather","arguments":{"city":"Pa'), ...extractor.finish()]
    const calls = events.filter((event) => event.type === 'call') as Array<{ call: { arguments: Record<string, unknown>; repairs: string[] } }>
    assert.equal(calls.length, 1)
    assert.equal(calls[0]?.call.arguments.city, 'Pa')
  })

  it('does not invent a value for a key the model never finished', () => {
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push('<tool_call>{"name":"get_weather","arguments":{"city":'), ...extractor.finish()]
    const calls = events.filter((event) => event.type === 'call') as Array<{ call: { arguments: Record<string, unknown>; missing: string[] } }>
    assert.equal(calls.length, 1)
    assert.deepEqual(calls[0]?.call.arguments, {})
    assert.deepEqual(calls[0]?.call.missing, ['city'])
  })
})

describe('an invoke with no wrapper', () => {
  it('reads a complete element', () => {
    const text = '<invoke name="get_weather">\n<parameter name="city" string="true">Paris</parameter>\n</invoke>\n'
    const result = salvageCalls(text, tools)
    assert.deepEqual(result.calls.map((call) => call.name), ['get_weather'])
    assert.deepEqual(result.calls[0]?.arguments, { city: 'Paris' })
    assert.equal(result.unrecovered, false)
  })

  it('reads a parameter written as a bare element', () => {
    const text = '<invoke name="read_file">\n<parameter name="path">a.md</parameter>\n<content># Title\n\nBody.\n</parameter>\n</invoke>\n'
    const result = salvageCalls(text, tools)
    assert.deepEqual(result.calls.map((call) => call.name), ['read_file'])
    assert.match(String(result.calls[0]?.arguments.content), /# Title/)
  })

  it('ignores a closer left over between parameters', () => {
    const text = '<tool_calls>\n<invoke name="get_weather">\n<parameter name="city">Paris</parameter>\n</parameter>\n</invoke>\n</tool_calls>'
    const extractor = new ToolCallExtractor(tools, [])
    const events = [...extractor.push(text), ...extractor.finish()]
    const calls = events.filter((event) => event.type === 'call') as Array<{ call: { name: string } }>
    assert.deepEqual(calls.map((event) => event.call.name), ['get_weather'])
  })

  it('refuses an element the model was still writing', () => {
    const text = '<invoke name="read_file">\n<parameter name="path">a.md</parameter>\n<parameter name="content"># Title\n\nHalf a file'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 0)
    assert.equal(result.unrecovered, true, 'an unfinished element is a call that did not register')
  })

  it('keeps a parameter value literal when it holds JSON', () => {
    const text = '<invoke name="read_file">\n<parameter name="content">const cfg = \'{"port":8080}\'</parameter>\n</invoke>'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls[0]?.arguments.content, 'const cfg = \'{"port":8080}\'')
  })
})


describe("a reply that answers in the tool's voice", () => {
  it("recognises the transcript's own result label", () => {
    assert.equal(looksLikeRoleplay('Tool result:\nconst x = 1\nexport {}', null), true)
    assert.equal(looksLikeRoleplay('<tool_response>{"ok":true}</tool_response>', null), true)
    assert.equal(looksLikeRoleplay('Tool output: 42 files', null), true)
  })

  it('recognises a result pasted back verbatim', () => {
    const result = 'src/a.ts:12: const value = compute()\n'.repeat(12)
    assert.equal(looksLikeRoleplay(`${result}\nSo the answer is clear.`, result), true)
  })

  it('leaves prose about a tool alone', () => {
    assert.equal(looksLikeRoleplay('The grep returned three files, so I read the first.', 'src/a.ts\nsrc/b.ts\nsrc/c.ts'), false)
    assert.equal(looksLikeRoleplay('Done — the export is already there.', null), false)
    assert.equal(looksLikeRoleplay('', null), false)
  })
})
