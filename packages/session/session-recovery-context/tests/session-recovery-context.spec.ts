/**
 * The compaction record, the initialization step that carries it, and the
 * suppression that keeps that step free of every other injection.
 * @module @deepseek-ai/dsh-session-recovery-context/tests
 */

import { mkdtemp, readFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as recovery from '@deepseek-ai/dsh-session-recovery-context'
import {
  DEFAULT_INSTRUCTION,
  compactionLogFilename,
  compactionLogPath,
  renderCompactionLog,
  selectCompactionEvents,
} from '@deepseek-ai/dsh-session-recovery-context'
import type { Config, SessionRecoveryProjection } from '@deepseek-ai/dsh-session-recovery-context'

const SIGNAL = new AbortController().signal

/** A session root under the OS temp directory, so a test never writes to the harness home. */
async function tempRoot(): Promise<string> {
  return mkdtemp(join(tmpdir(), 'recovery-'))
}

/** Mount the registry stack plus this plugin, exactly as a profile composes them. */
async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(recovery, { root: await tempRoot(), ...config })
  return ctx
}

/**
 * Mount the same stack with a system prompt, whose assembly carries the
 * runtime-context facts this plugin contributes.
 * @returns the context and the session root the plugin was given.
 */
async function mountWithPrompt(config: Config = {}) {
  const root = await tempRoot()
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(SystemPrompt, {})
  await ctx.plugin(recovery, { root, ...config })
  return { ctx, root }
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
    inject: () => { throw new Error('the recovery step owns its own messages') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
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

/** Log one operator prompt. */
function prompt(session: Session, text: string): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text }],
    source: { kind: 'user' },
  }), { surfaceOp: 'append' })
}

/** Log a compaction the way `compaction-basic` closes one. */
function compact(session: Session, id = 'auto-1', summary = 'summary text'): void {
  session.append('compaction/summary', {
    compactionId: id,
    summary: [{ type: 'text', text: summary }],
  } as never)
}

/**
 * Drive one pre-step and return the messages this plugin contributed.
 * @returns the contributed messages, the loop's own proposal excluded.
 */
async function fire(
  ctx: Context,
  agent: Agent,
  options: { kind?: 'enter' | 'reject'; signal?: AbortSignal } = {},
): Promise<UserMessage[]> {
  const proposed = createUserMessage({
    content: [{ type: 'text', text: 'proposal' }],
    source: { kind: 'plugin', plugin: 'recovery-test' },
  })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: options.signal ?? SIGNAL },
    () => Promise.resolve(options.kind === 'reject'
      ? { kind: 'reject' as const }
      : { kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind !== 'enter') return []
  return decision.messages.filter(message => message !== proposed)
}

/** Acknowledge the recovery step the way a model that replied `OK` does. */
function acknowledge(session: Session): void {
  session.append('user/message', createUserMessage({
    content: [{ type: 'text', text: 'OK' }],
    source: { kind: 'plugin', plugin: recovery.name, form: 'snapshot', sections: [] },
  }), { surfaceOp: 'append' })
}

/** Read the folded state the plugin decides from. */
function state(ctx: Context, session: Session): SessionRecoveryProjection {
  return ctx.sessionProjections.stateOf(session, 'sessionRecovery') as SessionRecoveryProjection
}

/** The text of one contributed message. */
function textOf(message: UserMessage | undefined): string {
  return message?.content.find(block => block.type === 'text')?.text ?? ''
}

