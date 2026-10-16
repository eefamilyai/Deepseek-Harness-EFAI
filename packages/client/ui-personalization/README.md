---
description: "Personalization settings section: fonts, line spacing, accent, layout widths, corners, scrollbars, real transparency, backdrop, blur, shadows, and motion — applied as token overrides."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-personalization

## Summary

The theme owns the tokens; this row owns the overrides. A **Personalization** settings section edits one volatile field per choice, in five groups — **Typography**, **Colour**, **Layout**, **Transparency**, **Effects** — and the browser half turns those values into a stylesheet the page wears. Every field defaults to "leave the theme alone", so mounting the plugin changes nothing until someone chooses something.

## What it writes

The engine composes one `<style>` element under the id `dsh-personalization`:

| Group | Field | Effect |
|---|---|---|
| Typography | `fontFamily` | `--dsw-font-family`; presets System, Segoe UI, Inter, Rounded, Humanist, Condensed, Serif, Mono. |
| | `codeFontFamily` | `--ds-font-family-code`, which every code composite resolves through. |
| | `fontScale` | A root `font-size` percentage, so every `rem` in the shell scales together. |
| | `lineHeight` | The message-text composites (`--dsw-font-markdown-base*`) re-declared with the line height multiplied. |
| Colour | `accent` | `--dsw-alias-state-business-primary` plus the washes derived from it with `color-mix`; fourteen swatches and a colour picker. |
| | `accentEverywhere` | Also links, message bubbles, and the current sidebar row. |
| Layout | `contentWidth` | `--dsh-chat-content-width` on `[data-conversation-content]`; a fixed choice hides the column's drag handles. |
| | `settingsWidth` | The width of `[data-shortcut-modal='settings']`, the settings panel (800px in the theme). |
| | `radiusScale` | Every `--dsw-radius-*` step multiplied by the scale. |
| | `scrollbars` | `--dsh-scrollbar-width` on every element (the theme re-binds it per surface); `hidden` also sets `scrollbar-width: none`. |
| Transparency | `shellOpacity` | The sidebar's own fills, its navigation rows, *and the document itself*: below 100% the page stops painting its background, so the window is genuinely see-through. |
| | `surfaceOpacity` | The layer stack (cards, bubbles, inputs) faded by its own amount. |
| | `panelOpacity` | The settings dialog and floating surfaces; a translucent dialog also blurs what it floats over. |
| | `glassBlur` | `--dsw-menu-backdrop-filter` and the translucent dialog's blur radius. |
| Effects | `backdrop`, `backdropImage` | A gradient or an `https:`/`http:`/`data:image/` image painted on the document, seen through the translucent layers. Choosing one while every layer is solid lowers the shell and surface to 80%. |
| | `shadows` | `--dsw-shadow-lv*` and the per-element `--dsw-elevation-*` tokens removed or strengthened. |
| | `reduceMotion` | Animation and transition durations cut to an instant. |

The overrides are `:root:root`-scoped because the theme declares tokens on the root element *and* on the themed body, and a custom property is inherited from the nearest ancestor that sets one. Every opacity is a `color-mix` over the palette token the theme itself uses, in both palettes. The field vocabulary and defaults live in [`src/options.ts`](src/options.ts), which both the Host schema and the browser half read.

No invariant companion is published: the stylesheet is recomputed from the one live record on every change, so there is no second observation of the choices that could diverge from it.

A write moves the page in the same step and is then sent to the row. A field the running Host refuses — most often one added after the Host started — keeps its value in this window, and the section says so until a write of that field is accepted.

## Model Experience

### Appearance overrides

#### What the model sees

Nothing. The section edits this deployment's own row and writes `dsh-personalization`, one `<style>` element, into the page; no field, value, or token reaches a request, a tool schema, or a session event.

#### Token effect

None. The choices are browser presentation, and they are not part of any model input.

#### KV Cache effect

None. The plugin contributes no prompt section and never touches an assembled request.

## Known Limitations and Deferred Work

- The client bundle is built from `lib/types`, so `tsc -b tsconfig.client.json` must run before `tsdown --env.DSH_BUILD_FACE client`. Running the bundler alone repackages whatever the last emit held: the source, the specs, and the profile all agree while the running page still executes older code, which reads as a fix that does not work.
- A new field reaches the Host only when the Host restarts, because the row's schema is loaded at boot; until then the section reports the field as unsaved.
- Window transparency is the launched application's property, not this plugin's: the desktop app creates its window with `transparent: true` over `backgroundMaterial: 'acrylic'` and a fully transparent background colour, which is why clearing the page background reveals the desktop. A host that creates a plain opaque window would instead reveal the window's own fill, and nothing here can change that from inside the page.
- The blur and tint of what shows through belong to the operating system's window material. macOS Reduce Transparency and Windows transparency effects change how strong the effect looks, and neither is observable from the page.
- The layout choices select on attributes other packages render (`data-conversation-content`, `data-width-handle`, `data-shortcut-modal='settings'`), so a rename upstream silently turns those choices off.
- A font preset names fonts the machine may not have; the stack falls through to the next installed family.
