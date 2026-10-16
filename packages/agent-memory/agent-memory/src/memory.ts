import { createHash } from 'node:crypto'
import type { MemoryNode, MemoryNodeKey } from './spec.ts'

/**
 * Record-key separator. `-` never appears in {@link foldAgentId}'s alphabet, so
 * a folded id can never swallow a separator and make one agent's record prefix
 * overlap another's. The backend's path-safe key alphabet (`[a-zA-Z0-9_-]`) is
 * what the whole key must satisfy, not the folded part alone.
 */
const KEY_SEP = '-'

/**
 * Fold one agent id into `[a-zA-Z0-9_]`: in the `per-record` layout a record key
 * becomes a file name, and an agent id legitimately carries characters (`.` `/`
 * `:`) that are not path segments. The appended digest of the RAW id keeps ids
 * that fold alike distinct and makes the folded part fixed-cost, so a record key
 * stays recognisable without being the identity.
 */
function foldAgentId(agentId: string): string {
  const folded = agentId.replace(/[^a-zA-Z0-9_]/g, '_')
  const digest = createHash('sha1').update(agentId).digest('hex').slice(0, 8)
  return `${folded}${KEY_SEP}${digest}`
}

/**
 * The backend record key of one agent's cursor row.
 * @param agentId - the agent's id.
 * @returns the key, safe for any backend and distinct per agent id.
 */
export function agentKey(agentId: string): string {
  return foldAgentId(agentId)
}

/**
 * Storage-key prefix shared by every node record of one agent.
 * @param agentId - the agent's id.
 * @returns the prefix a range scan of that agent's nodes uses.
 */
export function agentPrefix(agentId: string): string {
  return foldAgentId(agentId) + KEY_SEP
}

/**
 * The record key of one node; zero padding keeps keys in `seq` order.
 * @param agentId - the owning agent's id.
 * @param seq - the node's number.
 * @returns the node's record key.
 */
export function nodeKey(agentId: string, seq: number): MemoryNodeKey {
  return agentPrefix(agentId) + String(seq).padStart(12, '0')
}

/**
 * The content-addressed reference of one piece of evidence, which de-duplicates it and names it for recall.
 * @param kind - the node kind.
 * @param source - what produced the evidence.
 * @param full - the full evidence text.
 * @returns a 16-hex-digit reference.
 */
export function refOf(kind: MemoryNode['kind'], source: string, full: string): string {
  return createHash('sha1')
    .update(kind).update('\0').update(source).update('\0').update(full)
    .digest('hex').slice(0, 16)
}

/**
 * Flatten whitespace and fit text to a ceiling, keeping its start and end around an ellipsis.
 * @param text - the text to summarize.
 * @param maxChars - the ceiling.
 * @returns the one-line summary.
 */
export function summarize(text: string, maxChars: number): string {
  const flat = text.replace(/\s+/g, ' ').trim()
  if (flat.length <= maxChars) return flat
  const half = Math.floor((maxChars - 1) / 2)
  return half <= 0 ? flat.slice(0, maxChars) + '…' : `${flat.slice(0, half)}…${flat.slice(flat.length - half)}`
}

/**
 * Cut text to a ceiling.
 * @param text - the text.
 * @param maxChars - the ceiling.
 * @returns the text, or its first `maxChars` characters.
 */
export function truncate(text: string, maxChars: number): string {
  return text.length <= maxChars ? text : text.slice(0, maxChars)
}

/**
 * One index line: the node's tag and ref, its source, and its summary.
 * @param node - the node.
 * @returns the line.
 */
export function renderNode(node: MemoryNode): string {
  const tag = node.kind === 'note' ? 'note' : 'ev'
  return `[${tag}:${node.ref}] ${node.source}: ${node.text}`
}

/**
 * The prompt section listing the given nodes, or nothing for none.
 * @param nodes - the nodes, newest first.
 * @returns the section text, empty when there are no nodes.
 */
export function renderMemoryIndex(nodes: readonly MemoryNode[]): string {
  if (nodes.length === 0) return ''
  return 'Agent memory index (newest first). Recall a ref for the full evidence, or memory_map to refresh.\n'
    + nodes.map(renderNode).join('\n')
}
