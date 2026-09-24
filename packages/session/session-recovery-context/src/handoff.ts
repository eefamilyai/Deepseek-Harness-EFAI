/**
 * The handoff: the one message a compacted session receives so the model knows
 * where it is and what to do next, rendered from the ledger and the checkpoint.
 *
 * It is written for a reader that has just lost its working memory, in the
 * order that reader needs it: what it was asked, what state the work is in,
 * what the files look like now, where the full record lives, and — last,
 * closest to the next generation — exactly where to continue. It deliberately
 * does NOT restate the checkpoint summary: that is already in the history, one
 * message up, and a second copy only competes with it.
 *
 * Rendering is pure and budgeted. Sections are filled in priority order and the
 * low-priority ones (file contents, long lists) give way first, so a small
 * context window loses detail rather than the facts that must survive.
 * @module @deepseek-ai/dsh-session-recovery-context/handoff
 */

import { clip } from './ledger.ts'
import type { Ledger, LedgerFile } from './ledger.ts'

/** One file's current contents, re-attached after a compaction. */
export interface RehydratedFile {
  path: string
  text: string
  /** The file's full length when `text` is a cut. */
  totalChars?: number
}

/** Everything the handoff renders from. */
export interface HandoffInput {
  ledger: Ledger
  /** A rendered `git status` snapshot, when the workspace is a repository. */
  git?: string
  /** Current contents of the most recently edited files, newest first. */
  files?: readonly RehydratedFile[]
  /** The plain-text record this compaction wrote. */
  recordPath?: string
  /** The session's durable event log. */
  logPath?: string
  /** Character budget for the whole message. */
  budgetChars: number
}

/** The opening lines: what this message is and how to treat it. */
export const HANDOFF_PREAMBLE = [
  '# Handoff after context compaction',
  '',
  'The earlier part of this session was condensed into the checkpoint above to free up context.',
  'This message restates, from the session record itself, what you were asked and the exact state of the work.',
  'You are continuing work already in progress: do not acknowledge this message and do not recap it.',
  'Pick up at "Continue from here" at the end, and read the full record if you need an exact detail it does not carry.',
].join('\n')

/**
 * The bullets under one `## Heading` of a Markdown checkpoint.
 * @param summary - the checkpoint text.
 * @param heading - the heading to find, case-insensitive, without the hashes.
 * @returns the section body, trimmed, or `''` when absent or empty.
 */
