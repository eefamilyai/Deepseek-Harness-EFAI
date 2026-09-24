/**
 * The ledger, the handoff it renders, and the step that carries it.
 *
 * Four properties are worth pinning because a reader cannot check them by
 * inspection: the ledger records exactly the facts a summary drops (requests,
 * files, commands, errors, todos); the handoff keeps those facts when its
 * budget is small; the handoff rides the SAME step as the compaction, so a turn
 * compacted mid-run keeps running; and the operator's own message is never
 * held back behind it.
 * @module @deepseek-ai/dsh-session-recovery-context/tests
 */

import { mkdtemp, readFile, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import LlmRuntime, { ToolCallId, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { Message, UserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime, { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as recovery from '@deepseek-ai/dsh-session-recovery-context'
import {
  HANDOFF_PREAMBLE,
  HANDOFF_SOURCE_KIND,
  LEDGER_PROJECTION,
  compactionRecordFilename,
  emptyLedger,
  extractSection,
  fenceFor,
  foldLedger,
  handoffBudget,
  renderFocus,
  renderHandoff,
  resultSucceeded,
  sessionDir,
} from '@deepseek-ai/dsh-session-recovery-context'
import type { Config, Ledger } from '@deepseek-ai/dsh-session-recovery-context'
import { MockAdapter, textResponse, toolCallResponse } from '../../../core/agent-loop/tests/mock-adapter.ts'

const SIGNAL = new AbortController().signal

/** A checkpoint in the structure upstream's summarizer writes. */
const SUMMARY = [
  '## Primary Request and Intent',
  '- port the DSML reader',
  '',
  '## Current Work',
  '- halfway through `parseInvoke` in src/dsml.ts',
  '',
  '## Next Step',
  '- run `pnpm test dsml` and fix the two failing cases',
].join('\n')

/** A temp directory, so a test never writes to the harness home. */
async function tempDir(prefix: string): Promise<string> {
  return mkdtemp(join(tmpdir(), prefix))
}

/** A session whose header names a cwd, which is what the record path is keyed on. */
function sessionWithCwd(id: string, cwd: string): Session {
  return Session.create(SessionId(id), [], {
    version: SESSION_FORMAT_VERSION,
    id: SessionId(id),
    createdAt: 0,
    isSeeded: false,
    cwd,
  })
}

/** Log one operator message; a steering one arrives after a step of an open turn has ended. */
function prompt(session: Session, text: string, steering = false): void {
  if (steering) {
    session.append('turn/start', { turn: 1 })
    session.append('step/start', { turn: 1, step: 1 })
    session.append('step/end', { turn: 1, step: 1 })
  }
  const message = createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
  session.append('user/message', message, { surfaceOp: 'append' })
  if (steering) session.append('turn/end', { turn: 1, reason: { kind: 'completed' } })
}

let callCounter = 0

/** Log one tool call and its result the way the loop does. */
function toolRun(session: Session, name: string, args: object, output: string, isError = false): void {
  callCounter += 1
  const callId = ToolCallId(`call-${callCounter}`)
  session.append('tool/call', { turn: 1, step: 1, callId, name, arguments: JSON.stringify(args) })
  session.append('tool/result', {
    turn: 1,
    step: 1,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text: output }], isError }),
  }, { surfaceOp: 'append' })
}

/** Log a todo-list write. */
function todos(session: Session, items: { content: string; status: 'pending' | 'in_progress' | 'completed' }[]): void {
  session.append('todo/write', { todos: items })
}

/** Log a compaction the way `compaction-basic` closes one. */
function compact(session: Session, id = 'c-1', summary = SUMMARY): void {
  session.append('compaction/summary', {
    compactionId: id,
    summary: [{ type: 'text', text: summary }],
  } as never)
}

/** Fold every event of a session into a fresh ledger. */
function ledgerOf(session: Session): Ledger {
  return session.snapshotEvents().reduce((ledger, event) => foldLedger(ledger, event), emptyLedger())
}

/** The text of one message, logged or as a request carries it. */
function textOf(message: { readonly content: readonly Message['content'][number][] } | undefined): string {
  return message?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
}

