/**
 * Envelope patterns the gateway learned from its own transcripts.
 *
 * The taught format is one shape among many a degraded context produces. Rather
 * than wait for someone to hand-write a case per shape, the gateway can read its
 * own corpus: take replies that clearly contained a call (a declared tool name
 * next to a JSON object) that the reader did not recognise, and induce the
 * delimiters around them. A candidate is only kept when it recovers samples and
 * does *not* fire on replies that were plain prose — the induction is checked
 * against the corpus, not trusted.
 *
 * This is supervised-in-nothing learning: no labels, no model, just the two
 * constraints a delimiter must satisfy to be worth having.
 *
 * @module dswg/tools/learn
 */

import type { Db } from '../store/db.ts'
import type { ToolDefinition } from './protocol.ts'
import { salvageCalls } from './salvage.ts'
import { ToolCallExtractor } from './envelope.ts'

/** One induced delimiter pair. */
export interface MinedPattern {
  opener: string
  closer: string
  /** How many leaked samples this pair recovers. */
  hits: number
  /** How many prose samples it wrongly matched. */
  falsePositives: number
  /** hits - falsePositives. */
  score: number
  /** Up to three examples, for the dashboard. */
  samples: string[]
}

/** A stored pattern, as the reader loads it. */
export interface LearnedPattern {
  id: string
  opener: string
  closer: string
  score: number
  origin: string
  createdAt: number
  uses: number
}

/** How many characters of context around a call are considered. */
const CONTEXT_BEFORE = 60
const CONTEXT_AFTER = 30
/** Longest delimiter a pattern may claim. */
const MAX_OPENER = 24
const MAX_CLOSER = 16
/** How many candidates are validated before giving up on a corpus. */
const MAX_CANDIDATES = 60

/**
 * Context around every recoverable call in a reply.
 * @param text - one leaked reply.
 * @param tools - the tools its request declared.
 * @returns the text before and after each recovered call.
 */
function contexts(text: string, tools: readonly ToolDefinition[]): Array<{ before: string; after: string }> {
  const out: Array<{ before: string; after: string }> = []
  for (const call of salvageCalls(text, tools).calls) {
    const at = text.indexOf(call.raw)
    if (at === -1) continue
    out.push({
      before: text.slice(Math.max(0, at - CONTEXT_BEFORE), at),
      after: text.slice(at + call.raw.length, at + call.raw.length + CONTEXT_AFTER),
    })
  }
  return out
}

/**
 * Count how many *distinct* samples each delimiter pair appears in.
 *
 * The candidate space is every suffix of the leading context crossed with every
 * prefix of the trailing context, which is what makes this work for markers
 * nobody anticipated: the pairing is discovered, not matched against a list.
 * @param samples - one entry per leaked reply.
 * @returns pairs with the sample indexes they appeared in.
 */
function tallyCandidates(samples: Array<Array<{ before: string; after: string }>>): Map<string, Set<number>> {
  const tally = new Map<string, Set<number>>()
  samples.forEach((context, index) => {
    for (const { before, after } of context) {
      const maxOpen = Math.min(MAX_OPENER, before.length)
      for (let openLength = 1; openLength <= maxOpen; openLength += 1) {
        const opener = before.slice(before.length - openLength)
        if (opener.trim().length === 0) continue
        const maxClose = Math.min(MAX_CLOSER, after.length)
        for (let closeLength = 0; closeLength <= maxClose; closeLength += 1) {
          const closer = after.slice(0, closeLength)
          if (closeLength > 0 && closer.trim().length === 0) continue
          const key = `${opener}\u0000${closer}`
          const set = tally.get(key) ?? new Set<number>()
          set.add(index)
          tally.set(key, set)
        }
      }
    }
  })
  return tally
}

/**
 * Apply one candidate pair to a corpus and count what it does.
 * @param opener - the candidate opening delimiter.
 * @param closer - the candidate closing delimiter.
 * @param texts - the corpus.
 * @param tools - the tools to resolve against.
 * @returns how many texts now yield a call.
 */
