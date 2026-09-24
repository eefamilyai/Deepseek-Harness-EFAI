/**
 * The reader as every route gets it: the dialects a model actually writes, the
 * chunk-stream pass that promotes them to real calls, and the plugin that
 * installs that pass over whatever adapter answered.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, { LlmAdapter } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, readDsmlStream, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import * as dsmlPlugin from '../src/index.ts'

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

const GLOB: ToolSchema = {
  name: 'glob',
  description: 'Match paths.',
  parameters: { type: 'object', properties: { pattern: { type: 'string' } }, required: ['pattern'] },
}

const SEARCH: ToolSchema = {
  name: 'search_files',
  description: 'Search the tree.',
  parameters: {
    type: 'object',
    properties: { query: { type: 'string' }, limit: { type: 'integer' } },
    required: ['query'],
  },
}

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: { type: 'object', properties: { content: { type: 'string' } }, required: ['content'] },
}

const TOOLS = toolIndex([READ, GLOB, SEARCH, KERNEL])

/** Feed one whole reply through a reader and collect its events. */
function run(text: string, options: { notes?: boolean } = {}): DsmlEvent[] {
  const translator = new DsmlTranslator(TOOLS, options)
  return [...translator.push(text), ...translator.end()]
}

/** The calls one reply produced, as `name(argumentsJson)` pairs. */
function calls(text: string, options: { notes?: boolean } = {}): { name: string; arguments: unknown }[] {
  return run(text, options)
    .filter(event => event.kind === 'tool-call')
    .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as unknown }))
}

/** The visible text one reply produced. */
function visible(text: string, options: { notes?: boolean } = {}): string {
  return run(text, options).filter(event => event.kind === 'text').map(event => event.text).join('')
}

describe('native DSML dialects', () => {
  it('reads a single-pipe token block, spaces and all', () => {
    expect(calls([
      '<｜DSML｜ calls>',
      '  <｜DSML｜ invoke name="read">',
      '    <｜DSML｜ parameter name="path" string="true">src/index.ts</｜DSML｜ parameter>',
      '  </｜DSML｜ invoke>',
      '</｜DSML｜ calls>',
      '',
    ].join('\n'))).toEqual([{ name: 'read', arguments: { path: 'src/index.ts' } }])
  })

  it('reads the token spelled tool_calls with no space after the pipes', () => {
    expect(calls([
      '<｜DSML｜tool_calls>',
      '  <｜DSML｜invoke name="glob">',
      '    <｜DSML｜parameter name="pattern" string="true">*/config.toml</｜DSML｜parameter>',
      '  </｜DSML｜invoke>',
      '</｜DSML｜tool_calls>',
      '',
    ].join('\n'))).toEqual([{ name: 'glob', arguments: { pattern: '*/config.toml' } }])
  })

  it('reads function_calls as the same envelope, with a JSON arguments body', () => {
    expect(calls([
      '<｜DSML｜function_calls>',
      '  <｜DSML｜invoke name="search_files">',
      '    { "query": "database connection" }',
      '  </｜DSML｜invoke>',
      '</｜DSML｜function_calls>',
      '',
    ].join('\n'))).toEqual([{ name: 'search_files', arguments: { query: 'database connection' } }])
  })

  it('reads a bare <function_calls> wrapper around the taught tags', () => {
    expect(calls([
      '<function_calls>',
      '<invoke name="read">',
      '<parameter name="path">package.json</parameter>',
      '</invoke>',
      '</function_calls>',
      '',
    ].join('\n'))).toEqual([{ name: 'read', arguments: { path: 'package.json' } }])
  })

  it('finds the call after an echoed chat template', () => {
    const reply = [
      '<｜User｜>Read the file package.json<｜Assistant｜><think>...</think>',
      '<｜DSML｜ calls>',
      '  <｜DSML｜ invoke name="read">',
      '    <｜DSML｜ parameter name="path" string="true">package.json</｜DSML｜ parameter>',
      '  </｜DSML｜ invoke>',
      '</｜DSML｜ calls>',
      '',
    ].join('\n')
    expect(calls(reply)).toEqual([{ name: 'read', arguments: { path: 'package.json' } }])
  })

  it('recovers a parameter tag whose name=" was eaten on the wire', () => {
    // Captured verbatim from a live session: the second parameter's opener
    // arrives as a closer, with `parameter name="` gone and one quote left over.
    // It used to reach the user as text and strand the `</parameter>` under it,
    // which made the invoke look cut off mid-write and refused the whole call.
    expect(calls([
      '<｜｜DSML｜｜invoke name="search_files">',
      '<｜｜DSML｜｜parameter name="query" string="true">pool</｜｜DSML｜｜parameter>',
      '</｜｜DSML｜｜ limit" string="false">5</｜｜DSML｜｜parameter>',
      '</invoke>',
      '',
    ].join('\n'))).toEqual([{ name: 'search_files', arguments: { query: 'pool', limit: 5 } }])
  })

  it('recovers the same damage written as an opener', () => {
    expect(calls([
      '<｜｜DSML｜｜invoke name="search_files">',
      '<｜｜DSML｜｜parameter name="query" string="true">pool</｜｜DSML｜｜parameter>',
      '<｜｜DSML｜｜ limit" string="false">5</｜｜DSML｜｜parameter>',
      '</invoke>',
      '',
    ].join('\n'))).toEqual([{ name: 'search_files', arguments: { query: 'pool', limit: 5 } }])
  })

  it('leaves a well-formed token alone, whatever its parameter is called', () => {
    // The odd quote is the whole signal. A parameter whose name merely STARTS
    // with a reserved word still reads as the opener it is.
    expect(visible([
      '<｜｜DSML｜｜parameter name="parameters" string="true">x</｜｜DSML｜｜parameter>',
      '',
    ].join('\n'))).not.toContain('DSML')
  })

  it('drops an envelope token carrying nothing at all', () => {
    // No keyword and no attributes: it names no tool and frames nothing. A live
    // turn emitted thousands of these in a row and every one reached the user.
    expect(visible('<｜｜DSML｜｜>\n<｜｜DSML｜｜>\nstill here\n')).toBe('\n\nstill here\n')
  })

  it('carries a JSON body closed only by its wrapper', () => {
    expect(calls([
      '<tool_calls>',
      '<invoke name="search_files">',
      '{"query": "pool", "limit": 5}',
      '</tool_calls>',
      '',
    ].join('\n'))).toEqual([{ name: 'search_files', arguments: { query: 'pool', limit: 5 } }])
  })

  it('reads a JSON body as a value when its keys are not this tool\'s parameters', () => {
    // A dict is a perfectly ordinary Python value; only an object whose keys are
    // all declared parameters is an arguments object.
    expect(calls([
      '<tool_calls>',
      '<invoke name="kernel">',
      '{"a": 1}',
      '</invoke>',
      '</tool_calls>',
      '',
    ].join('\n'))).toEqual([{ name: 'kernel', arguments: { content: '{"a": 1}' } }])
  })

  it('refuses a half-written JSON body rather than repairing it', () => {
    const reply = ['<tool_calls>', '<invoke name="search_files">', '{"query": "pool"', '</tool_calls>', ''].join('\n')
    expect(calls(reply)).toEqual([])
  })
})

