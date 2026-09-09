# Agent Note: Flow-row family accents

Status: implemented

English | [中文](2026-09-09-web-flow-row-family-accents.zh.md)

## Problem

Every compact flow row in the transcript — the think disclosure and each tool call — drew its leading glyph, title, and separator dot from the same three neutral label tokens. A scrolled transcript was a column of identical grey rows, so finding the last Python call or the last file edit meant reading titles one by one. The only exception was the `cordis_*` override, which proved the presentation worked but covered one extension family. The code row's glyph made the neutral column worse: `IconCodeOutline16` is an octothorpe, which reads as a hashtag rather than as a program, and the row it labels is titled `Python`.

## Decision

`design-platform.css` declares a `--dsw-alias-flow-*` alias group with one hue per row family: `think` violet, `search` blue, `read` cyan, `mutate` green (write and edit, which already share one icon), `shell` orange, and `code` yellow. Each family resolves a different static step per theme — the darker step on the light surface, the lighter one on dark — so both clear 4.5:1 against that theme's `--dsw-alias-bg-base`. The group is deliberately outside `--dsw-alias-state-*` and avoids the red and amber ramps entirely: `ToolRow` swaps the leading glyph for a red or amber `StateDot` on a failed or interrupted call, so a family accent drawn from those ramps would read as run state.

`ToolRow` binds one `--dsh-row-accent` per `data-variant` and applies it to the leading glyph, the title, the hover/open chevron, and the separator dot; the summary keeps its neutral tertiary tone because it is the row's content, not its kind. `ReasoningRow` applies the think accent to the same four parts. The `others` variant sets no accent and falls through to the neutral label tokens — an unclassified call must not claim a hue that means something on a classified one — and the `cordis_*` rule now rebinds `--dsh-row-accent` to the product accent instead of restating three colors, which requires it to sit after the variant rules it overrides (both are one class plus one attribute, so only source order breaks the tie).

The code variant's glyph is the new `IconBracesOutline16`, a hand-authored `{ }` at the icon family's 1.25 stroke weight. `IconCodeOutline16` keeps its other call sites (the dock header action and the two Cordis rows).

## Alternatives considered

**One hue per tool name.** Rejected: a palette has to be learnable. Six families covering every classified variant stay distinguishable at 13px; nine or ten hues would need neighbours that read as the same color on a scrolled row, and `search` and `read` would gain nothing from separate hues their icons already carry.

**Accent the glyph only, leaving titles neutral.** Rejected: the glyph is 14px of outline stroke, which is too little ink to index a column by at a glance. Colouring the title is also what the existing `cordis_*` rule already did, so extending it kept one presentation rather than introducing a second.

**`</>` angle brackets for the code glyph.** Rejected: `IconInspectOutline12` is already that shape, and it renders as the trajectory affordance under the same expanded code row.

**A Python logo mark.** Rejected: the `code` variant covers `run_code` as well as `kernel`, and the mark is a PSF trademark whose geometry does not survive reduction to a 14px monochrome outline.

**A harness-owned `--dsh-flow-*` sheet beside `design-platform.css`.** Rejected: [ui-theme's README](../../../../packages/client/ui-theme/README.md) makes the token sheets the sole color authority and routes new colors through a static step plus a semantic alias. A second sheet would have split that authority for no gain.

## Testing

`flow-accent-tokens.client.spec.ts` reads `design-platform.css` and pins the group: the same six accents in both themes, a different step per theme, every accent resolving to a static step that theme declares, and no accent on the red or amber ramps. `tool-row-accent-styles.client.spec.ts` pins the variant-to-token map including `others`' absence, the four parts the accent reaches, and the cordis rule's position after the variant rules. Both read CSS text because jsdom resolves no cascade.

## Consequences

Adding a row family now means adding an alias to both theme blocks and one `--dsh-row-accent` rule; the token test fails a one-sided addition, and the row test fails a classified variant left neutral. The palette spends four new static hues (cyan, orange, violet, yellow) plus a green step, which is the cost of a set that avoids the two ramps run state owns. Run state still outranks family: a failed row shows its red dot and red summary over the family-coloured title.
