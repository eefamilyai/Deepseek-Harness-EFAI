/**
 * The markdown record a compaction leaves behind, and the name it is written
 * under.
 *
 * Compaction keeps a summary and drops the transcript. The transcript it drops
 * is the only place the operator's own words and the run of recent events exist
 * in full, so this module turns the folded projection back into one document:
 * the summary, every turn-starting operator prompt, and the event window since
 * the newest of those prompts.
 *
 * Rendering is pure and total. Selecting the event window is the only decision
 * it makes, and that decision is stated once in
 * {@link selectCompactionEvents} rather than smeared across the renderer.
 * @module @deepseek-ai/dsh-session-recovery-context/compaction-log
 */

import type { SessionId } from '@deepseek-ai/dsh-session'

/** Filename prefix for every compaction log this plugin writes. */
export const COMPACTION_LOG_PREFIX = 'compaction-'

/**
 * Events the record carries when the window since the last prompt is longer.
 *
 * The cap bounds one document, not the whole session: a long run between two
 * prompts would otherwise put every tool result of that run into the record.
 */
export const DEFAULT_COMPACTION_EVENTS = 100

/** One operator prompt as the record renders it. */
export interface CompactionLogPrompt {
  /** Sequence number of the `user/message` event. */
  seq: number
  /** The operator's text. */
  text: string
}

/** One event as the record renders it. */
export interface CompactionLogEvent {
  /** Sequence number of the committed event. */
  seq: number
  /** The event type. */
  type: string
  /** A short human-readable label for the payload, or `''`. */
  label: string
}

/** Everything one compaction record needs to render. */
export interface CompactionLogInput {
  /** The compaction this record answers. */
  compactionId: string
  /** The session the record belongs to. */
  sessionId: SessionId
  /** The summary the compaction wrote, already flattened to text. */
  summary: string
  /** Every turn-starting operator prompt, oldest first. */
  prompts: readonly CompactionLogPrompt[]
  /** The folded event tail, oldest first. */
  events: readonly CompactionLogEvent[]
  /** Event cap; defaults to {@link DEFAULT_COMPACTION_EVENTS}. */
  eventLimit?: number
}

/**
 * The filename one compaction's record is written under.
 * @param compactionId - the compaction id.
 * @param sessionId - the session id.
 * @returns the file's basename, without a directory.
 */
export function compactionLogFilename(compactionId: string, sessionId: SessionId): string {
  return `${COMPACTION_LOG_PREFIX}${compactionId}-${sessionId}.md`
}

/**
 * The event window the record carries: everything after the newest
 * turn-starting prompt, capped to its newest `limit` members.
 *
 * The window starts at the newest prompt because that prompt restates the task;
 * what came before it is the previous turn's work, which the summary already
 * covers. The cap then trims the window's oldest end, so a long run keeps the
 * events nearest the decision point rather than the ones that opened it.
 * @param events - the folded event tail, oldest first.
 * @param prompts - the turn-starting prompts, oldest first.
 * @param limit - the maximum number of events to keep.
 * @returns the selected events, oldest first.
 */
export function selectCompactionEvents(
  events: readonly CompactionLogEvent[],
  prompts: readonly CompactionLogPrompt[],
  limit: number = DEFAULT_COMPACTION_EVENTS,
): CompactionLogEvent[] {
  const last = prompts.length === 0 ? undefined : prompts[prompts.length - 1]
  const after = last === undefined ? events : events.filter(event => event.seq > last.seq)
  if (limit <= 0 || after.length <= limit) return [...after]
  return after.slice(after.length - limit)
}

/** Render one prompt list, or a placeholder when the session has none. */
function renderPrompts(prompts: readonly CompactionLogPrompt[]): string {
  if (prompts.length === 0) return '_No operator prompt was recorded before this compaction._'
  return prompts
    .map((prompt, index) => `### ${index + 1}. prompt (seq ${prompt.seq})\n\n${prompt.text}`)
    .join('\n\n')
}

/** Render one event list, or a placeholder when the window is empty. */
function renderEvents(events: readonly CompactionLogEvent[]): string {
  if (events.length === 0) return '_No event was recorded after the newest operator prompt._'
  return events
    .map((event) => {
      const label = event.label.length === 0 ? '' : `: ${event.label}`
      return `- \`${event.seq}\` **${event.type}**${label}`
    })
    .join('\n')
}

/**
 * Render the whole record as markdown.
 *
 * The order is the order the reader needs it in: what the compaction decided,
 * what the operator asked for, and what happened since. The summary leads
 * because it is the only part a model can act on without reading the rest.
 * @param input - the compaction, the prompts, and the event window.
 * @returns the markdown document.
 */
export function renderCompactionLog(input: CompactionLogInput): string {
  const summary = input.summary.trim().length === 0
    ? '_The compaction recorded no summary text._'
    : input.summary.trim()
  const events = selectCompactionEvents(input.events, input.prompts, input.eventLimit)
  return [
    '# Compaction record',
    '',
    `- Session: \`${input.sessionId}\``,
    `- Compaction: \`${input.compactionId}\``,
    `- Operator prompts: ${input.prompts.length}`,
    `- Events in window: ${events.length}`,
    '',
    '## Summary',
    '',
    summary,
    '',
    '## Operator prompts',
    '',
    'Every prompt that started a turn in this session, oldest first.',
    '',
    renderPrompts(input.prompts),
    '',
    '## Events since the newest prompt',
    '',
    'The tail of this session\'s log, oldest first.',
    '',
    renderEvents(events),
    '',
  ].join('\n')
}
