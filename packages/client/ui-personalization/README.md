---
description: "Personalization settings section: interface font, root size, accent, corner scale, and real shell/surface transparency — applied as token overrides."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-personalization

## Summary

The theme owns the tokens; this row owns the overrides. A **Personalization** settings section edits one volatile field per choice — font stack, root font size, accent, corner scale, and two opacity controls under an **Opacity** heading — and the browser half turns those values into a stylesheet the page wears. Every field defaults to "leave the theme alone", so mounting the plugin changes nothing until someone chooses something.

## What it writes

The engine composes one `<style>` element under the id `dsh-personalization`:

- **Font** — `--dsw-font-family`, and a root `font-size` percentage so every `rem` in the shell scales together.
- **Accent** — `--dsw-alias-state-business-primary` plus the two washes derived from it with `color-mix`, so selection, focus, and current items all follow one colour.
- **Corners** — every `--dsw-radius-*` step multiplied by the chosen scale, so the whole scale moves together.
- **Shell opacity** — the canvas, the sidebar's own fills, its navigation rows, *and the document itself*: below 100% the page stops painting its background, which is what makes the window genuinely see-through. The desktop app creates its window transparent over an acrylic material, so what shows through is the desktop behind the window.
- **Surface opacity** — the layer stack (cards, panels, menus, dialogs) faded by its own amount, so the shell can go to glass while the cards inside it stay readable. Both are `color-mix` over the palette token the theme itself uses, in both palettes, with presets (Solid 100 / Soft 85 / Glass 65 / Clear 45).

The overrides are `:root:root`-scoped because the theme declares tokens on the root element *and* on the themed body, and a custom property is inherited from the nearest ancestor that sets one.

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
- Window transparency is the launched application's property, not this plugin's: the desktop app creates its window with `transparent: true` over `backgroundMaterial: 'acrylic'` and a fully transparent background colour, which is why clearing the page background reveals the desktop. A host that creates a plain opaque window would instead reveal the window's own fill, and nothing here can change that from inside the page.
- The blur and tint of what shows through belong to the operating system's window material. macOS Reduce Transparency and Windows transparency effects change how strong the effect looks, and neither is observable from the page.
