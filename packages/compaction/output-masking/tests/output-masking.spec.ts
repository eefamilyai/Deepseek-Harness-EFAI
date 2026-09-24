/**
 * What masking must get right: which results it replaces, what the stub keeps,
 * that it runs only under pressure and ahead of compaction, and that each
 * replacement is priced exactly — the token meter's measurement after a pass
 * must equal a fresh replay of the same log.
 * @module @deepseek-ai/dsh-output-masking/tests
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import AgentRegistry, { agentEvents } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import { unsupportedInbox } from '@deepseek-ai/dsh-agent-loop-testkit'
import { ToolCallId, createMessage, createToolResultMessage, createUserMessage } from '@deepseek-ai/dsh-llm'
import SessionStore, { Session, SessionId } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import * as CompactionInvariant from '@deepseek-ai/dsh-compaction/invariant'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import * as masking from '@deepseek-ai/dsh-output-masking'
import {
  MASK_MARKER,
  MASKING_PROJECTION,
  callTarget,
  emptyMaskingSurface,
  foldMaskingSurface,
  maskCandidates,
  renderStub,
} from '@deepseek-ai/dsh-output-masking'
import type { Config, MaskingSurface } from '@deepseek-ai/dsh-output-masking'

const SIGNAL = new AbortController().signal
const POLICY = { keepRecent: 2, minChars: 100 }

let counter = 0
/** Steps logged so far per session: every fixture session runs inside one open turn. */
const steps = new WeakMap<Session, number>()

/** Log one model step that calls a tool, and the tool's result, framed the way the loop frames it. */
function toolStep(session: Session, name: string, args: object, text: string, isError = false): void {
  const step = (steps.get(session) ?? 0) + 1
  steps.set(session, step)
  if (step === 1) session.append('turn/start', { turn: 1 })
  counter += 1
  const callId = ToolCallId(`call-${counter}`)
  session.append('step/start', { turn: 1, step })
  session.append('assistant/message', {
    stream: [],
    turn: 1,
    step,
    message: createMessage({
      role: 'assistant',
      content: [{ type: 'tool-call', id: callId, name, arguments: JSON.stringify(args) }],
      source: { kind: 'model', provider: 'test', model: 'test' },
    }),
  }, { surfaceOp: 'append' })
  session.append('tool/call', { turn: 1, step, callId, name, arguments: JSON.stringify(args) })
  session.append('tool/result', {
    turn: 1,
    step,
    message: createToolResultMessage({ callId, content: [{ type: 'text', text }], isError }),
  }, { surfaceOp: 'append' })
  session.append('step/end', { turn: 1, step })
}

/** A long output with distinct first and last lines. */
function output(label: string, size = 3000): string {
  return `${label} first line\n${'body\n'.repeat(Math.ceil(size / 5))}${label} exit 0`
}

/** Fold a session's whole log into a fresh surface. */
function surfaceOf(session: Session): MaskingSurface {
  return session.snapshotEvents().reduce(foldMaskingSurface, emptyMaskingSurface())
}

/** The text the model sees for every tool result, in order. */
function visibleResults(session: Session): string[] {
  return session.deriveMessages()
    .filter(message => message.role === 'tool')
    .map(message => message.content.map(block => block.type === 'text' ? block.text : '').join(''))
}

describe('the surface fold', () => {
  it('names each result by its call and keeps no output text', () => {
    const session = Session.create(SessionId('fold'))
    toolStep(session, 'read', { file_path: 'src/a.ts' }, output('A'))
    toolStep(session, 'bash', { command: 'pnpm test\n--reporter dot' }, output('B'))
    const surface = surfaceOf(session)
    const results = surface.nodes.flatMap(node => node.result === null ? [] : [node.result])
    expect(results.map(result => [result.tool, result.target])).toEqual([['read', 'src/a.ts'], ['bash', 'pnpm test']])
    expect(results[0]).toMatchObject({ head: 'A first line', tail: 'A exit 0', isError: false, textOnly: true, masked: false })
    expect(JSON.stringify(surface)).not.toContain('body\nbody')
    expect(surface.calls).toEqual({})
  })

  it('reads a target from the argument that names one', () => {
    expect(callTarget(JSON.stringify({ path: 'x.py', command: 'view' }))).toBe('x.py')
    expect(callTarget(JSON.stringify({ code: '# plot the loss\nimport numpy' }))).toBe('# plot the loss')
    expect(callTarget('not json')).toBe('')
  })
})

