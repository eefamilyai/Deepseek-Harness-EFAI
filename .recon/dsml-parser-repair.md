# DSML parser repair — state at handoff

## Verified, reproducible

Baseline measured by stashing the only source change and rebuilding the host lib:

| tree | llm-dsml (286 tests) | llm-kiln dsml (126 tests) |
|---|---|---|
| HEAD, nothing of mine | 286 pass | **4 fail** |
| HEAD + one-line `scanParameters` fix | 286 pass | **3 fail** |

`tsc --noEmit -p packages/llm/llm-dsml/tsconfig.json` -> exit 0.
`pnpm run build:lib:host` -> exit 0.

The single change in the tree is `packages/llm/llm-dsml/src/dsml.ts`, `scanParameters`:

    - const token = new RegExp('<' + 'parameter\\s+(' + ATTRIBUTE_RUN + ')>|<' + '/parameter\\s*>', 'gi')
    + const token = new RegExp('<' + 'parameter\\b(' + ATTRIBUTE_RUN + ')>|<' + '/parameter\\s*>', 'gi')

It is a strict improvement: it fixes the committed kiln test "absorbs a stray
parameter beside the named ones instead of leaking it" and breaks nothing.
The remaining 3 kiln failures are **pre-existing at HEAD** — the committed tree
is already red. They are not regressions from this change.

## The 3 remaining kiln failures (all present at HEAD)

1. `does not tell the model a real tool does not exist`
2. `refuses a call whose last parameter never closed, </invoke> or not`
3. `says a wrapper around some OTHER notation ran nothing`

1 and 2 both assert the prose contains `unfinished tool call` and instead get the
raw block with **no note at all**. 3 asserts 0 calls and gets 1
(`kernel {code: 1+1}`) from the JSON-in-wrapper shape.

## Probe of the operator's shapes against the built lib

`.recon/probe-final.mjs` (tags assembled from char codes; re-run with `node`):

- A bare parameters, no invoke -> runs `kernel{code: print(1)}`
- B bare params + one real invoke -> runs only the real invoke; the bare group is dropped
- C truncated single invoke, no closer -> **correctly refused** (must stay refused)
- D operator's `job_output` + `browser` closer-bounded block -> **0 calls, prose**
- E clean two-invoke control -> 2 calls
- F JSON envelope inside the wrapper -> dispatches (specs disagree about this)
- G prose only -> prose

## The undecided policy fork

Shapes D and the committed test "refuses a call whose last parameter never closed"
are **byte-identical**: a parameter whose value is closed by </invoke> instead of
</parameter>. Making D run necessarily makes that refusal test's call run. A parameter
with **no closer at all** (shape C, `rm -rf /tmp/x`) stays refused either way.

Three readings were offered; the operator has not yet chosen:

1. Absorb and run it, and update the refusal test to match.
2. Keep the refusal; absorb only when no value can be truncated.
3. Absorb only when one declared tool owns every argument name in the group.

## Restart

The harness holds `llm-dsml` in memory from boot. `build:lib:host` cannot reach
the running process, so a restart is required to see any of this live:

    $lib = 'D:\deepseek-kernel-harness\packages\llm\llm-dsml\lib\index.js'
    $libTime = (Get-Item $lib).LastWriteTime
    $newest = Get-Process node -ErrorAction SilentlyContinue |
      Sort-Object StartTime -Descending | Select-Object -First 1
    if ($newest -and $newest.StartTime -gt $libTime) OK: post-dates the build
    else STALE: restart the harness

Resume the session after restarting; do not start fresh.
## Native DSML -> taught XML translation: verified matrix

Verified 2026-09-28 20:03 by `tests/native-spellings.spec.ts`
(11 tests), run through vitest against the real reader. Reader suite: 15 files / 297 tests green.

The token rewrite is ONE pass -- `DSML_TOKEN` (dsml.ts:513), applied by
`normalizeNative` (dsml.ts:1447) -- and it never consults the surrounding block.
That is why the malformed cases translate correctly too: the rewrite is
token-level, so its correctness is independent of whether the call is well-formed.

### Valid spellings -- all dispatch, no prose left behind

| # | Shape | Result |
|---|---|---|
| A | taught `<tool_calls>` control | dispatches |
| B | native, one pipe each side, space before word | dispatches |
| C | native, two pipes each side, space | dispatches |
| D | native, two pipes, NO space before word | dispatches |
| E | pipes on the LEFT of `DSML` only | dispatches |
| F | pipes on the RIGHT of `DSML` only | dispatches |
| G | over-piped, four pipes each side | dispatches |

The regex reads `< [pipes]* (/ ?) [pipes]* (?:DSML [pipes]*) + \s* (payload) >`, so
the pipe run is optional on BOTH sides of the word and the slash may ride anywhere
in the leading run. E and F are the cases the operator flagged as uncertain: both
sides work, because the pipe run before AND after `DSML` is optional.

### Malformed spellings -- three translate, one is refused on purpose

| # | Shape | Result |
|---|---|---|
| H | closer-spammed (surplus `parameter` closer) | dispatches, books `surplus-closer` |
| I | wrapped orphan (envelope, no `invoke` opener) | dispatches |
| J | second parameter lost its `name=` attribute | dispatches |
| K | unterminated (no closer ever arrived) | REFUSED, says `unfinished tool call` |

K is the deliberate refusal: nothing proves the argument ended, so running it would
invent one. That boundary is what keeps the reader predictable -- structure that
proves intent is read, and structure that does not is refused.

### One observation, deliberately left alone

A closer on its OWN LINE leaves its newline in the value (`"d.txt\n"`); a closer
inline does not. This is pre-existing and pinned as intended by
`tests/value-markup.spec.ts`, which asserts `code + '\n'`; downstream path
consumers trim. `stripSurplusClosers` (dsml.ts:368-381) slices at the surplus
closer's start, so the newline before it survives. Changing this would move an
asserted contract for no observed failure, so it was not touched.
