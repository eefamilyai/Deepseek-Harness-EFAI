/**
 * Runtime-location facts the kernel provider cannot get wrong.
 *
 * An installed Desktop packs the Kiln runtime inside `app.asar`. Electron's own
 * `fs` lists those files, the spawned interpreter does not: it answers
 * `can't open file … app.asar …: [Errno 2]` and exits before the ready frame,
 * so every cell was reported as "Kernel crashed mid-run" — including a cell that
 * only printed `alive`. These pin the two halves of the repair: never resolve a
 * runtime inside an archive, and refuse that launch at load instead of starting
 * a child that dies.
 */
import { join, sep } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { Config, apply, defaultRuntimeDir, outsideAsar } from '../src/index.ts'

/** The runtime as an installed Desktop's package directory would name it. */
const ARCHIVE = ['opt', 'app.asar', 'dsh', 'node_modules', 'pkg', 'kiln'].join(sep)
/** The copy an unpacking build places beside the archive. */
const UNPACKED = ['opt', 'app.asar.unpacked', 'dsh', 'node_modules', 'pkg', 'kiln'].join(sep)

describe('outsideAsar', () => {
  it('maps a path inside an archive to its unpacked sibling', () => {
    expect(outsideAsar(ARCHIVE)).toBe(UNPACKED)
  })

  it('leaves a path with no archive alone', () => {
    const real = join('repo', 'python', 'kiln', 'runtime')
    expect(outsideAsar(real)).toBe(real)
  })

  it('does not mistake the unpacked sibling for an archive', () => {
    expect(outsideAsar(UNPACKED)).toBe(UNPACKED)
  })
})

describe('defaultRuntimeDir', () => {
  it('never resolves to a directory inside an archive', () => {
    const resolved = defaultRuntimeDir()
    expect(outsideAsar(resolved)).toBe(resolved)
  })
})

describe('apply', () => {
  it('refuses a runtime the kernel process cannot open', async () => {
    // The refusal precedes registration, so the context needs no kernel service.
    await expect(apply(new Context(), Config({ runtimeDir: ARCHIVE })))
      .rejects.toThrow(/inside an asar archive/)
  })
})
