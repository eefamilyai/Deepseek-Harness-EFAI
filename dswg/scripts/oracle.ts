/**
 * Diff dswg's tool-call reader against the harness's own DSML translator.
 *
 * The harness is the client this gateway is built to serve, and its reader has
 * seen far more real replies than ours has. Running both over the same corpus
 * answers the only question that matters for that pairing: is there a reply the
 * harness can dispatch that this gateway would hand back as prose.
 *
 *   node scripts/oracle.ts [--verbose] [--limit 500]
 *
 * The harness package is a developer-side reference; when it is not checked out
 * the script says so and stops rather than pretending the corpus passed.
 *
 * @module dswg/scripts/oracle
 */

import { existsSync, readFileSync } from 'node:fs'
import { pathToFileURL } from 'node:url'
import { join } from 'node:path'
import { loadConfig } from '../src/config.ts'
import { openDatabase } from '../src/store/db.ts'
import { Corpus } from '../src/store/corpus.ts'
import { ToolCallExtractor } from '../src/tools/envelope.ts'
import { looksLikeCall, salvageCalls } from '../src/tools/salvage.ts'
import { PatternStore } from '../src/tools/learn.ts'
import type { ToolDefinition } from '../src/tools/protocol.ts'

/** Where the harness checkout keeps its reader. */
const HARNESS = join(import.meta.dirname, '..', '..', 'packages', 'llm', 'llm-text-toolcalls', 'src', 'index.ts')

/** The tool names the corpus mentions, as schemas both readers accept. */
const NAMES = ['read', 'write', 'edit', 'glob', 'grep', 'kernel', 'skill', 'pwsh', 'job_output', 'todo_write', 'subagent']
const TOOLS: ToolDefinition[] = NAMES.map((name) => ({ name, parameters: { type: 'object', properties: {} } }))

/** One corpus entry under test. */
interface Entry {
  id: string
  text: string
  source: string
}

/**
 * Read one `--flag value` argument.
 * @param name - flag without dashes.
 * @returns the value, or null.
 */
function arg(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

/** Collect the corpus: captured turns plus the recorded leak transcripts. */
function entries(): Entry[] {
  const config = loadConfig()
  const db = openDatabase(config.home)
  const corpus = new Corpus(db, config.home)
  const out: Entry[] = []
  for (const meta of corpus.recent(Number(arg('limit') ?? '500'))) {
    const payload = corpus.read(meta.turnId)
    if (payload && payload.text.trim().length > 0) out.push({ id: meta.turnId, text: payload.text, source: 'capture' })
  }
  db.sql.close()
  const leaks = join(import.meta.dirname, '..', '..', '.recon', 'leak-records.json')
  if (existsSync(leaks)) {
    const records = JSON.parse(readFileSync(leaks, 'utf8')) as { seq: number; text: string }[]
    for (const record of records) out.push({ id: `leak-${record.seq}`, text: record.text, source: 'leak' })
  }
  return out
}

/** The calls this gateway's reader produces, reader first then salvage. */
function mine(text: string, learned: ReturnType<PatternStore['list']>): string[] {
  const extractor = new ToolCallExtractor(TOOLS, learned)
  const events = [...extractor.push(text), ...extractor.finish()]
  const calls = events.filter((event) => event.type === 'call').map((event) => (event as { call: { name: string } }).call.name)
  if (calls.length > 0) return calls
  if (!looksLikeCall(text, TOOLS)) return []
  return salvageCalls(text, TOOLS).calls.map((call) => call.name)
}

/** The harness reader's module surface. */
interface TranslatorModule {
  DsmlTranslator: new (tools: unknown, options?: unknown) => {
    push(text: string): Iterable<{ kind: string; name?: string }>
    end(): Iterable<{ kind: string; name?: string }>
  }
}

/** The calls the harness's own reader produces. */
async function theirs(reader: TranslatorModule, text: string): Promise<string[]> {
  const translator = new reader.DsmlTranslator(new Map(TOOLS.map((tool) => [tool.name, { name: tool.name, description: tool.name, parameters: tool.parameters }])), { notes: false })
  const events = [...translator.push(text), ...translator.end()]
  return events.filter((event) => event.kind === 'tool-call').map((event) => event.name ?? '?')
}

/** Run the comparison. */
async function main(): Promise<void> {
  const verbose = process.argv.includes('--verbose')
  if (!existsSync(HARNESS)) {
    console.log(`harness reader not found at ${HARNESS}`)
    console.log('this comparison needs the deepseek-harness checkout; nothing was verified')
    process.exitCode = 2
    return
  }
  const harness = (await import(pathToFileURL(HARNESS).href)) as TranslatorModule
  const config = loadConfig()
  const db = openDatabase(config.home)
  const learned = new PatternStore(db).list()
  db.sql.close()

  const corpus = entries()
  let agreeCall = 0
  let agreeNone = 0
  let missed = 0
  let extra = 0
  const misses: string[] = []
  const extras: string[] = []
  for (const entry of corpus) {
    const ours = mine(entry.text, learned)
    const harnessCalls = await theirs(harness, entry.text)
    if (harnessCalls.length > 0 && ours.length > 0) agreeCall += 1
    else if (harnessCalls.length === 0 && ours.length === 0) agreeNone += 1
    else if (harnessCalls.length > 0) {
      missed += 1
      misses.push(`${entry.id} [${entry.source}] harness=${harnessCalls.join(',')} ours=none :: ${entry.text.slice(0, 150).replace(/\n/g, ' ')}`)
    } else {
      extra += 1
      extras.push(`${entry.id} [${entry.source}] ours=${ours.join(',')} harness=none :: ${entry.text.slice(0, 150).replace(/\n/g, ' ')}`)
    }
  }
  console.log(`${corpus.length} reply(s) compared against the harness reader`)
  console.log(`  both dispatch:      ${agreeCall}`)
  console.log(`  both see prose:     ${agreeNone}`)
  console.log(`  harness only (MISS): ${missed}`)
  console.log(`  ours only:           ${extra}`)
  if (misses.length > 0) {
    console.log('\nmisses:')
    for (const miss of (verbose ? misses : misses.slice(0, 15))) console.log(`  ${miss}`)
  }
  if (extras.length > 0 && verbose) {
    console.log('\nours only:')
    for (const line of extras) console.log(`  ${line}`)
  }
  process.exitCode = missed > 0 ? 1 : 0
}

await main()
