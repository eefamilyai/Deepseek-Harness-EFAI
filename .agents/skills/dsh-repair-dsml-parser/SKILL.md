---
name: dsh-repair-dsml-parser
description: Use when the DSML tool-call reader (packages/llm/llm-dsml) has stopped dispatching the agent's own calls — tool calls arrive flattened onto one line with their closers stripped, parse as prose, or draw a "no such tool" note; when the agent can no longer use its tools and must hand the operator PowerShell scripts to run instead; or when hardening the reader against a newly observed malformed shape. Covers the script-only emergency posture, tag-literal hygiene, the parser's choke points, the one-directional truncation rule, anchor-checked edits, and the verify-then-restart gate.
---

# Repairing the DSML parser from inside a broken tool channel

The reader at `packages/llm/llm-dsml` is what turns a model's text-channel tool-call markup into real calls. When it breaks, it breaks the agent that is trying to fix it: the agent's own tool calls are the input to the thing that is broken. This skill is the procedure for getting out of that state.

## 1. Recognise the symptom

A broken reader is not silent. It has three tells, and they are distinguishable:

| What the operator sees | What it means |
|---|---|
| Tool calls arrive on ONE line, every opener intact, every closer and newline gone | Something upstream stripped the closers. The reader's `unfinished()` guard reads that as a command cut off mid-write and refuses it. |
| A block reaches the user as raw markup, followed by `[no such tool …]` | The block parsed to nothing and the reader guessed the tool was unknown. |
| The agent reports it cannot use its tools, then writes scripts for the operator to run | The first two, confirmed. |

Do not guess at the layer. The reader can be tested on the exact bytes in isolation, which is what section 7 does.

## 2. First move: stop using the tool channel

Once tool calls are not dispatching, every further tool call is wasted output. Switch posture immediately and say so plainly:

- Write the fix as a PowerShell script the operator runs and pastes back.
- One script per turn. Read its output before writing the next.
- Never write a script that assumes the previous one succeeded; check its anchors first (section 6).

This is slower than using tools and it is the only thing that works. Say why, once, and get on with it.

## 3. Tag-literal hygiene — the rule that keeps scripts runnable

A script that repairs the parser, and that itself contains a literal parameter closer inside a string, will be truncated by the very reader it is meant to fix. The failure is self-similar and it will look like the parser is still broken.

**Build every tag literal from character codes.** Never write one directly, in any script, in any language:

```powershell
$LT = [char]60; $GT = [char]62; $SL = [char]47
$PC = "$LT$SL" + "parameter$GT"    # the parameter closer, assembled
$IC = "$LT$SL" + "invoke$GT"       # the invoke closer
```

```javascript
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const PC = LT + SL + 'parameter' + GT
```

```python
LT, GT, SL = chr(60), chr(62), chr(47)
PC = LT + SL + 'parameter' + GT
```

The same discipline applies to TypeScript the script *writes*: a test fixture can build its input the same way, and a source edit can assemble a closer in code. The one place a literal closer is unavoidable is a source file that must contain real markup — there, make the edit through a script whose own payload carries a placeholder, and substitute it from `[char]` codes as the last step.

## 4. Where the parser decides

Three methods carry the whole reader. Knowing them is what makes an anchored edit possible.

| Site | Job | Why it matters here |
|---|---|---|
| `consumeLine` | one line: suppression, learning, native-dialect rewrite, fence/span illustration, block open/close | Per-line, so a guard that needs the whole block cannot live here alone |
| `closeBlock` | joins a buffered block and hands it to `parseCalls` | Runs once the model's own closer arrived |
| `parseCalls` | text to calls: `INVOKE`, `INVOKE_OPEN`, `invokeArguments` | **The choke point.** Every close path funnels through it, including `end()`'s flush of a block the model never closed |

Put a repair that needs the joined block in `parseCalls`. Putting it only in `closeBlock` misses the flush path; putting it only in `consumeLine` misses the fact that per line the guard sees one invoke and stands down.

`end()` flushes a block through `parseCalls` directly, not through `closeBlock`. Verify which path a new test actually exercises before claiming both are covered.

## 5. The rule that must not regress

`unfinished()` answers exactly one question: **is an opener still waiting for its closer?**

```ts
function unfinished(body: string): boolean {
  const counts = parameterCounts(body)
  return counts.open > counts.close
}
```

