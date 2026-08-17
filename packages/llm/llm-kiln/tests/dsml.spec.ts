/**
 * The tool-call transport for providers that have no tool channel.
 *
 * These providers see the harness's tool schemas only as text and answer only
 * with text, so the encoding is load-bearing in a way a native `tools` field
 * never is: a format the model writes slightly differently reads as prose, and
 * a call that reads as prose is a call that silently did not happen. Every case
 * here is a shape a DeepSeek web session has actually produced.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, invokeArguments, isRateLimit, KilnAdapter, RATE_LIMIT_RETRY_MS } from '@deepseek-ai/dsh-llm-kiln'
import { accountRoute, buildTurns, mintCallId, rebuildRoutes, renderToolCall, toolIndex } from '@deepseek-ai/dsh-llm-kiln'
import { coerceParameter, toolProtocolPrompt } from '@deepseek-ai/dsh-llm-kiln'
import type { KilnBridge, KilnProvider, KilnStreamEvent } from '@deepseek-ai/dsh-llm-kiln'

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python in a persistent namespace.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
}

const WEB_SEARCH: ToolSchema = {
  name: 'web_search',
  description: 'Search the web.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, max_results: { type: 'integer' }, deep: { type: 'boolean' } },
    required: ['query'],
  },
}

const TOOLS = [KERNEL, WEB_SEARCH]

const source = { kind: 'plugin', plugin: 'test' } as const
const USER_HI = createUserMessage({ content: [{ type: 'text', text: 'hi' }], source })
const USER_GO = createUserMessage({ content: [{ type: 'text', text: 'go' }], source })

/** Feed chunks through a fresh translator and collect every event, flush included. */
function translate(chunks: readonly string[], tools: readonly ToolSchema[] = TOOLS) {
  const translator = new DsmlTranslator(toolIndex(tools))
  const events = chunks.flatMap(chunk => translator.push(chunk))
  return [...events, ...translator.end()]
}

/** Just the calls, as `[name, parsed arguments]`. */
function calls(chunks: readonly string[], tools: readonly ToolSchema[] = TOOLS) {
  return translate(chunks, tools)
    .filter(event => event.kind === 'tool-call')
    .map(event => [event.name, JSON.parse(event.arguments) as unknown] as const)
}

/** Just the prose, concatenated. */
function prose(chunks: readonly string[], tools: readonly ToolSchema[] = TOOLS): string {
  return translate(chunks, tools)
    .filter(event => event.kind === 'text')
    .map(event => event.text)
    .join('')
}

