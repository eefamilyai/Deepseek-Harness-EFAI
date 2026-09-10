/**
 * The agent-memory engine: durable, cache-friendly memory as a toggleable host
 * plugin. Two write paths guarantee capture even when the model ignores the
 * explicit tools:
 *
 *   1. host-side observer on `tools/result` auto-records tool output;
 *   2. the model-facing `memory_add`/`memory_recall`/`memory_map` tools.
 *
 * Only a bounded, deterministic index is re-injected each turn (via
 * `system-prompt/assemble`); the full evidence stays on the storage domain and
 * comes back ONLY through `memory_recall`. One shared domain, keyed per agent
 * id, so memory survives harness restarts and session switches.
 * @module @deepseek-ai/dsh-agent-memory
 */

import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolRunContext, ToolExecution, ToolExecutionResult } from '@deepseek-ai/dsh-tools'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import type { AssembleContext, PromptAssembly } from '@deepseek-ai/dsh-system-prompt'
import type {} from '@deepseek-ai/dsh-system-prompt'
import type { Domain } from '@deepseek-ai/dsh-storage-domain'

import { memoryDomain } from './spec.ts'
import type { MemoryDomain, MemoryNode, MemoryNodeKey, MemoryNodeKind } from './spec.ts'
import {
  agentKey, agentPrefix, nodeKey, refOf, summarize, truncate, renderMemoryIndex,
} from './memory.ts'

export const name = 'agent-memory'
export const inject = ['storageDomain', 'systemPrompt', 'tools']

export const MEMORY_PROMPT_SECTION = 'memory:index'

export interface Config {
  /** How many of the newest memory nodes the injected index lists. */
  maxIndexNodes?: number
  /** Character ceiling on the whole injected index; it is truncated to fit. */
  maxIndexChars?: number
  /** Character ceiling on one entry's one-line summary inside the index. */
  maxSummaryChars?: number
  /** Character ceiling on the full evidence stored for one memory node. */
  maxFullChars?: number
  /** Character ceiling on a tool result captured by the automatic observer. */
  maxAutoRecordChars?: number
}

export const Config: z<Config> = z.object({
  maxIndexNodes: z.number().step(1).min(1).default(40),
  maxIndexChars: z.number().step(1).min(1).default(4000),
  maxSummaryChars: z.number().step(1).min(1).default(240),
  maxFullChars: z.number().step(1).min(1).default(20000),
  maxAutoRecordChars: z.number().step(1).min(1).default(16000),
})

type ResolvedConfig = Required<Config>

interface AgentLike { readonly id: string }

function assemblyAgent(context: AssembleContext): AgentLike | undefined {
  return (context as AssembleContext & { agent?: AgentLike }).agent
}

/** Extract lossless-readable text from model-facing content, bounded defensively. */
function extractText(content: readonly ContentBlock[]): string {
  const parts: string[] = []
  for (const block of content) {
    const b = block as unknown as Record<string, unknown>
    if (b.type === 'text' && typeof b.text === 'string') parts.push(b.text)
    else if (b.type === 'tool-result') {
      const inner = b.content
      if (Array.isArray(inner)) parts.push(extractText(inner as ContentBlock[]))
      else if (typeof inner === 'string') parts.push(inner)
    } else if (typeof b.text === 'string') parts.push(b.text)
  }
  return parts.join('\n')
}

class MemoryService {
  constructor(
    private readonly domain: Domain<MemoryDomain>,
    private readonly config: ResolvedConfig,
  ) {}

