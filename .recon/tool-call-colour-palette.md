# Tool-call accent palette (2026-11-03)

## Request

Keep the flow accents (they colour tool-call rows) but "make the colour variety
larger and more pleasing to the eye".

## What the old palette did

`packages/client/ui-flow-accents` bound eight families to eight hues: think
violet, search blue, read cyan, mutate green, shell orange, code yellow, instruct
pink, generic lime. Two problems were visible in a real transcript:

- `write` and `edit` both bound `--dsw-alias-flow-mutate`, so the two mutations a
  scan most needs to tell apart were the same colour, and the generic lime sat a
  hue away from the mutate green — six distinguishable colours, not eight.
- The steps were declared on design-system names (`--dsw-static-blue-350`,
  `--dsw-static-violet-400`, …). `--dsw-static-violet-400` is a real design-system
  token (rgb(167, 139, 250)), so the layer repainted it for the whole app.

## What it does now

Nine families, one hue each, spaced in OKLCH at one perceived lightness per
palette: rose 352 (instruct), orange 40 (shell), gold 85 (code), green 138
(write), teal 198 (edit), cyan 228 (read), azure 260 (search), violet 302
(think), and a neutral slate 270/0.02 for the generic row. Chroma is capped at
what sRGB holds at that lightness, which is what keeps neighbouring hues apart at
13px, and every value clears 4.5:1 on its own background — 8.0–9.1:1 on the dark
surface (`#151517`), 4.9–5.8:1 on white.

`write` and `edit` now bind separate aliases. The steps live in the package's own
`--dsw-static-flow-<family>-bright`/`-deep` namespace, so nothing upstream reads
is overridden.

## Verification

- `npx vitest run packages/client/ui-flow-accents`: 13 passed (token layer and
  binding sheet, including "binds every hue the palette declares, and no hue it
  does not").
- Served to a live client and read back from the DOM: `getComputedStyle` on real
  transcript rows resolves think `rgb(196,155,255)`, bash `rgb(255,144,105)`,
  write `rgb(131,200,106)`, read `rgb(80,193,238)`, code `rgb(223,169,12)`,
  generic `rgb(173,178,192)` — the new palette, not the packaged one.
- Palette previews were rendered through headless Chrome before committing
  (`.scratch/flow-preview/`).

## How it reached the running app without a rebuild

A loader patch entry cannot rename a row's module: `name` on a non-insert patch
asserts the existing name instead of replacing it, which is why the first attempt
left the packaged bundle in place. The working shape is disable + insert:

```yaml
- id: ui-flow-accents
  disabled: true
- insert:
    - id: ui-flow-accents-checkout
      name: 'D:/deepseek-kernel-harness/packages/client/ui-flow-accents/lib/index.js'
```

The client-modules scanner accepts a path-like row (`isAbsolute`/`file:`) and
resolves the nearest package manifest, so it serves the checkout's `lib/client.js`.
Delete both entries to fall back to the packaged copy; a future installer build
carries the palette natively because it rebuilds this package.

## Follow-up fixed in the same pass

The 0.2.2-alpha.3 release bumped the family version on 414 manifests, and
`local-overlay/rebuild.mjs` then refused the tree for 373 upstream-owned manifests
that differ only in that line. `classify()` now takes the base commit and keeps
such a manifest out of Tier 2 (`RELEASE-MANAGED`), so release churn stays out of
the seam patches. Gates: `pnpm run verify-fork-overlay` green at 17 patches, 71
Tier-2 files, base `f3803c9697`.
