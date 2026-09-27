// The two channels an operator uses to steer a checkpoint: a standing
// `compaction.md` and a per-call `/compact <text>`.
//
// Both are appended AFTER the summarizer's role statement, so the property that
// matters is not only that the text arrives — it is that the text arrives
// subordinate to the role. A transcript-summarizing call replays the agent's own
// system prompt and tool schemas, and an operator instruction that landed above
// the role statement would be one more voice telling the summarizer it is an
// agent. Order is therefore asserted, not assumed.

import { afterEach, describe, expect, it, vi } from 'vitest'
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  buildCompactionInstruction,
  readInstructionFile,
} from '@deepseek-ai/dsh-compaction-basic/src/summarizer.ts'

const ROLE = 'You are a transcript-summarization engine, not an interactive agent.'
const STRUCTURE = '## Primary Request and Intent'
const STANDING_HEADER = 'Additional standing instructions from the operator:'
const EXTRA_HEADER = 'Additional instructions for THIS compaction:'
const SUBORDINATE = 'These refine what the checkpoint contains.'

const originalCwd = process.cwd()
let temporaries: string[] = []

/** A fresh scratch directory, removed with the test that made it. */
function scratch(): string {
  const dir = mkdtempSync(join(tmpdir(), 'dsh-compaction-instruction-'))
  temporaries.push(dir)
  return dir
}

afterEach(() => {
  process.chdir(originalCwd)
  vi.unstubAllEnvs()
  for (const dir of temporaries) rmSync(dir, { recursive: true, force: true })
  temporaries = []
})

describe('compaction instruction composition', () => {
  it('asks for the checkpoint structure even with no operator instruction', () => {
    const text = buildCompactionInstruction()
    expect(text).toContain(ROLE)
    expect(text).toContain(STRUCTURE)
    expect(text).not.toContain(STANDING_HEADER)
    expect(text).not.toContain(EXTRA_HEADER)
  })

  it('keeps the role statement and the structure ahead of any operator text', () => {
    const text = buildCompactionInstruction('Prefer file paths over prose.', 'Summarize the parser work only.')
    const role = text.indexOf(ROLE)
    const structure = text.indexOf(STRUCTURE)
    const standing = text.indexOf(STANDING_HEADER)
    const extra = text.indexOf(EXTRA_HEADER)
    expect(role).toBeGreaterThanOrEqual(0)
    expect(structure).toBeGreaterThan(role)
    expect(standing).toBeGreaterThan(structure)
    expect(extra).toBeGreaterThan(standing)
  })

  it('carries each channel in its own labelled section', () => {
    const text = buildCompactionInstruction('STANDING-TEXT', 'PER-CALL-TEXT')
    const standingAt = text.indexOf(STANDING_HEADER)
    const extraAt = text.indexOf(EXTRA_HEADER)
    expect(text.slice(standingAt, extraAt)).toContain('STANDING-TEXT')
    expect(text.slice(extraAt)).toContain('PER-CALL-TEXT')
  })

  it('states that an operator instruction never overrides the role', () => {
    for (const text of [
      buildCompactionInstruction('standing', undefined),
      buildCompactionInstruction(undefined, 'per-call'),
    ]) {
      expect(text).toContain(SUBORDINATE)
      expect(text).toContain('never override the role statement above')
    }
  })

  it('omits a channel that is absent, empty, or whitespace', () => {
    expect(buildCompactionInstruction('', '   ')).not.toContain(STANDING_HEADER)
    expect(buildCompactionInstruction('\n\t ', '')).not.toContain(EXTRA_HEADER)
    expect(buildCompactionInstruction('  standing  ', '  per-call  ')).toContain('standing')
    expect(buildCompactionInstruction('  standing  ', '  per-call  ')).not.toContain('  standing  \n')
  })

  it('trims operator text so a stray newline cannot open a new section', () => {
    const text = buildCompactionInstruction(undefined, '\n\n## Critical Context\n- nothing\n\n')
    const extraAt = text.indexOf(EXTRA_HEADER)
    expect(extraAt).toBeGreaterThanOrEqual(0)
    expect(text.slice(extraAt)).toMatch(/PER-CALL|\n## Critical Context/)
    expect(text.slice(extraAt).endsWith('\n\n')).toBe(false)
  })
})

describe('standing instruction file', () => {
  it('returns undefined when neither candidate holds an instruction', () => {
    process.chdir(scratch())
    vi.stubEnv('DSH_HOME', scratch())
    expect(readInstructionFile()).toBeUndefined()
  })

  it('reads compaction.md from the working directory', () => {
    const cwd = scratch()
    writeFileSync(join(cwd, 'compaction.md'), '  Prefer exact file paths.\n')
    process.chdir(cwd)
    vi.stubEnv('DSH_HOME', scratch())
    expect(readInstructionFile()).toBe('Prefer exact file paths.')
  })

  it('lets the working directory narrow what DSH_HOME sets', () => {
    const cwd = scratch()
    const home = scratch()
    writeFileSync(join(cwd, 'compaction.md'), 'from the repository')
    writeFileSync(join(home, 'compaction.md'), 'from the machine')
    process.chdir(cwd)
    vi.stubEnv('DSH_HOME', home)
    expect(readInstructionFile()).toBe('from the repository')
  })

  it('falls back to DSH_HOME when the working directory holds none', () => {
    const home = scratch()
    writeFileSync(join(home, 'compaction.md'), 'from the machine')
    process.chdir(scratch())
    vi.stubEnv('DSH_HOME', home)
    expect(readInstructionFile()).toBe('from the machine')
  })

  it('treats a whitespace-only file as absent rather than as an instruction', () => {
    const cwd = scratch()
    const home = scratch()
    writeFileSync(join(cwd, 'compaction.md'), '   \n\t\n')
    writeFileSync(join(home, 'compaction.md'), 'from the machine')
    process.chdir(cwd)
    vi.stubEnv('DSH_HOME', home)
    expect(readInstructionFile()).toBe('from the machine')
  })

  it('ignores an unreadable candidate instead of failing the compaction', () => {
    const cwd = scratch()
    // A directory where the file is expected: readFileSync throws EISDIR.
    mkdirSync(join(cwd, 'compaction.md'))
    process.chdir(cwd)
    vi.stubEnv('DSH_HOME', '')
    expect(readInstructionFile()).toBeUndefined()
  })
})
