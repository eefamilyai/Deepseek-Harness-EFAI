// The catalogue of malformed tool-call shapes the reader repairs, and the
// repair each one gets. The reader already repairs all of these silently,
// because a repaired call runs. What it could not do is remember them:
// every new malformation cost the same investigation as the last one.
// This module is that memory.
//
// Two halves. KNOWN_SHAPES is the seed shipped with the reader. recordShape
// appends a shape the seed has never seen to one JSON file at one fixed path.
// Nothing here walks a directory: the path comes from an explicit argument,
// then DSML_CATALOG, then a fixed home path, so every call is O(1) in the
// size of the tree and O(0) in the size of any directory.

import { homedir } from 'node:os'
import { dirname, join } from 'node:path'
import { mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs'

// One malformed shape the reader has learned to take.
export interface RepairShape {
  // Stable kebab-case key; the seed and the file are joined on this.
  readonly id: string
  // How the model wrote it, in the shape's own terms.
  readonly saw: string
  // What the reader does with it, in one line.
  readonly fix: string
  // A concrete spelling, so the rule is testable rather than described.
  readonly example: string
  // How many times a live reader has repaired this shape, when counting is on.
  readonly hits?: number
}

// Every malformed shape the reader repairs today.
//
// This is the seed, not a limit: recordShape grows the file beside it. The
// order is the order the reader tests them, which is why a shape that can be
// mistaken for another sits where the reader puts it.
export const KNOWN_SHAPES: readonly RepairShape[] = [
  {
    id: 'structural-notation',
    saw: 'a complete call written in a notation the spelling rules never learned, so it reached prose intact',
    fix: 'the tool name and its named values are read by structure, and the residue must reduce to punctuation and envelope words',
    example: '{"tool": "kernel", "arguments": {"code": "print(1)"}}',
  },
  {
    id: 'closer-stripped',
    saw: 'every opener kept and every closer lost, so intact arguments read as a command cut off mid-write',
    fix: 'a second invoke opener proves the first closed; the provable closers are restored before the parse',
    example: '<invoke name="read"><parameter name="path">a.txt <invoke name="read"><parameter name="path">b.txt',
  },
  {
    id: 'surplus-closer',
    saw: 'an argument that closed, then a second parameter closer before the invoke closer',
    fix: 'the surplus closer is dropped; every argument closed, so the call is whole and runs',
    example: '<invoke name="skill"><parameter name="name">x</parameter></parameter></invoke>',
  },
  {
    id: 'missing-invoke-close',
    saw: 'arguments all closed, but no invoke closer, so the outer wrapper is the only closer',
    fix: 'the wrapper closes the call; a missing invoke closer carries nothing the arguments need',
    example: '<tool_calls><invoke name="read"><parameter name="path">a.txt</parameter></tool_calls>',
  },
  {
    id: 'fused-opener',
    saw: 'two openers fused into one tag, the first cut off mid-write',
    fix: 'everything ahead of the inner opener is dropped and the inner tag is read',
    example: '<parameter name="invoke name="kernel">',
  },
  {
    id: 'nameless-parameter',
    saw: 'a parameter whose name was eaten, leaving a bare word and a stray closing quote',
    fix: 'the leading word is read as the name and the opener is rebuilt',
    example: '<｜｜DSML｜｜ timeoutMs" string="false">',
  },
  {
    id: 'equals-tag',
    saw: 'an equals sign where the name attribute belongs',
    fix: 'the tag is rebuilt with name= and the name it carried',
    example: '<invoke="kernel">',
  },
  {
    id: 'pipe-wrapped-token',
    saw: 'the provider special tokens, pipe-wrapped DSML, with the DSML word on either side of the pipe run',
    fix: 'the payload is read as a keyword plus attributes and rewritten into the taught tag, whichever side of the pipes the word sits on',
    example: '<｜｜DSML｜｜ tool_calls>',
  },
  {
    id: 'bare-frame',
    saw: 'the model own frame word with no pipes around it',
    fix: 'the frame carries nothing the reader needs and is removed',
    example: '<_calls>',
  },
  {
    id: 'tool-named-tag',
    saw: 'the tool named as its own tag instead of as an invoke',
    fix: 'the tag is rewritten as an invoke naming that tool',
    example: '<kernel><parameter name="code">1</parameter></kernel>',
  },
  {
    id: 'orphan-parameter',
    saw: 'a parameter with no invoke naming a tool — either alone on its line, or under the '
      + 'taught wrapper with the opener never written',
    fix: 'the tool is inferred when exactly one declared tool owns every argument written, '
      + 'and an invoke is synthesized around them',
    example: '<parameter name="pattern">two-stars-slash-star.ts</parameter>',
  },
  {
    id: 'json-body',
    saw: 'a JSON arguments object where parameter elements belong',
    fix: 'the object is read as the arguments when every key is this tool own',
    example: '<invoke name="search_files">{"query":"x"}</invoke>',
  },
  {
    id: 'system-reminder-echo',
    saw: 'the system prompt recited back inside a system_reminder span',
    fix: 'the whole span is suppressed; it is framing, never the model answer',
    example: '<system_reminder>You have tools</system_reminder>',
  },
  {
    id: 'orphan-closer',
    saw: 'a taught closer in prose with no open block to close',
    fix: 'the closer is structure, not content, and is dropped',
    example: 'The call ran.</parameter>',
  },
  {
    id: 'near-miss-argument',
    saw: 'an argument named the way a human would spell it rather than the way the schema does',
    fix: 'the name is placed in the one declared slot it folds or prefixes onto; two candidates refuse it',
    example: '<parameter name="filePath">a.txt</parameter>',
  },
  {
    id: 'orphan-group',
    saw: 'the taught wrapper, whole arguments, an invoke closer between them, and no invoke opener',
    fix: 'each closer bounds one call; the tool is inferred per group when exactly one declared tool owns that group own arguments',
    example: '<tool_calls><parameter name="code">1</parameter></invoke><parameter name="code">2</parameter></invoke></tool_calls>',
  },
  {
    id: 'closer-spam',
    saw: 'a run of closer-only lines with nothing between them, the model repeating structure',
    fix: 'the turn is stopped and the model is told to write the call again; nothing in the run is a call',
    example: '</invoke>\n</invoke>\n</invoke>\n</invoke>\n',
  },
]

// The catalogue as it sits on disk.
export interface CatalogFile {
  readonly version: 1
  readonly shapes: readonly RepairShape[]
  // Exact-text rewrites learned by observation; see LearnedLiteral.
  readonly literals?: readonly LearnedLiteral[]
}

// One exact-text rewrite the reader learned by observing its own repair.
//
// Literal, never a pattern. A catalogue that could inject a regular expression
// into the reader would be a parser that anyone able to write that file could
// rewrite, and this file is a diagnostics log rather than a rule engine. An
// observed fragment is replayed verbatim or not at all.
export interface LearnedLiteral {
  // The exact text as it arrived.
  readonly broken: string
  // What that text becomes.
  readonly fixed: string
  // How many times a reader has applied it.
  readonly hits?: number
}

// Where the catalogue lives when nothing names a path.
export const DEFAULT_CATALOG_PATH = join(homedir(), '.dsh', 'dsml-catalog.json')

// The literals of one parsed file, kept for the life of the process.
//
// A stream reader builds a translator per text block and the learned pass runs
// on every line, so re-reading and re-parsing the file for each block would
// make a diagnostics feature cost more than the parse it annotates. Every write
// clears this, so a fragment learned this turn is live on the next one.
let cached: { readonly path: string; readonly literals: readonly LearnedLiteral[] } | undefined

// The one path this module reads and writes.
//
// Resolution is a fixed chain of lookups and never a search: an explicit
// argument wins, then DSML_CATALOG, then a fixed path under the home
// directory. A test points DSML_CATALOG at a temp file; a user points it at a
// checkout to keep the catalogue in version control. Nothing here lists a
// directory to find it.
export function catalogPath(explicit?: string, env: NodeJS.ProcessEnv = process.env): string {
  if (explicit !== undefined && explicit.length > 0) return explicit
  const override = env.DSML_CATALOG
  if (override !== undefined && override.length > 0) return override
  return DEFAULT_CATALOG_PATH
}

// The hit-counter key for one learned literal.
//
// A literal has no stable id the way a named shape does — the broken text IS
// its identity — so the counter is keyed on it. The prefix keeps the two key
// spaces from colliding: a fragment that happened to spell a shape id is still
// counted as a literal, not folded into that shape's total.
export function literalKey(broken: string): string {
  return 'literal:' + broken
}

// Read one entry as a literal rewrite, or undefined when it is not one.
//
// Bounded on purpose. A fragment longer than a tag run is a document, and
// replaying it would rewrite text the model meant. A rewrite that changes
// nothing is refused rather than stored, because it would be applied forever
// without ever being reported as a repair.
function asLiteral(value: unknown): LearnedLiteral | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const broken = entry.broken
  const fixed = entry.fixed
  if (typeof broken !== 'string' || broken.length === 0 || broken.length > 512) return undefined
  if (typeof fixed !== 'string' || fixed === broken) return undefined
  // A structural closer is never a repair target. Learning "delete this exact
  // text" for a closer made every later well-formed block lose its closers, so
  // each one read as a command cut off mid-write. Refused on read as well as on
  // write, so a file already holding such an entry cannot take effect.
  if (/<\/(?:parameter|invoke|tool_calls)\s*>/i.test(broken)) return undefined
  const hits = entry.hits
  if (hits !== undefined && typeof hits !== 'number') return undefined
  return hits === undefined ? { broken, fixed } : { broken, fixed, hits }
}