  async append(
    agentId: string,
    kind: MemoryNodeKind,
    source: string,
    fullRaw: string,
  ): Promise<{ ref: string; seq: number }> {
    const full = truncate(fullRaw.trim(), this.config.maxFullChars)
    if (full.length === 0) return { ref: '', seq: 0 }
    const summary = summarize(full, this.config.maxSummaryChars)
    const ref = refOf(kind, source, full)

    // Content-addressable de-duplication: skip an identical prior capture.
    const existing = this.findByRef(agentId, ref)
    if (existing !== undefined) return existing

    const cursor = this.domain.global.get().cursor
    const seq = cursor + 1
    const now = Date.now()
    const node: MemoryNode = { kind, text: summary, full, ref, source, seq, ts: now }
    await this.domain.table('nodes').put(nodeKey(agentId, seq), node)
    await this.domain.global.set({ cursor: seq })

    const key = agentKey(agentId)
    const agent = this.domain.table('agents').get(key) ?? { lastSeen: 0, count: 0 }
    await this.domain.table('agents').put(key, { lastSeen: now, count: agent.count + 1 })
    return { ref, seq }
  }

  recent(agentId: string): MemoryNode[] {
    const prefix = agentPrefix(agentId)
    const out: MemoryNode[] = []
    for (const [key, node] of this.domain.table('nodes').entries()) {
      if (key.startsWith(prefix)) out.push(node)
    }
    out.sort((a, b) => b.seq - a.seq)
    return out.slice(0, this.config.maxIndexNodes)
  }

  findByRef(agentId: string, ref: string): { ref: string; seq: number } | undefined {
    const prefix = agentPrefix(agentId)
    let best: MemoryNode | undefined
    for (const [key, node] of this.domain.table('nodes').entries()) {
      if (key.startsWith(prefix) && node.ref === ref) {
        if (best === undefined || node.seq > best.seq) best = node
      }
    }
    return best === undefined ? undefined : { ref: best.ref, seq: best.seq }
  }

  fullByRef(agentId: string, ref: string): string | undefined {
    const prefix = agentPrefix(agentId)
    let best: MemoryNode | undefined
    for (const [key, node] of this.domain.table('nodes').entries()) {
      if (key.startsWith(prefix) && node.ref === ref) {
        if (best === undefined || node.seq > best.seq) best = node
      }
    }
    return best?.full
  }

  indexText(agentId: string): string {
    return truncate(renderMemoryIndex(this.recent(agentId)), this.config.maxIndexChars)
  }
}

const OWN_TOOLS = new Set(['memory_add', 'memory_recall', 'memory_map'])

