import { z } from 'zod'
import { defineDomain, domainTable } from '@deepseek-ai/dsh-storage-domain'

/** Where a memory node came from: a captured tool result, or a note the agent wrote. */
export type MemoryNodeKind = 'tool-result' | 'note'

/** One remembered piece of evidence, stored as a record of the `nodes` table. */
export interface MemoryNode {
  /** Whether the node captured a tool result or a written note. */
  readonly kind: MemoryNodeKind
  /** Bounded summary shown inside the prompt index. */
  readonly text: string
  /** Full evidence, kept ON DISK ONLY (never injected) and returned by recall. */
  readonly full: string
  /** Content-addressed reference of the FULL evidence (de-duplication + recall key). */
  readonly ref: string
  /** What produced the evidence: the tool name, or the note's label. */
  readonly source: string
  /** The agent's monotonic node number, which orders the index newest first. */
  readonly seq: number
  /** Epoch milliseconds when the node was recorded. */
  readonly ts: number
}

/** One agent's progress through its own memory, stored as a record of the `agents` table. */
export interface AgentCursor {
  /** The highest node `seq` recorded for the agent. */
  readonly lastSeen: number
  /** How many nodes the agent has recorded. */
  readonly count: number
}

/** Record validation for {@link MemoryNode}. */
export const memoryNodeSchema = z.object({
  kind: z.enum(['tool-result', 'note']),
  text: z.string(),
  full: z.string(),
  ref: z.string(),
  source: z.string(),
  seq: z.number().int(),
  ts: z.number(),
})

/** Record validation for {@link AgentCursor}. */
export const agentCursorSchema = z.object({
  lastSeen: z.number(),
  count: z.number().int().min(0),
})

// The domain name doubles as the backend unit name, which must match
// UNIT_NAME_RE ([a-z][a-z0-9_]*) — hence the underscore, not the hyphen
// this package carries everywhere else.
/** The storage domain holding every agent's memory nodes and cursors. */
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

/** The type of {@link memoryDomain}. */
export type MemoryDomain = typeof memoryDomain
/** A node record key: the agent's folded prefix and the zero-padded `seq`, see `nodeKey`. */
export type MemoryNodeKey = string
