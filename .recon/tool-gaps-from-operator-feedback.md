# Tool gaps from operator feedback (2026-10-21)

A prior session reported what it lacked while building a rendering task. This
note records the triage (fork-owned vs. not) and what was actually changed.

## Triage

| # | Report | Fork-owned? | Action |
| --- | --- | --- | --- |
| 1 | `browser` cannot run JS or show the console; async throws are invisible | **Yes** — `packages/web/web-browser` is Tier 1 | Added `eval` and `console` actions on both drivers |
| 1b | Screenshot fails on a minimised window ("the page drew no new frame") | Partly — sidebar surface is the Desktop window | Not fixed; see below |
| 1c | Deterministic capture at time T (render t=0, t=0.5, t=1.0) | Would be headless-only | Not fixed; see below |
| 2 | No image analysis (silhouette, luminance, frame diff) | **Yes** — `python/kiln/runtime/` is Tier 1 | Added `image_tools.py` + 7 preloaded helpers |
| 3 | `npm install` dies with `spawn EPERM` | No — sandbox policy (piped grandchild stdio) | Not a code change; see below |
| 4 | Dead kernel poisons everything; `tool_help()` crashed three times | **Yes** — `packages/kernel/kernel-python` is Tier 1 | Start-up crash now retried once in a fresh process |
| 5 | `edit` refuses after own `pwsh` write; PowerShell `.Replace()` trap | No — upstream tools / PowerShell | Not a code change |

## What changed

### `browser` eval and console (Tier 1)

`packages/web/web-browser/src/inspect.ts` (new) holds the page-side scripts:

- `evalScript(code)` — `eval`s the model's code in the page so expressions,
  statements, and returned promises all work; serializes the completion value
  with cycles, `BigInt`, functions, DOM nodes, and `undefined` made printable
  instead of throwing.
- `installConsoleScript()` / `readConsoleScript()` — a bounded recorder for
  `console.*`, `window.onerror`, and `unhandledrejection`. Reading advances a
  cursor, so a second call reports only new entries while history survives.
- `formatEvalResult` / `formatConsoleRead` — model-facing text.

`driver.ts` gained `evaluateScript(target, script)`. The headless driver installs
the recorder through `page.addInitScript({ content })` at page creation; the
sidebar driver installs it via the existing `evaluate` op after every `navigate`
(the window cannot inject before the document's own scripts, so load-time errors
are the one thing the sidebar surface cannot capture — reported as such, not
silently dropped). `BROWSER_ACTIONS` is now
`navigate, read, click, type, press, scroll, back, screenshot, eval, console`,
and the tool description plus the `tool:browser` prompt section explain when to
reach for them.

### Image measurement in the kernel (Tier 1)

`python/kiln/runtime/image_tools.py` (new), registered in `kernel_child.py` with
the same both-places pattern the vision and image tools use (`prompt_dict` makes
a helper callable, `globals()` is what `tool_help` scans):

`analyze_image`, `compare_images`, `region_stats`, `luminance_rows`,
`dominant_colors`, `image_diff_mask`, `preview_image`.

Every helper takes a path, a `data:` URL, raw base64, bytes, or a PIL image, and
returns plain numbers: content bounding box and its share of the frame, per-channel
means and deviations, luminance profile per horizontal band, changed-pixel counts
with the box that contains them. Pure Pillow, no new dependency.

### Kernel start-up retry (Tier 1)

`KernelChild.everReady` records whether the child ever answered its `ready`
frame. `KilnKernelProvider.execute` retries a cell once when the child crashed
*before* becoming ready — that child never executed the code, so re-sending it
cannot repeat a side effect. A crash after `ready` is still reported, never
retried. This is what turns "every cell says Kernel crashed mid-run" into a
working call.

## Two bugs found by browser-level verification

The unit tests passed while the feature was still broken; both were caught only
by driving real Chromium (`.scratch/browser-inspect-e2e.ts`, 11 checks):

1. **`page.addInitScript(string)` never ran the recorder.** Playwright's bare
   string overload does not execute the source as written. Fixed by using the
   documented `{ content }` form. Without this the `console` action would have
   reported "no recorder is installed" forever.
2. **`Image.convert('L')` hid single-channel changes.** The change mask and the
   content box were computed on luminance, so a delta confined to one channel
   rounded to zero — a colour shift would have read as "no change". Replaced with
   a per-pixel maximum across channels (`_channel_peak`).

## Verification

- `packages/web/web-browser`: 35 tests pass (`inspect.spec.ts` 9, `tool.spec.ts`
  17, `sidebar-driver.spec.ts` 9); package typecheck ok.
- Real Chromium: 11/11 — recorder installed on navigation, `console.log` with
  arguments, `console.error`, uncaught async error, unhandled rejection, cursor
  semantics, `eval` expression / statements / awaited promise / throw / circular.
- `packages/kernel/kernel-python`: 7 tests pass (`runtime-dir.spec.ts` 5,
  `startup-retry.spec.ts` 2 — the retry test proves the first start failed via a
  marker file and the cell still ran); package typecheck ok.
- `python/kiln/runtime/test_image_tools.py`: 24 checks pass.
- Live kernel: helpers registered (`tool_help("analyze_image")` resolves),
  measured a real frame — content box `[40,30,51,51]`, 2601 px, a moved-rect diff
  of 2550 changed pixels with the containing box, a 4-band luminance profile, and
  a written diff mask.
- `verify-seam-frozen`: 71 upstream files, 71 in tree — the seam did not grow.
  Every change above is Tier 1.

## Not done, and why

- **`spawn EPERM` for `npm install`.** That is the documented sandbox boundary:
  a grandchild process cannot open a piped stdio handle under the confined
  policy. Fixing it means changing sandbox policy, not harness code, and it is a
  security decision rather than a bug. The practical escape is to run installs
  under `danger-full-access` (this session did) or to pre-provision dependencies.
- **`edit` refusing after an own `pwsh` write.** Upstream file tools; the
  read-before-write guard cannot distinguish "changed by my own shell" from
  "changed by someone else". A fork-owned relaxation would weaken a real safety
  check, so it needs an upstream decision.
- **Deterministic capture at time T.** The right primitive is Playwright's
  `page.clock` (install/pauseAt/fastForward), which can drive `setTimeout` and
  `requestAnimationFrame`. It is headless-only: the Desktop sidebar has no clock
  control, so the action would refuse on the surface the operator usually uses.
  Worth doing deliberately with a `driver: headless` requirement rather than
  bolting on an action that fails half the time.
- **Screenshot on a minimised window.** The failure comes from the sidebar
  surface's own capture path (the window compositor has no new frame to read).
  A headless capture would need the page to be re-hosted, which changes which
  browser the operator is watching.

## Live status

The Python changes are live now — the kernel runs from
`python/kiln/runtime` (see [kernel-crashing-on-tool-calls.md](kernel-crashing-on-tool-calls.md)),
and the new helpers were exercised in the running kernel.

The TypeScript changes (`eval`/`console` actions, start-up retry) are in the fork
source and its build graph, but the running Desktop app loads a packaged
`app.asar`; they take effect after a rebuild, not on reload.