export function extractSection(summary: string, heading: string): string {
  const lines = summary.split('\n')
  const wanted = heading.trim().toLowerCase()
  const start = lines.findIndex(line => /^#{1,6}\s/.test(line) && line.replace(/^#{1,6}\s+/, '').trim().toLowerCase() === wanted)
  if (start < 0) return ''
  const body: string[] = []
  for (const line of lines.slice(start + 1)) {
    if (/^#{1,6}\s/.test(line)) break
    body.push(line)
  }
  const text = body.join('\n').trim()
  return text === '(none)' || text === '- (none)' ? '' : text
}

/**
 * A code fence longer than any backtick run in the text, so a fenced file or
 * error that itself contains a fence (a Markdown file, a doc test) cannot close
 * the block early and spill into the handoff's own structure.
 * @param text - the text to fence.
 * @returns the fence.
 */
export function fenceFor(text: string): string {
  let longest = 0
  for (const run of text.match(/`+/g) ?? []) longest = Math.max(longest, run.length)
  return '`'.repeat(Math.max(3, longest + 1))
}

/** Render the operator's messages, oldest first, verbatim within the ledger's bound. */
function renderPrompts(ledger: Ledger, budget: number): string {
  if (ledger.prompts.length === 0) return ''
  const rendered = ledger.prompts.map((prompt, index) => {
    const label = index === 0 ? 'first request' : prompt.steering ? 'correction mid-turn' : 'request'
    return `### ${index + 1}. ${label} (seq ${prompt.seq})\n\n${prompt.text}`
  })
  // Keep the first request and as many of the newest as fit; the middle yields.
  const first = rendered[0] as string
  const kept: string[] = []
  let used = first.length
  let dropped = ledger.droppedPrompts
  for (let index = rendered.length - 1; index >= 1; index -= 1) {
    const entry = rendered[index] as string
    if (used + entry.length + 2 > budget) {
      dropped += index
      break
    }
    kept.unshift(entry)
    used += entry.length + 2
  }
  const note = dropped > 0 ? [`_${dropped} earlier message(s) are omitted here; they are in the record below._`] : []
  return ['## Your requests (verbatim, oldest first)', '', first, ...note, ...kept].join('\n\n')
}

/** Render the todo list as it stood at compaction. */
function renderTodos(ledger: Ledger): string {
  if (ledger.todos.length === 0) return ''
  const mark = (status: string): string => status === 'completed' ? '[x]' : status === 'in_progress' ? '[~]' : '[ ]'
  return ['### Todo list', '', ...ledger.todos.map(todo => `- ${mark(todo.status)} ${todo.content}`)].join('\n')
}

/** Render one file line: its path and what happened to it. */
function fileLine(file: LedgerFile): string {
  const actions = [
    file.created ? 'created' : '',
    file.edited ? 'edited' : '',
    file.reads > 0 ? `read ×${file.reads}` : '',
  ].filter(action => action.length > 0)
  return `- \`${file.path}\` — ${actions.join(', ')}`
}

/** Render the files touched, newest first, changed files ahead of read-only ones. */
function renderFiles(ledger: Ledger, limit: number): string {
  if (ledger.files.length === 0) return ''
  const newest = [...ledger.files].reverse()
  const changed = newest.filter(file => file.created || file.edited)
  const readOnly = newest.filter(file => !file.created && !file.edited)
  const listed = [...changed, ...readOnly].slice(0, limit)
  const more = ledger.files.length - listed.length
  return [
    '### Files touched (newest first)',
    '',
    ...listed.map(fileLine),
    ...more > 0 ? [`- …and ${more} more, listed in the record`] : [],
  ].join('\n')
}

/** Render failures that no later call resolved. */
function renderErrors(ledger: Ledger): string {
  if (ledger.errors.length === 0) return ''
  return [
    '### Unresolved errors (newest last)',
    '',
    ...ledger.errors.map((error) => {
      const where = error.target.length > 0 ? ` \`${error.target}\`` : ''
      const fence = fenceFor(error.text)
      return `- **${error.tool}**${where} (seq ${error.seq}):\n\n  ${fence}\n  ${error.text.replace(/\n/g, '\n  ')}\n  ${fence}`
    }),
  ].join('\n')
}

/** Render the most recent shell commands and kernel cells with their outcome. */
function renderCommands(ledger: Ledger, limit: number): string {
  if (ledger.commands.length === 0) return ''
  const recent = ledger.commands.slice(-limit)
  return [
    '### Recent commands (newest last)',
    '',
    ...recent.map(command => `- ${command.ok ? '✓' : '✗'} ${command.tool}: \`${command.text.replace(/`/g, "'")}\``),
  ].join('\n')
}

/** Render re-attached file contents within a budget. */
function renderRehydrated(files: readonly RehydratedFile[], budget: number): string {
  const parts: string[] = []
  let used = 0
  for (const file of files) {
    const cut = file.totalChars !== undefined && file.totalChars > file.text.length
      ? `\n… (${file.totalChars - file.text.length} more characters; read the file for the rest)`
      : ''
    const fence = fenceFor(file.text)
    const block = `### \`${file.path}\`\n\n${fence}\n${file.text}${cut}\n${fence}`
    if (used + block.length > budget) {
      const room = budget - used - 200
      if (room < 800) break
      parts.push(`### \`${file.path}\`\n\n${fence}\n${clip(file.text, room)}\n… (cut to fit; read the file for the rest)\n${fence}`)
      break
    }
    parts.push(block)
    used += block.length
  }
  if (parts.length === 0) return ''
  return ['## Recently changed files (current contents)', '', ...parts].join('\n\n')
}

/** Render where the complete record lives. */
function renderPointers(input: HandoffInput): string {
  // The writer names a compressed log `.zstd`, so the suffix says how to read it.
  const format = input.logPath?.endsWith('.zstd') === true ? 'zstd-compressed JSONL' : 'JSONL'
  const lines = [
    input.recordPath === undefined ? '' : `- This handoff and the checkpoint, as plain text: \`${input.recordPath}\``,
    input.logPath === undefined ? '' : `- The complete session log (${format}, one event per line): \`${input.logPath}\``,
  ].filter(line => line.length > 0)
  if (lines.length === 0) return ''
  return ['## Full record', '', ...lines].join('\n')
}

/**
 * Render the closing section: the exact position to resume from.
 * @param ledger - the folded ledger, whose latest checkpoint names the next step.
 * @returns the section, or `''` when there is nothing to say.
 */
export function renderContinue(ledger: Ledger): string {
  const summary = ledger.compaction?.summary ?? ''
  const current = extractSection(summary, 'Current Work')
  const next = extractSection(summary, 'Next Step')
  const inProgress = ledger.todos.filter(todo => todo.status === 'in_progress').map(todo => todo.content)
  const latest = ledger.prompts.at(-1)
  const lines = [
    current.length > 0 ? `**In progress when the context was compacted:**\n${current}` : '',
    inProgress.length > 0 ? `**Todo in progress:** ${inProgress.join('; ')}` : '',
    next.length > 0 ? `**Next step:**\n${next}` : '',
    latest === undefined ? '' : `**Most recent request (seq ${latest.seq}):** ${clip(latest.text.replace(/\s+/g, ' '), 400)}`,
  ].filter(line => line.length > 0)
  if (lines.length === 0) return ''
  return ['## Continue from here', '', ...lines].join('\n\n')
}

/**
 * Render the handoff within its budget.
 *
 * Priority, highest first: the preamble and the closing section, the operator's
 * requests, the todo list and unresolved errors, the file and command lists,
 * the git snapshot, the pointers, and finally the re-attached file contents,
 * which take only what is left.
 * @param input - the ledger, the workspace facts, and the budget.
 * @returns the handoff text.
 */
export function renderHandoff(input: HandoffInput): string {
  const { ledger, budgetChars } = input
  const continueSection = renderContinue(ledger)
  const todos = renderTodos(ledger)
  const errors = renderErrors(ledger)
  const pointers = renderPointers(input)
  const git = input.git === undefined || input.git.length === 0 ? '' : `### Git\n\n\`\`\`\n${input.git}\n\`\`\``

  const fixed = [HANDOFF_PREAMBLE, continueSection, todos, errors, pointers]
    .reduce((sum, part) => sum + part.length + 2, 0)
  // Requests get up to 40% of what the fixed parts leave; lists up to 25%.
  const flexible = Math.max(0, budgetChars - fixed)
  const prompts = renderPrompts(ledger, Math.max(1200, Math.floor(flexible * 0.4)))
  let files = renderFiles(ledger, 40)
  let commands = renderCommands(ledger, 10)
  let gitSection = git
  const listsBudget = Math.floor(flexible * 0.25)
  if (files.length + commands.length + gitSection.length > listsBudget) files = renderFiles(ledger, 15)
  if (files.length + commands.length + gitSection.length > listsBudget) commands = renderCommands(ledger, 5)
  if (files.length + commands.length + gitSection.length > listsBudget) {
    gitSection = clip(gitSection, Math.max(0, listsBudget - files.length - commands.length))
  }

  const state = [todos, errors, files, commands, gitSection].filter(part => part.length > 0)
  const stateSection = state.length === 0 ? '' : ['## State when the context was compacted', '', ...state].join('\n\n')
  const head = [HANDOFF_PREAMBLE, prompts, stateSection].filter(part => part.length > 0).join('\n\n')
  const tail = [pointers, continueSection].filter(part => part.length > 0).join('\n\n')
  const room = budgetChars - head.length - tail.length - 4
  const rehydrated = renderRehydrated(input.files ?? [], room)
  return [head, rehydrated, tail].filter(part => part.length > 0).join('\n\n')
}

/**
 * The per-turn focus line re-anchored after a compaction: the plan pushed back
 * into the model's most recent attention, the way an agent that rewrites its
 * own todo file keeps the goal in view.
 * @param ledger - the folded ledger.
 * @returns the focus text, or `''` before any compaction.
 */
export function renderFocus(ledger: Ledger): string {
  if (ledger.compactions === 0) return ''
  const next = extractSection(ledger.compaction?.summary ?? '', 'Next Step')
  const inProgress = ledger.todos.find(todo => todo.status === 'in_progress')
  const open = ledger.todos.filter(todo => todo.status !== 'completed').length
  const parts = [
    inProgress === undefined ? '' : `in progress: ${inProgress.content}`,
    open > 0 ? `${open} todo(s) open` : '',
    next.length > 0 ? `next step at the last compaction: ${clip(next.replace(/\s+/g, ' ').replace(/^- /, ''), 300)}` : '',
  ].filter(part => part.length > 0)
  if (parts.length === 0) return ''
  return `Focus (this session was compacted; the handoff message has the full state): ${parts.join(' · ')}`
}