describe('which results are masked', () => {
  it('spares the newest results, small ones, errors, and ones already masked', () => {
    const session = Session.create(SessionId('candidates'))
    toolStep(session, 'read', { file_path: 'big.ts' }, output('big'))
    toolStep(session, 'read', { file_path: 'small.ts' }, 'tiny')
    toolStep(session, 'bash', { command: 'make' }, output('failed'), true)
    toolStep(session, 'read', { file_path: 'big2.ts' }, output('big2'))
    toolStep(session, 'read', { file_path: 'recent1.ts' }, output('recent1'))
    toolStep(session, 'read', { file_path: 'recent2.ts' }, output('recent2'))
    const targets = maskCandidates(surfaceOf(session), POLICY).map(node => node.result?.target)
    expect(targets).toEqual(['big.ts', 'big2.ts'])
  })

  it('writes a stub that says what ran, how large it was, and how it began and ended', () => {
    const session = Session.create(SessionId('stub'))
    toolStep(session, 'bash', { command: 'pnpm test' }, output('RUN'))
    const result = surfaceOf(session).nodes.find(node => node.result !== null)?.result
    const stub = renderStub(result!)
    expect(stub.startsWith(MASK_MARKER)).toBe(true)
    expect(stub).toContain('bash pnpm test')
    expect(stub).toContain('It began: RUN first line')
    expect(stub).toContain('It ended: RUN exit 0')
    expect(stub).toContain('Run the call again')
    expect(stub.length).toBeLessThan(400)
  })
})

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
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
}

/** Mount the registries and this plugin, as a profile composes them. */
async function mount(config: Config, meter = false): Promise<Context> {
  const ctx = new Context()
  await ctx.plugin(SessionProjectionRegistry)
  await ctx.plugin(AgentRegistry)
  if (meter) await ctx.plugin(TokenMeter)
  await ctx.plugin(masking, config)
  return ctx
}

/** Drive one pre-step through the chain; `inner` stands where compaction runs. */
async function step(ctx: Context, agent: Agent, inner: () => void = () => {}): Promise<'enter' | 'reject'> {
  const proposed = createUserMessage({ content: [{ type: 'text', text: 'continue' }], source: { kind: 'user' } })
  const decision = await agentEvents(ctx, agent).waterfall(
    'agent/pre-step',
    { messages: [proposed], turn: 1, step: 1, signal: SIGNAL },
    () => {
      inner()
      return Promise.resolve({ kind: 'enter' as const, messages: [proposed] })
    },
  )
  return decision.kind
}

/** A session with six large results, four of them old enough to mask. */
function workedSession(id: string): Session {
  const session = Session.create(SessionId(id))
  for (let index = 0; index < 6; index += 1) toolStep(session, 'read', { file_path: `f${index}.ts` }, output(`F${index}`))
  return session
}