describe('DsmlTranslator', () => {
  it('reads one call whose tags are split across stream chunks', () => {
    expect(calls([
      'Let me check.\n<tool_ca', 'lls>\n<invoke name="kernel">\n<parameter name="code">print(1)\n',
      'print(2)</parameter>\n</in', 'voke>\n</tool_calls>\n',
    ])).toEqual([['kernel', { code: 'print(1)\nprint(2)' }]])
  })

  it('opens a block that shares its line with prose', () => {
    // A starts-with test would put this entire call one character out of
    // reach, and it would reach the user as text describing work never done.
    const chunks = ['Sure. <tool_calls><invoke name="kernel"><parameter name="code">1+1</parameter>'
      + '</invoke></tool_calls> Done.\n']
    expect(calls(chunks)).toEqual([['kernel', { code: '1+1' }]])
    expect(prose(chunks)).toBe('Sure.  Done.\n')
  })

  it('types each parameter from the tool schema', () => {
    expect(calls(['<tool_calls>\n<invoke name="web_search">\n'
      + '<parameter name="query">rust ownership</parameter>\n'
      + '<parameter name="max_results">5</parameter>\n'
      + '<parameter name="deep">true</parameter>\n</invoke>\n</tool_calls>\n',
    ])).toEqual([['web_search', { query: 'rust ownership', max_results: 5, deep: true }]])
  })

  it('leaves a declared string parameter as text even when it looks like JSON', () => {
    // A Python cell may legally begin with `{`. Guessing JSON here would
    // rewrite the model's code into an object before the kernel ever saw it.
    expect(calls(['<tool_calls>\n<invoke name="kernel">\n'
      + '<parameter name="code">{"a": 1}</parameter>\n</invoke>\n</tool_calls>\n',
    ])).toEqual([['kernel', { code: '{"a": 1}' }]])
  })

  it('accepts a bare invoke body for a single-parameter tool', () => {
    expect(calls(['<tool_calls>\n<invoke name="kernel">\nprint("hi")\n</invoke>\n</tool_calls>\n']))
      .toEqual([['kernel', { code: 'print("hi")' }]])
  })

  it('reads several invokes in one block', () => {
    expect(calls(['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n</invoke>\n'
      + '<invoke name="web_search">\n<parameter name="query">x</parameter>\n</invoke>\n</tool_calls>\n',
    ])).toEqual([['kernel', { code: '1+1' }], ['web_search', { query: 'x' }]])
  })

  it('unescapes XML entities in a parameter', () => {
    expect(calls(['<tool_calls>\n<invoke name="kernel">\n'
      + '<parameter name="code">print("a &lt; b &amp;&amp; c &gt; d")</parameter>\n</invoke>\n</tool_calls>\n',
    ])).toEqual([['kernel', { code: 'print("a < b && c > d")' }]])
  })

  it('shows a block naming a tool that does not exist, and calls nothing', () => {
    // The transcript is this transport's only correction channel. A dropped
    // block reads to the model as a call that ran and returned nothing.
    const chunks = ['<tool_calls>\n<invoke name="bash">\n<parameter name="command">ls</parameter>\n'
      + '</invoke>\n</tool_calls>\n']
    expect(calls(chunks)).toEqual([])
    expect(prose(chunks)).toContain('<invoke name="bash">')
    expect(prose(chunks)).toContain('no such tool')
  })

  it('flushes an unterminated block as text rather than inventing its end', () => {
    const chunks = ['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">rm -rf /tmp/x']
    expect(calls(chunks)).toEqual([])
    expect(prose(chunks)).toBe('<tool_calls>\n<invoke name="kernel">\n<parameter name="code">rm -rf /tmp/x\n')
  })

  it('treats a fenced code block as prose', () => {
    const chunks = ['Here is the plan:\n```python\nprint(1)\n```\nShall I?\n']
    expect(calls(chunks)).toEqual([])
    expect(prose(chunks)).toBe('Here is the plan:\n```python\nprint(1)\n```\nShall I?\n')
  })

  it('keeps blank lines in prose', () => {
    expect(prose(['one\n', '\n', 'two\n'])).toBe('one\n\ntwo\n')
  })

  it('calls nothing when the request declared no tools', () => {
    expect(calls(['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1</parameter>\n'
      + '</invoke>\n</tool_calls>\n'], [])).toEqual([])
  })
})