export function apply(ctx: Context, config: Config): Promise<void> {
  const resolved: ResolvedConfig = {
    maxIndexNodes: config.maxIndexNodes ?? 40,
    maxIndexChars: config.maxIndexChars ?? 4000,
    maxSummaryChars: config.maxSummaryChars ?? 240,
    maxFullChars: config.maxFullChars ?? 20000,
    maxAutoRecordChars: config.maxAutoRecordChars ?? 16000,
  }

  return ctx.storageDomain.open(memoryDomain).then((domain) => {
    const service = new MemoryService(domain, resolved)

    // Fiber 1: auto-capture. Host-side, model-independent, contained — a memory
    // write never disturbs the tool result the agent loop already has.
    const stopObserve = ctx.on('tools/result', (exec: Readonly<ToolExecution>, result: Readonly<ToolExecutionResult>) => {
      void (async () => {
        try {
          if (OWN_TOOLS.has(exec.name)) return
          const agent = exec.agent
          if (agent === undefined) return
          const text = extractText(result.content)
          if (text.trim().length === 0) return
          await service.append(agent.id, 'tool-result', exec.name, truncate(text, resolved.maxAutoRecordChars))
        } catch {
          /* memory capture must never break the agent loop */
        }
      })()
    })

    // Fiber 2: prompt index. Stable block separate from the conversation; a
    // bounded, token-stable table replaces any previous `memory:index` entry.
    const stopAssemble = ctx.on('system-prompt/assemble', async (_assembly: PromptAssembly, context: AssembleContext, next) => {
      const assembled = await next()
      const agent = assemblyAgent(context)
      if (agent === undefined) return assembled
      const text = service.indexText(agent.id)
      const contexts = assembled.contexts.filter(entry => entry.name !== MEMORY_PROMPT_SECTION)
      if (text.length === 0) return { ...assembled, contexts }
      return { ...assembled, contexts: [...contexts, { name: MEMORY_PROMPT_SECTION, text }] }
    })

    ctx.tools.register(defineTool({
      name: 'memory_add',
      description: 'Durably record a note or evidence. The full text is kept on disk and its bounded summary joins the auto-injected memory index; use memory_recall(ref) to read the full text later.',
      parameters: {
        text: { type: 'string', required: true, description: 'The note or evidence to remember.' },
        kind: { type: 'string', enum: ['note', 'tool-result'], description: 'Defaults to note.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            ref: { type: 'string', required: true },
            seq: { type: 'integer', required: true },
          },
        },
        render: (_args, value) => {
          const v = value as { ref?: string; seq?: number }
          return [{ type: 'text', text: `recorded memory ref ${v.ref ?? '(empty)'} (seq ${v.seq ?? 0})` }]
        },
      },
      async execute(args, exec: ToolRunContext) {
        const a = args as { text: string; kind?: string }
        if (exec.agent === undefined) throw new Error('memory_add requires an owning agent')
        const kind: MemoryNodeKind = a.kind === 'tool-result' ? 'tool-result' : 'note'
        const out = await service.append(exec.agent.id, kind, 'memory_add', a.text)
        return out
      },
    }))

    ctx.tools.register(defineTool({
      name: 'memory_recall',
      description: 'Return the FULL on-disk evidence for a memory ref from the index. Loads it into the immediate turn only; nothing persists into the index.',
      parameters: {
        ref: { type: 'string', required: true, description: 'The 16-char ref from a memory index entry.' },
      },
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            found: { type: 'boolean', required: true },
            ref: { type: 'string', required: true },
            text: { type: 'string', required: true },
          },
        },
        render: (_args, value) => {
          const v = value as { found: boolean; ref: string; text: string }
          return [{ type: 'text', text: v.found ? v.text : `no memory found for ref ${v.ref}` }]
        },
      },
      async execute(args, exec: ToolRunContext) {
        const a = args as { ref: string }
        if (exec.agent === undefined) throw new Error('memory_recall requires an owning agent')
        const text = service.fullByRef(exec.agent.id, a.ref)
        return text === undefined
          ? { found: false, ref: a.ref, text: '' }
          : { found: true, ref: a.ref, text }
      },
    }))

    ctx.tools.register(defineTool({
      name: 'memory_map',
      description: 'Render the current memory index on demand: ref, kind, source, and one-line summary per entry, newest first.',
      parameters: {},
      output: {
        schema: {
          type: 'object',
          additionalProperties: false,
          properties: {
            count: { type: 'integer', required: true },
            entries: {
              type: 'array', required: true,
              items: {
                type: 'object', additionalProperties: false,
                properties: {
                  ref: { type: 'string', required: true },
                  seq: { type: 'integer', required: true },
                  kind: { type: 'string', required: true },
                  source: { type: 'string', required: true },
                  summary: { type: 'string', required: true },
                },
              },
            },
          },
        },
        render: (_args, value) => {
          const v = value as { count: number; entries: { ref: string; seq: number; kind: string; source: string; summary: string }[] }
          if (v.count === 0) return [{ type: 'text', text: '(memory is empty)' }]
          const lines = v.entries.map(e => `[${e.kind}:${e.ref}] ${e.source}: ${e.summary}`)
          return [{ type: 'text', text: lines.join('\n') }]
        },
      },
      async execute(_args, exec: ToolRunContext) {
        if (exec.agent === undefined) throw new Error('memory_map requires an owning agent')
        const nodes = service.recent(exec.agent.id)
        return {
          count: nodes.length,
          entries: nodes.map(n => ({ ref: n.ref, seq: n.seq, kind: n.kind, source: n.source, summary: n.text })),
        }
      },
    }))

    ctx.effect(function* () {
      yield stopObserve
      yield stopAssemble
    }, 'agent-memory teardown')

    ctx.effect(function* () {
      yield () => domain.close()
    }, 'agent-memory domain close')
  })
}

export { memoryDomain, renderMemoryIndex, summarize, truncate }
export type { MemoryNode, MemoryNodeKind, MemoryDomain, MemoryNodeKey }
