
/**
 * The shapes the reader repairs in a block whose structure went wrong, and the
 * shapes it must still refuse.
 *
 * Two repairs are pinned here, each with the boundary that keeps it from
 * firing where the block is genuinely unfinished:
 *
 *   * `orphan-group` — a wrapped block whose invoke OPENERS are all missing and
 *     whose invoke CLOSERS are present, one closer per call.
 *   * `closer-spam` — a run of closer-only lines, which is the model repeating
 *     structure rather than writing a call.
 *
 * Every tag is assembled from character codes. A spec that spells one as a
 * single token cannot itself be embedded in a markup document without
 * truncating it, which is the failure this reader exists to repair.
 */

import { describe, expect, it } from 'vitest'
import type { StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import { DsmlTranslator, readDsmlStream, toolIndex } from '../src/index.ts'
import type { DsmlEvent } from '../src/index.ts'
import { GLITCH_RUN_DEFAULT, closerRun, glitchRun } from '../src/dsml.ts'

const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const PO = LT + 'parameter '
const PC = LT + SL + 'parameter' + GT
const IO = LT + 'invoke '
const IC = LT + SL + 'invoke' + GT
const CO = LT + 'tool_calls' + GT
const CC = LT + SL + 'tool_calls' + GT
const PIPE = String.fromCharCode(0xFF5C)

/** One pipe-wrapped native token: the spelling a spammed run arrives in. */
function wrapped(name: string): string {
  return LT + PIPE + PIPE + name + PIPE + PIPE + GT
}

const KERNEL: ToolSchema = {
  name: 'kernel',
  description: 'Run Python.',
  parameters: {
    type: 'object',
    properties: { code: { type: 'string' }, timeoutMs: { type: 'integer' } },
    required: ['code'],
  },
}

const KERNEL_TOOLS = toolIndex([KERNEL])

function run(text: string, tools = KERNEL_TOOLS): { events: DsmlEvent[]; reader: DsmlTranslator } {
  const reader = new DsmlTranslator(tools)
  return { events: [...reader.push(text), ...reader.end()], reader }
}

function calls(text: string, tools = KERNEL_TOOLS): { name: string; arguments: Record<string, unknown> }[] {
  return run(text, tools)
    .events.filter((event): event is Extract<DsmlEvent, { kind: 'tool-call' }> => event.kind === 'tool-call')
    .map(event => ({ name: event.name, arguments: JSON.parse(event.arguments) as Record<string, unknown> }))
}

/** One whole argument element. */
function argument(name: string, value: string): string {
  return PO + 'name="' + name + '"' + GT + value + PC
}

describe('a wrapped block whose invoke openers are missing', () => {
  /** Two complete arguments, each bounded by the invoke closer, no opener at all. */
  const grouped = [
    CO,
    argument('code', 'print(1)') + IC,
    argument('code', 'print(2)') + IC,
    CC,
    '',
  ].join('\n')

  it('reads one call per closer', () => {
    expect(calls(grouped)).toEqual([
      { name: 'kernel', arguments: { code: 'print(1)' } },
      { name: 'kernel', arguments: { code: 'print(2)' } },
    ])
  })

  it('reports the shape it repaired', () => {
    expect(run(grouped).reader.repairedShapes()).toContain('orphan-group')
  })

  it('shows no raw markup', () => {
    const visible = run(grouped).events
      .filter((event): event is Extract<DsmlEvent, { kind: 'text' }> => event.kind === 'text')
      .map(event => event.text)
      .join('')
    expect(visible).toBe('')
  })

  it('refuses a single group, which the single-orphan rule already owns', () => {
    const one = [CO, argument('code', 'print(1)') + IC, CC, ''].join('\n')
    expect(calls(one)).toEqual([{ name: 'kernel', arguments: { code: 'print(1)' } }])
    expect(run(one).reader.repairedShapes()).not.toContain('orphan-group')
  })

  it('refuses when one group is not a whole call', () => {
    const truncated = [CO, argument('code', 'print(1)') + IC, PO + 'name="code">print(2)', CC, ''].join('\n')
    expect(calls(truncated)).toEqual([])
    expect(run(truncated).reader.repairedShapes()).not.toContain('orphan-group')
  })

  it('refuses when a group carries prose between its arguments', () => {
    const prose = [CO, argument('code', 'a') + IC, 'and then', argument('code', 'b') + IC, CC, ''].join('\n')
    expect(calls(prose)).toEqual([])
  })

  it('refuses when two declared tools own the argument name', () => {
    const TWIN: ToolSchema = {
      name: 'other',
      description: 'Also takes code.',
      parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] },
    }
    expect(calls(grouped, toolIndex([KERNEL, TWIN]))).toEqual([])
  })

  it('leaves a well-formed two-call block alone', () => {
    const wellFormed = [
      CO,
      IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC,
      IO + 'name="kernel"' + GT, argument('code', 'print(2)'), IC,
      CC,
      '',
    ].join('\n')
    expect(calls(wellFormed)).toHaveLength(2)
    expect(run(wellFormed).reader.repairedShapes()).not.toContain('orphan-group')
  })
})

