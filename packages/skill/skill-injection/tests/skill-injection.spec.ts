/**
 * What this plugin adds to a step, and — just as important — what it does not
 * add twice.
 *
 * The pure readers are pinned directly; the listener is exercised through a
 * fake `agent/pre-step` chain, because the property that matters is how it
 * composes with the decision `tool-skill` already produced.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { UserMessage } from '@deepseek-ai/dsh-llm'
import type { Agent, PreStepDecision } from '@deepseek-ai/dsh-agent'
import { Config, apply, atGestureNames, name, visibleInvokedSkillNames } from '../src/index.ts'

const signal = new AbortController().signal

/** A user message carrying `text`. */
function user(text: string): UserMessage {
  return createUserMessage({ content: [{ type: 'text', text }], source: { kind: 'user' } })
}

/** One skill the registry can answer with. */
function skill(skillName: string) {
  return {
    name: skillName,
    provider: 'test',
    resourceBase: { kind: 'directory', path: `/skills/${skillName}` },
    content: `body of ${skillName}`,
    invocation: { modelInvocable: true, userInvocable: true },
  }
}

/**
 * A context whose skill registry answers for `available`, plus a session
 * surface reporting `visibleSkills` as still readable.
 */
function harness(options: {
  available?: string[]
  visibleSkills?: string[]
  decision?: PreStepDecision
  messages?: UserMessage[]
} = {}) {
  const available = new Set(options.available ?? [])
  const ctx = new Context()
  const looked: string[] = []
  ctx.provide('skills', {
    get: (skillName: string) => {
      looked.push(skillName)
      return Promise.resolve(available.has(skillName) ? skill(skillName) : undefined)
    },
  })

  const events = (options.visibleSkills ?? []).map((skillName, index) => ({
    seq: index + 1,
    type: 'user/message',
    data: { source: { kind: 'skill-invocation', name: skillName } },
  }))
  const agent = {
    session: {
      header: { cwd: '/work' },
      surface: { nodes: events.map(event => event.seq) },
      ownEvents: () => events,
    },
  } as unknown as Agent

  const base: PreStepDecision = options.decision ?? { kind: 'enter', messages: [] }
  return {
    ctx,
    agent,
    looked,
    /** Drive the registered listener the way the agent loop would. */
    async step(): Promise<PreStepDecision> {
      return await ctx.waterfall(
        'agent/pre-step',
        { agent, messages: options.messages ?? [], turn: 1, step: 1, signal },
        () => Promise.resolve(base),
      ) as PreStepDecision
    },
  }
}

describe('atGestureNames', () => {
  it('reads one gesture anywhere in the sentence', () => {
    expect(atGestureNames([user('please @skill dsh-session-history and continue')]))
      .toEqual(['dsh-session-history'])
  })

  it('reads several, first mention first, without duplicates', () => {
    expect(atGestureNames([user('@skill one @skill two'), user('@skill one')]))
      .toEqual(['one', 'two'])
  })

  it('ignores an unbounded or malformed token', () => {
    expect(atGestureNames([user('email@skill x'), user('@skillx y'), user('@skill  ')])).toEqual([])
  })
})

describe('visibleInvokedSkillNames', () => {
  it('names only the bodies the surface still carries', () => {
    const events = [
      { seq: 1, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'kept' } } },
      { seq: 2, type: 'user/message', data: { source: { kind: 'skill-invocation', name: 'pruned' } } },
      { seq: 3, type: 'user/message', data: { source: { kind: 'user' } } },
    ]
    const agent = {
      session: { surface: { nodes: [1, 3] }, ownEvents: () => events },
    } as unknown as Agent
    expect([...visibleInvokedSkillNames(agent)]).toEqual(['kept'])
  })
})

describe('the pre-step listener', () => {
  it('injects the body an @skill gesture asked for', async () => {
    const h = harness({ available: ['dsh-session-history'], messages: [user('@skill dsh-session-history')] })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, {})

    const decision = await h.step()
    expect(decision.kind).toBe('enter')
    const injected = (decision as { messages: UserMessage[] }).messages
    expect(injected).toHaveLength(1)
    expect(injected[0]!.source).toMatchObject({ kind: 'skill-invocation', name: 'dsh-session-history' })
    expect(JSON.stringify(injected[0]!.content)).toContain('body of dsh-session-history')
  })

  it('re-injects an always-loaded body the surface no longer carries', async () => {
    const h = harness({ available: ['dsh-session-history'] })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, {})

    const decision = await h.step()
    const injected = (decision as { messages: UserMessage[] }).messages
    expect(injected.map(message => (message.source as { name?: string }).name)).toEqual(['dsh-session-history'])
  })

  it('adds nothing when the always-loaded body is still visible', async () => {
    const h = harness({ available: ['dsh-session-history'], visibleSkills: ['dsh-session-history'] })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, {})

    expect((await h.step() as { messages: UserMessage[] }).messages).toEqual([])
    expect(h.looked).toEqual([])
  })

  it('does not duplicate a body this step already injected', async () => {
    const carried = createUserMessage({
      content: [{ type: 'text', text: 'body of dsh-session-history' }],
      source: { kind: 'skill-invocation', name: 'dsh-session-history', form: 'instructions' },
    })
    const h = harness({
      available: ['dsh-session-history'],
      decision: { kind: 'enter', messages: [carried] },
    })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, {})

    expect((await h.step() as { messages: UserMessage[] }).messages).toEqual([carried])
  })

  it('looks a missing name up once per agent, not once per step', async () => {
    const h = harness({ available: [] })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, {})

    await h.step()
    await h.step()
    expect(h.looked).toEqual(['dsh-session-history'])
  })

  it('leaves a rejected step alone', async () => {
    const h = harness({ available: ['dsh-session-history'], decision: { kind: 'reject' } })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, {})

    expect(await h.step()).toEqual({ kind: 'reject' })
    expect(h.looked).toEqual([])
  })

  it('reads no gesture when the reader is switched off', async () => {
    const h = harness({ available: ['one'], messages: [user('@skill one')] })
    await h.ctx.plugin({ name, inject: ['skills'], apply, Config }, { atGesture: false, alwaysLoadSkills: [] })

    expect((await h.step() as { messages: UserMessage[] }).messages).toEqual([])
  })
})
