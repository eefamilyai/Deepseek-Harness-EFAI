/**
 * The oracle that licenses the mirrored path derivation in `src/log-path.ts`.
 *
 * That module restates the JSONL backend's path sanitization because the backend
 * keeps it module-private behind a `files` list that publishes only `lib/`. A
 * restatement is only safe while something proves it still agrees, so every case
 * below compares it against the real `logPath` — imported here through the
 * backend's `./src/*` entry, which is sound in a test and unsound in shipped
 * code. When the backend changes its encoding, this file fails and the printed
 * path is corrected; nothing else in the harness notices, which is exactly the
 * failure mode that made this pinning necessary.
 */

import { describe, expect, it } from 'vitest'
import { SessionId } from '@deepseek-ai/dsh-session'
import { logPath, projectKey as backendProjectKey } from '@deepseek-ai/dsh-session-persistence-jsonl/src/format.ts'
import { projectKey, sessionLogPath } from '@deepseek-ai/dsh-session-recovery-context'
import type { LogCompression } from '@deepseek-ai/dsh-session-recovery-context'

const ROOTS = ['C:\\Users\\op\\.dsh\\sessions', '/home/op/.dsh/sessions']

const CWDS: readonly (string | undefined)[] = [
  undefined,
  'D:\\deepseek-kernel-harness',
  'C:/mixed/slashes\\both',
  '/home/op/work/repo',
  '\\\\server\\share\\project',
  'C:\\Users\\Ünïcødé\\工作',
  'relative/path',
  'C:\\',
  '/',
  // Long enough to cross the project-key length bound.
  `/home/op/${'segment/'.repeat(60)}end`,
  // Characters the escape has to reach: space, tilde, quote, percent.
  'C:\\Program Files (x86)\\a~b\'c%d',
]

const IDS = [
  '0199c5c2-3f5a-7c21-9f88-2b6f4d0e1a77',
  'kiln-kernel-1',
  '..',
  '.',
  'has space and ~tilde',
  'ünïcødé-id',
]

const COMPRESSIONS: readonly LogCompression[] = ['zstd', 'none']

describe('mirrored log-path derivation', () => {
  it('agrees with the backend on every root, cwd, id, and encoding', () => {
    for (const root of ROOTS) {
      for (const cwd of CWDS) {
        for (const id of IDS) {
          for (const compression of COMPRESSIONS) {
            expect(sessionLogPath(root, cwd, SessionId(id), compression))
              .toBe(logPath(root, cwd, SessionId(id), compression))
          }
        }
      }
    }
  })

  it('agrees on the project key itself, including its bound and its escapes', () => {
    for (const cwd of CWDS) {
      if (cwd === undefined) continue
      expect(projectKey(cwd)).toBe(backendProjectKey(cwd))
    }
  })

  it('refuses the inputs the backend refuses', () => {
    expect(() => projectKey('')).toThrow(/empty project path/)
    expect(() => backendProjectKey('')).toThrow(/empty project path/)
    expect(() => sessionLogPath(ROOTS[0] as string, 'C:\\x', SessionId(''), 'zstd')).toThrow(/empty path segment/)
  })
})
