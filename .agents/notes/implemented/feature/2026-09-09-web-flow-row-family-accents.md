# Agent Note: Flow-row family accents

Status: implemented

English | [中文](2026-09-09-web-flow-row-family-accents.zh.md)

## Problem

Every compact flow row in the transcript — the think disclosure, each tool call, the context-injection and system-prompt rows, and the skill row — drew its leading glyph, title, and separator dot from the same three neutral label tokens. A scrolled transcript was a column of identical grey rows, so finding the last Python call or the last file edit meant reading titles one by one. The only exception was the `cordis_*` override, which proved the presentation worked but covered one extension family. The code row's glyph made the neutral column worse: `IconCodeOutline16` is an octothorpe, which reads as a hashtag rather than as a program, and the row it labels is titled `Python`.

## Decision

`design-platform.css` declares a `--dsw-alias-flow-*` alias group with one hue per row family: `think` violet, `search` blue, `read` cyan, `mutate` green (write and edit, which already share one icon), `shell` orange, `code` yellow, `instruct` magenta, and `generic` lime. `instruct` covers the context-injection row, its recall variant, the system-prompt row, and the skill row — an injected instruction file, a skill catalog, a recalled session, and the complete system prompt are all text placed in the model's instructions, which is one kind of row however it was produced. `generic` covers the unclassified `others` variant, which is not a rare fallback here: the goal, RLM, and preset tools all land on it.

Both themes take the most chromatic value their surface allows at a 4.5:1 floor against `--dsw-alias-bg-base` — near-fluorescent on the dark surface, full-chroma mid-tones on the light one, where a fluorescent value cannot carry 13px text. The gap between the two is widest on yellow and cyan, whose hues are intrinsically light. The group is deliberately outside `--dsw-alias-state-*` and no flow hue sits on the red or amber ramps: `ToolRow` and `SkillRow` swap the leading glyph for a red or amber `StateDot` on a failed or interrupted call, so a family accent drawn from those ramps would read as run state.

`DisclosureRow` owns the rebinding seam. Its `.leading` and `.title` read `var(--dsh-row-accent, <neutral token>)`, so a consumer recolours the glyph and the title by setting one custom property and an unset row is byte-identical to the old neutral chrome. Each consumer applies the same value to the two parts the shared chrome does not own — its hover/open chevron and its separator dot — and the summary keeps its neutral tertiary tone because it is the row's content, not its kind. `SkillRow` builds its own chrome rather than composing `DisclosureRow`, so it rebinds and applies all four parts itself.

The rebind binds on the row element, never on an outer wrapper: `ToolCallTree` renders subcalls as nested rows inside the parent call's wrapper, and a wrapper binding would inherit the parent's hue into every child that sets none. `ToolRow` therefore writes `.root[data-variant='…'] .row`, and the `cordis_*` rule rebinds to the product accent from the same position, which requires it to sit after the variant rules it overrides (equal specificity; only source order breaks the tie).

The code variant's glyph is the new `IconBracesOutline16`, a hand-authored `{ }` at the icon family's 1.25 stroke weight. `IconCodeOutline16` keeps its other call sites (the dock header action and the two Cordis rows).

## Alternatives considered

**One hue per tool name.** Rejected: a palette has to be learnable. Eight families already put neighbouring hues about 45° apart, which the near-fluorescent dark values carry and the light ones only just do; a hue per tool name would need neighbours that read as the same colour on a scrolled row.

**A separate hue for the skill row.** Rejected: it would have been the ninth, and it would have split a coherent family — the skill row and the context rows carry the same kind of material into the same place. The glyphs already tell them apart.

**Leaving the unclassified `others` row neutral.** Shipped first and reversed: the reasoning was that an unclassified call should not claim a hue that means something on a classified one. In this harness that put the busiest rows outside the index, because the goal, RLM, and preset tools are all unclassified.

**Accent the glyph only, leaving titles neutral.** Rejected: the glyph is 14px of outline stroke, which is too little ink to index a column by at a glance. Colouring the title is also what the existing `cordis_*` rule already did, so extending it kept one presentation rather than introducing a second.

**Per-consumer overrides of `DisclosureRow`'s colours.** Shipped first and replaced: each row carried two-class selectors that outranked the primitive's own `.leading` and `.title`. Moving the fallback into the primitive deleted those overrides, made the seam one property instead of a specificity convention, and is what let the context and skill rows join by adding a single declaration.

**`</>` angle brackets for the code glyph.** Rejected: `IconInspectOutline12` is already that shape, and it renders as the trajectory affordance under the same expanded code row.

**A Python logo mark.** Rejected: the `code` variant covers `run_code` as well as `kernel`, and the mark is a PSF trademark whose geometry does not survive reduction to a 14px monochrome outline.

**A harness-owned `--dsh-flow-*` sheet beside `design-platform.css`.** Rejected: [ui-theme's README](../../../../packages/client/ui-theme/README.md) makes the token sheets the sole color authority and routes new colors through a static step plus a semantic alias. A second sheet would have split that authority for no gain.

## Testing

`flow-accent-tokens.client.spec.ts` reads `design-platform.css` and pins the group: the same eight accents in both themes, a different step per theme, no step shared between two families, every accent resolving to a static step that theme declares, and no accent on the red or amber ramps. `tool-row-accent-styles.client.spec.ts` pins the variant-to-token map for every variant, the two parts ToolRow itself colours, the cordis rule's position after the variant rules, and that every rebind selector ends at `.row` rather than `.root`. `disclosure-row-styles.client.spec.ts` pins the primitive's fallback, which is what keeps an unset row neutral. All three read CSS text because jsdom resolves no cascade.

## Consequences

Adding a row family now means adding an alias to both theme blocks and one `--dsh-row-accent` declaration on the row; the token test fails a one-sided addition or a reused step, and the row test fails a variant left neutral or a rebind placed where subcalls would inherit it. The palette spends six new static hues (cyan, lime, orange, pink, violet, yellow) and three added steps on existing ones, which is the cost of eight distinguishable families that avoid the two ramps run state owns. Light mode is the constrained side: its yellow and cyan are mid-tones rather than the near-fluorescent values the dark surface carries, because 13px text at 4.5:1 on white cannot be fluorescent. Run state still outranks family: a failed row shows its red dot and red summary over the family-coloured title.
