/**
 * Mine tool-call delimiters from the gateway's own corpus.
 *
 * The reader knows a fixed set of envelopes. Anything else arrives as prose: the
 * call never runs and the raw markup reaches the user. This command reads every
 * reply recorded as a leak, induces the delimiters around the calls those
 * replies clearly contained, and keeps only pairs that recover them without
 * firing on ordinary prose.
 *
 *   node scripts/mine.ts                # report proposals
 *   node scripts/mine.ts --apply        # store them for the reader to use
 *   node scripts/mine.ts --min-samples 3 --limit 500
 *
 * @module dswg/scripts/mine
 */

import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/store/db.ts'
import { Corpus } from '../src/store/corpus.ts'
import { PatternStore, minePatterns } from '../src/tools/learn.ts'

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
 * Run the miner.
 */
function main(): void {
  const config = loadConfig()
  const db = openDatabase(config.home)
  const corpus = new Corpus(db, config.home)
  const patterns = new PatternStore(db)

  const minimumHits = Number(arg('min-samples') ?? '2')
  const limit = Number(arg('limit') ?? '300')
  const apply = process.argv.includes('--apply')

  const leakRows = corpus.leakSamples(limit)
  if (leakRows.length === 0) {
    console.log('no leaks recorded yet — the reader has not missed a call the model tried to make')
    db.sql.close()
    return
  }

  const toolNames = new Set<string>(corpus.knownToolNames())
  for (const row of leakRows) for (const name of row.tools) toolNames.add(name)
  const tools = [...toolNames].map((name) => ({ name, parameters: { type: 'object', properties: {} } }))
  const prose = corpus.proseSamples(limit)

  console.log(`corpus: ${leakRows.length} leak(s), ${prose.length} prose sample(s), ${tools.length} known tool name(s)`)
  const proposals = minePatterns(
    leakRows.map((row) => row.text),
    prose,
    tools,
    Number.isFinite(minimumHits) && minimumHits > 0 ? minimumHits : 2,
  )

  if (proposals.length === 0) {
    console.log('no new delimiter pair recovers enough leaks without matching prose')
  }
  for (const proposal of proposals) {
    const opener = JSON.stringify(proposal.opener)
    const closer = JSON.stringify(proposal.closer)
    console.log(`  opener ${opener}  closer ${closer}  hits=${proposal.hits} falsePositives=${proposal.falsePositives} score=${proposal.score}`)
    if (apply) patterns.add(proposal, 'cli')
  }
  if (apply && proposals.length > 0) console.log(`stored ${proposals.length} pattern(s); the reader uses them from the next turn`)
  if (!apply && proposals.length > 0) console.log('re-run with --apply to store them')

  console.log(`\nknown patterns: ${patterns.list().length}`)
  for (const pattern of patterns.list()) {
    console.log(`  ${JSON.stringify(pattern.opener)} … ${JSON.stringify(pattern.closer)}  score=${pattern.score} uses=${pattern.uses}`)
  }
  db.sql.close()
  void join
}

main()
