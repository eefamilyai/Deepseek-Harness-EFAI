/**
 * Where the JSONL backend put this session's log, stated without reaching into
 * that backend's internals.
 *
 * The two pieces that encode FORMAT policy are imported rather than copied:
 * `SESSION_FORMAT_VERSION` and `sessionFormatLogFilename` are public API, so the
 * generation this names is always the generation the writer appends to.
 *
 * What is mirrored here is the backend's path SANITIZATION — the project key, the
 * segment escape, and the compression suffix — which
 * `@deepseek-ai/dsh-session-persistence-jsonl` keeps module-private behind a
 * `files` list that publishes only `lib/`. Importing it through that package's
 * `./src/*` entry works in this repo and breaks in an installed copy, which is
 * the worst of the available failures: green here, missing there.
 *
 * Mirroring is safe only because it is pinned. `tests/log-path-oracle.spec.ts`
 * asserts this module byte-for-byte against the real `logPath` across drive
 * letters, UNC and POSIX roots, unicode, traversal attempts, and both
 * compressions, so a change to the backend's encoding fails a test here instead
 * of printing a path that does not exist.
 *
 * EXIT: `@deepseek-ai/dsh-session-persistence-jsonl` exports `logPath`, or
 * `SessionPersistence` answers with the `SessionLocation` it already models for
 * errors. Either one deletes this file and its oracle.
 *
 * @module @deepseek-ai/dsh-session-recovery-context/log-path
 */

import { join } from 'node:path'
import { SESSION_FORMAT_VERSION } from '@deepseek-ai/dsh-session'
import type { SessionId } from '@deepseek-ai/dsh-session'
import { sessionFormatLogFilename } from '@deepseek-ai/dsh-session-format'

/** Physical encoding selected for JSONL session artifacts, as the backend names it. */
export type LogCompression = 'zstd' | 'none'

/** Code units a path component keeps verbatim; everything else is escaped. */
const SAFE_UNIT = /^[A-Za-z0-9._-]$/

/** The project-key length bound, leaving room for the surrounding `--` pair. */
const PROJECT_KEY_LIMIT = 251

/**
 * Escape one string into a single safe path segment.
 *
 * A {@link SessionId} is an unvalidated branded string, so it cannot be spliced
 * into a path unescaped — no traversal, no collision. `.` and `..` are escaped
 * whole because a partially escaped dot pair is still a traversal.
 * @param raw - the segment to encode; empty input has no valid encoding.
 * @returns the encoded segment.
 * @throws when `raw` is empty.
 */
export function encodeSegment(raw: string): string {
  if (raw.length === 0) throw new Error('cannot encode an empty path segment')
  if (raw === '.') return '~002E'
  if (raw === '..') return '~002E~002E'
  let out = ''
  for (let index = 0; index < raw.length; index += 1) {
    const code = raw.charCodeAt(index)
    const unit = String.fromCharCode(code)
    out += unit !== '~' && SAFE_UNIT.test(unit) ? unit : escapeUnit(code)
  }
  return out
}

/** One code unit as the backend's `~XXXX` escape. */
function escapeUnit(code: number): string {
  return `~${code.toString(16).toUpperCase().padStart(4, '0')}`
}

/**
 * The readable directory key for a project path.
 *
 * Separator and drive-separator runs collapse to one `-`, unsafe units take the
 * segment escape, and the result is bounded for filesystem component limits.
 * Both the collapse and the truncation are lossy on purpose: this key exists to
 * be navigable by a human reading `~/.dsh/sessions`, not to be reversible.
 * @param cwd - the session's project directory.
 * @returns one filesystem-safe project directory name.
 * @throws when `cwd` is empty.
 */
export function projectKey(cwd: string): string {
  if (cwd.length === 0) throw new Error('cannot encode an empty project path')
  let readable = ''
  let separatorRun = false
  for (let index = 0; index < cwd.length; index += 1) {
    const code = cwd.charCodeAt(index)
    const unit = String.fromCharCode(code)
    if (unit === '/' || unit === '\\' || unit === ':') {
      if (!separatorRun) readable += '-'
      separatorRun = true
      continue
    }
    readable += unit !== '~' && SAFE_UNIT.test(unit) ? unit : escapeUnit(code)
    separatorRun = false
  }
  const slug = readable.replace(/^-+/, '') || 'root'
  return `--${slug.slice(0, PROJECT_KEY_LIMIT)}--`
}

/**
 * The project directory one session's artifacts live under.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory; `undefined` selects `_no-cwd`.
 * @returns the project directory path beneath `root`.
 */
export function projectDir(root: string, cwd: string | undefined): string {
  return cwd === undefined ? join(root, '_no-cwd') : join(root, projectKey(cwd))
}

/**
 * The directory one session owns.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory.
 * @param id - the session id, escaped to one path segment.
 * @returns the session directory beneath its project directory.
 */
export function sessionDir(root: string, cwd: string | undefined, id: SessionId): string {
  return join(projectDir(root, cwd), encodeSegment(id))
}

/**
 * The current generation's log file for one session — the path the writer is
 * appending to right now.
 * @param root - the backend's session root directory.
 * @param cwd - the session's project directory.
 * @param id - the session id.
 * @param compression - the backend's configured artifact encoding.
 * @returns the absolute log path.
 */
export function sessionLogPath(
  root: string,
  cwd: string | undefined,
  id: SessionId,
  compression: LogCompression,
): string {
  const suffix = compression === 'zstd' ? '.zstd' : ''
  return join(sessionDir(root, cwd, id), `${sessionFormatLogFilename(SESSION_FORMAT_VERSION)}${suffix}`)
}
