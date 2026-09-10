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
import type { GenerateOptions, ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, invokeArguments, isRateLimit, KilnAdapter, RATE_LIMIT_RETRY_MS, requestOptions, trailingReasoningCalls } from '@deepseek-ai/dsh-llm-kiln'
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

  it('dispatches a complete invoke whose <tool_calls> wrapper the model never closed', () => {
    // The reported leak: the inner call is WHOLE — only the outer </tool_calls>
    // never arrived (dropped, or written as a native token that strips). The
    // call must run, not reach the user as the raw markup of a call that looks
    // done and never happened. The truncation test above still holds the line:
    // a call missing its own </invoke> stays text.
    const chunks = ['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n</invoke>']
    expect(calls(chunks)).toEqual([['kernel', { code: '1+1' }]])
    expect(prose(chunks)).toBe('')
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

  it('strips the native `_calls` frame wrapper instead of leaking it as prose', () => {
    // DeepSeek wraps its native call in `<｜｜DSML｜｜_calls>…</｜｜DSML｜｜_calls>`,
    // the pipe-token equivalent of `<tool_calls>`. The wrapper carries no tool
    // and must not surface as visible text around a call that ran.
    const chunks = [`<${P}${P}DSML${P}${P}_calls>\n`
      + `${dsml(' name="run_code"')}\n<parameter name="code">1+1</parameter>\n${dsmlEnd}\n`
      + `</${P}${P}DSML${P}${P}_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['run_code', { code: '1+1' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('strips a bare `_calls` frame token pair even with no inner call', () => {
    // The exact reported symptom: an empty `<｜｜DSML｜｜_calls>` / `</｜｜DSML｜｜_calls>`
    // pair must not reach the user as visible tags.
    const chunks = [`<${P}${P}DSML${P}${P}_calls>\n</${P}${P}DSML${P}${P}_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('reads a native opener that carries the taught `invoke` word inside the token', () => {
    // DeepSeek sometimes writes `<｜｜DSML｜｜invoke name="run_code">`, tag name and
    // all, inside the token; the old rebuild doubled it to `<invokeinvoke …>`,
    // which then leaked as prose instead of dispatching.
    const chunks = [`${dsml('invoke name="run_code"')}\n`
      + '<parameter name="code" string="true">1+1</parameter>\n'
      + `</${P}${P}DSML${P}${P}invoke>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['run_code', { code: '1+1' }]])
    expect(prose(chunks, NATIVE)).not.toContain('invokeinvoke')
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('reads the invoke-in-token opener closed by the plain `</｜｜DSML｜｜>` token', () => {
    const chunks = [`${dsml('invoke name="run_code"')}\n<parameter name="code">2+2</parameter>\n${dsmlEnd}\n`]
    expect(calls(chunks, NATIVE)).toEqual([['run_code', { code: '2+2' }]])
  })

  it('recovers a taught <tool_calls> the model closed with a native `_calls` token', () => {
    // A mixed envelope: the taught opener, then DeepSeek's native
    // `</｜｜DSML｜｜_calls>` as the closer, which normalizeNative strips — leaving
    // the <tool_calls> block without a taught closer. The complete inner call
    // still dispatches at end of stream instead of leaking as visible markup.
    const chunks = ['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n</invoke>\n'
      + `</${P}${P}DSML${P}${P}_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: '1+1' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('drops an orphan </tool_calls> the model left after a native opener', () => {
    // The reverse mix: a native `<｜｜DSML｜｜_calls>` opener (stripped) paired with
    // a taught </tool_calls> closer. The inner bare <invoke> dispatches on its
    // own, and the leftover </tool_calls> must not surface as a stray tag.
    const chunks = [`<${P}${P}DSML${P}${P}_calls>\n`
      + '<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n</invoke>\n</tool_calls>\n']
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: '1+1' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
    expect(prose(chunks, NATIVE)).not.toContain('</tool_calls>')
  })

  it('recovers the merged ｜｜DSML｜｜tool_calls wrapper with a self-closing invoke', () => {
    // The exact reported leak: the model fused DeepSeek's native token with the
    // taught `tool_calls`/`invoke` words and rode the argument on the tag, closed
    // only by the wrapper — no `</invoke>`. Every piece used to fall through to
    // prose; the call must run and the raw tokens must never reach the user.
    const chunks = [`<${P}${P}DSML${P}${P}tool_calls> `
      + `<${P}${P}DSML${P}${P}invoke name="kernel" code=""> `
      + `</${P}${P}DSML${P}${P}tool_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: '' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('reads a merged tool_calls wrapper whose invoke carries its code as an attribute', () => {
    const chunks = [`<${P}${P}DSML${P}${P}tool_calls>\n`
      + `<${P}${P}DSML${P}${P}invoke name="run_code" code="1+1">\n`
      + `</${P}${P}DSML${P}${P}tool_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['run_code', { code: '1+1' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('dispatches a self-closing <invoke> whose argument rides the tag', () => {
    // Attribute-only invoke with no `</invoke>`, closed by the wrapper. The
    // schema declares `path`, so the attribute is honoured.
    const chunks = ['<tool_calls>\n<invoke name="read_file" path="./p.json" />\n</tool_calls>\n']
    expect(calls(chunks, NATIVE)).toEqual([['read_file', { path: './p.json' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('reads a bodied invoke inside the merged ｜｜DSML｜｜tool_calls wrapper', () => {
    const chunks = [`<${P}${P}DSML${P}${P}tool_calls>\n`
      + '<invoke name="kernel">\n<parameter name="code">6*7</parameter>\n</invoke>\n'
      + `</${P}${P}DSML${P}${P}tool_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: '6*7' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('leaves a truncated invoke inside the merged wrapper as text', () => {
    // A body was started (a `<parameter>`) and cut off. The wrapper makes the
    // block look bounded, but the call itself is unfinished, so its end must not
    // be invented — the same line the taught-format truncation test holds.
    const chunks = [`<${P}${P}DSML${P}${P}tool_calls>\n`
      + `<${P}${P}DSML${P}${P}invoke name="run_code">\n<parameter name="code">rm -rf /tmp/x`]
    expect(calls(chunks, NATIVE)).toEqual([])
    expect(prose(chunks, NATIVE)).toContain('rm -rf /tmp/x')
  })

  // The token is a FAMILY, not a fixed set of spellings: every case below is a
  // shape one session produced, and each differs from a shape already handled
  // above only by a space or by which word the model fused into the token.
  it('reads the space-separated ` calls` / ` invoke` frame the taught words blend into', () => {
    // The reported leak, verbatim. `</｜｜DSML｜｜ invoke>` is the load-bearing
    // token: with no closer for the `<invoke>` the block ran to end of stream,
    // parsed to nothing, and dumped the whole turn — code and all — as prose.
    const chunks = [`<${P}${P}DSML${P}${P} calls>\n`
      + '<invoke name="kernel">\n'
      + `<${P}${P}DSML${P}${P} parameter name="code" string="true">import os\nprint(os.getcwd())\n`
      + `</${P}${P}DSML${P}${P} parameter>\n`
      + `</${P}${P}DSML${P}${P} invoke>\n`
      + `</${P}${P}DSML${P}${P} calls>\n`]
    // The closer sits on its own line, exactly as the session wrote it, so the
    // value keeps the newline before it — the taught format's rule is that the
    // value is the raw text between the tags.
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: 'import os\nprint(os.getcwd())\n' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('reads `parameter` fused into the token with no space', () => {
    // The same fusion glued to the pipes. Both spellings must reach the same
    // branch, because the model uses both within one session.
    const chunks = [`<${P}${P}DSML${P}${P}invoke name="run_code">\n`
      + `<${P}${P}DSML${P}${P}parameter name="code">1+1</${P}${P}DSML${P}${P}parameter>\n`
      + `</${P}${P}DSML${P}${P}invoke>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['run_code', { code: '1+1' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('reads the tool named as the keyword inside the token', () => {
    // `<｜｜DSML｜｜kernel>` — the token wearing the tool's own name, inside an
    // otherwise well-formed taught wrapper, so there is no `<invoke>` at all.
    const chunks = [`<tool_calls>\n<${P}${P}DSML${P}${P}kernel>\n`
      + '<parameter name="code">print(1)</parameter>\n'
      + `</${P}${P}DSML${P}${P}kernel>\n</tool_calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: 'print(1)' }]])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('strips the space-separated frame pair even with no inner call', () => {
    const chunks = [`<${P}${P}DSML${P}${P} calls>\n</${P}${P}DSML${P}${P} calls>\n`]
    expect(calls(chunks, NATIVE)).toEqual([])
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('dispatches a finished call whose `</invoke>` the model forgot', () => {
    // The reported `</parameter> </parameter>` in pairs. The block is complete
    // — wrapper closed, every parameter closed — and only `</invoke>` is
    // missing, which carries nothing the arguments need. It used to parse to
    // nothing and dump the whole block; the openers vanish into the markdown
    // renderer as unknown tags and the closers surface, one per parameter.
    const chunks = ['<tool_calls>\n<invoke name="web_search">\n'
      + '<parameter name="query">deepseek</parameter>\n'
      + '<parameter name="max_results">3</parameter>\n</tool_calls>\n']
    expect(calls(chunks)).toEqual([['web_search', { query: 'deepseek', max_results: 3 }]])
    expect(prose(chunks)).not.toContain('</parameter>')
    expect(prose(chunks).trim()).toBe('')
  })

  it('still refuses a call whose LAST parameter never closed', () => {
    // The truncation rule, unchanged and now measured precisely: one finished
    // parameter followed by one cut off mid-write is a command whose end must
    // not be invented, even though the block around it looks bounded.
    const chunks = ['<tool_calls>\n<invoke name="web_search">\n'
      + '<parameter name="query">deepseek</parameter>\n'
      + '<parameter name="max_results">3']
    expect(calls(chunks)).toEqual([])
    expect(prose(chunks)).toContain('deepseek')
  })

  it('does not tell the model a real tool does not exist', () => {
    // An unfinished call to a DECLARED tool drew `[no such tool]`, so the model
    // "fixed" a name that was never wrong and re-sent the same block. The note
    // must name the actual mistake; only a genuinely undeclared tool gets the
    // roster note.
    const unfinished = ['<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</tool_calls>\n']
    expect(calls(unfinished)).toEqual([])
    expect(prose(unfinished)).not.toContain('no such tool')
    expect(prose(unfinished)).toContain('unfinished tool call')

    const ghost = ['<tool_calls>\n<invoke name="ghost">\n<parameter name="code">1+1</parameter>\n</invoke>\n</tool_calls>\n']
    expect(calls(ghost)).toEqual([])
    expect(prose(ghost)).toContain('no such tool')
  })

  it('drops an orphan </parameter> left after the call it belonged to', () => {
    // Rewriting `</｜｜DSML｜｜parameter>` into the taught closer made a NEW way
    // to leak: one closer too many, or a parameter closed after its invoke, now
    // reaches the prose path looking like clean taught syntax. It is structure
    // either way — the call already ran — so it must not surface as a stray tag.
    const chunks = ['<invoke name="kernel">\n<parameter name="code">print(1)</parameter>\n</invoke>\n'
      + `</${P}${P}DSML${P}${P} parameter>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['kernel', { code: 'print(1)' }]])
    expect(prose(chunks, NATIVE)).not.toContain('</parameter>')
    expect(prose(chunks, NATIVE).trim()).toBe('')
  })

  it('refuses to pass an unplaced native token through as an argument', () => {
    // The safety net under every spelling still unseen. A token this reader
    // cannot place must not become the tool's argument via the unlabelled-body
    // path — that is what fed `kernel` a cell starting with `<｜｜DSML｜｜…` and
    // burned a turn on `SyntaxError: invalid character '｜'`.
    const chunks = [`<invoke name="run_code">\n<${P}${P}DSML${P}${P}mystery x="1">1+1\n</invoke>\n`]
    expect(calls(chunks, NATIVE)).toEqual([['run_code', {}]])
    expect(prose(chunks, NATIVE)).not.toContain('SyntaxError')
  })
})

describe('system_reminder suppression', () => {
  const P = '｜'

  it('drops a system_reminder span but keeps the prose around it', () => {
    const chunks = ['Sure.\n<system_reminder>\nYou are an AI agent in a sandbox.\n</system_reminder>\nHere is the answer.\n']
    expect(prose(chunks)).toBe('Sure.\nHere is the answer.\n')
    expect(prose(chunks)).not.toContain('system_reminder')
    expect(prose(chunks)).not.toContain('sandbox')
  })

  it('drops a multi-line recited prompt and dispatches nothing from it', () => {
    const chunks = [
      '<system_reminder>\n', 'You are an AI agent in a fully enclosed sandbox.\n',
      '# Calling tools\nWrite a <tool_calls> block.\n', '</system_reminder>\n', 'done\n',
    ]
    expect(prose(chunks)).toBe('done\n')
    expect(calls(chunks)).toEqual([])
  })

  it('does NOT dispatch a tool_calls example recited inside the framing', () => {
    // The recited prompt teaches the tool format, so the echo contains a literal
    // <tool_calls> block. Suppressing before the scanner is what keeps it from
    // running as a real call.
    const chunks = ['<system_reminder>\nExample: <tool_calls>\n<invoke name="kernel">\n'
      + '<parameter name="code">1+1</parameter>\n</invoke>\n</tool_calls>\n</system_reminder>\nhi\n']
    expect(calls(chunks)).toEqual([])
    expect(prose(chunks)).toBe('hi\n')
  })

  it('keeps the framing tag visible when the model merely names it in a sentence', () => {
    // A model DISCUSSING the framing writes the tag inline, not as a block
    // delimiter. Suppressing from an inline mention deleted the whole rest of
    // the answer with no trace on either side, so the mention stays prose.
    const chunks = ['The tag `<system-reminder>` above is the proof, and here is the rest of my answer.\n']
    expect(prose(chunks)).toBe('The tag `<system-reminder>` above is the proof, and here is the rest of my answer.\n')
  })

  it('still suppresses a block opener that shares its line with leading prose', () => {
    // The gate is on the opener's own position, so prose BEFORE a block opener
    // keeps the suppression: only the mention inside a sentence is prose.
    const chunks = ['Sure.\n<system-reminder>\nrecited prompt\n</system-reminder>\nanswer\n']
    expect(prose(chunks)).toBe('Sure.\nanswer\n')
    expect(prose(chunks)).not.toContain('recited')
  })

  it('suppresses to the end of the turn when the span is never closed', () => {
    const chunks = ['<system_reminder>\nYou are an AI agent...\nblah blah the whole prompt\n']
    expect(prose(chunks)).toBe('')
    expect(calls(chunks)).toEqual([])
  })

  it('strips a pipe-wrapped native system_reminder token', () => {
    const chunks = [`<${P}system_reminder${P}>\nrecited prompt\n</${P}system_reminder${P}>\nanswer\n`]
    expect(prose(chunks)).toBe('answer\n')
    expect(prose(chunks)).not.toContain('recited')
  })

  it('still dispatches a real tool call after a closed system_reminder', () => {
    const chunks = ['<system_reminder>\nrecited\n</system_reminder>\n'
      + '<tool_calls>\n<invoke name="kernel">\n<parameter name="code">1+1</parameter>\n</invoke>\n</tool_calls>\n']
    expect(calls(chunks)).toEqual([['kernel', { code: '1+1' }]])
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

describe('a call the model left in its reasoning channel', () => {
  const CORDIS: ToolSchema = {
    name: 'cordis_inspect_list',
    description: 'List Cordis providers.',
    parameters: { type: 'object', properties: { platform: { type: 'string' } }, required: ['platform'] },
  }

  /** Collect every chunk of one stream, tools declared so DSML knows the names. */
  async function streamChunks(events: readonly KilnStreamEvent[], tools: readonly ToolSchema[]) {
    const adapter = new KilnAdapter({
      bridge: { async *stream() { for (const event of events) yield event } } as unknown as KilnBridge,
      routes: () => new Map(),
      kilnId: route => route,
    })
    const chunks = []
    for await (const chunk of adapter.stream({
      provider: 'kiln-deepseek', model: 'deepseek-expert', messages: [USER_GO], tools: [...tools],
    })) chunks.push(chunk)
    return chunks
  }

  /** The tool calls a stream produced, as `[name, parsed arguments]`. */
  async function streamCalls(events: readonly KilnStreamEvent[], tools: readonly ToolSchema[] = [KERNEL, CORDIS]) {
    return (await streamChunks(events, tools))
      .filter((chunk): chunk is Extract<typeof chunk, { type: 'block-end' }> => chunk.type === 'block-end')
      .map(chunk => chunk.block)
      .filter((block): block is Extract<typeof block, { type: 'tool-call' }> => block.type === 'tool-call')
      .map(block => [block.name, JSON.parse(block.arguments) as unknown] as const)
  }

  /** The finish reason a stream ended on. */
  async function streamFinish(events: readonly KilnStreamEvent[], tools: readonly ToolSchema[] = [KERNEL, CORDIS]) {
    const finish = (await streamChunks(events, tools)).find(chunk => chunk.type === 'finish')
    return finish?.type === 'finish' ? finish.reason : undefined
  }

  // The failure this fixes: the model thinks out loud and ends the thought with
  // the call it means to make — but inside `<think>`, which the content scanner
  // never sees, so the turn used to end having run nothing.
  const REASONED_CALL = 'We need the provider list. Let me call it and display the output.\n\n'
    + '<tool_calls>\n<invoke name="cordis_inspect_list">\n<parameter name="platform">host</parameter>\n</invoke>\n</tool_calls>'

  it('recovers a complete call at the tail of the reasoning', async () => {
    expect(await streamCalls([
      { type: 'reasoning', text: REASONED_CALL },
      { type: 'meta', finish: 'stop' },
    ])).toEqual([['cordis_inspect_list', { platform: 'host' }]])
  })

  it('reports that turn as a tool-calls turn so the loop runs the call', async () => {
    expect(await streamFinish([
      { type: 'reasoning', text: REASONED_CALL },
      { type: 'meta', finish: 'stop' },
    ])).toEqual({ kind: 'tool-calls' })
  })

  it('unit: trailingReasoningCalls reads the same tail', () => {
    expect(trailingReasoningCalls(REASONED_CALL, toolIndex([CORDIS]))).toEqual([
      { name: 'cordis_inspect_list', arguments: JSON.stringify({ platform: 'host' }) },
    ])
  })

  it('leaves a call quoted mid-thought alone', () => {
    // Prose after the block means the model was discussing an example, not
    // ending on the call — recovering it would run something it never asked for.
    const midThought = 'We could run <tool_calls><invoke name="kernel"><parameter name="code">1</parameter>'
      + '</invoke></tool_calls> but first let me read the file.'
    expect(trailingReasoningCalls(midThought, toolIndex([KERNEL]))).toBeUndefined()
  })

  it('leaves a truncated tail block alone (never invents the end of a command)', () => {
    const truncated = 'Let me run this:\n<tool_calls>\n<invoke name="kernel">\n<parameter name="code">import os\nprint(os'
    expect(trailingReasoningCalls(truncated, toolIndex([KERNEL]))).toBeUndefined()
  })

  it('leaves an unknown tool in the reasoning alone', () => {
    const unknown = 'Let me try.\n<tool_calls>\n<invoke name="not_a_tool">\n<parameter name="x">1</parameter>\n</invoke>\n</tool_calls>'
    expect(trailingReasoningCalls(unknown, toolIndex([KERNEL]))).toBeUndefined()
  })

  it('does not double-dispatch when a content-channel call already ran', async () => {
    // A real call in the visible channel wins; the reasoning tail is not also
    // promoted, so the tool runs exactly once.
    expect(await streamCalls([
      { type: 'content', text: '<tool_calls><invoke name="kernel"><parameter name="code">1+1</parameter></invoke></tool_calls>\n' },
      { type: 'reasoning', text: REASONED_CALL },
      { type: 'meta', finish: 'stop' },
    ])).toEqual([['kernel', { code: '1+1' }]])
  })

  it('recovers nothing from reasoning that names no call', async () => {
    expect(await streamFinish([
      { type: 'reasoning', text: 'I have enough to answer; no tool needed.' },
      { type: 'content', text: 'Here is the answer.' },
      { type: 'meta', finish: 'stop' },
    ])).toEqual({ kind: 'stop' })
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

describe('requestOptions session isolation', () => {
  const SESSION = 'conv-123' as NonNullable<GenerateOptions['sessionId']>
  const base = { provider: 'deepseek', model: 'deepseek-chat', messages: [] } as unknown as GenerateOptions

  it('pins an ordinary request to the conversation chat with no oneshot flag', () => {
    const opts = requestOptions({ ...base, sessionId: SESSION })
    expect(opts.conv_id).toBe('conv-123')
    expect(opts.oneshot).toBeUndefined()
  })

  it('routes a compaction summary to its own throwaway chat', () => {
    const opts = requestOptions({ ...base, sessionId: SESSION, purpose: 'compaction' })
    expect(opts.oneshot).toBe(true)
    // It must NOT reuse the conversation chat (the full, possibly-overflowed one).
    expect(opts.conv_id).not.toBe('conv-123')
    expect(String(opts.conv_id)).toContain('conv-123#compaction#')
  })

  it('gives two compaction calls distinct chats so they never thread together', () => {
    const a = requestOptions({ ...base, sessionId: SESSION, purpose: 'compaction' })
    const b = requestOptions({ ...base, sessionId: SESSION, purpose: 'compaction' })
    expect(a.conv_id).not.toBe(b.conv_id)
  })

  it('also isolates the session-title summary', () => {
    const opts = requestOptions({ ...base, sessionId: SESSION, purpose: 'session-title' })
    expect(opts.oneshot).toBe(true)
    expect(String(opts.conv_id)).toContain('conv-123#session-title#')
  })
})
