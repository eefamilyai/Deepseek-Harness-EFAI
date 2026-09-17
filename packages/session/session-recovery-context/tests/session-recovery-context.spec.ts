/**
 * Post-compaction recovery, from the fold up.
 *
 * The behavior under test is a claim about turns, not about strings: the turn
 * after a compaction must arrive already holding the operator's own words. Each
 * case here fixes one way that used to fail — nothing injected, injected twice,
 * injected into a session that was never compacted, or injected with the task
 * statement dropped in favour of the newest steering.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { dshHomePath } from '@deepseek-ai/dsh-home-paths'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import { SESSION_FORMAT_VERSION, Session, SessionId } from '@deepseek-ai/dsh-session'
import type { SessionEvent } from '@deepseek-ai/dsh-session'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import * as recovery from '@deepseek-ai/dsh-session-recovery-context'
import { DEFAULT_PREAMBLE, eventLabel, renderRecovery } from '@deepseek-ai/dsh-session-recovery-context'
import type { Config, SessionRecoveryProjection } from '@deepseek-ai/dsh-session-recovery-context'

const SIGNAL = new AbortController().signal
const ROOT = 'C:\\sessions'

/** Mount the registry stack plus this plugin, exactly as a profile composes them. */
async function mount(config: Config = {}) {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  await ctx.plugin(recovery, config)
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
    inject: () => { throw new Error('recovery context must append to the open step') },
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** A session whose header names a cwd, which is what the log path is keyed on. */
function sessionWithCwd(id: string, cwd: string): Session {
  const sessionId = SessionId(id)
  return Session.create(sessionId, [], {
    version: SESSION_FORMAT_VERSION,
    id: sessionId,
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
function compact(session: Session, summary = 'summary text'): void {
  session.append('compaction/summary', { summary } as never)
}

/**
 * Drive one pre-step and commit whatever the waterfall added, which is what the
 * agent loop does with an `enter` decision.
 * @returns the messages this plugin contributed, proposal excluded.
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
  const signal = options.signal ?? SIGNAL
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal },
    () => Promise.resolve(options.kind === 'reject'
      ? { kind: 'reject' as const }
      : { kind: 'enter' as const, messages: [proposed] }),
  )
  if (decision.kind !== 'enter') return []
  const added = decision.messages.filter(message => message !== proposed)
  for (const message of added) agent.session.append('user/message', message, { surfaceOp: 'append' })
  return added
}

/** The text of every message this plugin has injected into one session. */
function injected(session: Session): string[] {
  const texts: string[] = []
  for (const event of session.snapshotEvents()) {
    if (event.type !== 'user/message') continue
    if (event.data.source.kind !== 'plugin' || event.data.source.plugin !== recovery.name) continue
    texts.push(event.data.content.find(block => block.type === 'text')?.text ?? '')
  }
  return texts
}

/** Read the folded state the plugin decides from. */
function state(ctx: Context, session: Session): SessionRecoveryProjection {
  return ctx.sessionProjections.stateOf(session, 'sessionRecovery') as SessionRecoveryProjection
}

/** One event shaped like the fold sees it, for the label unit tests. */
function eventOf(data: unknown): SessionEvent {
  return { type: 'user/message', seq: 1, time: 0, data } as unknown as SessionEvent
}

describe('post-compaction injection', () => {
  it('injects nothing into a session that was never compacted', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('fresh'))
    prompt(session, 'build the thing')

    expect(await fire(ctx, sessionAgent(session))).toEqual([])
    expect(injected(session)).toEqual([])
  })

  it('injects the operator prompts and the event tail once a compaction is logged', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('compacted'))
    prompt(session, 'port the parser')
    prompt(session, 'do not touch dsml.ts')
    compact(session)

    const added = await fire(ctx, sessionAgent(session))

    expect(added).toHaveLength(1)
    const text = injected(session)[0] ?? ''
    expect(text).toContain(DEFAULT_PREAMBLE)
    expect(text).toContain('port the parser')
    expect(text).toContain('do not touch dsml.ts')
    expect(text).toContain('## Last')
    expect(text).toContain('compaction/summary')
  })

  it('names the exact log file the writer is appending to', async () => {
    const ctx = await mount({ root: ROOT })
    const session = sessionWithCwd('with-path', 'D:\\repo')
    prompt(session, 'go')
    compact(session)

    await fire(ctx, sessionAgent(session))

    expect(injected(session)[0]).toContain(
      recovery.sessionLogPath(ROOT, 'D:\\repo', SessionId('with-path'), 'zstd'),
    )
  })

  it('falls back to the harness session root when the deployment names none', async () => {
    // The shipped bundle passes the same `dshHomePath('sessions')` the JSONL
    // backend gets, so an omitted root must land on that and not on a guess.
    const ctx = await mount()
    const session = sessionWithCwd('defaulted', 'D:\\repo')
    compact(session)

    await fire(ctx, sessionAgent(session))

    expect(injected(session)[0]).toContain(
      recovery.sessionLogPath(dshHomePath('sessions'), 'D:\\repo', SessionId('defaulted'), 'zstd'),
    )
  })

  it('injects once per compaction, not once per step', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('once'))
    prompt(session, 'first')
    compact(session)
    const agent = sessionAgent(session)

    await fire(ctx, agent)
    await fire(ctx, agent)
    expect(injected(session)).toHaveLength(1)

    // A second compaction is a second thing to recover from.
    compact(session, 'again')
    await fire(ctx, agent)
    expect(injected(session)).toHaveLength(2)
  })

  it('leaves a rejected step and an aborted step alone', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('refused'))
    compact(session)
    const agent = sessionAgent(session)

    expect(await fire(ctx, agent, { kind: 'reject' })).toEqual([])
    const aborted = new AbortController()
    aborted.abort()
    expect(await fire(ctx, agent, { signal: aborted.signal })).toEqual([])
    expect(injected(session)).toEqual([])
  })

  it('carries its own message as a snapshot source so the fold can recognise it', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('attributed'))
    compact(session)

    const [message] = await fire(ctx, sessionAgent(session))
    const text = message?.content.find(block => block.type === 'text')?.text ?? ''
    expect(message?.source).toEqual({
      kind: 'plugin',
      plugin: 'session-recovery-context',
      form: 'snapshot',
      sections: [{ name: 'session-recovery-context', text }],
    })
  })
})