One direction only. A body with MORE closers than openers is FINISHED — every argument closed, and the surplus tag is structure to drop. Reading the two counts against each other made a complete, correct call look truncated, so it fell through to prose and drew a note telling the model its tool did not exist. That regression is expensive: the model then "corrects" a spelling that was never wrong and writes the identical block again.

If a change makes `unfinished` symmetric, stop.

## 6. Edit by anchor, and refuse to guess

An edit script must locate its target exactly and abort when it cannot. A near-miss that silently writes nothing is worse than a failure, because the next verification run looks clean while the fix is absent.

```powershell
function Fail($m) { Write-Host "ABORT: $m" -ForegroundColor Red; exit 1 }
$text = Get-Content $file -Raw
$n = ([regex]::Matches($text, [regex]::Escape($anchor))).Count
if ($n -ne 1) { Fail "anchor found $n time(s), expected 1" }
$text = $text.Replace($anchor, $replacement)
```

Three habits that follow:

- **Back up before editing**, with a timestamped suffix, and delete the backups once the gate is green. Stale `.bak` files accumulate and pollute `git status`.
- **Anchors go stale between turns.** Re-read the region before writing the anchor; do not reuse one from an earlier turn's output. A large edit can be re-cut against the real text once the abort prints it.
- **Prefer appending a new exported function to editing an existing one.** Function declarations hoist, so an appended helper needs no insertion point and cannot half-apply.

## 7. Verify in this order

The reader's behaviour is only visible in the built artifact, so a source-level test alone does not prove the fix:

1. **Typecheck** — `npx tsc --noEmit -p packages/llm/llm-dsml/tsconfig.json`. A removed call site leaves an unused private method and `noUnusedLocals` fails on it.
2. **Tests** — `npx vitest run packages/llm/llm-dsml`. Read the count, not just the exit code; a spec file that failed to load also exits non-zero.
3. **Build** — `pnpm run build:lib:host`. Let it finish; it takes about forty seconds.
4. **Probe the built lib** — `node` against `packages/llm/llm-dsml/lib/index.js`. This is the one that matters: it exercises the artifact the harness actually loads, and it reports the dispatch count for the exact shape being fixed.
5. **Negative cases in the probe** — a single truncated invoke stays untouched, a block that kept one closer is left alone, prose is unchanged, and a repaired block names its shape. A positive result with a broken negative is not a fix.

## 8. The restart is not optional

The harness loads `llm-dsml` once at boot and holds the module graph in memory. `build:lib:host` rewrites files on disk; it cannot reach into the running process.

**A green build and a green probe still mean the operator is running the old parser.** Tell them to restart, and tell them how to confirm it took:

```powershell
$lib = 'D:\deepseek-kernel-harness\packages\llm\llm-dsml\lib\index.js'
$libTime = (Get-Item $lib).LastWriteTime
$newest = Get-Process node -ErrorAction SilentlyContinue |
  Sort-Object StartTime -Descending | Select-Object -First 1
if ($newest -and $newest.StartTime -gt $libTime) { 'OK: running process post-dates the build' }
else { 'STALE: restart the harness' }
```

Resume the session after restarting rather than starting fresh, or the transcript is lost.

## 9. When the reader is innocent

If the mangling happens upstream — in the model-output encoder, the transport, or a render step — the reader never saw clean input and no parser change will help. Two facts separate the cases:

- The reader can be fed the exact bytes through the built lib. If it dispatches there but not in the live session, the reader is innocent.
- A closer-stripped block with sibling invokes is repairable and is now repaired. A *display* artifact that also flattens the source means the reader was never the problem.

Say which it is rather than assuming, and do not ship a parser change for a transport bug.

## 10. Hardening against the next shape

When a new malformed shape appears, the reader's job is to decide whether it is **decidable**:

- If structure proves the intent — a second invoke opener proving the first closed, a fence marking displayed rather than executed text, a unique schema match — read it, and record it in `src/catalog.ts` with a `saw` / `fix` / `example` triple.
- If it does not — an ambiguous prefix matching two parameters, a lone truncated invoke — refuse it. Guessing is what makes a parser unpredictable, and an unpredictable parser is worse than a strict one.

Add the shape to `KNOWN_SHAPES`, add a test that fails without the rule, and add a negative test that the rule does not fire where it should not. A rule with no negative test is a rule that will widen.
