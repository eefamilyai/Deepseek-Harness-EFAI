/**
 * Replay the corpus through the current parser.
 *
 * Every captured turn holds the model's actual output. Running the reader over
 * all of them answers two questions a unit test cannot: did a change make an
 * output that used to parse stop parsing, and did it make one that used to leak
 * parse now.
 *
 *   node scripts/replay.ts [--limit 500] [--verbose]
 *
 * @module dswg/scripts/replay
 */

import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/store/db.ts'
import { Corpus } from '../src/store/corpus.ts'
import { ToolCallExtractor } from '../src/tools/envelope.ts'
import { looksLikeCall, salvageCalls } from '../src/tools/salvage.ts'
import { looksLikeRoleplay } from '../src/tools/roleplay.ts'
import { PatternStore } from '../src/tools/learn.ts'
import type { ToolDefinition } from '../src/tools/protocol.ts'

/**
 * Read one `--flag value` argument.
 * @param name - flag without dashes.
 * @returns the value, or null.
 */
function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

/**
 * Replay the corpus.
 */
function main(): void {
  const config = loadConfig()
  const db = openDatabase(config.home)
  const corpus = new Corpus(db, config.home)
  const patterns = new PatternStore(db)
  const limit = Number(arg('limit') ?? '500')
  const verbose = process.argv.includes('--verbose')

  const turns = corpus.recent(limit)
  if (turns.length === 0) {
    console.log('no captured turns yet — run some traffic first')
    db.sql.close()
    return
  }

  const learned = patterns.list()
  let parsedNow = 0
  let leakedNow = 0
  let narrated = 0
  let recovered = 0
  let regressed = 0
  let unavailable = 0
  const shapes = new Map<string, number>()
  const problems: string[] = []

  for (const meta of turns) {
    const payload = corpus.read(meta.turnId)
    if (!payload) {
      unavailable += 1
      continue
    }
    const text = payload.text
    if (text.trim().length === 0) continue
    const tools: ToolDefinition[] = meta.tools.map((name) => ({ name, parameters: { type: 'object', properties: {} } }))

    const extractor = new ToolCallExtractor(tools, learned)
    const events = [...extractor.push(text), ...extractor.finish()]
    const calls = events.filter((event) => event.type === 'call')
    const malformed = events.filter((event) => event.type === 'malformed')

    if (tools.length > 0 && calls.length === 0 && looksLikeRoleplay(text, null)) {
      // The turn is answered again with a correction, so the reply costs one
      // retry rather than reaching the user as an invented result.
      narrated += 1
      if (verbose) problems.push(`narrated ${meta.turnId}: answered in the tool's voice`)
    }

    if (tools.length > 0 && calls.length === 0 && looksLikeCall(text, tools)) {
      const salvage = salvageCalls(text, tools)
      if (salvage.calls.length > 0) {
        recovered += 1
        for (const call of salvage.calls) shapes.set(call.shape, (shapes.get(call.shape) ?? 0) + 1)
        if (verbose) problems.push(`recovered ${meta.turnId}: ${salvage.calls.map((call) => call.name).join(', ')}`)
      } else if (salvage.unrecovered) {
        leakedNow += 1
        problems.push(`LEAK ${meta.turnId} (${meta.tools.join(',')}): ${text.slice(0, 120).replace(/\n/g, ' ')}`)
      } else if (verbose) {
        problems.push(`quoted ${meta.turnId}: the reply talks about tool markup without making a call`)
      }
    }
    if (calls.length > 0) {
      parsedNow += 1
      for (const event of calls) shapes.set((event as { call: { source: string } }).call.source, (shapes.get((event as { call: { source: string } }).call.source) ?? 0) + 1)
      if (meta.leaked) regressed += 1
    }
    if (malformed.length > 0 && calls.length === 0 && verbose) {
      problems.push(`malformed ${meta.turnId}: ${(malformed[0] as { error: string }).error}`)
    }
  }

  console.log(`replayed ${turns.length} captured turn(s)`)
  if (unavailable > 0) console.log(`  ${unavailable} payload(s) no longer on disk (pruned)`)
  console.log(`  parsed by the reader:     ${parsedNow}`)
  console.log(`  recovered by salvage:    ${recovered}`)
  console.log(`  still leaking:           ${leakedNow}`)
  console.log(`  answered in the tool's voice: ${narrated}`)
  if (regressed > 0) console.log(`  previously-leaked turns that now parse: ${regressed}`)
  console.log(`  shapes: ${[...shapes.entries()].map(([shape, count]) => `${shape}=${count}`).join(' ') || 'none'}`)
  if (problems.length > 0) {
    console.log('\nnotes:')
    for (const problem of problems.slice(0, 40)) console.log(`  ${problem}`)
  }
  db.sql.close()
  void join
}

main()
