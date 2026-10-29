import { describe, it } from 'node:test'
import assert from 'node:assert/strict'
import { salvageCalls, looksLikeCall, findObjects, normaliseDialect } from '../src/tools/salvage.ts'
import { minePatterns } from '../src/tools/learn.ts'
import { ToolCallExtractor } from '../src/tools/envelope.ts'
import type { ToolDefinition } from '../src/tools/protocol.ts'

const tools: ToolDefinition[] = [
  { name: 'get_weather', description: 'Weather.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
  { name: 'read_file', description: 'Read.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
]

describe('dialect normalisation', () => {
  it('rewrites Python literals', () => {
    const result = normaliseDialect('{"a": None, "b": True, "c": False}')
    assert.equal(result.changed, true)
    assert.deepEqual(JSON.parse(result.text), { a: null, b: true, c: false })
  })

  it('converts single quotes only when no double quotes are present', () => {
    assert.equal(normaliseDialect("{'a': 'b'}").text, '{"a": "b"}')
    assert.equal(normaliseDialect('{"a": "it\'s"}').text, '{"a": "it\'s"}')
  })

  it('drops a trailing comma', () => {
    assert.ok(normaliseDialect('{"a": [1, 2,],}').text.includes(']}'))
  })
})

describe('salvage', () => {
  it('recovers a call wrapped in prose', () => {
    const text = 'Sure, let me look that up {"name":"get_weather","arguments":{"city":"Paris"}} and then I will answer.'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.name, 'get_weather')
    assert.deepEqual(result.calls[0]?.arguments, { city: 'Paris' })
    assert.equal(result.text.includes('"name"'), false)
  })

  it('recovers a call whose opener was lost but whose closer survived', () => {
    const text = 'Working on it.</tool_call> {"name":"read_file","arguments":{"path":"a.txt"}}</tool_call>'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.name, 'read_file')
  })

  it('recovers Python-style dict output', () => {
    const text = "{'name': 'get_weather', 'arguments': {'city': 'Oslo'}}"
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.deepEqual(result.calls[0]?.arguments, { city: 'Oslo' })
  })

  it('recovers a wrapper object with a tool field', () => {
    const text = 'Calling: {"tool": "read_file", "parameters": {"path": "b.txt"}}'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.deepEqual(result.calls[0]?.arguments, { path: 'b.txt' })
  })

  it('recovers a function object with stringified arguments', () => {
    const text = '{"function": {"name": "get_weather", "arguments": "{\\"city\\":\\"Lima\\"}"}}'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.deepEqual(result.calls[0]?.arguments, { city: 'Lima' })
  })

  it('recovers call syntax with keyword arguments', () => {
    const text = 'I will run get_weather(city="Berlin") now.'
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.name, 'get_weather')
    assert.deepEqual(result.calls[0]?.arguments, { city: 'Berlin' })
  })

  it('does not execute a call the reply merely describes', () => {
    const essay = `${'The tool takes a JSON object. '.repeat(60)}{"name":"read_file","arguments":{"path":"/etc/passwd"}}${' Then it returns the text. '.repeat(60)}`
    const result = salvageCalls(essay, tools)
    assert.equal(result.calls.length, 0, 'a call quoted mid-essay must not be recovered')
  })

  it('still recovers a call at the end of a long reply', () => {
    const long = `${'Context goes here. '.repeat(60)}\n{"name":"read_file","arguments":{"path":"a.txt"}}`
    assert.equal(salvageCalls(long, tools).calls.length, 1)
  })

  it('ignores an object naming no declared tool', () => {
    const result = salvageCalls('Config: {"name": "something_else", "arguments": {}}', tools)
    assert.equal(result.calls.length, 0)
  })

  it('ignores deep nested noise that is not call shaped', () => {
    const text = '{"goal":{"id":"x","todos":[{"content":"a","status":"pending"}]}}'
    assert.equal(salvageCalls(text, tools).calls.length, 0)
  })

  it('recovers the giant-blob-then-orphan-closer shape from a real leak', () => {
    const blob = JSON.stringify({ goal: { id: 'g1', todos: [{ content: 'recover state', status: 'pending' }] } })
    const text = `Tool result: ${blob} </tool_call>\n\nTool result: ${blob} </tool_call>\n\n{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>`
    const result = salvageCalls(text, tools)
    assert.equal(result.calls.length, 1)
    assert.equal(result.calls[0]?.name, 'get_weather')
    // The call JSON is gone; the repeated blob is collapsed to one copy.
    assert.equal(result.text.includes('"name":"get_weather"'), false)
    assert.equal((result.text.match(/Tool result:/g) ?? []).length, 2)
    assert.equal(result.text.includes('"todos"'), true)
  })

  it('finds nested objects without double counting', () => {
    const spans = findObjects('{"a": {"b": 1}, "c": 2}')
    assert.equal(spans.length, 1)
    assert.equal(spans[0]?.body, '{"a": {"b": 1}, "c": 2}')
  })
})

