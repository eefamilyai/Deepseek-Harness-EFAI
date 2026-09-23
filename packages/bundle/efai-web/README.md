---
description: "The fork's rows for the browser profile as a bundle: the version route, the effects and accent layers, and the Tools and Accounts settings sections."
kind: "package-reference"
---

# @deepseek-ai/dsh-efai-web

## Summary

`dsh-efai-web` is the fork's second profile bundle: the rows that only a browser profile wants, stacked after upstream's `@deepseek-ai/dsh-web-app` and the fork's own `dsh-efai-base`. It mounts the `/version` route, the visual-effects and accent layers, and the Tools and Accounts settings sections. It switches nothing of upstream's off: the terminal, the presets, and the settings pages are upstream's own.

## Table of Contents

- [Use this package](#use-this-package)
- [Why it disables nothing](#why-it-disables-nothing)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

A profile names it; nothing imports it. `efai/ensure-profile-bundles.mjs` places it directly after `@deepseek-ai/dsh-web-app` in the profile's layer list.

<a id="why-it-disables-nothing"></a>
## Why it disables nothing

The kernel tool stays where `dsh-efai-base` puts it, on the host plane. The tools registry is layered, so a host registration reaches every preset agent's catalog, and each call resolves the agent that made it, so one row serves every session. That is why this bundle no longer carries a preset roster of its own: upstream's presets are used as shipped, and a preset's own tool choices are edited in upstream's preset editor.

<a id="dev-note"></a>
## Dev Note

A bundle patch replaces a targeted row's whole `config` rather than merging into it. Rows that only need switching off are targeted by id with `disabled: true`, which carries no config and so cannot delete one.