function countHits(opener: string, closer: string, texts: readonly string[], tools: readonly ToolDefinition[]): number {
  let hits = 0
  for (const text of texts) {
    const extractor = new ToolCallExtractor(tools, [{ opener, closer }])
    const events = [...extractor.push(text), ...extractor.finish()]
    if (events.some((event) => event.type === 'call')) hits += 1
  }
  return hits
}

/**
 * Shrink a validated pattern to the shortest delimiters that still explain it.
 *
 * A homogeneous corpus shares whatever prose surrounded its calls, so the longest
 * common delimiter can be longer than the real marker ("Alright.\nBEGIN_CALL"
 * rather than "BEGIN_CALL"). Shortening is only allowed at a *token boundary*:
 * cutting inside `BEGIN_CALL` would leave `CALL`, which still matches the sample
 * by accident and would then fire on any word ending in it.
 * @param pattern - the validated pattern.
 * @param leaks - the positive corpus.
 * @param prose - the negative corpus.
 * @param tools - the tools to resolve against.
 * @returns the tightened delimiters.
 */
function tighten(
  pattern: { opener: string; closer: string; hits: number },
  leaks: readonly string[],
  prose: readonly string[],
  tools: readonly ToolDefinition[],
): { opener: string; closer: string } {
  const stillGood = (nextOpener: string, nextCloser: string): boolean =>
    nextOpener.trim().length > 0 &&
    nextCloser.trim().length > 0 &&
    countHits(nextOpener, nextCloser, leaks, tools) === pattern.hits &&
    countHits(nextOpener, nextCloser, prose, tools) === 0

  let opener = pattern.opener
  let closer = pattern.closer

  // Cut the opener after a boundary character, keeping the token that carries it.
  for (let index = 0; index < opener.length - 1; index += 1) {
    const at = opener[index] as string
    const next = opener[index + 1] as string
    if (!/[\s:>\]|]/.test(at) || /[\s:>\]|]/.test(next)) continue
    const candidate = opener.slice(index + 1)
    if (stillGood(candidate, closer)) {
      opener = candidate
      break
    }
  }

  // Cut the closer before a boundary character, keeping the token that closes it.
  for (let index = 1; index < closer.length; index += 1) {
    const at = closer[index] as string
    const previous = closer[index - 1] as string
    if (!/[\s:<>\[|]/.test(at) || /[\s:<>\[|]/.test(previous)) continue
    const candidate = closer.slice(0, index)
    if (stillGood(opener, candidate)) {
      closer = candidate
      break
    }
  }

  return { opener, closer }
}

/**
 * Induce delimiter pairs from leaked replies and validate them against the corpus.
 * @param leaks - replies that contained a call the reader missed.
 * @param prose - replies that were ordinary prose (the negative control).
 * @param tools - the tools those requests declared.
 * @param minimumHits - how many leaks a pattern must recover.
 * @returns the surviving patterns, best first.
 */
export function minePatterns(
  leaks: string[],
  prose: string[],
  tools: readonly ToolDefinition[],
  minimumHits = 2,
): MinedPattern[] {
  if (leaks.length === 0 || tools.length === 0) return []
  const contextsPerSample = leaks.map((text) => contexts(text, tools))
  const tally = tallyCandidates(contextsPerSample)

  const ranked = [...tally.entries()]
    .filter(([, indexes]) => indexes.size >= minimumHits)
    .map(([key, indexes]) => {
      const [rawOpener = '', rawCloser = ''] = key.split('\u0000')
      const opener = rawOpener.trim()
      const closer = rawCloser.trim()
      return { opener, closer, samples: indexes.size, specificity: opener.length + closer.length }
    })
    .filter((entry) => entry.opener.length > 0 || entry.closer.length > 0)
    // A longer delimiter is more specific: it fires on fewer unrelated texts.
    .sort((a, b) => b.samples - a.samples || b.specificity - a.specificity)
    .slice(0, MAX_CANDIDATES)

  const results: MinedPattern[] = []
  for (const candidate of [...ranked].sort((a, b) => b.specificity - a.specificity)) {
    // A delimiter that is a suffix/prefix of one already kept recovers the same
    // calls with less specificity, so it is the same finding, not a second one.
    const subsumed = results.some(
      (kept) =>
        (candidate.opener === '' || kept.opener.endsWith(candidate.opener)) &&
        (candidate.closer === '' || kept.closer.startsWith(candidate.closer)),
    )
    if (subsumed) continue
    const hits = countHits(candidate.opener, candidate.closer, leaks, tools)
    if (hits < minimumHits) continue
    const falsePositives = countHits(candidate.opener, candidate.closer, prose, tools)
    const score = hits - falsePositives
    if (score <= 0) continue
    const tightened = tighten({ opener: candidate.opener, closer: candidate.closer, hits }, leaks, prose, tools)
    const duplicate = results.some(
      (entry) =>
        entry.opener === tightened.opener &&
        (entry.closer.startsWith(tightened.closer) || tightened.closer.startsWith(entry.closer)),
    )
    if (duplicate) continue
    results.push({
      opener: tightened.opener,
      closer: tightened.closer,
      hits,
      falsePositives,
      score,
      samples: leaks.slice(0, 3).map((text) => text.slice(0, 200)),
    })
  }
  return results.sort((a, b) => b.score - a.score)
}

/** Persists learned patterns. */
export class PatternStore {
  #db: Db
  #cache: LearnedPattern[] | null = null

  /**
   * @param db - the database.
   */
  constructor(db: Db) {
    this.#db = db
  }

  /**
   * Every stored pattern, newest first.
   * @returns the patterns.
   */
  list(): LearnedPattern[] {
    if (this.#cache) return this.#cache
    const rows = this.#db.sql.prepare('SELECT * FROM learned_patterns ORDER BY score DESC').all() as unknown as Array<Record<string, unknown>>
    this.#cache = rows.map((row) => ({
      id: String(row.id),
      opener: String(row.opener),
      closer: String(row.closer),
      score: Number(row.score),
      origin: String(row.origin),
      createdAt: Number(row.created_at),
      uses: Number(row.uses),
    }))
    return this.#cache
  }

  /**
   * Store a pattern, ignoring one that already exists.
   * @param pattern - the mined pattern.
   * @param origin - where it came from.
   * @returns the stored pattern.
   */
  add(pattern: MinedPattern, origin = 'corpus'): LearnedPattern {
    const id = `${pattern.opener}\u0000${pattern.closer}`
    this.#db.sql
      .prepare(
        `INSERT INTO learned_patterns (id, opener, closer, score, origin, created_at, uses, samples)
         VALUES (?, ?, ?, ?, ?, ?, 0, ?)
         ON CONFLICT(id) DO UPDATE SET score = excluded.score`,
      )
      .run(id, pattern.opener, pattern.closer, pattern.score, origin, Date.now(), JSON.stringify(pattern.samples))
    this.#cache = null
    return this.list().find((entry) => entry.id === id) as LearnedPattern
  }

  /**
   * Record that a pattern did some work.
   * @param id - the pattern id.
   */
  touch(id: string): void {
    this.#db.sql.prepare('UPDATE learned_patterns SET uses = uses + 1 WHERE id = ?').run(id)
    this.#cache = null
  }

  /**
   * Delete one pattern.
   * @param id - the pattern id.
   * @returns true when a row was removed.
   */
  remove(id: string): boolean {
    const result = this.#db.sql.prepare('DELETE FROM learned_patterns WHERE id = ?').run(id)
    this.#cache = null
    return Number(result.changes) > 0
  }
}
