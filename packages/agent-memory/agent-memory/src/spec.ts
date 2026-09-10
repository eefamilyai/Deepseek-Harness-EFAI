import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

export type MemoryNodeKind = 'tool-result' | 'note'

export interface MemoryNode {
  readonly kind: MemoryNodeKind
  /** Bounded summary shown inside the prompt index. */
  readonly text: string
  /** Full evidence, kept ON DISK ONLY (never injected) and returned by recall. */
  readonly full: string
  /** Content-addressed reference of the FULL evidence (de-duplication + recall key). */
  readonly ref: string
  readonly source: string
  readonly seq: number
  readonly ts: number
}

export interface AgentCursor {
  readonly lastSeen: number
  readonly count: number
}

export const memoryNodeSchema = z.object({
  kind: z.enum(['tool-result', 'note']),
  text: z.string(),
  full: z.string(),
  ref: z.string(),
  source: z.string(),
  seq: z.number().int(),
  ts: z.number(),
})

export const agentCursorSchema = z.object({
  lastSeen: z.number(),
  count: z.number().int().min(0),
})

// The domain name doubles as the backend unit name, which must match
// UNIT_NAME_RE ([a-z][a-z0-9_]*) — hence the underscore, not the hyphen
// this package carries everywhere else.
export const memoryDomain = defineDomain({
  name: 'agent_memory',
  version: 1,
  layout: 'per-record',
  global: {
    schema: z.object({ cursor: z.number().int().min(0) }),
    initial: { cursor: 0 },
  },
  tables: {
    nodes: domainTable(memoryNodeSchema),
    agents: domainTable(agentCursorSchema),
  },
})

export type MemoryDomain = typeof memoryDomain
export type MemoryNodeKey = string
