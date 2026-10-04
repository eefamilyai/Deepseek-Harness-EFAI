---
description: "Personalization settings section: interface font, root size, accent, corner scale, shell and surface opacity, and the backdrop a translucent shell reveals — applied as token overrides."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-personalization

## Summary

The theme owns the tokens; this row owns the overrides. A **Personalization** settings section edits one volatile field per choice — font stack, root font size, accent, corner scale, shell opacity, surface opacity, and the backdrop behind a translucent shell — and the browser half turns those values into a stylesheet the page wears. Every field defaults to "leave the theme alone", so mounting the plugin changes nothing until someone chooses something.

## What it writes

The engine composes one `<style>` element under the id `dsh-personalization`:

- **Font** — `--dsw-font-family`, and a root `font-size` percentage so every `rem` in the shell scales together.
- **Accent** — `--dsw-alias-state-business-primary` plus the two washes derived from it with `color-mix`, so selection, focus, and current items all follow one colour.
- **Corners** — every `--dsw-radius-*` step multiplied by the chosen scale, so the whole scale moves together.
- **Shell and surfaces** — the canvas, the sidebar's own fills, and the layer stack faded by *different* amounts, each as `color-mix` over the palette token the theme itself uses, in both palettes. One value can therefore make the frame translucent while the cards inside it stay readable.
- **Backdrop** — three presets (`aurora`, `mist`, `dusk`) painted on a fixed layer behind the interface, which is what a faded shell then reveals; `theme` paints nothing and leaves the page's background alone.

The overrides are `:root:root`-scoped because the theme declares tokens on the root element *and* on the themed body, and a custom property is inherited from the nearest ancestor that sets one.

## Model Experience

### Appearance overrides

#### What the model sees

Nothing. The section edits this deployment's own row and writes a stylesheet into the page; no field, value, or token reaches a request, a tool schema, or a session event.

#### Token effect

None. The choices are browser presentation, and they are not part of any model input.

#### KV Cache effect

None. The plugin contributes no prompt section and never touches an assembled request.

## Known Limitations and Deferred Work

- The stylesheet cannot make the operating-system window translucent: an Electron window's own transparency is a main-process property of the application that launches it, which a client plugin does not own. What this section fades are the app's layers over each other — a translucent shell over the backdrop behind it.
- A translucent shell only shows something when a backdrop is painted behind the interface: either the theme's own background, one of the presets here, or the Visual effects plugin's whale.