describe('an argument left without its own closer', () => {
  it('refuses an argument with no closer of any kind', () => {
    const cut = [CO, IO + 'name="kernel"' + GT, PO + 'name="code">print(1)', CC, ''].join('\n')
    expect(calls(cut)).toEqual([])
  })

  it('refuses two argument openers closed by one invoke closer', () => {
    const twoOpen = [
      CO,
      IO + 'name="kernel"' + GT,
      PO + 'name="code">print(1)',
      PO + 'name="timeoutMs">5000',
      IC,
      CC,
      '',
    ].join('\n')
    expect(calls(twoOpen)).toEqual([])
  })

  it('leaves a body whose own closers all arrived alone', () => {
    const whole = [
      CO,
      IO + 'name="kernel"' + GT,
      argument('code', 'print(1)'),
      argument('timeoutMs', '5000'),
      IC,
      CC,
      '',
    ].join('\n')
    expect(calls(whole)).toEqual([{ name: 'kernel', arguments: { code: 'print(1)', timeoutMs: 5000 } }])
  })
})

describe('a run of closer-only lines', () => {
  const closer = IC + '\n'

  it('counts a run at the tail and resets on anything else', () => {
    expect(closerRun(closer.repeat(3))).toBe(3)
    expect(closerRun(closer.repeat(4) + 'prose\n' + closer.repeat(2))).toBe(2)
  })

  it('skips blank lines rather than resetting the run', () => {
    expect(closerRun((IC + '\n\n').repeat(4))).toBe(4)
  })

  it('counts every taught closer, not just the invoke one', () => {
    const mixed = [IC, PC, CC, LT + SL + 'function_calls' + GT, ''].join('\n')
    expect(closerRun(mixed)).toBe(4)
  })

  it('does not count a line carrying anything besides a closer', () => {
    expect(closerRun('done' + PC + '\n')).toBe(0)
  })

  it('sets the threshold above any real call', () => {
    expect(GLITCH_RUN_DEFAULT).toBe(12)
  })
})

/** A stream of exactly the chunks it was handed. */
async function* provider(chunks: readonly StreamChunk[]): AsyncIterable<StreamChunk> {
  for (const chunk of chunks) yield chunk
}

async function drain(source: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const out: StreamChunk[] = []
  for await (const chunk of source) out.push(chunk)
  return out
}

/** One text block carrying `text`, split at each newline as a real stream does. */
function textBlock(index: number, text: string): StreamChunk[] {
  const parts = text.split(/(?<=\n)/)
  return [
    { type: 'block-start', index, blockType: 'text' },
    ...parts.map((part): StreamChunk => ({ type: 'text-delta', index, text: part })),
    { type: 'block-end', index, block: { type: 'text', text } },
  ]
}

const blockedText = (chunks: readonly StreamChunk[]): string => chunks
  .filter((chunk): chunk is Extract<StreamChunk, { type: 'block-end' }> =>
    chunk.type === 'block-end' && chunk.block.type === 'text')
  .map(chunk => chunk.block.type === 'text' ? chunk.block.text : '')
  .join('')

describe('closer spam ends the turn', () => {
  it('stops a stream that emits nothing but closers', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, IC + '\n'.repeat(0) + (IC + '\n').repeat(GLITCH_RUN_DEFAULT + 2)),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), KERNEL_TOOLS))
    expect(blockedText(chunks)).toContain('repeated structural closers')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('still runs the call that closed before the run started', async () => {
    const good = [CO, IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC, CC, ''].join('\n')
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, good + (IC + '\n').repeat(GLITCH_RUN_DEFAULT + 2)),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), KERNEL_TOOLS))
    const produced = chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(produced).toHaveLength(1)
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('leaves a turn whose closers belong to real calls alone', async () => {
    const two = [
      CO,
      IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC,
      IO + 'name="kernel"' + GT, argument('code', 'print(2)'), IC,
      CC,
      '',
    ].join('\n')
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, two),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), KERNEL_TOOLS))
    expect(blockedText(chunks)).toBe('')
    expect(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(2)
  })

  it('does not fire one line short of the threshold', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, (IC + '\n').repeat(GLITCH_RUN_DEFAULT - 1)),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), KERNEL_TOOLS))
    expect(blockedText(chunks)).not.toContain('repeated structural closers')
  })
})

describe('an argument value that quotes the format', () => {
  it('still reads the call, because a quoted opener is not a tag', () => {
    const quoted = '<parameter\\b'
    const block = [CO, IO + 'name="kernel"' + GT, argument('code', quoted), IC, CC, ''].join('\n')
    expect(calls(block)).toEqual([{ name: 'kernel', arguments: { code: quoted } }])
  })
})