describe('silent reading', () => {
  it('adds no note to a block that named nothing real', () => {
    const block = ['<tool_calls>', '<invoke name="rm_rf">', '<parameter name="path">/</parameter>', '</invoke>', '</tool_calls>', ''].join('\n')
    expect(visible(block, { notes: false })).not.toContain('no such tool')
    expect(visible(block, { notes: true })).toContain('no such tool')
  })

  it('adds no format reminder to a block it repaired', () => {
    const block = ['<tool_calls>', '<invoke=read>', '<parameter=path>a.txt</parameter>', '</invoke>', '</tool_calls>', ''].join('\n')
    expect(calls(block, { notes: false })).toEqual([{ name: 'read', arguments: { path: 'a.txt' } }])
    expect(visible(block, { notes: false })).toBe('')
    expect(visible(block, { notes: true })).toContain('format reminder')
  })

  it('leaves prose about the format exactly as written', () => {
    const prose = 'The harness reads a <tool_calls> block. Nothing else runs.\n'
    expect(visible(prose, { notes: false })).toBe(prose)
  })
})

describe('streaming granularity', () => {
  it('releases prose as it arrives rather than holding the whole line', () => {
    const translator = new DsmlTranslator(TOOLS, { notes: false })
    expect(translator.push('Here ')).toEqual([{ kind: 'text', text: 'Here ' }])
    expect(translator.push('is the plan')).toEqual([{ kind: 'text', text: 'is the plan' }])
    expect(translator.push('.\n')).toEqual([{ kind: 'text', text: '.\n' }])
    expect(translator.end()).toEqual([])
  })

  it('holds the rest of a line from the first `<`', () => {
    const translator = new DsmlTranslator(TOOLS, { notes: false })
    translator.push('Sure. ')
    // Nothing comes out while the line might still become a call.
    expect(translator.push('<tool_c')).toEqual([])
    expect(translator.push('alls>\n<invoke name="read">\n')).toEqual([])
    const rest = [...translator.push('<parameter name="path">a.txt</parameter>\n</invoke>\n</tool_calls>\n')]
    expect(rest).toEqual([{ kind: 'tool-call', name: 'read', arguments: JSON.stringify({ path: 'a.txt' }) }])
  })

  it('holds indentation, so chunking cannot change what a block reads as', () => {
    const block = '  <tool_calls>\n<invoke name="read">\n<parameter name="path">a.txt</parameter>\n</invoke>\n</tool_calls>\n'
    const split = new DsmlTranslator(TOOLS, { notes: false })
    expect(split.push('  ')).toEqual([])
    const chunked = [...split.push(block.slice(2)), ...split.end()]
    expect(chunked).toEqual(run(block, { notes: false }))
    expect(chunked.filter(event => event.kind === 'tool-call')).toHaveLength(1)
  })

  it('reads a tag mid-sentence as the mention it is, not as a lost argument', () => {
    const translator = new DsmlTranslator(TOOLS, { notes: false })
    const events = [
      ...translator.push('The wrapper looks like '),
      ...translator.push('<parameter name="path">x</parameter> in the docs.\n'),
      ...translator.end(),
    ]
    expect(events.filter(event => event.kind === 'tool-call')).toEqual([])
  })
})