// Every literal rewrite the catalogue holds, parsed once per process.
//
// A missing or unreadable file is the normal first run, not an error: the
// reader then behaves exactly as it did before it could learn.
export function learnedLiterals(explicit?: string): readonly LearnedLiteral[] {
  // A reader with no catalogue established learns nothing and replays nothing.
  // Without this the default path under the home directory was read anyway, so
  // a test process replayed whatever a live session had written there — host
  // state deciding the result of a pure parse.
  if (!countingOn(explicit)) return []
  const path = catalogPath(explicit)
  if (cached !== undefined && cached.path === path) return cached.literals
  let literals: readonly LearnedLiteral[] = []
  try {
    const parsed: unknown = JSON.parse(readFileSync(path, 'utf8'))
    if (typeof parsed === 'object' && parsed !== null) {
      const raw = (parsed as { literals?: unknown }).literals
      if (Array.isArray(raw)) {
        literals = raw.map(asLiteral).filter((one): one is LearnedLiteral => one !== undefined)
      }
    }
  } catch {
    literals = []
  }
  cached = { path, literals }
  return literals
}

// Write the catalogue beside its target and rename, so a reader never sees half
// a file, then drop the parse cache so the next read sees what was written.
function writeCatalog(path: string, file: CatalogFile): void {
  mkdirSync(dirname(path), { recursive: true })
  const staging = path + '.tmp'
  writeFileSync(staging, JSON.stringify(file, null, 2) + '\n', 'utf8')
  renameSync(staging, path)
  cached = undefined
}