describe('the fold', () => {
  it('keeps every prompt by default and never counts its own injection as one', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('prompts'))
    for (const text of ['one', 'two', 'three']) prompt(session, text)
    compact(session)
    await fire(ctx, sessionAgent(session))

    expect(state(ctx, session).prompts.map(entry => entry.text)).toEqual(['one', 'two', 'three'])
  })

  it('drops from the MIDDLE at the prompt bound, keeping the brief and the latest', async () => {
    // The first prompt is the task statement and the last are the current
    // intent; a bound that dropped the oldest would discard the brief itself.
    const ctx = await mount({ root: ROOT, maxPrompts: 3 })
    const session = Session.create(SessionId('bounded'))
    for (const text of ['brief', 'steer-a', 'steer-b', 'steer-c']) prompt(session, text)

    expect(state(ctx, session).prompts.map(entry => entry.text)).toEqual(['brief', 'steer-b', 'steer-c'])
  })

  it('clips a long prompt and says how much it withheld', async () => {
    const ctx = await mount({ root: ROOT, promptChars: 10 })
    const session = Session.create(SessionId('clipped'))
    prompt(session, 'x'.repeat(40))

    const text = state(ctx, session).prompts[0]?.text ?? ''
    expect(text.startsWith('xxxxxxxxxx…')).toBe(true)
    expect(text).toContain('+30 chars')
  })

  it('flattens newlines so one prompt stays one line of the digest', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('multiline'))
    prompt(session, 'first line\n\nsecond line')

    expect(state(ctx, session).prompts[0]?.text).toBe('first line second line')
  })

  it('counts no machine-injected message as an operator prompt', async () => {
    // `agent-instructions`, the skill catalog, and this plugin all write
    // `user/message` events. Only the operator's own count as the brief; the
    // rest are context the harness put there and would drown the real one.
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('machine'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'text', text: 'workspace context' }],
      source: { kind: 'plugin', plugin: 'agent-instructions' },
    }), { surfaceOp: 'append' })

    expect(state(ctx, session).prompts).toEqual([])
    // It is still an event, so the tail still shows it happened.
    expect(state(ctx, session).tail).toHaveLength(1)
  })

  it('ignores a prompt with no text at all', async () => {
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('empty-prompt'))
    session.append('user/message', createUserMessage({
      content: [{ type: 'image', source: { kind: 'ref', ref: 'x' } } as never],
      source: { kind: 'user' },
    }), { surfaceOp: 'append' })

    expect(state(ctx, session).prompts).toEqual([])
  })

  it('bounds the tail to the configured window', async () => {
    const ctx = await mount({ root: ROOT, tailEvents: 3 })
    const session = Session.create(SessionId('tail'))
    for (const text of ['a', 'b', 'c', 'd', 'e']) prompt(session, text)

    const tail = state(ctx, session).tail
    expect(tail).toHaveLength(3)
    expect(tail.map(entry => entry.label)).toEqual(['c', 'd', 'e'])
  })

  it('keeps no tail at all when the window is zero', async () => {
    const ctx = await mount({ root: ROOT, tailEvents: 0 })
    const session = Session.create(SessionId('no-tail'))
    prompt(session, 'a')
    compact(session)
    await fire(ctx, sessionAgent(session))

    expect(state(ctx, session).tail).toEqual([])
    expect(injected(session)[0]).not.toContain('## Last')
  })

  it('clips a tail label to its own budget', async () => {
    const ctx = await mount({ root: ROOT, labelChars: 4 })
    const session = Session.create(SessionId('label-budget'))
    prompt(session, 'abcdefgh')

    expect(state(ctx, session).tail.at(-1)?.label.startsWith('abcd…')).toBe(true)
  })
})