/** Collect a whole chunk stream. */
async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** One provider stream, written the way an adapter writes one. */
async function* provider(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

/** A text block carrying `text`, split at every newline like a real stream. */
function textBlock(index: number, text: string): StreamChunk[] {
  const parts = text.split(/(?<=\n)/)
  return [
    { type: 'block-start', index, blockType: 'text' },
    ...parts.map((part): StreamChunk => ({ type: 'text-delta', index, text: part })),
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

const CALL_TEXT = ['Reading it now.', '<tool_calls>', '<invoke name="read">', '<parameter name="path">a.txt</parameter>', '</invoke>', '</tool_calls>', ''].join('\n')

describe('readDsmlStream', () => {
  it('promotes a text-channel call to a real tool call and says the turn calls tools', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, CALL_TEXT),
      { type: 'usage', usage: { inputTokens: 10, outputTokens: 20 } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), TOOLS))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call).toBeDefined()
    expect(call?.type === 'block-end' && call.block.type === 'tool-call' && call.block.name).toBe('read')
    expect(call?.type === 'block-end' && call.block.type === 'tool-call' && call.block.arguments)
      .toBe(JSON.stringify({ path: 'a.txt' }))
    const text = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'text')
    expect(text?.type === 'block-end' && text.block.type === 'text' && text.block.text).toBe('Reading it now.\n')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    expect(chunks.some(chunk => chunk.type === 'usage')).toBe(true)
  })

  it('opens every block before it closes and never repeats an index', async () => {
    const chunks = await drain(readDsmlStream(provider([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: 'thinking' },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: 'thinking' } },
      ...textBlock(1, CALL_TEXT),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), TOOLS))
    const open = new Map<number, string>()
    const started: number[] = []
    for (const chunk of chunks) {
      if (chunk.type === 'block-start') {
        expect(started).not.toContain(chunk.index)
        started.push(chunk.index)
        open.set(chunk.index, chunk.blockType)
      }
      if (chunk.type === 'block-end') {
        expect(open.get(chunk.index)).toBe(chunk.block.type)
        open.delete(chunk.index)
      }
    }
    expect(open.size).toBe(0)
    expect(started).toEqual([...started].sort((left, right) => left - right))
  })

  it('returns the stream untouched when the request declared no tools', async () => {
    const source = provider([{ type: 'finish', reason: { kind: 'stop' } }])
    expect(readDsmlStream(source, toolIndex([]))).toBe(source)
  })

  it('leaves ordinary prose and its finish reason alone', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, 'Here is a plan.\nNo calls yet.\n'),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), TOOLS))
    const text = chunks.find(chunk => chunk.type === 'block-end')
    expect(text?.type === 'block-end' && text.block.type === 'text' && text.block.text).toBe('Here is a plan.\nNo calls yet.\n')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('forwards a native tool call under its own index without claiming a recovery', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, 'Calling.\n'),
      { type: 'block-start', index: 1, blockType: 'tool-call' },
      { type: 'tool-call-delta', index: 1, id: 'native-1', name: 'read', argumentsDelta: '{"path":"a.txt"}' } as StreamChunk,
      { type: 'block-end', index: 1, block: { type: 'tool-call', id: 'native-1', name: 'read', arguments: '{"path":"a.txt"}' } } as StreamChunk,
      { type: 'finish', reason: { kind: 'tool-calls' } },
    ]), TOOLS))
    const ids = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(ids).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('never finishes a half-written call for a stream that broke', async () => {
    const failure = { message: 'connection reset', code: 'TRANSPORT' }
    // The block never closed: only the end-of-stream flush could turn it into a
    // call, and a stream that errored is not the model having finished asking.
    const truncated = ['<tool_calls>', '<invoke name="read">', '<parameter name="path">a.txt</parameter>', '</invoke>'].join('\n')
    const chunks = await drain(readDsmlStream(provider([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: truncated },
      { type: 'finish', reason: { kind: 'error', failure } },
    ]), TOOLS))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'error', failure } })
  })

  it('recovers a whole call left at the tail of the reasoning channel', async () => {
    const thought = `I should read it.\n${CALL_TEXT}`
    const chunks = await drain(readDsmlStream(provider([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), TOOLS))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(true)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('leaves the thought alone when reasoning recovery is off', async () => {
    const thought = `I should read it.\n${CALL_TEXT}`
    const chunks = await drain(readDsmlStream(provider([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]), TOOLS, { reasoningRecovery: false }))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('refuses the thought once the answer said something of its own', async () => {
    const thought = `I should read it.\n${CALL_TEXT}`
    const chunks = await drain(readDsmlStream(provider([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } },
      ...textBlock(1, 'Let me know if that helps.\n'),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), TOOLS))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
  })

  it('runs a call the model wrote after a cut-off answer', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, CALL_TEXT),
      { type: 'finish', reason: { kind: 'max-tokens' } },
    ]), TOOLS))
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('flushes buffered text when the provider stream stops without finishing', async () => {
    const chunks = await drain(readDsmlStream(provider([
      { type: 'block-start', index: 0, blockType: 'text' },
      { type: 'text-delta', index: 0, text: 'half a sentence\n' },
    ]), TOOLS))
    const text = chunks.find(chunk => chunk.type === 'block-end')
    expect(text?.type === 'block-end' && text.block.type === 'text' && text.block.text).toBe('half a sentence\n')
  })

  it('passes a delta for a block it never saw open straight through', async () => {
    const orphan: StreamChunk = { type: 'text-delta', index: 7, text: 'orphan' }
    const chunks = await drain(readDsmlStream(provider([orphan, { type: 'finish', reason: { kind: 'stop' } }]), TOOLS))
    expect(chunks[0]).toEqual(orphan)
  })
})