describe('a run of structural tokens with nothing between them', () => {
  /** A pipe-wrapped argument opener: the token a stuck model repeats, with no closer anywhere. */
  const spamLine = wrapped(' parameter name="code"') + '\n'

  it('counts a run of OPENERS, which no closer-only test can see', () => {
    expect(glitchRun(spamLine.repeat(6))).toBe(6)
    expect(closerRun(spamLine.repeat(6))).toBe(0)
  })

  it('counts every token on one long line', () => {
    expect(glitchRun((LT + 'parameter' + GT).repeat(20))).toBe(20)
    expect(glitchRun(spamLine.repeat(4).trim())).toBe(4)
  })

  it('resets on any line carrying real content', () => {
    expect(glitchRun(spamLine.repeat(4) + 'print(1)\n')).toBe(0)
    expect(glitchRun('hello\nworld\n')).toBe(0)
  })

  it('skips blank lines rather than resetting', () => {
    expect(glitchRun((spamLine + '\n').repeat(4))).toBe(4)
  })

  it('leaves a well-formed block alone', () => {
    const good = [CO, IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC, CC, ''].join('\n')
    expect(glitchRun(good)).toBeLessThan(GLITCH_RUN_DEFAULT)
  })
})

describe('structural spam cuts the turn and still runs the call', () => {
  const spam = (wrapped(' parameter name="code"') + '\n').repeat(20)
  const good = [CO, IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC, CC, ''].join('\n')

  it('runs the call written before an OPENER run starts', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, good + spam),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), KERNEL_TOOLS))
    expect(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(1)
    expect(blockedText(chunks)).toContain('repeated structural closers')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
  })

  it('ends a turn that was nothing but the run', async () => {
    const chunks = await drain(readDsmlStream(provider([
      ...textBlock(0, spam),
      { type: 'finish', reason: { kind: 'stop' } },
    ]), KERNEL_TOOLS))
    expect(chunks.filter(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')).toHaveLength(0)
    expect(blockedText(chunks)).toContain('repeated structural closers')
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'stop' } })
  })

  it('stops PULLING the provider rather than reading on and discarding', async () => {
    let pulled = 0
    const trailer = Array.from({ length: 50 }, (_, index): StreamChunk =>
      ({ type: 'text-delta', index: 1, text: 'MORE-' + index + '\n' }))
    async function* counted(): AsyncIterable<StreamChunk> {
      const chunks: StreamChunk[] = [
        ...textBlock(0, good + spam),
        ...trailer,
        { type: 'finish', reason: { kind: 'stop' } },
      ]
      for (const chunk of chunks) {
        pulled += 1
        yield chunk
      }
    }
    await drain(readDsmlStream(counted(), KERNEL_TOOLS))
    expect(pulled).toBeLessThan(60)
  })
})

describe('a wrapper this reader has no rule for', () => {
  const tag = (name: string): string => LT + name + GT

  it('absorbs an invented envelope word', () => {
    const block = [
      tag('envelope'), IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC, tag(SL + 'envelope'), '',
    ].join('\n')
    expect(calls(block)).toEqual([{ name: 'kernel', arguments: { code: 'print(1)' } }])
  })

  it('reads a wrapper written on the SAME line as the call it wraps', () => {
    for (const word of ['tools', 'tool calls', 'toolcall', 'functions']) {
      const block = tag(word) + IO + 'name="kernel"' + GT + '\n' + argument('code', 'print(1)') + '\n' + IC + '\n'
      expect(calls(block)).toEqual([{ name: 'kernel', arguments: { code: 'print(1)' } }])
    }
  })

  it('never shows the wrapper it absorbed', () => {
    for (const text of [
      tag('tools') + IO + 'name="kernel"' + GT + '\n' + argument('code', 'print(1)') + '\n' + IC + '\n',
      [tag('tools'), '', 'Edited files', '', tag(SL + 'tools'), ''].join('\n'),
      tag('tools') + 'Edited files\n' + tag(SL + 'tools') + '\n',
      [CO, IO + 'name="kernel"' + GT, argument('code', 'print(1)'), IC, tag('tools'), ''].join('\n'),
    ]) {
      const visible = run(text).events
        .filter((event): event is Extract<DsmlEvent, { kind: 'text' }> => event.kind === 'text')
        .map(event => event.text)
        .join('')
      expect(visible).not.toContain(LT)
    }
  })

  it('leaves a sentence that merely mentions the format byte-identical', () => {
    const sentence = 'The harness reads a ' + CO + ' block. Nothing else runs.'
    expect(run(sentence).events).toEqual([{ kind: 'text', text: sentence + '\n' }])
  })

  it('leaves a tag mentioned mid-sentence alone', () => {
    const line = 'Edited files ' + tag('tools')
    expect(run(line + '\n').events).toEqual([{ kind: 'text', text: line + '\n' }])
  })
})