describe('event labels', () => {
  it('reads content text, then a named field, and gives up honestly', () => {
    expect(eventLabel(eventOf({ content: [{ type: 'text', text: 'hello' }] }), 40)).toBe('hello')
    expect(eventLabel(eventOf({ content: [{ type: 'image' }, { type: 'text', text: 'shown' }] }), 40)).toBe('shown')
    expect(eventLabel(eventOf({ name: 'kernel' }), 40)).toBe('kernel')
    expect(eventLabel(eventOf({ summary: 'folded' }), 40)).toBe('folded')
    expect(eventLabel(eventOf({ turn: 3 }), 40)).toBe('')
    expect(eventLabel(eventOf({ content: 'not an array' }), 40)).toBe('')
    expect(eventLabel(eventOf({ content: [null, 7] }), 40)).toBe('')
    expect(eventLabel(eventOf({ name: '' }), 40)).toBe('')
    expect(eventLabel(eventOf(null), 40)).toBe('')
    expect(eventLabel(eventOf('scalar'), 40)).toBe('')
  })

  it('leaves a label unclipped when the budget is zero or negative', () => {
    expect(eventLabel(eventOf({ name: 'kept whole' }), 0)).toBe('kept whole')
  })
})

describe('rendering', () => {
  const empty: SessionRecoveryProjection = { prompts: [], tail: [], compactionSeq: 1, answeredSeq: null }

  it('says so plainly when the log recorded no operator prompt', () => {
    expect(renderRecovery(empty, 'P', undefined)).toBe('P\n\n## Operator prompts, oldest first\n(none recorded)')
  })

  it('omits the log line when there is no session to name', () => {
    expect(renderRecovery(empty, 'P', undefined)).not.toContain('logged')
    expect(renderRecovery(empty, 'P', 'C:\\log.jsonl.zstd')).toContain('C:\\log.jsonl.zstd')
  })

  it('numbers prompts and labels only the events that carry one', () => {
    const text = renderRecovery({
      prompts: [{ seq: 4, text: 'brief' }],
      tail: [{ seq: 9, type: 'turn/start', label: '' }, { seq: 10, type: 'tool/call', label: 'kernel' }],
      compactionSeq: 11,
      answeredSeq: null,
    }, 'P', undefined)
    expect(text).toContain('1. [seq 4] brief')
    expect(text).toContain('[seq 9] turn/start\n')
    expect(text).toContain('[seq 10] tool/call — kernel')
  })
})