/** An adapter that replies with exactly the chunks it was handed. */
class ScriptedAdapter extends LlmAdapter {
  constructor(private readonly chunks: readonly StreamChunk[]) { super() }
  async * stream(_options: GenerateOptions): AsyncIterable<StreamChunk> {
    for (const chunk of this.chunks) yield chunk
  }
}

const contexts: Context[] = []

afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function compose(config: dsmlPlugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(dsmlPlugin, config)
  ctx.llm.registerAdapter(['native', 'quiet'], new ScriptedAdapter([
    ...textBlock(0, CALL_TEXT),
    { type: 'finish', reason: { kind: 'stop' } },
  ]))
  return ctx
}

describe('llm-dsml plugin', () => {
  it('reads the text channel of a provider that has a native one', async () => {
    const ctx = await compose()
    const chunks = await drain(ctx.llm.stream({
      provider: 'native',
      model: 'any',
      messages: [],
      tools: [READ],
    }))
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call?.type === 'block-end' && call.block.type === 'tool-call' && call.block.name).toBe('read')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('leaves an excluded route exactly as its adapter wrote it', async () => {
    const ctx = await compose({ excludeProviders: ['quiet'] })
    const chunks = await drain(ctx.llm.stream({
      provider: 'quiet',
      model: 'any',
      messages: [],
      tools: [READ],
    }))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('costs an auxiliary toolless call nothing', async () => {
    const ctx = await compose()
    const chunks = await drain(ctx.llm.stream({ provider: 'native', model: 'any', messages: [] }))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('honours reasoningRecovery from the composition layer', async () => {
    const ctx = await compose({ reasoningRecovery: false })
    const thought = `I should read it.\n${CALL_TEXT}`
    ctx.llm.registerAdapter(['thinker'], new ScriptedAdapter([
      { type: 'block-start', index: 0, blockType: 'reasoning' },
      { type: 'reasoning-delta', index: 0, text: thought },
      { type: 'block-end', index: 0, block: { type: 'reasoning', text: thought } },
      { type: 'finish', reason: { kind: 'stop' } },
    ]))
    const chunks = await drain(ctx.llm.stream({ provider: 'thinker', model: 'any', messages: [], tools: [READ] }))
    expect(chunks.some(chunk => chunk.type === 'block-start' && chunk.blockType === 'tool-call')).toBe(false)
  })
})