describe('leak detection', () => {
  it('flags call-shaped prose', () => {
    assert.equal(looksLikeCall('here <tool_call>{"name":"x"}', tools), true)
    assert.equal(looksLikeCall('the arguments are wrong', tools), false)
    assert.equal(looksLikeCall('I will call get_weather(city="A") now', tools), true)
  })

  it('does not flag ordinary prose', () => {
    assert.equal(looksLikeCall('The weather today is mild and pleasant.', tools), false)
    assert.equal(looksLikeCall('', tools), false)
  })

  it('does not flag agent prose that merely mentions a tool name', () => {
    const prose = [
      'Confirmed — the file is down to 19 lines: the append mutated `open(p, "a")` into `"w"` and truncated it.',
      'The write succeeded and I re-read the file afterwards.',
      'I used read_file and edit to make the change; both returned cleanly.',
    ]
    for (const text of prose) {
      assert.equal(looksLikeCall(text, tools), false, `false positive on: ${text.slice(0, 40)}`)
    }
  })

  it('still flags a genuine call written as markup or as a name', () => {
    assert.equal(looksLikeCall('{"name": "get_weather", "arguments": {}}', tools), true)
    assert.equal(looksLikeCall("get_weather(city='Paris')", tools), true)
    assert.equal(looksLikeCall('<tool_call>', tools), true)
  })
})

describe('learned envelopes', () => {
  it('learns the delimiters around leaked calls and uses them', () => {
    const leaks = [
      'BEGIN_CALL {"name":"get_weather","arguments":{"city":"A"}} END_CALL',
      'BEGIN_CALL {"name":"get_weather","arguments":{"city":"B"}} END_CALL',
      'BEGIN_CALL {"name":"read_file","arguments":{"path":"c"}} END_CALL',
    ]
    const prose = ['Just chatting about the weather.', 'Nothing to call here.']
    const patterns = minePatterns(leaks, prose, tools, 2)
    assert.ok(patterns.length >= 1, 'expected at least one induced pattern')
    const best = patterns[0]!
    assert.equal(best.opener, 'BEGIN_CALL')
    assert.equal(best.closer, 'END_CALL')
    assert.ok(best.hits >= 2)
  })

  it('uses a learned envelope in the streaming reader', () => {
    const extractor = new ToolCallExtractor(tools, [{ opener: 'BEGIN_CALL', closer: 'END_CALL' }])
    const events = [
      ...extractor.push('BEGIN_CALL {"name":"get_weather","arguments":{"city":"X"}} END_CALL'),
      ...extractor.finish(),
    ]
    const call = events.find((event) => event.type === 'call')
    assert.ok(call && call.type === 'call')
    assert.equal(call.call.name, 'get_weather')
  })

  it('never fires on ordinary prose', () => {
    const leaks = [
      'BEGIN_CALL {"name":"get_weather","arguments":{"city":"A"}} END_CALL',
      'BEGIN_CALL {"name":"get_weather","arguments":{"city":"B"}} END_CALL',
    ]
    const prose = [
      'The weather in Paris is mild today, and the forecast looks calm.',
      'I read the file and it contained three lines of text.',
      'No tools were needed for this answer at all.',
    ]
    const patterns = minePatterns(leaks, prose, tools, 2)
    assert.ok(patterns.length >= 1)
    for (const pattern of patterns) assert.equal(pattern.falsePositives, 0)
  })

  it('needs at least the minimum number of samples', () => {
    const leaks = ['BEGIN_CALL {"name":"get_weather","arguments":{"city":"A"}} END_CALL']
    assert.equal(minePatterns(leaks, [], tools, 2).length, 0)
  })
})