// Remember one exact-text rewrite, so the next turn applies it before parsing.
//
// Best-effort like the rest of this module, and a no-op when the fragment is
// already known: a model that repeats one malformation every turn appends one
// entry and not one per turn.
export function recordLiteral(broken: string, fixed: string, explicit?: string): boolean {
  const entry = asLiteral({ broken, fixed })
  if (entry === undefined) return false
  // Learning writes the same diagnostics file the counters do, so it obeys the
  // same switch: with neither an explicit path nor DSML_CATALOG, a reader stays
  // a pure function of its input and a test run touches nothing. The plugin
  // establishes the default at boot, which is what makes this automatic in the
  // running harness rather than in every caller that happens to parse.
  if (!countingOn(explicit)) return false
  try {
    if (learnedLiterals(explicit).some(known => known.broken === entry.broken)) return false
    const path = catalogPath(explicit)
    const file: CatalogFile = {
      version: 1,
      shapes: loadCatalog(path),
      literals: [...learnedLiterals(path), entry],
    }
    writeCatalog(path, file)
    return true
  } catch {
    return false
  }
}

// Read the catalogue, or the seed when there is nothing to read.
//
// A missing file is the normal first run, not an error. So is a file holding
// something this module did not write: it is ignored rather than repaired,
// because guessing at a stranger JSON is how a diagnostics file starts failing
// parses.
export function loadCatalog(explicit?: string): readonly RepairShape[] {
  const merged = new Map<string, RepairShape>()
  for (const shape of KNOWN_SHAPES) merged.set(shape.id, shape)
  let raw: string
  try {
    raw = readFileSync(catalogPath(explicit), 'utf8')
  } catch {
    return [...merged.values()]
  }
  let parsed: unknown
  try {
    parsed = JSON.parse(raw) as unknown
  } catch {
    return [...merged.values()]
  }
  if (typeof parsed !== 'object' || parsed === null) return [...merged.values()]
  const shapes = (parsed as { shapes?: unknown }).shapes
  if (!Array.isArray(shapes)) return [...merged.values()]
  for (const entry of shapes) {
    const shape = asShape(entry)
    if (shape === undefined) continue
    // The seed owns the RULE and the file owns the COUNT. A shape the reader
    // ships a rule for must not be redefined by a file written against an older
    // build — but its hit count is the one thing the file exists to hold.
    // Discarding the entry whole dropped every count on every read, so a shape
    // that had been repaired a thousand times read back as never seen.
    const seeded = merged.get(shape.id)
    if (seeded === undefined) merged.set(shape.id, shape)
    else if (shape.hits !== undefined) merged.set(shape.id, { ...seeded, hits: shape.hits })
  }
  return [...merged.values()]
}

