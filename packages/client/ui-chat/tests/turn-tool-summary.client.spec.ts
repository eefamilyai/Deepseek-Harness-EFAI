import { describe, expect, it } from 'vitest'
import type { ToolCallBlock } from '../src/client/contract/snapshot.ts'
import { fitLabelParts, MAX_SUMMARY_LABEL, summarizeToolCalls } from '../src/client/contract/turn-tool-summary.ts'

/** Settled root Tool call with applied-diff metadata. */
function settled(
  callId: string,
  name: string,
  args: unknown,
  meta?: unknown,
): ToolCallBlock {
  return {
    kind: 'tool-result',
    seq: 1,
    time: 1,
    callId,
    call: { name, argsRaw: JSON.stringify(args) },
    callTime: 1,
    content: [],
    isError: false,
    subCalls: [],
    ...meta === undefined ? {} : { meta },
  }
}

describe('turn tool summary', () => {
  it('names created files and uses applied diff metadata for the line delta', () => {
    const summary = summarizeToolCalls([
      settled('a', 'write', { file_path: '/w/diagnose-session.mjs', content: 'x' }, {
        diffs: [{ path: '/w/diagnose-session.mjs', oldText: null, newText: 'a\nb\nc\n' }],
      }),
      settled('b', 'bash', { command: 'ls' }),
    ])
    expect(summary.actions).toEqual([
      { action: { kind: 'created', name: 'diagnose-session.mjs' }, count: 1 },
      { action: { kind: 'command' }, count: 1 },
    ])
    expect(summary.added).toBe(3)
    expect(summary.removed).toBe(0)
    expect(summary.omitted).toBe(0)
  })

  it('falls back to argument-derived counts for an edit with no applied metadata', () => {
    const summary = summarizeToolCalls([
      settled('a', 'edit', {
        file_path: '/w/src/index.ts',
        old_string: 'one\ntwo',
        new_string: 'one\ntwo\nthree',
      }),
    ])
    expect(summary.actions).toEqual([{ action: { kind: 'edited', name: 'index.ts' }, count: 1 }])
    expect(summary.added).toBe(3)
    expect(summary.removed).toBe(2)
  })

  it("uses a kernel cell's leading comment as its label", () => {
    const summary = summarizeToolCalls([
      settled('a', 'kernel', { code: '# Count the files under packages/\nprint(1)' }),
      settled('b', 'kernel', { code: '# Read the manifest\nprint(2)' }),
    ])
    expect(summary.actions).toEqual([
      { action: { kind: 'script', label: 'Count the files under packages/' }, count: 1 },
      { action: { kind: 'script', label: 'Read the manifest' }, count: 1 },
    ])
  })

  it('clips a long kernel comment at a word boundary, not mid-word', () => {
    const summary = summarizeToolCalls([
      settled('a', 'kernel', {
        code: '# Report working directory and top-level contents of the checkout root\nprint(1)',
      }),
    ])
    // The whole trailing words go, so the row reads as abbreviated prose rather
    // than as a word cut in half.
    expect(summary.actions).toEqual([
      { action: { kind: 'script', label: 'Report working directory and top-level contents of the…' }, count: 1 },
    ])
  })

  it('clips a single long token even though it has no word boundary', () => {
    const summary = summarizeToolCalls([
      settled('a', 'kernel', { code: `# ${'x'.repeat(80)}\nprint(1)` }),
    ])
    expect(summary.actions).toEqual([
      { action: { kind: 'script', label: `${'x'.repeat(63)}…` }, count: 1 },
    ])
  })

  it('omits the label when a kernel cell has no leading comment', () => {
    const summary = summarizeToolCalls([settled('a', 'kernel', { code: 'print(1)' })])
    expect(summary.actions).toEqual([{ action: { kind: 'script' }, count: 1 }])
  })

  it('collapses repeated actions into one counted entry', () => {
    const summary = summarizeToolCalls([
      settled('a', 'bash', { command: 'ls' }),
      settled('b', 'bash', { command: 'pwd' }),
      settled('c', 'grep', { pattern: 'x' }),
      settled('d', 'glob', { pattern: 'y' }),
    ])
    expect(summary.actions).toEqual([
      { action: { kind: 'command' }, count: 2 },
      { action: { kind: 'search' }, count: 2 },
    ])
  })

  it('caps the listed actions and reports the overflow', () => {
    const summary = summarizeToolCalls([
      settled('a', 'bash', { command: 'a' }),
      settled('b', 'read', { path: '/w/a.ts' }),
      settled('c', 'grep', { pattern: 'x' }),
      settled('d', 'web_search', { queries: ['q'] }),
      settled('e', 'web_fetch', { url: 'https://example.com' }),
      settled('f', 'todo_write', { todos: [] }),
      settled('g', 'read', { path: '/w/b.ts' }),
    ])
    expect(summary.actions).toHaveLength(5)
    expect(summary.omitted).toBe(2)
  })

  it('classifies subagent delegation separately from an ordinary tool', () => {
    const summary = summarizeToolCalls([
      settled('a', 'subagent', { prompt: 'x' }),
      settled('b', 'subagent_fork', { prompt: 'y' }),
    ])
    expect(summary.actions).toEqual([
      { action: { kind: 'delegated', name: 'subagent' }, count: 1 },
      { action: { kind: 'delegated', name: 'subagent_fork' }, count: 1 },
    ])
  })

  it('derives a create stat for a str_replace_editor call', () => {
    const summary = summarizeToolCalls([
      settled('a', 'str_replace_editor', {
        command: 'create',
        path: '/w/new.ts',
        file_text: 'a\nb\n',
      }),
    ])
    expect(summary.actions).toEqual([{ action: { kind: 'created', name: 'new.ts' }, count: 1 }])
    expect(summary.added).toBe(2)
    expect(summary.removed).toBe(0)
  })

  it('keeps the phrases that fit the row budget and reports the rest', () => {
    const fitted = fitLabelParts(['first action', 'second action', 'third action'], ' · ', 30)
    expect(fitted.parts).toEqual(['first action', 'second action'])
    expect(fitted.omitted).toBe(1)
  })

  it('keeps the first phrase however long it is', () => {
    // A row that prints nothing explains nothing, so the leading phrase survives
    // even when it alone exceeds the budget.
    const fitted = fitLabelParts(['x'.repeat(90), 'second'], ' · ', 40)
    expect(fitted.parts).toEqual(['x'.repeat(90)])
    expect(fitted.omitted).toBe(1)
  })

  it('fits every phrase inside the budget when the row is short enough', () => {
    const fitted = fitLabelParts(['a', 'b'], ' · ', MAX_SUMMARY_LABEL)
    expect(fitted.parts).toEqual(['a', 'b'])
    expect(fitted.omitted).toBe(0)
  })

  it('tolerates truncated argument JSON without throwing', () => {
    const block: ToolCallBlock = {
      callId: 'a', name: 'bash', argsRaw: '{"command": "ls', turn: 1, step: 1, time: 1, subCalls: [],
    }
    const summary = summarizeToolCalls([block])
    expect(summary.actions).toEqual([{ action: { kind: 'command' }, count: 1 }])
    expect(summary.added).toBe(0)
    expect(summary.removed).toBe(0)
  })
})
