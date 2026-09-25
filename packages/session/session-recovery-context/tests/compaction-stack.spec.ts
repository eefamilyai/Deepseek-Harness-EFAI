/**
 * The whole compaction stack, as a profile composes it, through the real loop.
 *
 * Every other test here isolates one piece. This one mounts the production
 * agent loop with its invariants, upstream's real `compaction-basic` driven by
 * real token pressure, the real token meter, this plugin, and output masking,
 * and scripts only the model: it reads one large file per step until it has
 * read them all. The question each test answers is the one the plugins exist
 * for — does a turn that compacts in the middle of a task finish the task,
 * knowing what it was doing?
 */

import { mkdtemp } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { Agent } from '@deepseek-ai/dsh-agent'
import * as AgentInvariant from '@deepseek-ai/dsh-agent/invariant'
import AgentLoop from '@deepseek-ai/dsh-agent-loop'
import * as AgentLoopInvariant from '@deepseek-ai/dsh-agent-loop/invariant'
import { mountAgentLoopTestDependencies } from '@deepseek-ai/dsh-agent-loop-testkit'
import { BasicCompactionEngine } from '@deepseek-ai/dsh-compaction-basic'
import InvariantRegistry from '@deepseek-ai/dsh-invariants'
import { LlmAdapter, ToolCallId, createUserMessage } from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, LlmResolvedModelInfo, StreamChunk } from '@deepseek-ai/dsh-llm'
import * as masking from '@deepseek-ai/dsh-output-masking'
import { MASK_MARKER } from '@deepseek-ai/dsh-output-masking'
import { SessionId } from '@deepseek-ai/dsh-session'
import * as SessionInvariant from '@deepseek-ai/dsh-session/invariant'
import TokenMeter from '@deepseek-ai/dsh-token-meter'
import { defineContentToolFixture } from '@deepseek-ai/dsh-tools'
import * as recovery from '@deepseek-ai/dsh-session-recovery-context'
import { HANDOFF_PREAMBLE, HANDOFF_SOURCE_KIND } from '@deepseek-ai/dsh-session-recovery-context'

/** The operator's request, which must survive every compaction verbatim. */
const REQUEST = 'Read every module under src/ one at a time, then tell me which ones export a default.'

/** The checkpoint the scripted summarizer writes, in upstream's section structure. */
const CHECKPOINT = [
  '## Primary Request and Intent',
  '- read the modules under src/',
  '',
  '## Current Work',
  '- reading the modules one per step',
  '',
  '## Next Step',
  '- keep reading the remaining modules, then report which export a default',
].join('\n')

/** One large file body, so a handful of reads fills the window. */
function moduleBody(index: number): string {
  return `// src/mod${index}.ts\n${`export const value${index} = ${'x'.repeat(60)}\n`.repeat(60)}`
}

/** The text of one request message. */
function textOf(message: GenerateOptions['messages'][number] | undefined): string {
  return message?.content.map(block => block.type === 'text' ? block.text : '').join('') ?? ''
}

/**
 * A model that reads `modules` files, one per step, and then answers; it also
 * serves the summarizer, which marks its request with upstream's compaction
 * instruction.
 */
class ScriptedReader extends LlmAdapter {
  readonly conversation: GenerateOptions[] = []
  readonly summaries: GenerateOptions[] = []

  constructor(private readonly modules: number, private readonly contextWindow: number) {
    super()
  }

  override resolveModel(provider: string, model: string): Promise<LlmResolvedModelInfo> {
    return Promise.resolve({ provider, id: model, name: model, context: { contextWindow: this.contextWindow } })
  }

