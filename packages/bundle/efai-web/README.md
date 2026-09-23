---
description: "The fork's rows for the browser profile as a bundle: sidebar bridge, terminal and effects surfaces, settings sections, the version route, and the fork preset roster."
kind: "package-reference"
---

# @deepseek-ai/dsh-efai-web

## Summary

`dsh-efai-web` is the fork's second profile bundle: the rows that only a browser profile wants, stacked after upstream's `@deepseek-ai/dsh-web-app` and the fork's own `dsh-efai-base`. It mounts the sidebar host bridge and its client surfaces, the two settings sections, the `/version` route, and swaps upstream's preset roster for the fork's.

## Table of Contents

- [Use this package](#use-this-package)
- [The two rows it switches off](#the-two-rows-it-switches-off)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

A profile names it; nothing imports it. `efai/ensure-profile-bundles.mjs` places it directly after `@deepseek-ai/dsh-web-app` in the profile's layer list.

<a id="the-two-rows-it-switches-off"></a>
## The two rows it switches off

`agent-presets` — upstream's roster row, replaced by `efai-presets`, because both provide the same service and exactly one may be active.

`tool-kernel` — the host-plane row from `dsh-efai-base`. Under presets the kernel tool is an agent-plane row that each preset mounts, so the host-plane copy would be a duplicate; the seam and its Python backend stay on the host plane either way.

<a id="dev-note"></a>
## Dev Note

A bundle patch replaces a targeted row's whole `config` rather than merging into it. Rows that only need switching off are targeted by id with `disabled: true`, which carries no config and so cannot delete one.