describe('the ledger records what a summary drops', () => {
  it('keeps the first request and the newest ones verbatim, marking corrections', () => {
    const session = Session.create(SessionId('prompts'))
    prompt(session, 'port the DSML reader to TypeScript')
    for (let index = 0; index < 30; index += 1) prompt(session, `step ${index}`)
    prompt(session, 'do not touch dsml.ts', true)

    const ledger = ledgerOf(session)
    expect(ledger.prompts[0]?.text).toBe('port the DSML reader to TypeScript')
    expect(ledger.prompts.at(-1)).toMatchObject({ text: 'do not touch dsml.ts', steering: true })
    expect(ledger.prompts).toHaveLength(24)
    expect(ledger.droppedPrompts).toBe(8)
  })

  it('tracks files by what happened to them, and only on success', () => {
    const session = Session.create(SessionId('files'))
    toolRun(session, 'read', { file_path: '/repo/a.ts' }, 'a')
    toolRun(session, 'read', { file_path: '/repo/a.ts' }, 'a')
    toolRun(session, 'edit', { file_path: '/repo/a.ts', old_string: 'x', new_string: 'y' }, 'ok')
    toolRun(session, 'write', { file_path: '/repo/new.ts', content: 'z' }, 'written')
    toolRun(session, 'str_replace_editor', { command: 'view', path: '/repo/b.ts' }, 'b')
    toolRun(session, 'edit', { file_path: '/repo/missing.ts', old_string: 'x', new_string: 'y' }, 'no match', true)

    const files = ledgerOf(session).files
    expect(files.map(file => file.path)).toEqual(['/repo/a.ts', '/repo/new.ts', '/repo/b.ts'])
    expect(files[0]).toMatchObject({ edited: true, created: false, reads: 2 })
    expect(files[1]).toMatchObject({ created: true })
    expect(files[2]).toMatchObject({ reads: 1, edited: false })
  })

  it('records command outcomes, reading exit codes and kernel tracebacks', () => {
    expect(resultSucceeded('bash', false, 'done\nexit code: 0')).toBe(true)
    expect(resultSucceeded('bash', false, 'boom\nexit code: 2')).toBe(false)
    expect(resultSucceeded('pwsh', false, 'Exited with status 1')).toBe(false)
    expect(resultSucceeded('kernel', false, 'Traceback (most recent call last):\n  ...')).toBe(false)
    expect(resultSucceeded('read', true, '')).toBe(false)

    const session = Session.create(SessionId('commands'))
    toolRun(session, 'bash', { command: 'pnpm test' }, 'FAIL dsml.spec.ts\nexit code: 1')
    toolRun(session, 'kernel', { code: '# count the modules\nlen(mods)' }, '12')
    expect(ledgerOf(session).commands).toEqual([
      expect.objectContaining({ tool: 'bash', text: 'pnpm test', ok: false }),
      expect.objectContaining({ tool: 'kernel', text: 'count the modules', ok: true }),
    ])
  })

  it('keeps an error open until the same call succeeds', () => {
    const session = Session.create(SessionId('errors'))
    toolRun(session, 'bash', { command: 'pnpm test' }, 'TypeError: x is undefined\nexit code: 1')
    expect(ledgerOf(session).errors).toEqual([
      expect.objectContaining({ tool: 'bash', target: 'pnpm test', text: 'TypeError: x is undefined\nexit code: 1' }),
    ])
    toolRun(session, 'bash', { command: 'pnpm test' }, 'all green\nexit code: 0')
    expect(ledgerOf(session).errors).toEqual([])
  })

  it('takes the latest todo list whole, and the latest compaction', () => {
    const session = Session.create(SessionId('todos'))
    todos(session, [{ content: 'a', status: 'pending' }])
    todos(session, [{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])
    compact(session, 'c-1', 'first')
    compact(session, 'c-2', 'second')
    const ledger = ledgerOf(session)
    expect(ledger.todos).toEqual([{ content: 'a', status: 'completed' }, { content: 'b', status: 'in_progress' }])
    expect(ledger.compaction).toMatchObject({ id: 'c-2', summary: 'second' })
    expect(ledger.compactions).toBe(2)
  })
})

describe('the handoff', () => {
  /** A session with every kind of fact the handoff restates. */
  function workedSession(): Session {
    const session = Session.create(SessionId('worked'))
    prompt(session, 'port the DSML reader to TypeScript; keep the public API')
    toolRun(session, 'read', { file_path: '/repo/src/dsml.ts' }, 'source')
    toolRun(session, 'edit', { file_path: '/repo/src/dsml.ts', old_string: 'a', new_string: 'b' }, 'ok')
    toolRun(session, 'bash', { command: 'pnpm test dsml' }, 'AssertionError: expected 3 to be 4\nexit code: 1')
    prompt(session, 'use the existing tokenizer, do not write a new one', true)
    todos(session, [
      { content: 'port parseInvoke', status: 'in_progress' },
      { content: 'update README', status: 'pending' },
    ])
    compact(session)
    return session
  }

  it('answers the recall, artifact, continuation, and request probes from the record alone', () => {
    const handoff = renderHandoff({ ledger: ledgerOf(workedSession()), budgetChars: 20000 })
    // Recall: the exact error text.
    expect(handoff).toContain('AssertionError: expected 3 to be 4')
    // Artifact: every file changed, and how.
    expect(handoff).toContain('`/repo/src/dsml.ts` — edited, read ×1')
    // Continuation: where to pick up.
    expect(handoff).toContain('halfway through `parseInvoke` in src/dsml.ts')
    expect(handoff).toContain('run `pnpm test dsml` and fix the two failing cases')
    expect(handoff).toContain('**Todo in progress:** port parseInvoke')
    // Requests: the brief and the correction, word for word.
    expect(handoff).toContain('port the DSML reader to TypeScript; keep the public API')
    expect(handoff).toContain('correction mid-turn')
    expect(handoff).toContain('use the existing tokenizer, do not write a new one')
    // Continue-from-here closes the message, nearest the next generation.
    expect(handoff.trimEnd().endsWith('do not write a new one')).toBe(true)
  })

  it('does not restate the checkpoint, which the history already carries', () => {
    const handoff = renderHandoff({ ledger: ledgerOf(workedSession()), budgetChars: 20000 })
    expect(handoff).not.toContain('## Primary Request and Intent')
    expect(handoff.startsWith(HANDOFF_PREAMBLE)).toBe(true)
  })

  it('gives up file contents before the facts that must survive', () => {
    const ledger = ledgerOf(workedSession())
    const files = [{ path: '/repo/src/dsml.ts', text: 'x'.repeat(20000) }]
    // Smaller than the facts themselves: file contents give way entirely.
    const tiny = renderHandoff({ ledger, files, budgetChars: 800 })
    const small = renderHandoff({ ledger, files, budgetChars: 6000 })
    const large = renderHandoff({ ledger, files, budgetChars: 40000 })
    expect(tiny).not.toContain('Recently changed files')
    expect(small.length).toBeLessThanOrEqual(6000)
    expect(small).toContain('cut to fit')
    expect(large).toContain('x'.repeat(20000))
    for (const handoff of [tiny, small, large]) {
      expect(handoff).toContain('AssertionError: expected 3 to be 4')
      expect(handoff).toContain('port the DSML reader to TypeScript; keep the public API')
      expect(handoff).toContain('## Continue from here')
    }
  })

  it('scales its budget with the routed window, within a floor and a ceiling', () => {
    expect(handoffBudget(undefined, 0.08, 6000, 24000)).toBe(24000)
    expect(handoffBudget(8000, 0.08, 6000, 24000)).toBe(6000)
    expect(handoffBudget(40000, 0.08, 6000, 24000)).toBe(12800)
    expect(handoffBudget(163840, 0.08, 6000, 24000)).toBe(24000)
  })

  it('reads a checkpoint section by heading, treating "(none)" as empty', () => {
    expect(extractSection(SUMMARY, 'next step')).toBe('- run `pnpm test dsml` and fix the two failing cases')
    expect(extractSection('## Next Step\n- (none)\n', 'Next Step')).toBe('')
    expect(extractSection('no headings here', 'Next Step')).toBe('')
  })

  it('fences a re-attached file so its own fences cannot close the block', () => {
    expect(fenceFor('plain text')).toBe('```')
    expect(fenceFor('# Doc\n```ts\ncode\n```\n')).toBe('````')
    const readme = '# Doc\n\n```ts\nconst x = 1\n```\n\nafter the fence'
    const handoff = renderHandoff({
      ledger: { ...emptyLedger(), compaction: { seq: 1, id: 'c', summary: SUMMARY }, compactions: 1 },
      files: [{ path: 'README.md', text: readme }],
      budgetChars: 20000,
    })
    expect(handoff).toContain(`### \`README.md\`\n\n\`\`\`\`\n${readme}\n\`\`\`\``)
  })

  it('re-anchors the plan in a focus line only after a compaction', () => {
    const session = Session.create(SessionId('focus'))
    todos(session, [{ content: 'port parseInvoke', status: 'in_progress' }])
    expect(renderFocus(ledgerOf(session))).toBe('')
    compact(session)
    const focus = renderFocus(ledgerOf(session))
    expect(focus).toContain('in progress: port parseInvoke')
    expect(focus).toContain('next step at the last compaction: run `pnpm test dsml`')
    expect(focus).not.toContain('full record')
    expect(renderFocus(ledgerOf(session), '/s/compaction-c-1-focus.md')).toContain('full record: /s/compaction-c-1-focus.md')
  })
})

/** Mount the registry stack plus this plugin, exactly as a profile composes them. */
async function mountPlugin(root: string, config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(recovery, Object.assign({ root, git: false }, config))
  return ctx
}

/** A minimal Agent carrying one session, which is all the pre-step listener reads. */
function sessionAgent(session: Session): Agent {
  return {
    id: SessionId('agent'),
    options: {},
    session,
    inbox: unsupportedInbox(),
    status: 'running',
    ctx: new Context(),
    send: () => {},
    followup: () => {},
    steer: () => {},
    inject: () => { throw new Error('the handoff rides the step, not the inbox') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Drive one pre-step and return every message the step enters with. */
async function step(ctx: Context, agent: Agent, kind: 'enter' | 'reject' = 'enter'): Promise<UserMessage[] | 'rejected'> {
  const proposed = createUserMessage({ content: [{ type: 'text', text: 'the operator asks something' }], source: { kind: 'user' } })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: SIGNAL },
    () => Promise.resolve(kind === 'reject'
      ? { kind: 'reject' as const }
      : { kind: 'enter' as const, messages: [proposed] }),
  )
  return decision.kind === 'enter' ? decision.messages : 'rejected'
}

/** Commit a step's messages the way the loop does, so the ledger folds them. */
function commit(session: Session, messages: readonly UserMessage[]): void {
  for (const message of messages) session.append('user/message', message, { surfaceOp: 'append' })
}

describe('the step that carries the handoff', () => {
  it('adds nothing to a session that was never compacted', async () => {
    const ctx = await mountPlugin(await tempDir('recovery-'))
    const session = Session.create(SessionId('fresh'))
    prompt(session, 'build the thing')
    const messages = await step(ctx, sessionAgent(session))
    expect(messages).not.toBe('rejected')
    expect(messages).toHaveLength(1)
  })

  it('puts the handoff first in the SAME step and keeps the operator message after it', async () => {
    const ctx = await mountPlugin(await tempDir('recovery-'))
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session)

    const messages = await step(ctx, sessionAgent(session))
    if (messages === 'rejected') throw new Error('unexpected reject')
    expect(messages).toHaveLength(2)
    expect(messages[0]?.source).toMatchObject({ kind: HANDOFF_SOURCE_KIND, form: 'handoff', compactionId: 'c-1' })
    expect(textOf(messages[0])).toContain('port the parser')
    expect(textOf(messages[1])).toBe('the operator asks something')
  })

  it('hands off once per compaction, and again after the next one', async () => {
    const ctx = await mountPlugin(await tempDir('recovery-'))
    const session = Session.create(SessionId('once'))
    const agent = sessionAgent(session)
    prompt(session, 'task')
    compact(session, 'c-1')
    const first = await step(ctx, agent)
    if (first === 'rejected') throw new Error('unexpected reject')
    commit(session, first)
    expect((ctx.sessionProjections.stateOf(session, LEDGER_PROJECTION) as Ledger).handedOffSeq).not.toBeNull()
    expect(await step(ctx, agent)).toHaveLength(1)

    compact(session, 'c-2')
    const again = await step(ctx, agent)
    if (again === 'rejected') throw new Error('unexpected reject')
    expect(again).toHaveLength(2)
    expect(again[0]?.source).toMatchObject({ compactionId: 'c-2' })
  })

  it('leaves a rejected step rejected', async () => {
    const ctx = await mountPlugin(await tempDir('recovery-'))
    const session = Session.create(SessionId('rejected'))
    compact(session)
    expect(await step(ctx, sessionAgent(session), 'reject')).toBe('rejected')
  })

  it('writes the handoff and the checkpoint to a plain-text record', async () => {
    const root = await tempDir('recovery-')
    const ctx = await mountPlugin(root)
    const session = sessionWithCwd('recorded', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session, 'c-9')
    await step(ctx, sessionAgent(session))
    const record = await readFile(join(sessionDir(root, 'D:\\repo', session.id), compactionRecordFilename('c-9', session.id)), 'utf8')
    expect(record).toContain(HANDOFF_PREAMBLE)
    expect(record).toContain('# Checkpoint summary')
    expect(record).toContain('run `pnpm test dsml`')
  })

  it('re-attaches the current contents of files the session changed', async () => {
    const cwd = await tempDir('recovery-cwd-')
    const path = join(cwd, 'parser.ts')
    await writeFile(path, 'export const parser = 42\n', 'utf8')
    const ctx = await mountPlugin(await tempDir('recovery-'))
    const session = sessionWithCwd('rehydrated', cwd)
    toolRun(session, 'edit', { file_path: path, old_string: '41', new_string: '42' }, 'ok')
    compact(session)
    const messages = await step(ctx, sessionAgent(session))
    if (messages === 'rejected') throw new Error('unexpected reject')
    expect(textOf(messages[0])).toContain('export const parser = 42')
  })
})

describe('in the real agent loop', () => {
  /**
   * Mount the production loop with this plugin and a stand-in compaction that
   * lands inside the pre-step chain on the chosen step, exactly where
   * `compaction-basic` compacts.
   */
  async function loop(responses: ConstructorParameters<typeof MockAdapter>[0], compactOnStep: number) {
    const ctx = new Context()
    await ctx.plugin(LlmRuntime)
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(recovery, { root: await tempDir('recovery-loop-'), git: false })
    let steps = 0
    ctx.on('agent/pre-step', async ({ agent }, next) => {
      steps += 1
      if (steps === compactOnStep) compact(agent.session, `c-${steps}`)
      return next()
    })
    await ctx.plugin(AgentLoop, { agents: [] })
    const adapter = new MockAdapter(responses)
    ctx.llm.registerAdapter(['mock'], adapter)
    ctx.tools.register(defineContentToolFixture({
      name: 'probe',
      description: 'A tool the scripted model calls.',
      parameters: {},
      execute: () => Promise.resolve([{ type: 'text', text: 'probed' }]),
    }))
    return { ctx, adapter }
  }

  it('keeps a turn running when it is compacted mid-task', async () => {
    const { ctx, adapter } = await loop([
      toolCallResponse('p1', 'probe', {}),
      toolCallResponse('p2', 'probe', {}),
      textResponse('finished the task'),
    ], 2)
    try {
      const agent = await ctx.agentLoop.create(SessionId('mid-task'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'do the task' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      // All three scripted steps ran: the compaction did not end the turn.
      expect(adapter.requests).toHaveLength(3)
      const second = adapter.requests[1]?.messages ?? []
      expect(second.some(message => textOf(message).startsWith(HANDOFF_PREAMBLE))).toBe(true)
      const events = agent.session.snapshotEvents()
      const handoffs = events.filter(event => event.type === 'user/message' && event.data.source.kind === HANDOFF_SOURCE_KIND)
      expect(handoffs).toHaveLength(1)
      const final = events.filter(event => event.type === 'assistant/message').at(-1)
      expect(final?.type === 'assistant/message' ? textOf(final.data.message) : '').toBe('finished the task')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('answers a new message in the step it arrives with, not a turn later', async () => {
    const { ctx, adapter } = await loop([
      textResponse('first answer'),
      textResponse('second answer'),
    ], 2)
    try {
      const agent = await ctx.agentLoop.create(SessionId('new-turn'), { provider: 'mock', model: 'mock' })
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'first question' }], source: { kind: 'user' } }))
      await agent.whenIdle()
      agent.followup(createUserMessage({ content: [{ type: 'text', text: 'second question' }], source: { kind: 'user' } }))
      await agent.whenIdle()

      expect(adapter.requests).toHaveLength(2)
      const texts = (adapter.requests[1]?.messages ?? []).map(textOf)
      const handoffAt = texts.findIndex(text => text.startsWith(HANDOFF_PREAMBLE))
      const questionAt = texts.findIndex(text => text === 'second question')
      expect(handoffAt).toBeGreaterThanOrEqual(0)
      expect(questionAt).toBeGreaterThan(handoffAt)
    } finally {
      await ctx.fiber.dispose()
    }
  })
})
