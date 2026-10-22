/**
 * The page-inspection builders behind `eval` and `console`.
 *
 * These scripts run in a page the harness does not control, so the two things
 * that can be checked without a browser are checked here: that each builder
 * emits syntactically valid JavaScript, and that the code the model sent is
 * embedded as data rather than pasted into the script's own source.
 */

import { describe, expect, it } from 'vitest'
import {
  evalScript, formatConsoleRead, formatEvalResult, installConsoleScript, readConsoleScript,
} from '../src/inspect.ts'
import type { ConsoleRead } from '../src/inspect.ts'

/** Compile one builder's output the way a page would, without running it. */
function compiles(script: string): boolean {
  try {
    // The builders emit expressions, so they are compilable in return position.
    new Function(`return ${script}`)
    return true
  } catch {
    return false
  }
}

describe('inspect scripts', () => {
  it('emits compilable JavaScript for every builder', () => {
    expect(compiles(installConsoleScript())).toBe(true)
    expect(compiles(readConsoleScript())).toBe(true)
    expect(compiles(evalScript('1 + 1'))).toBe(true)
  })

  it('embeds model code as a JSON literal, not as source', () => {
    // A script that would break out of a naive template interpolation must
    // survive as data: the quote and the backtick stay inside the literal.
    const hostile = '"); throw new Error("escaped"); //'
    const script = evalScript(hostile)
    expect(script).toContain(JSON.stringify(hostile))
    expect(compiles(script)).toBe(true)
  })

  it('installs the recorder idempotently and reads through a cursor', () => {
    const install = installConsoleScript()
    expect(install).toContain('__dshConsole')
    // Re-installing must not reset a buffer that already holds evidence.
    expect(install).toContain('return true')
    expect(readConsoleScript()).toContain('cursor')
  })
})

describe('formatEvalResult', () => {
  it('prints a returned value under RESULT', () => {
    expect(formatEvalResult({ ok: true, value: '{"triangles":12}' })).toBe('RESULT:\n{"triangles":12}')
  })

  it('prints a thrown error under SCRIPT ERROR', () => {
    expect(formatEvalResult({ ok: false, error: 'TypeError: x is undefined' }))
      .toBe('SCRIPT ERROR: TypeError: x is undefined')
  })

  it('names a missing error message rather than printing an empty line', () => {
    expect(formatEvalResult({ ok: false })).toContain('the page threw without a message')
  })
})

describe('formatConsoleRead', () => {
  const read = (value: Partial<ConsoleRead>): ConsoleRead => ({ recording: true, entries: [], dropped: 0, ...value })

  it('separates "nothing recorded yet" from "nothing new"', () => {
    expect(formatConsoleRead(read({ recording: false }))).toContain('no recorder is installed')
    expect(formatConsoleRead(read({}))).toBe('CONSOLE: no new messages.')
  })

  it('lists each message with its level and location', () => {
    const text = formatConsoleRead(read({
      entries: [
        { level: 'error', text: 'boom', at: 0, where: 'app.js:3:9' },
        { level: 'uncaught', text: 'TypeError: nope', at: 1 },
      ],
    }))
    expect(text).toContain('[error] boom (app.js:3:9)')
    expect(text).toContain('[uncaught] TypeError: nope')
    expect(text).toContain('(2 new)')
  })

  it('reports dropped entries so silence is never mistaken for calm', () => {
    const text = formatConsoleRead(read({ dropped: 7 }))
    expect(text).toContain('7 older entries were dropped')
  })
})