// Note a shape the seed has never seen, so the next investigation starts from
// a written-down example instead of a transcript.
//
// Best-effort by construction. This runs while a malformed call is being read,
// and a reader that throws here has turned a repaired call into a failed turn;
// every failure path returns false and leaves the parse untouched. A shape
// already present, by id, is a no-op, so a model that repeats its mistake
// every turn appends one line and not one per turn.
export function recordShape(shape: RepairShape, explicit?: string): boolean {
  const path = catalogPath(explicit)
  try {
    const existing = loadCatalog(path)
    let seen = false
    for (const candidate of existing) {
      if (candidate.id === shape.id) seen = true
    }
    if (seen) return false
    // The literals are carried through untouched: a shape learned by name must
    // not erase the fragments learned by observation.
    const file: CatalogFile = { version: 1, shapes: [...existing, shape], literals: learnedLiterals(path) }
    writeCatalog(path, file)
    return true
  } catch {
    return false
  }
}

// Read one entry off disk as a shape, or undefined when it is not one.
//
// The catalogue is a diagnostics file a human may edit and a model may mangle,
// so every field is checked before it is trusted. A partial entry is discarded
// whole rather than filled in: a shape with no fix says nothing about what the
// reader should do, and keeping half of it would put an unusable rule in front
// of the next investigation.
function asShape(value: unknown): RepairShape | undefined {
  if (typeof value !== 'object' || value === null) return undefined
  const entry = value as Record<string, unknown>
  const id = entry.id
  const saw = entry.saw
  const fix = entry.fix
  const example = entry.example
  if (typeof id !== 'string' || id.length === 0) return undefined
  if (typeof saw !== 'string') return undefined
  if (typeof fix !== 'string') return undefined
  if (typeof example !== 'string') return undefined
  const hits = entry.hits
  if (hits !== undefined && typeof hits !== 'number') return undefined
  return hits === undefined ? { id, saw, fix, example } : { id, saw, fix, example, hits }
}

// Whether counting is switched on for this process.
//
// A hit counter is only worth keeping where something asked for it. Without
// an explicit path or DSML_CATALOG, a reader stays a pure function of its
// input: it repairs, it counts in memory, and it writes nothing. That is what
// keeps a test run and an ordinary turn from appending to a file in the home
// directory they never asked about.
function countingOn(explicit?: string, env: NodeJS.ProcessEnv = process.env): boolean {
  if (explicit !== undefined && explicit.length > 0) return true
  const override = env.DSML_CATALOG
  return override !== undefined && override.length > 0
}

// Add one hit to each named shape, in a single read and a single write.
//
// Callers hand over every id one turn repaired, not one id at a time: the cost
// of the file is the read and the write, so batching a turn into one pass keeps
// a chatty model from turning the catalogue into a per-token disk workload. An
// id the seed does not carry is ignored rather than invented, because a shape
// with no rule behind it has nothing to say about what the reader does.
//
// Best-effort like the rest of this module. A turn that cannot write the
// catalogue still runs its calls.
export function bumpShapes(ids: readonly string[], explicit?: string): boolean {
  if (ids.length === 0) return false
  if (!countingOn(explicit)) return false
  const path = catalogPath(explicit)
  try {
    const counted = new Map<string, number>()
    for (const id of ids) counted.set(id, (counted.get(id) ?? 0) + 1)
    const shapes = loadCatalog(path)
    const known = learnedLiterals(path)
    // A turn whose ids all name nothing the file carries has nothing to write,
    // so the read is the whole of its cost.
    const carries = shapes.some(shape => counted.has(shape.id))
      || known.some(literal => counted.has(literalKey(literal.broken)))
    if (!carries) return false
    const next = shapes.map((shape) => {
      const bump = counted.get(shape.id)
      if (bump === undefined) return shape
      return { ...shape, hits: (shape.hits ?? 0) + bump }
    })
    // A literal that was applied this turn is counted by the same rule, so the
    // file records which learned fragments are actually earning their keep.
    const literals = known.map((literal) => {
      const bump = counted.get(literalKey(literal.broken))
      if (bump === undefined) return literal
      return { ...literal, hits: (literal.hits ?? 0) + bump }
    })
    writeCatalog(path, { version: 1, shapes: next, literals })
    return true
  } catch {
    return false
  }
}
