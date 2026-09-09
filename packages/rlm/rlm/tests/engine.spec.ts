/**
 * Pure-engine unit tests. The engine's only runtime import is ./protocol.ts, so
 * this spec runs with fake LLM/kernel/message deps and NO harness resolution.
 * @module @deepseek-ai/dsh-rlm/test
 */

import { describe, it, expect } from 'vitest'
import type { ContentBlock, ToolCallId, StreamChunk } from '@deepseek-ai/dsh-llm'
import type { KernelExecuteResult } from '@deepseek-ai/dsh-kernel'
import type { RlmDeps } from '../src/engine.ts'
import { runRlm, parsePythonArguments, formatCellResult, RLM_PYTHON_TOOL_NAME } from '../src/engine.ts'

const ok = (output: string): KernelExecuteResult => ({ output, outcome: 'ok', restarted: false })

/** The fake stream objects are minimal wire-shaped literals; keep the assertion localized. */
const chunk = (value: unknown): StreamChunk => value as unknown as StreamChunk

function fakeMessages() {
  let n = 0
  return {
    createUserMessage(text: string) { return { id: `u${++n}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'user' } } },
    createAssistantMessage(content: ContentBlock[], provider: string, model: string) {
      return { id: `a${++n}`, role: 'assistant', content, source: { kind: 'model', provider, model } }
    },
    createToolResultMessage(callId: ToolCallId, text: string, _isError: boolean) {
      return { id: `t${++n}`, role: 'user', content: [{ type: 'text', text }], source: { kind: 'tool', callId } }
    },
  }
}

describe('parsePythonArguments', () => {
  it('accepts a code string', () => {
    expect(parsePythonArguments(JSON.stringify({ code: 'print(1)' }))).toBe('print(1)')
  })
  it('rejects non-JSON', () => {
    expect(() => parsePythonArguments('not json')).toThrow(/valid JSON/)
  })
  it('rejects empty code', () => {
    expect(() => parsePythonArguments(JSON.stringify({ code: '  ' }))).toThrow(/non-empty/)
  })
})

describe('formatCellResult', () => {
  it('marks empty ok output', () => {
    expect(formatCellResult(ok('')).text).toContain('empty')
    expect(formatCellResult(ok('')).isError).toBe(false)
  })
  it('reports a crash and restart', () => {
    const r = formatCellResult({ output: 'boom', outcome: 'crashed', restarted: true })
    expect(r.isError).toBe(true)
    expect(r.text).toContain('restarted')
  })
})

describe('runRlm', () => {
  it('runs a python call and terminates on a ready answer', async () => {
    let turn = 0
    const cells: string[] = []
    const deps = {
      stream: async function* () {
        turn += 1
        if (turn === 1) {
          yield chunk({ type: 'block-start', index: 0, blockType: 'tool-call' })
          yield chunk({ type: 'tool-call-delta', index: 0, id: 'c1', name: RLM_PYTHON_TOOL_NAME, argumentsDelta: JSON.stringify({ code: 'set_answer("hello", True)' }) })
          yield chunk({ type: 'block-end', index: 0, block: { type: 'tool-call', id: 'c1', name: RLM_PYTHON_TOOL_NAME, arguments: JSON.stringify({ code: 'set_answer("hello", True)' }) } })
          yield chunk({ type: 'finish', reason: { kind: 'stop' } })
          return
        }
        yield chunk({ type: 'finish', reason: { kind: 'stop' } })
      },
      execute: async (code: string): Promise<KernelExecuteResult> => {
        cells.push(code)
        if (code.trim() === 'rlm_dump()') return ok('__KILN_RLM_STATE__ {"answer":{"content":"hello","ready":true},"binds":{}}')
        return ok('answer set')
      },
      parseDump: () => ({ answer: { content: 'hello', ready: true }, binds: {} }),
      messages: fakeMessages(),
    }
    const result = await runRlm({ prompt: 'say hello', model: 'm', provider: 'p', maxSteps: 4 }, deps as unknown as RlmDeps)
    expect(result.stopReason).toBe('ready')
    expect(result.answer).toBe('hello')
    expect(cells.some(c => c.includes('set_answer'))).toBe(true)
    expect(cells.some(c => c === 'rlm_dump()')).toBe(true)
  })

  it('stops without a tool call when the model never emits one', async () => {
    const deps = {
      stream: async function* () {
        yield chunk({ type: 'finish', reason: { kind: 'stop' } })
      },
      execute: async (): Promise<KernelExecuteResult> => ok(''),
      parseDump: () => undefined,
      messages: fakeMessages(),
    }
    const result = await runRlm({ prompt: 'x', model: 'm', provider: 'p', maxSteps: 2 }, deps as unknown as RlmDeps)
    expect(result.stopReason).toBe('no-tool-call')
  })
})
