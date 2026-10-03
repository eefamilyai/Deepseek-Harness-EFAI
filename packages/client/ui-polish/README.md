---
description: "Whole-client interaction polish: one motion language for the shell, layered elevation in both palettes, overlay entrances, and consistent control feedback."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-polish

## Summary

The client's feel, as one injected stylesheet. It retunes the shell's motion
scale (three durations and the single curve that forty-three component
transitions share), re-points the curve for the many transitions that name the
bare `ease` keyword, rebuilds elevation as layered shadow pairs in both palettes,
gives every floating surface one entrance, adds press feedback to menus and
options, and tints selection, caret, and native controls from the product accent.
It selects only on design tokens, ARIA roles and states, the app frame's state
attributes, and element selectors — never on a CSS-module class.

## Table of Contents

- [Use this package](#use-this-package)
- [Why a stylesheet and not a component](#why-a-stylesheet-and-not-a-component)
- [What it changes](#what-it-changes)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount it in a browser roster; `packages/bundle/efai-web` does, ahead of the
surfaces it paints:

```yaml
- id: ui-polish
  name: '@deepseek-ai/dsh-client-ui-polish'
```

<a id="why-a-stylesheet-and-not-a-component"></a>
## Why a stylesheet and not a component

The polish spans every surface in the app — the shell frame, the docks, menus,
dialogs, tooltips, toasts, tables, prose, scrollbars — and a component would have
to own, or wrap, most of them to reach them. The contracts this sheet selects on
are stable by construction: tokens are the design system's public interface, ARIA
roles and states are required for accessibility, and the app frame publishes its
panel state as attributes. A CSS-module class would be the one tempting,
unavailable option: those are hashed per bundle and belong to packages this
plugin does not build.

<a id="what-it-changes"></a>
## What it changes

| Layer | Change |
|---|---|
| Motion tokens | `--ds-ease-in-out` becomes a decelerating curve, two more join it, and the three durations are rebalanced |
| Curve fallback | `transition-timing-function` on every element re-points the transitions that named `ease`, keeping their durations and property lists |
| Materials | `--dsw-shadow-lv*` and `--dsw-elevation-*` become layered contact/ambient/wide shadows; dark mode separates by hairline instead of black on black |
| Overlays | `[role='dialog' | 'menu' | 'listbox' | 'tooltip']` gain a short pop-in, and `[data-closing]` a matching exit |
| Controls | menus and options acknowledge a press with travel; disabled controls drop the pointer affordance; tabs and switches take the standard duration |
| Typography | font smoothing, `text-wrap: pretty` for prose and `balance` for headings, tabular code numerals, accent-tinted selection, caret, and native controls |

Two rules are load-bearing and asserted by specs: the sheet never sets the
`transition` shorthand (which would wipe a component's property list) and never
sets `animation-timing-function` (which would ease the shimmer, marquee, and
spinner loops that are linear on purpose).

No runtime invariant companion is published because the package holds no state
and registers no service: it injects one stylesheet, and its specs assert the
sheet's contract — the selectors it may use, the tokens it must retune, the two
rules above, and that the reduced-motion block collapses every duration it
introduces.

## Model Experience

None, as the package paints existing surfaces and registers no prompt section, tool schema, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The app frame animates `grid-template-columns` while a panel toggles, which is a layout animation and cannot be replaced from here: the track width is the panel's layout, and only the owning component can animate a transform instead. Retuning the curve and duration is what this layer can do.
- Exit animations cover the components that publish a closing state; a menu that unmounts with no such state still disappears at once, because CSS cannot delay an unmount.
- Elevation is retuned per palette through `--dsw-shadow-*`; a surface that hardcodes its own shadow instead of reading a token keeps it.