describe('prompt facts', () => {
  /** Assemble one prompt through the real registry with this plugin mounted. */
  async function assembleWith(session: Session | undefined, personaPrefix = '') {
    const SystemPrompt = (await import('@deepseek-ai/dsh-system-prompt')).default
    const host = new Context()
    await host.plugin(SessionProjectionRegistry)
    await host.plugin(AgentRegistry)
    await host.plugin(SystemPrompt, { personaPrefix })
    await host.plugin(recovery, { root: ROOT })
    return host.systemPrompt.assemble(session === undefined
      ? {}
      : { agent: { session, options: { provider: 'p', model: 'm' } } as never })
  }

  it('states the log file as runtime context', async () => {
    const { renderContextSnapshot } = await import('@deepseek-ai/dsh-system-prompt')
    const assembly = await assembleWith(sessionWithCwd('facts', 'D:\\repo'))

    expect(renderContextSnapshot(assembly))
      .toContain(recovery.sessionLogPath(ROOT, 'D:\\repo', SessionId('facts'), 'zstd'))
  })

  it('registers the log, the directory, and the id as variables a persona can reference', async () => {
    const assembly = await assembleWith(sessionWithCwd('facts', 'D:\\repo'))

    expect(assembly.variables.session_log)
      .toBe(recovery.sessionLogPath(ROOT, 'D:\\repo', SessionId('facts'), 'zstd'))
    expect(assembly.variables.session_dir)
      .toBe(recovery.sessionDir(ROOT, 'D:\\repo', SessionId('facts')))
    expect(assembly.variables.session_id).toBe('facts')
  })

  it('resolves {{session_log}} inside deployment persona text', async () => {
    // The deployment plane is where the log path is meant to be named, and
    // `{{name}}` there is strict: a name this plugin failed to register would
    // throw on every turn rather than render empty. This is the guard for the
    // profile patch that writes the reference.
    const { renderPrompt } = await import('@deepseek-ai/dsh-system-prompt')
    const assembly = await assembleWith(
      sessionWithCwd('persona', 'D:\\repo'),
      'This session is logged to {{session_log}}.',
    )

    expect(renderPrompt(assembly))
      .toContain(`logged to ${recovery.sessionLogPath(ROOT, 'D:\\repo', SessionId('persona'), 'zstd')}.`)
  })

  it('leaves every fact empty when the assembly carries no agent', async () => {
    const { renderContextSnapshot } = await import('@deepseek-ai/dsh-system-prompt')
    const assembly = await assembleWith(undefined)

    expect(assembly.variables.session_log).toBeUndefined()
    expect(assembly.variables.session_dir).toBeUndefined()
    expect(assembly.variables.session_id).toBeUndefined()
    expect(renderContextSnapshot(assembly)).not.toContain('logged to')
  })

  it('still injects after a compaction in a composition with no system prompt', async () => {
    // The prompt facts are a convenience; the injection is the behavior. A
    // composition without `systemPrompt` must keep the second and lose only the first.
    const ctx = await mount({ root: ROOT })
    const session = Session.create(SessionId('promptless'))
    prompt(session, 'still the brief')
    compact(session)

    expect(await fire(ctx, sessionAgent(session))).toHaveLength(1)
  })
})
