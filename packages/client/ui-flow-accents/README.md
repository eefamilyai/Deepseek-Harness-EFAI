---
description: "One hue per compact conversation-row family: the palette as a theme override layer plus the binding sheet that puts each hue on its rows."
kind: "package-reference"
---


# @deepseek-ai/dsh-client-ui-flow-accents

## Summary

Colour-codes the compact conversation rows by family, so a scrolled transcript can be indexed by hue: search, read, mutate, shell, code, think, instruction, and the generic call each get one accent. The package has two halves. The palette registers as a theme override layer, so it follows the active light/dark palette and retracts when this plugin unmounts. The binding sheet puts each hue on the rows, keyed on attributes upstream already emits — never on a CSS-module class, whose name is hashed per bundle and belongs to a bundle this package does not build.

## Table of Contents

- [Use this package](#use-this-package)
- [Why the binding is a stylesheet](#why-the-binding-is-a-stylesheet)
- [The two halves](#the-two-halves)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount it in a browser roster whose transcript should be colour-indexed; `packages/bundle/efai-web` does:

```yaml
- id: ui-flow-accents
  name: '@deepseek-ai/dsh-client-ui-flow-accents'
```

<a id="why-the-binding-is-a-stylesheet"></a>
## Why the binding is a stylesheet

The rows belong to upstream packages, and every one of those packages also ships inside the official Desktop's `resources/app.asar`, where the installed copy is resolved ahead of a source checkout — an edit on the row's own module stylesheet never renders there. The rows do export their family in the DOM for their own styling and tests: `data-variant` on a tool or think row's root, `data-tool` for the Cordis product accent, `data-sample='bash'` on the keyed shell view, `data-chat-node-key='system-prompt'` on the system-prompt node, `data-context-source`/`data-context-summary` inside a context-injection row, and `data-shimmer-decoration` on every separator dot. Selecting on those is what lets one fork-owned sheet bind the whole set.

Two properties the sheet encodes rather than inherits:

- **The token is declared on the family root, not on the row.** Custom properties inherit, so a subcall row nested inside another call's root resolves the nearest root by itself; a rule that bound the row directly would have to know which ancestor is nearest, which equal-specificity CSS cannot ask.
- **The read is scoped to family rows.** A bare `[data-disclosure-row]` rule would override upstream's own hover colour for every disclosure in the application, so each read selector names a family marker.

<a id="the-two-halves"></a>
## The two halves

| File | Role |
|---|---|
| `src/client/tokens.ts` | the palette, one `--dsw-alias-flow-*` alias and its step per family, registered as a theme layer |
| `src/client/accents.css` | the binding: each family's token on its root, the read that paints row text, and the separator dot |

The package spec reads both as artifacts: every tool variant upstream classifies is bound, every declared hue is bound (and only the one deliberate product accent is not a flow hue), the Cordis binding follows the variants it overrides, no read selector is a bare row, no selector matches a hashed class, and the dot is keyed on its own attribute.

No runtime invariant companion is published because the package holds no state: one registration and one stylesheet injection, both retracted or inert with the plugin fiber.

## Model Experience

None, as the package paints existing rows and registers no prompt section, tool schema, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A family whose row emits no stable attribute cannot be bound; the instruction family is reached through the system-prompt node key and the context row's own producer marker, so a context-injection row with neither a producer label nor a tool delta keeps the neutral tone.
- The binding depends on upstream's attribute names, not on a declared contract: if one disappears the row degrades to the neutral label tone rather than failing, and no test here can detect that.