describe('native tool-call dialects', () => {
  // Under weaker framing a DeepSeek web session reverts from the taught
  // `<tool_calls>` format to whichever tool-call head its training triggers.
  // Each shape here is one a live session actually produced; every one used to
  // reach the user as prose — a call that read as done and never ran.
  const RUN_CODE: ToolSchema = {
    name: 'run_code',
    description: 'Run code.',
    parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
  }
  const READ_FILE: ToolSchema = {
    name: 'read_file',
    description: 'Read a file.',
    parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
  }
  const NATIVE = [KERNEL, RUN_CODE, READ_FILE]
  // The fullwidth vertical line (U+FF5C) DeepSeek's special tokens are built
  // from, written out so the intent of each test string is legible.
  const P = '｜'
  const dsml = (attrs: string) => `<${P}${P}DSML${P}${P}${attrs}>`
  const dsmlEnd = `</${P}${P}DSML${P}${P}>`

  it('reads DeepSeek\'s native special-token (DSML) block as a call', () => {
    expect(calls([`${dsml(' name="run_code"')}\n`
      + '<parameter name="code">const k = await f();\nconsole.log(k)</parameter>\n'
      + `${dsmlEnd}\n`], NATIVE))
      .toEqual([['run_code', { code: 'const k = await f();\nconsole.log(k)' }]])
  })

  it('reads a DSML block whose opener is split across stream chunks', () => {
    // The opener token itself is torn between two chunks; the partial-line
    // buffer must reassemble it before normalization runs.
    expect(calls([`<${P}${P}DSML${P}${P} name="run`, '_code">\n'
      + `<parameter name="code">42</parameter>\n${dsmlEnd}\n`], NATIVE))
      .toEqual([['run_code', { code: '42' }]])
  })

  it('reads a bare <invoke> the model wrote without the <tool_calls> wrapper', () => {
    expect(calls(['<invoke name="kernel">\n<parameter name="code">print(1)</parameter>\n</invoke>\n'], NATIVE))
      .toEqual([['kernel', { code: 'print(1)' }]])
  })

  it('reads a tool named as its own tag, with the body as the lone argument', () => {
    expect(calls(['<run_code>console.log(1+1);</run_code>\n'], NATIVE))
      .toEqual([['run_code', { code: 'console.log(1+1);' }]])
  })

  it('reads a self-closing tool tag, taking its attribute as the argument', () => {
    expect(calls(['<read_file path="./package.json" />\n'], NATIVE))
      .toEqual([['read_file', { path: './package.json' }]])
  })

  it('reads a bare <DSML> wrapper around an inner self-closing tool tag', () => {
    // The other live shape: <DSML> brackets the call, and the tool sits on an
    // inner tag. The wrapper carries nothing and must not leak as prose around
    // a call that did run.
    const chunks = ['<DSML>\n<run_code code="console.log(6*7);" />\n</DSML>']
    expect(calls(chunks, NATIVE)).toEqual([['run_code', { code: 'console.log(6*7);' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('does not run a DSML block that names a tool the request never declared', () => {
    const chunks = [`${dsml(' name="rm_rf"')}\n<parameter name="path">/</parameter>\n${dsmlEnd}\n`]
    expect(calls(chunks, NATIVE)).toEqual([])
  })

  it('leaves a tool name that only appears in prose untouched', () => {
    // The gate is a real tag naming a declared tool. A mention in prose, or an
    // unknown tag, is not a call and must survive as the exact text written.
    const line = 'Use `<div>` here, and read_file is a tool I might call later.\n'
    expect(calls([line], NATIVE)).toEqual([])
    expect(prose([line], NATIVE)).toBe(line)
  })

  it('flushes a truncated DSML call as text rather than inventing its end', () => {
    const chunks = [`${dsml(' name="run_code"')}\n<parameter name="code">rm -rf /tmp/x`]
    expect(calls(chunks, NATIVE)).toEqual([])
    expect(prose(chunks, NATIVE)).toContain('rm -rf /tmp/x')
  })

  it('still reads the taught <tool_calls> format unchanged', () => {
    expect(calls(['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n'
      + '</invoke>\n</tool_calls>\n'], NATIVE)).toEqual([['kernel', { code: '1+1' }]])
  })
})

describe('invokeArguments', () => {
  it('fills the lone required parameter from a bare body, past optional knobs', () => {
    // Unambiguity is a fact about REQUIRED parameters, not declared ones.
    // `web_search` also takes `max_results` and `deep`, but neither can hold
    // unlabelled prose, so `query` is the only assignment the schema permits.
    // Counting declared parameters instead refused every tool that has an
    // optional knob — which is nearly all of them — and dispatched `{}`, a
    // call that could only ever come back as a validation error.
    expect(invokeArguments(WEB_SEARCH, 'rust ownership')).toBe('{"query":"rust ownership"}')
  })

  it('still refuses to guess when more than one required parameter is unfilled', () => {
    const pair: ToolSchema = {
      name: 'move',
      description: 'Move a file.',
      parameters: {
        type: 'object',
        properties: { from: { type: 'string' }, to: { type: 'string' } },
        required: ['from', 'to'],
      },
    }
    expect(invokeArguments(pair, 'a.txt b.txt')).toBe('{}')
  })

  it('returns empty arguments for an unknown tool with no parameter tags', () => {
    expect(invokeArguments(undefined, 'anything')).toBe('{}')
  })
})

describe('coerceParameter', () => {
  it('falls back to the text when a typed value will not parse', () => {
    expect(coerceParameter(WEB_SEARCH, 'max_results', 'lots')).toBe('lots')
    expect(coerceParameter(WEB_SEARCH, 'deep', 'maybe')).toBe('maybe')
  })

  it('guesses JSON only for an undeclared parameter that is unambiguously JSON', () => {
    expect(coerceParameter(KERNEL, 'unknown', '[1,2]')).toEqual([1, 2])
    expect(coerceParameter(KERNEL, 'unknown', 'plain words')).toBe('plain words')
  })
})

describe('renderToolCall', () => {
  it('round-trips a prior call back through the translator', () => {
    const rendered = renderToolCall('web_search', JSON.stringify({ query: 'a < b', max_results: 3 }))
    expect(calls([`${rendered}\n`])).toEqual([['web_search', { query: 'a < b', max_results: 3 }]])
  })

  it('labels arguments it cannot parse instead of emitting a malformed block', () => {
    expect(renderToolCall('kernel', 'not json')).toBe('[tool call kernel] not json')
  })
})

describe('toolProtocolPrompt', () => {
  it('lists exactly the request\'s tools', () => {
    const prompt = toolProtocolPrompt(TOOLS)
    expect(prompt).toContain('## kernel')
    expect(prompt).toContain('## web_search')
    expect(prompt).not.toContain('bash')
  })

  it('says nothing when the request carries no tools', () => {
    expect(toolProtocolPrompt(undefined)).toBe('')
    expect(toolProtocolPrompt([])).toBe('')
  })
})

describe('buildTurns', () => {
  it('puts the harness prompt first and adds only the format statement', () => {
    const [system] = buildTurns({
      provider: 'kiln-deepseek',
      model: 'deepseek-expert',
      system: 'HARNESS PROMPT',
      tools: TOOLS,
      messages: [],
    })
    expect(system?.role).toBe('system')
    expect(system?.content.startsWith('HARNESS PROMPT')).toBe(true)
    expect(system?.content).toContain('# Calling tools')
  })

  it('sends no system turn at all when the harness supplied no prompt and no tools', () => {
    expect(buildTurns({
      provider: 'kiln-deepseek',
      model: 'deepseek-expert',
      messages: [USER_HI],
    })).toEqual([{ role: 'user', content: 'hi' }])
  })
})

describe('KilnAdapter call ids', () => {
  /** A bridge stub that replays one scripted response per stream call. */
  function bridgeOf(responses: readonly string[]): KilnBridge {
    let next = 0
    return {
      async *stream(): AsyncIterable<KilnStreamEvent> {
        yield { type: 'content', text: responses[next++] ?? '' }
        yield { type: 'meta', finish: 'stop' }
      },
    } as unknown as KilnBridge
  }

  /** Every tool-call id the adapter emitted for one request. */
  async function idsOf(adapter: KilnAdapter): Promise<string[]> {
    const ids: string[] = []
    for await (const chunk of adapter.stream({
      provider: 'kiln-deepseek',
      model: 'deepseek-expert',
      tools: TOOLS,
      messages: [USER_GO],
    })) {
      if (chunk.type === 'tool-call-delta') ids.push(chunk.id)
    }
    return ids
  }

  it('never repeats a call id across responses', async () => {
    // The conversation projection resolves a call's nested dispatches and its
    // result BY call id. Reused ids make every earlier row in the transcript
    // render the newest call's children and output.
    const cell = '<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n'
      + '</invoke>\n</tool_calls>\n'
    const adapter = new KilnAdapter({
      bridge: bridgeOf([cell, cell, cell]),
      routes: () => new Map(),
      kilnId: route => route,
    })
    const seen = [...await idsOf(adapter), ...await idsOf(adapter), ...await idsOf(adapter)]
    expect(seen).toHaveLength(3)
    expect(new Set(seen).size).toBe(3)
  })

  it('names the tool in the id so a log stays legible', () => {
    expect(mintCallId('kernel').startsWith('kiln-kernel-')).toBe(true)
  })
})

describe('DsmlTranslator tag attributes', () => {
  // `bash` is the shape that broke: a tool whose own parameter is named
  // `description`, which is also the JSON Schema keyword documenting every
  // OTHER parameter. Both regexes used to require `name` to be the sole
  // attribute on a tag, so the model's two commonest near-misses were silent.
  const BASH: ToolSchema = {
    name: 'bash',
    description: 'Run a bash command.',
    parameters: {
      type: 'object',
      properties: {
        command: { type: 'string', description: 'The bash command to execute.' },
        description: { type: 'string', description: 'What this command does, 5-10 words.' },
        timeoutMs: { type: 'number', description: 'Timeout in milliseconds.' },
      },
      required: ['command', 'description'],
    },
  }

  /** Wrap an invoke body in a complete block and translate it. */
  function call(inner: string) {
    return calls([`<tool_calls>\n${inner}\n</tool_calls>\n`], [BASH])
  }

  it('keeps a parameter that carries an extra attribute', () => {
    // The reported bug verbatim: `command` parsed, `description` vanished, and
    // the harness rejected the call with `missing required property
    // "description"` — a validation error for a value the model DID write.
    expect(call('<invoke name="bash">\n<parameter name="command">ls</parameter>\n'
      + '<parameter name="description" type="string">List files</parameter>\n</invoke>'))
      .toEqual([['bash', { command: 'ls', description: 'List files' }]])
  })

  it('reads an argument the model wrote as an attribute on the invoke tag', () => {
    // A tool with a parameter called `description` invites exactly this. The
    // whole call used to match nothing and degrade to prose.
    expect(call('<invoke name="bash" description="List files">\n'
      + '<parameter name="command">ls</parameter>\n</invoke>'))
      .toEqual([['bash', { command: 'ls', description: 'List files' }]])
  })

  it('tolerates whitespace around the attribute equals sign', () => {
    expect(call('<invoke name = "bash">\n<parameter name = "command">ls</parameter>\n'
      + '<parameter name = "description">List files</parameter>\n</invoke>'))
      .toEqual([['bash', { command: 'ls', description: 'List files' }]])
  })

  it('lets a quoted attribute value contain a closing bracket', () => {
    expect(call('<invoke name="bash" description="Redirect a > b">\n'
      + '<parameter name="command">a > b</parameter>\n</invoke>'))
      .toEqual([['bash', { command: 'a > b', description: 'Redirect a > b' }]])
  })

  it('never invents an argument the schema does not declare', () => {
    expect(call('<invoke name="bash" hurry="true" description="List files">\n'
      + '<parameter name="command">ls</parameter>\n</invoke>'))
      .toEqual([['bash', { command: 'ls', description: 'List files' }]])
  })

  it('prefers an explicit parameter over a tag attribute of the same name', () => {
    expect(call('<invoke name="bash" description="from the tag">\n'
      + '<parameter name="command">ls</parameter>\n'
      + '<parameter name="description">from the element</parameter>\n</invoke>'))
      .toEqual([['bash', { command: 'ls', description: 'from the element' }]])
  })

  it('fills the one required parameter still missing from a bare body', () => {
    expect(call('<invoke name="bash" description="List files">ls</invoke>'))
      .toEqual([['bash', { description: 'List files', command: 'ls' }]])
  })

  it('still fills a single-parameter tool from a bare body', () => {
    expect(calls(['<tool_calls>\n<invoke name="kernel">1+1</invoke>\n</tool_calls>\n']))
      .toEqual([['kernel', { code: '1+1' }]])
  })

  it('flags an invoke tag whose name is unreadable instead of staying silent', () => {
    const out = prose(['<tool_calls>\n<invoke tool="bash">\n'
      + '<parameter name="command">ls</parameter>\n</invoke>\n</tool_calls>\n'], [BASH])
    expect(out).toContain('malformed tool call')
    expect(out).toContain('<invoke tool="bash">')
  })

  it('still reports a well-formed tag that names a tool the request never declared', () => {
    const out = prose(['<tool_calls>\n<invoke name="rm_rf">\n'
      + '<parameter name="path">/</parameter>\n</invoke>\n</tool_calls>\n'], [BASH])
    expect(out).toContain('no such tool')
  })
})

describe('toolProtocolPrompt required parameters', () => {
  const BASH: ToolSchema = {
    name: 'bash',
    description: 'Run a bash command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command', 'description'],
    },
  }

  it('states the required names above the schema that buries them', () => {
    const prompt = toolProtocolPrompt([BASH])
    expect(prompt).toContain('Required parameters (every call must include all of these): `command`, `description`')
  })

  it('says so plainly when a tool requires nothing', () => {
    expect(toolProtocolPrompt([{ name: 'ping', description: 'Ping.', parameters: { type: 'object', properties: {} } }]))
      .toContain('Required parameters: none.')
  })

  it('tells the model arguments are elements, not attributes', () => {
    expect(toolProtocolPrompt([BASH])).toContain('never as attributes on the `<invoke>` tag')
  })
})

describe('rate limiting', () => {
  it('separates a quota window from transient overload', () => {
    // These used to share one regex and one 5s retry. Answering "you are being
    // rate limited" by resending every 5 seconds is what keeps the limit shut.
    expect(isRateLimit('Rate limit exceeded, please try again later')).toBe(true)
    expect(isRateLimit('Too many requests')).toBe(true)
    expect(isRateLimit('DeepSeek 429: rate-limited')).toBe(true)
    expect(isRateLimit('请求过于频繁')).toBe(true)
    expect(isRateLimit('Server is busy. Try again later.')).toBe(false)
    expect(isRateLimit('the Kiln provider bridge is missing')).toBe(false)
  })

  it('waits three minutes, matching the sidecar', () => {
    expect(RATE_LIMIT_RETRY_MS).toBe(180_000)
  })

  /** Drive one stream to its finish chunk. */
  async function finishOf(events: readonly KilnStreamEvent[]) {
    const adapter = new KilnAdapter({
      bridge: {
        async *stream() { for (const event of events) yield event },
      } as unknown as KilnBridge,
      routes: () => new Map(),
      kilnId: route => route,
    })
    let finish: unknown
    for await (const chunk of adapter.stream({
      provider: 'kiln-deepseek',
      model: 'deepseek-expert',
      messages: [USER_GO],
    })) {
      if (chunk.type === 'finish') finish = chunk.reason
    }
    return finish
  }

  it('reports a rate-limited stream as RATE_LIMIT with a retry-after', async () => {
    // TRANSPORT is backed off in milliseconds by the retry policy, which
    // against a quota window is only a faster way to stay blocked.
    expect(await finishOf([
      { type: 'content', text: '\n[provider bridge error] DeepSeek 429: rate-limited' },
      { type: 'meta', finish: 'error', error: 'DeepSeek 429: rate-limited' },
    ])).toEqual({
      kind: 'error',
      failure: {
        message: 'DeepSeek 429: rate-limited',
        code: 'RATE_LIMIT',
        status: 429,
        providerRetryAfterMs: 180_000,
      },
    })
  })

  it('leaves a genuine transport failure classified as TRANSPORT', async () => {
    expect(await finishOf([
      { type: 'meta', finish: 'error', error: 'the provider bridge exited' },
    ])).toEqual({
      kind: 'error',
      failure: { message: 'the provider bridge exited', code: 'TRANSPORT' },
    })
  })

  it('reports a full DeepSeek chat as CONTEXT_WINDOW_EXCEEDED so the harness compacts', async () => {
    // ds_direct raises this wording when a chat hits its length limit; the code
    // is what routes it to the harness's context-overflow path (the same engine
    // as /compact) instead of failing the turn as a plain transport error.
    expect(await finishOf([
      { type: 'content', text: '\n[provider error] context window exceeded — the DeepSeek chat reached its length limit' },
      { type: 'meta', finish: 'error', error: 'context window exceeded — the DeepSeek chat reached its length limit; compact the conversation and continue in a new chat' },
    ])).toMatchObject({ failure: { code: 'CONTEXT_WINDOW_EXCEEDED' } })
  })

  it('carries the sidecar reason instead of a generic message', async () => {
    // The reason used to be dropped entirely: every failure read as "the Kiln
    // provider reported an error" no matter what actually went wrong.
    const finish = await finishOf([
      { type: 'meta', finish: 'error', error: 'DeepSeek auth failed — token expired' },
    ]) as { failure: { message: string } }
    expect(finish.failure.message).toBe('DeepSeek auth failed — token expired')
  })

  it('still falls back to a generic message when the sidecar sends none', async () => {
    const finish = await finishOf([{ type: 'meta', finish: 'error' }]) as { failure: { message: string } }
    expect(finish.failure.message).toBe('the Kiln provider reported an error')
  })

  it('never classifies model prose about rate limits as a rate limit', async () => {
    // The failure class comes from the sidecar's structured field, not the text.
    expect(await finishOf([
      { type: 'content', text: 'Rate limits are usually enforced per account.' },
      { type: 'meta', finish: 'error', error: 'the provider bridge exited' },
    ])).toMatchObject({ failure: { code: 'TRANSPORT' } })
  })
})

describe('rebuildRoutes', () => {
  const base: Omit<KilnProvider, 'id' | 'accounts'> = {
    name: 'DeepSeek', models: [{ id: 'deepseek-expert', name: 'Expert' }], advertised: [],
    default: 'deepseek-expert', enabled: true, local: false, has_key: true, api_key_env: '', builtin: true,
    schema: 'deepseek-web', base_url: '',
  }
  const catalogWith = (accounts: readonly string[]): KilnProvider[] =>
    [{ id: 'deepseek', accounts: [...accounts], ...base }]

  /** Fresh mutable tables, as `apply()` holds them. */
  function tables() {
    return { routes: new Map<string, KilnProvider>(), kilnIds: new Map<string, string>(), accounts: new Map<string, string>() }
  }

  it('adds one route per pooled login, plus the base route', () => {
    const t = tables()
    rebuildRoutes(t, catalogWith(['a@x.com', 'b@x.com']), 'kiln-', false)
    expect([...t.routes.keys()]).toEqual(['kiln-deepseek', 'kiln-deepseek@a@x.com', 'kiln-deepseek@b@x.com'])
    expect(t.accounts.get('kiln-deepseek@b@x.com')).toBe('b@x.com')
  })

  it('surfaces a freshly added account as a new route on re-run, in place', () => {
    // This is the whole point of the re-register approach: after add_account
    // persists a login, a second catalog read carries it, and rebuilding the
    // SAME table objects (the adapter closes over them) makes it selectable.
    const t = tables()
    rebuildRoutes(t, catalogWith(['a@x.com']), 'kiln-', false)
    expect(t.routes.has('kiln-deepseek@new@x.com')).toBe(false)
    rebuildRoutes(t, catalogWith(['a@x.com', 'new@x.com']), 'kiln-', false)
    expect(t.routes.has('kiln-deepseek@new@x.com')).toBe(true)
    expect(t.accounts.get('kiln-deepseek@new@x.com')).toBe('new@x.com')
  })

  it('drops a route that can no longer serve when onlyConfigured is set', () => {
    const t = tables()
    rebuildRoutes(t, [{ ...base, id: 'openai', accounts: [], has_key: false, api_key_env: 'OPENAI_API_KEY', schema: 'openai' }], 'kiln-', true)
    expect(t.routes.size).toBe(0)
  })
})

describe('account-pinned routes', () => {
  const POOLED = {
    id: 'deepseek',
    name: 'DeepSeek',
    accounts: ['main@x.com', 'subs@x.com'],
    models: [{ id: 'deepseek-expert', name: 'Expert' }],
    advertised: [],
    default: 'deepseek-expert',
    enabled: true,
    local: false,
    has_key: true,
    api_key_env: '',
  } as unknown as KilnProvider

  /** The adapter as `apply()` wires it: one plain route plus one per login. */
  function wired(captured: { opts?: Record<string, unknown> | undefined }) {
    const routes = new Map<string, KilnProvider>([['kiln-deepseek', POOLED]])
    const accounts = new Map<string, string>()
    for (const account of POOLED.accounts ?? []) {
      const route = accountRoute('kiln-', 'deepseek', account)
      routes.set(route, POOLED)
      accounts.set(route, account)
    }
    return new KilnAdapter({
      bridge: {
        async *stream(request: { opts?: Record<string, unknown> | undefined }) {
          captured.opts = request.opts
          yield { type: 'meta', finish: 'stop' } as KilnStreamEvent
        },
      } as unknown as KilnBridge,
      routes: () => routes,
      kilnId: () => 'deepseek',
      account: route => accounts.get(route),
    })
  }

  /** Run one request through a route and return the opts the sidecar received. */
  async function optsFor(provider: string) {
    const captured: { opts?: Record<string, unknown> | undefined } = {}
    for await (const _ of wired(captured).stream({ provider, model: 'deepseek-expert', messages: [USER_GO] })) { /* drain */ }
    return captured.opts ?? {}
  }

  it('names the login on a pinned route so the sidecar does not use the ring', async () => {
    expect(await optsFor('kiln-deepseek@subs@x.com')).toMatchObject({ account: 'subs@x.com' })
  })

  it('sends no account on the plain route, leaving the ring in charge', async () => {
    expect('account' in await optsFor('kiln-deepseek')).toBe(false)
  })

  it('keeps the provider id unambiguous when the login contains an @', () => {
    // The account id is normally an email, so the route name has two `@`s. The
    // provider part must still be recoverable from the first one.
    const route = accountRoute('kiln-', 'deepseek', 'subs@x.com')
    expect(route).toBe('kiln-deepseek@subs@x.com')
    expect(route.slice('kiln-'.length).split('@')[0]).toBe('deepseek')
  })

  it('distinguishes pinned routes in the picker by login', () => {
    const adapter = wired({})
    expect(adapter.providerInfo('kiln-deepseek').name).toBe('DeepSeek')
    expect(adapter.providerInfo('kiln-deepseek@main@x.com').name).toBe('DeepSeek (main@x.com)')
    expect(adapter.providerInfo('kiln-deepseek@subs@x.com').name).toBe('DeepSeek (subs@x.com)')
  })

  it('still routes a pinned route to the same underlying provider', async () => {
    // Pinning changes the login, never the provider the request is dispatched to.
    expect(await optsFor('kiln-deepseek@main@x.com')).toMatchObject({ account: 'main@x.com' })
  })
})