describe('the pass ahead of each step', () => {
  it('leaves the context alone while it is below the usage ratio', async () => {
    const ctx = await mount({ ...POLICY, minBatch: 2, contextWindow: 1_000_000 })
    const session = workedSession('below')
    await step(ctx, sessionAgent(session))
    expect(visibleResults(session).some(text => text.startsWith(MASK_MARKER))).toBe(false)
  })

  it('masks every old large result in one batch once the ratio is crossed, then lets the step run', async () => {
    const ctx = await mount({ ...POLICY, minBatch: 2, contextWindow: 2000, usageRatio: 0.5 })
    const session = workedSession('above')
    expect(await step(ctx, sessionAgent(session))).toBe('enter')
    const visible = visibleResults(session)
    expect(visible.slice(0, 4).every(text => text.startsWith(MASK_MARKER))).toBe(true)
    expect(visible.slice(4).every(text => text.startsWith('F'))).toBe(true)
    expect(visible[0]).toContain('read f0.ts')
    // The originals stay in the log; only the surface changed.
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(4)
    // A second step finds nothing left to mask.
    await step(ctx, sessionAgent(session))
    expect(session.snapshotEvents().filter(event => event.type === 'compaction/prune')).toHaveLength(4)
    const state = ctx.sessionProjections.stateOf(session, MASKING_PROJECTION)
    expect(state?.nodes.filter(node => node.result?.masked === true).map(node => node.result?.target)).toEqual(['f0.ts', 'f1.ts', 'f2.ts', 'f3.ts'])
  })

  it('waits until a pass would mask at least minBatch results', async () => {
    const ctx = await mount({ ...POLICY, minBatch: 5, contextWindow: 2000 })
    const session = workedSession('batch')
    await step(ctx, sessionAgent(session))
    expect(visibleResults(session).some(text => text.startsWith(MASK_MARKER))).toBe(false)
  })

  it('stays out of a compaction in progress', async () => {
    const ctx = await mount({ ...POLICY, minBatch: 2, contextWindow: 2000 })
    const session = workedSession('compacting')
    session.append('compaction/start', { compactionId: 'c-1', turn: 1 } as never)
    await step(ctx, sessionAgent(session))
    expect(visibleResults(session).some(text => text.startsWith(MASK_MARKER))).toBe(false)
  })

  it('runs before the rest of the chain, so compaction measures the masked surface', async () => {
    const ctx = await mount({ ...POLICY, minBatch: 2, contextWindow: 2000 }, true)
    const session = workedSession('ordering')
    const before = ctx.tokenMeter.measure(session).surfaceTokens
    let seen = 0
    await step(ctx, sessionAgent(session), () => {
      seen = ctx.tokenMeter.measure(session).surfaceTokens
    })
    expect(seen).toBeLessThan(before / 2)
  })
})

describe('pricing and invariants', () => {
  it('prices each replacement exactly: the live meter matches a fresh replay', async () => {
    const ctx = await mount({ ...POLICY, minBatch: 2, contextWindow: 2000 }, true)
    const session = workedSession('priced')
    await step(ctx, sessionAgent(session))
    const live = ctx.tokenMeter.measure(session).surfaceTokens
    const replayCtx = new Context()
    await replayCtx.plugin(SessionProjectionRegistry)
    await replayCtx.plugin(TokenMeter)
    const replay = Session.create(SessionId('priced-replay'), session.snapshotEvents())
    expect(replayCtx.tokenMeter.measure(replay).surfaceTokens).toBe(live)
    const state = ctx.sessionProjections.stateOf(session, MASKING_PROJECTION)
    expect(state?.nodes.reduce((sum, node) => sum + node.tokens, 0)).toBe(live)
  })

  it('passes the session and compaction invariants inside an open turn', async () => {
    const ctx = new Context()
    await ctx.plugin(SessionStore)
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(InvariantRegistry)
    await ctx.plugin(SessionInvariant)
    await ctx.plugin(CompactionInvariant)
    await ctx.plugin(AgentRegistry)
    await ctx.plugin(TokenMeter)
    await ctx.plugin(masking, { ...POLICY, minBatch: 2, contextWindow: 2000 })
    const session = ctx.sessions.create(SessionId('invariants'))
    for (let index = 0; index < 6; index += 1) toolStep(session, 'read', { file_path: `f${index}.ts` }, output(`F${index}`))
    await step(ctx, sessionAgent(session))
    expect(visibleResults(session).filter(text => text.startsWith(MASK_MARKER))).toHaveLength(4)
  })
})
