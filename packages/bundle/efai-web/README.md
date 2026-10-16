---
description: "The fork's rows for the browser profile as a bundle: the version route, the effects and accent layers, and the Tools and Accounts settings sections."
kind: "package-reference"
---

# @deepseek-ai/dsh-efai-web

## Summary

`dsh-efai-web` is the fork's second profile bundle: the rows that only a browser profile wants, stacked after upstream's `@deepseek-ai/dsh-web-app` and the fork's own `dsh-efai-base`. It mounts the `/version` route, the visual-effects and accent layers, the DeepSeek peak-hour pill, and the Tools and Accounts settings sections. It switches nothing of upstream's off: the terminal, the presets, and the settings pages are upstream's own.

## Table of Contents

- [Use this package](#use-this-package)
- [Why it disables nothing](#why-it-disables-nothing)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

A profile names it; nothing imports it. `efai/ensure-profile-bundles.mjs` places it directly after `@deepseek-ai/dsh-web-app` in the profile's layer list and names it in the profile's `dependencies`. The dependency is what the Web **Plugins** page reads as installed: a bundle that is only selected still composes and runs, but it gets no card there, so its rows are neither listed nor switchable.

<a id="why-it-disables-nothing"></a>
## Why it disables nothing

The kernel tool stays where `dsh-efai-base` puts it, on the host plane. The tools registry is layered, so a host registration reaches every preset agent's catalog, and each call resolves the agent that made it, so one row serves every session. That is why this bundle no longer carries a preset roster of its own: upstream's presets are used as shipped, and a preset's own tool choices are edited in upstream's preset editor.

<a id="dev-note"></a>
## Dev Note

A bundle patch replaces a targeted row's whole `config` rather than merging into it. Rows that only need switching off are targeted by id with `disabled: true`, which carries no config and so cannot delete one.

One row id belongs to one bundle. The composition appends each layer's `insert` list without deduplicating ids, so a row id this layer and `dsh-efai-base` both declare ends up composed twice; the plugin manager then reports that row as unaddressable through the profile patch and the Plugins page renders its switch locked, while the row itself still runs. Every row here therefore belongs to this layer alone — `ai-accounts` and `profile-hub` are `dsh-efai-base`'s, which this layer stacks over.

<a id="model-experience"></a>

No runtime invariant companion is published: a profile bundle is composition data with no runtime of its own; the Loader reports rows that fail to load.

## Model Experience

### The browser profile's composition

#### What the model sees

Nothing of its own: a bundle is composition, and every model-visible effect belongs to the row that contributes it. What this layer decides is which of them exist in a Web deployment — the `web-browser` rows and the kernel's browser window, the fork's `tool-roster` in place of upstream's `agent-presets` row, and the client plugins that render the transcript.

#### Token effect

Indirectly, and only through the rows: the roster's switches decide which tool schemas and guidance sections are billed, and the browser window's bounds decide how much of a page's text a fetch returns. The bundle itself adds no bytes to a request.

#### KV Cache effect

None of its own. A change to this file changes which plugins are mounted, which is a restart rather than a mid-session prefix change.

## Known Limitations and Deferred Work

- The bundle replaces and disables rows by id. An upstream release that renames a row this file names will fail to boot rather than silently keep the upstream row, so a release that renames the agent-presets or tool-kernel rows has to be checked here.