  override async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    if (textOf(options.messages.at(-1)).includes('acting as a compaction engine')) {
      this.summaries.push(options)
      yield { type: 'block-start', index: 0, blockType: 'text' }
      yield { type: 'block-end', index: 0, block: { type: 'text', text: CHECKPOINT } }
      yield { type: 'finish', reason: { kind: 'stop' } }
      return
    }
    const step = this.conversation.length
    this.conversation.push(options)
    if (step < this.modules) {
      const args = JSON.stringify({ file_path: `src/mod${step}.ts` })
      yield { type: 'block-start', index: 0, blockType: 'tool-call' }
      yield { type: 'block-end', index: 0, block: { type: 'tool-call', id: ToolCallId(`read-${step}`), name: 'read', arguments: args } }
      yield { type: 'finish', reason: { kind: 'tool-calls' } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: 'All modules read.' } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** Wait until the agent's turn has finished. */
function idle(ctx: Context, agent: Agent): Promise<void> {
  return new Promise((resolve) => {
    const dispose = ctx.on('agent/status', ({ agent: subject, status }) => {
      if (subject === agent && status === 'idle') {
        dispose()
        resolve()
      }
    })
  })
}

/** Mount the stack a base-backed profile runs, with the model scripted. */
async function stack(model: ScriptedReader, withMasking: boolean): Promise<Context> {
  const ctx = new Context()
  await mountAgentLoopTestDependencies(ctx)
  await ctx.plugin(InvariantRegistry)
  await ctx.plugin(SessionInvariant)
  await ctx.plugin(AgentInvariant)
  await ctx.plugin(AgentLoopInvariant)
  await ctx.plugin(recovery, { root: await mkdtemp(join(tmpdir(), 'compaction-stack-')), git: false })
  if (withMasking) await ctx.plugin(masking, { usageRatio: 0.4, keepRecent: 2, minChars: 1000, minBatch: 2 })
  await ctx.plugin(AgentLoop, { agents: [] })
  await ctx.plugin(TokenMeter)
  ctx.llm.registerAdapter(['mock'], model)
  ctx.on('agent/request', async (_payload, next) => ({ ...await next(), provider: 'mock', model: 'mock' }))
  ctx.tools.register(defineContentToolFixture({
    name: 'read',
    description: 'Read a file.',
    parameters: { file_path: { type: 'string' } },
    execute: (args: { file_path?: string }) => {
      const index = Number(/mod(\d+)/.exec(args.file_path ?? '')?.[1] ?? 0)
      return Promise.resolve([{ type: 'text', text: moduleBody(index) }])
    },
  }))
  await ctx.plugin(BasicCompactionEngine, {
    headroomTokens: 0,
    thresholdRatio: 0.8,
    retainTokens: 2000,
    maxTokens: 8192,
    compactionRetries: 1,
  })
  return ctx
}

/** Run one scripted task to completion and return what the model and the log saw. */
async function run(modules: number, contextWindow: number, withMasking: boolean) {
  const model = new ScriptedReader(modules, contextWindow)
  const ctx = await stack(model, withMasking)
  const agent = await ctx.agentLoop.create(SessionId(`stack-${String(withMasking)}`), {
    provider: 'unconfigured-agent-fallback',
    model: 'unconfigured-agent-fallback',
  })
  const done = idle(ctx, agent)
  agent.followup(createUserMessage({ content: [{ type: 'text', text: REQUEST }], source: { kind: 'user' } }))
  await done
  const events = agent.session.snapshotEvents()
  return { ctx, model, events }
}

describe('the compaction stack in the real loop', () => {
  it('compacts mid-task under real pressure, hands off in the same step, and finishes the task', async () => {
    const { ctx, model, events } = await run(14, 12000, false)
    try {
      const compactions = events.filter(event => event.type === 'compaction/summary')
      expect(compactions.length).toBeGreaterThan(0)
      expect(model.summaries.length).toBe(compactions.length)

      // Every scripted step ran and the task finished: no step was spent on
      // recovery, and the turn did not end at the compaction.
      expect(model.conversation).toHaveLength(15)
      expect(events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
      const answers = events.filter(event => event.type === 'assistant/message')
      expect(textOf(answers.at(-1)?.type === 'assistant/message' ? answers.at(-1)?.data.message : undefined)).toBe('All modules read.')

      // Exactly one handoff per compaction, each in the log as its own message.
      const handoffs = events.filter(event => event.type === 'user/message' && event.data.source.kind === HANDOFF_SOURCE_KIND)
      expect(handoffs).toHaveLength(compactions.length)

      // The request right after the first compaction carries the checkpoint and
      // the handoff, and the handoff restates the request and where to resume.
      const after = model.conversation.find(request => request.messages.some(message => textOf(message).startsWith(HANDOFF_PREAMBLE)))
      expect(after).toBeDefined()
      const handoff = textOf(after?.messages.find(message => textOf(message).startsWith(HANDOFF_PREAMBLE)))
      expect(handoff).toContain(REQUEST)
      expect(handoff).toContain('## Continue from here')
      expect(handoff).toContain('keep reading the remaining modules')
      expect(handoff).toMatch(/src\/mod\d+\.ts/)
      expect(JSON.stringify(after?.messages)).toContain('reading the modules one per step')
    } finally {
      await ctx.fiber.dispose()
    }
  })

  it('with masking, stubs old output first and compacts less, and still finishes', async () => {
    const plain = await run(14, 12000, false)
    const masked = await run(14, 12000, true)
    try {
      const prunes = masked.events.filter(event => event.type === 'compaction/prune')
      expect(prunes.length).toBeGreaterThan(0)
      const last = masked.model.conversation.at(-1)
      expect(last?.messages.some(message => message.role === 'tool' && textOf(message).startsWith(MASK_MARKER))).toBe(true)
      const count = (events: typeof plain.events) => events.filter(event => event.type === 'compaction/summary').length
      expect(count(masked.events)).toBeLessThan(count(plain.events))
      expect(masked.model.conversation).toHaveLength(15)
      expect(masked.events.at(-1)).toMatchObject({ type: 'turn/end', data: { reason: { kind: 'completed' } } })
    } finally {
      await plain.ctx.fiber.dispose()
      await masked.ctx.fiber.dispose()
    }
  })
})
