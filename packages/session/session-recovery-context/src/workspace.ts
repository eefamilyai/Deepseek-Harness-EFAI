/**
 * Workspace facts the handoff re-attaches: a `git status` snapshot and the
 * current contents of the files the session changed most recently.
 *
 * Both are read at handoff time rather than folded, because they describe the
 * disk now, not the log. Both are best-effort and bounded: a failure yields
 * nothing rather than failing the step, and every read has a size or time cap.
 * @module @deepseek-ai/dsh-session-recovery-context/workspace
 */

import { execFile } from 'node:child_process'
import { readFile, stat } from 'node:fs/promises'
import { isAbsolute, join } from 'node:path'
import type { Ledger } from './ledger.ts'
import type { RehydratedFile } from './handoff.ts'

/** How long the git snapshot may take before it is abandoned. */
const GIT_TIMEOUT_MS = 3000

/** Changed paths listed before the snapshot is cut. */
const GIT_MAX_PATHS = 30

/**
 * A short `git status` for the working directory, or `''` outside a repository.
 * @param cwd - the session's working directory.
 * @returns the branch line and up to {@link GIT_MAX_PATHS} changed paths.
 */
export function gitSnapshot(cwd: string): Promise<string> {
  return new Promise((resolve) => {
    execFile('git', ['status', '--porcelain=v1', '--branch', '--untracked-files=normal'], {
      cwd,
      timeout: GIT_TIMEOUT_MS,
      windowsHide: true,
      maxBuffer: 1024 * 1024,
    }, (error, stdout) => {
      if (error !== null) {
        resolve('')
        return
      }
      const lines = stdout.split('\n').map(line => line.trimEnd()).filter(line => line.length > 0)
      const [branch, ...paths] = lines
      const shown = paths.slice(0, GIT_MAX_PATHS)
      const more = paths.length - shown.length
      resolve([branch ?? '', ...shown, ...more > 0 ? [`… ${more} more changed path(s)`] : []].join('\n').trim())
    })
  })
}

/** Limits on the file contents re-attached to one handoff. */
export interface RehydrateLimits {
  /** Files re-attached at most. */
  files: number
  /** Characters kept per file. */
  perFileChars: number
  /** Largest file read at all, in bytes; bigger files are skipped. */
  maxBytes: number
}

/** The limits used when a deployment states none. */
export const DEFAULT_REHYDRATE_LIMITS: RehydrateLimits = {
  files: 4,
  perFileChars: 8000,
  maxBytes: 512 * 1024,
}

/** Whether a buffer looks like text rather than binary. */
function looksTextual(buffer: Buffer): boolean {
  const sample = buffer.subarray(0, Math.min(buffer.length, 4096))
  return !sample.includes(0)
}

/**
 * Read the most recently changed files, newest first.
 *
 * Only files the session created or edited qualify: those are the ones the next
 * step is most likely to touch again, and the ones a summary describes least
 * precisely. A file that vanished, is binary, or is too large is skipped.
 * @param ledger - the folded ledger.
 * @param cwd - the directory a relative path resolves against.
 * @param limits - how much to re-attach.
 * @returns the files' current contents, newest first.
 */
export async function rehydrateFiles(
  ledger: Ledger,
  cwd: string,
  limits: RehydrateLimits = DEFAULT_REHYDRATE_LIMITS,
): Promise<RehydratedFile[]> {
  const candidates = [...ledger.files].reverse().filter(file => file.created || file.edited)
  const out: RehydratedFile[] = []
  for (const file of candidates) {
    if (out.length >= limits.files) break
    const path = isAbsolute(file.path) ? file.path : join(cwd, file.path)
    try {
      const info = await stat(path)
      if (!info.isFile() || info.size > limits.maxBytes) continue
      const buffer = await readFile(path)
      if (!looksTextual(buffer)) continue
      const text = buffer.toString('utf8')
      out.push(text.length > limits.perFileChars
        ? { path: file.path, text: text.slice(0, limits.perFileChars), totalChars: text.length }
        : { path: file.path, text })
    } catch {
      // Gone, unreadable, or not local: the file list still names it.
    }
  }
  return out
}