describe('compaction initialization', () => {
  it('contributes nothing to a session that was never compacted', async () => {
    const ctx = await mount()
    const session = Session.create(SessionId('fresh'))
    prompt(session, 'build the thing')

    expect(await fire(ctx, sessionAgent(session))).toEqual([])
  })

  it('carries the record and one instruction, and nothing else', async () => {
    const ctx = await mount()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    prompt(session, 'do not touch dsml.ts')
    compact(session, 'c-1', 'the parser was ported halfway')

    const [only, ...rest] = await fire(ctx, sessionAgent(session))

    expect(rest).toEqual([])
    const text = textOf(only)
    expect(text).toContain('the parser was ported halfway')
    expect(text).toContain('port the parser')
    expect(text).toContain('do not touch dsml.ts')
    expect(text).toContain(DEFAULT_INSTRUCTION)
    expect(text).toContain('# Compaction record')
  })

  it('writes the record to compaction-[id]-[session-id].md', async () => {
    const root = await tempRoot()
    const ctx = await mount({ root })
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session, 'c-7', 'halfway')

    await fire(ctx, sessionAgent(session))

    const path = compactionLogPath(root, session, 'c-7')
    expect(path.endsWith(compactionLogFilename('c-7', session.id))).toBe(true)
    expect(await readFile(path, 'utf8')).toContain('halfway')
  })

  it('admits the operator prompt only after the acknowledgement', async () => {
    const ctx = await mount()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session)

    const recoveryStep = await fire(ctx, sessionAgent(session))
    expect(recoveryStep).toHaveLength(1)

    acknowledge(session)
    const nextStep = await fire(ctx, sessionAgent(session))
    expect(nextStep.map(textOf)).toContain('proposal')
  })

  it('carries the recovered prompt once the acknowledgement is folded', async () => {
    const ctx = await mount()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session)

    await fire(ctx, sessionAgent(session))
    acknowledge(session)

    // The acknowledgement is the newest operator-shaped message, so the plugin
    // no longer intercepts; the loop sees its own claimed messages.
    const after = await fire(ctx, sessionAgent(session))
    expect(after.map(textOf)).not.toContain(DEFAULT_INSTRUCTION)
  })

  it('leaves a rejected step rejected', async () => {
    const ctx = await mount()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    compact(session)

    expect(await fire(ctx, sessionAgent(session), { kind: 'reject' })).toEqual([])
  })

  it('suppresses the system prompt for exactly the recovery step', async () => {
    const ctx = await mount()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    compact(session)
    const agent = sessionAgent(session)
    const assembly = { sections: [{ name: 'persona', text: 'x' }], contexts: [], tools: [], variables: {} }

    const fallback = (): Promise<never> => Promise.resolve(assembly as never)
    const during = await ctx.waterfall(
      'system-prompt/assemble',
      assembly as never,
      { agent, scope: agent } as never,
      fallback as never,
    )
    expect((during as unknown as typeof assembly).sections).toEqual([])

    acknowledge(session)
    const after = await ctx.waterfall(
      'system-prompt/assemble',
      assembly as never,
      { agent, scope: agent } as never,
      fallback as never,
    )
    expect((after as unknown as typeof assembly).sections).toEqual(assembly.sections)
  })

  it('carries the record file path and contents as runtime context', async () => {
    const { ctx, root } = await mountWithPrompt()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session, 'c-1', 'the parser was ported halfway')
    const agent = sessionAgent(session)

    // The first step writes the record; the acknowledgement lets the next step
    // warm the context that assembly reads.
    await fire(ctx, agent)
    acknowledge(session)
    await fire(ctx, agent)

    const assembled = await (ctx.get('systemPrompt')!).assemble({ agent, scope: agent } as never)
    const context = assembled.contexts.find(entry => entry.name === 'session:context-file')

    expect(context).toBeDefined()
    expect(context!.text).toContain(compactionLogPath(root, session, 'c-1'))
    expect(context!.text).toContain('# Compaction record')
    expect(context!.text).toContain('the parser was ported halfway')
    expect(context!.text).toContain('port the parser')
  })

  it('renders only the path before a record has been written', async () => {
    const { ctx } = await mountWithPrompt()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    prompt(session, 'port the parser')
    compact(session, 'c-1')
    // Acknowledged without a step, so the record is named but never written.
    acknowledge(session)
    const agent = sessionAgent(session)

    const assembled = await (ctx.get('systemPrompt')!).assemble({ agent, scope: agent } as never)
    const context = assembled.contexts.find(entry => entry.name === 'session:context-file')

    expect(context!.text).toContain('Context file: ')
    expect(context!.text).not.toContain('# Compaction record')
  })

  it('contributes no context file before any compaction', async () => {
    const { ctx } = await mountWithPrompt()
    const session = Session.create(SessionId('fresh'))
    prompt(session, 'build the thing')
    const agent = sessionAgent(session)

    const assembled = await (ctx.get('systemPrompt')!).assemble({ agent, scope: agent } as never)
    const context = assembled.contexts.find(entry => entry.name === 'session:context-file')

    expect(context!.text).toBe('')
  })

  it('reports an awaiting compaction until the acknowledgement lands', async () => {
    const ctx = await mount()
    const session = sessionWithCwd('compacted', 'D:\\repo')
    compact(session)
    expect(recovery.awaitingAcknowledgement(state(ctx, session))).toBe(true)

    acknowledge(session)
    expect(recovery.awaitingAcknowledgement(state(ctx, session))).toBe(false)
  })
})

describe('selectCompactionEvents', () => {
  const events = [1, 2, 3, 4, 5].map(seq => ({ seq, type: 'tool/result', label: `e${seq}` }))

  it('keeps everything after the newest prompt', () => {
    const kept = selectCompactionEvents(events, [{ seq: 3, text: 'p' }])
    expect(kept.map(event => event.seq)).toEqual([4, 5])
  })

  it('keeps the newest events when the window is longer than the cap', () => {
    const kept = selectCompactionEvents(events, [], 2)
    expect(kept.map(event => event.seq)).toEqual([4, 5])
  })

  it('keeps the whole window when it fits the cap', () => {
    const kept = selectCompactionEvents(events, [{ seq: 1, text: 'p' }], 10)
    expect(kept.map(event => event.seq)).toEqual([2, 3, 4, 5])
  })
})

describe('renderCompactionLog', () => {
  it('names the session, the summary, the prompts, and the events', () => {
    const text = renderCompactionLog({
      compactionId: 'c-1',
      sessionId: SessionId('s-1'),
      summary: 'halfway',
      prompts: [{ seq: 1, text: 'port the parser' }],
      events: [{ seq: 2, type: 'tool/result', label: 'ok' }],
    })

    expect(text).toContain('# Compaction record')
    expect(text).toContain('c-1')
    expect(text).toContain('s-1')
    expect(text).toContain('halfway')
    expect(text).toContain('port the parser')
    expect(text).toContain('tool/result')
  })

  it('says so plainly when there is nothing to show', () => {
    const text = renderCompactionLog({
      compactionId: 'c-1',
      sessionId: SessionId('s-1'),
      summary: '   ',
      prompts: [],
      events: [],
    })

    expect(text).toContain('no summary text')
    expect(text).toContain('No operator prompt')
    expect(text).toContain('No event was recorded')
  })
})

describe('compactionLogFilename', () => {
  it('is compaction-[id]-[session-id].md', () => {
    expect(compactionLogFilename('c-1', SessionId('s-1'))).toBe('compaction-c-1-s-1.md')
  })
})
