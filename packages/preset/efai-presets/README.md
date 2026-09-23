---
description: "The fork's agent preset roster: upstream's preset machinery pointed at this package's own presets, which carry the kernel acting surface."
kind: "package-reference"
---

# @deepseek-ai/dsh-efai-presets

## Summary

`dsh-efai-presets` supplies the four preset ids a session can compose from — `standard`, `minimal`, `ptc`, `cordis` — from this package's own preset root, and drops upstream's shipped root so those ids resolve here. It exists because the fork's rosters mount the `kernel` acting surface and upstream's copies cannot, and because a preset root's path is inside a package: only code that knows where the package was installed can name it.

## Table of Contents

- [Use this package](#use-this-package)
- [Why the shipped root is dropped](#why-the-shipped-root-is-dropped)
- [Keeping the copies honest](#keeping-the-copies-honest)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount it in place of `@deepseek-ai/dsh-agent-presets`, which is what `packages/bundle/efai-web/cordis.patch.yml` does: it disables upstream's `agent-presets` row and inserts this one with the same `default`.

```yaml
- id: efai-presets
  name: '@deepseek-ai/dsh-efai-presets'
  config:
    default: standard
```

Configuration is upstream's, minus the two fields this package decides. `roots` given here are appended **after** this package's own, and `includeShippedRoot` is forced off. `includeUserRoot` is untouched, so presets authored under `$DSH_HOME/.agent-presets` still load and still lose a duplicate id to these.

<a id="why-the-shipped-root-is-dropped"></a>
## Why the shipped root is dropped

A shipped root is prepended before every configured root and wins a duplicate id. Left on, upstream's `standard` would mask this package's `standard`, and the kernel would silently leave the roster — the failure would look like a missing tool, not a missing preset. Dropping it is the only arrangement where the four ids mean what this package says they mean.

<a id="keeping-the-copies-honest"></a>
## Keeping the copies honest

These rosters are forked copies, so upstream roster changes no longer arrive on their own. `node local-overlay/verify-efai-presets.mjs` fails when upstream's version of a forked preset moves, naming which one; re-apply that change here, then re-record with `--record`. The gate runs as part of `pnpm run verify-fork-overlay`.

<a id="dev-note"></a>
## Dev Note

`EFAI_PRESET_ROOT` is resolved from `import.meta.url`, which is correct for a source launch out of `src/`, a built launch out of `lib/`, and an installed package under `node_modules` — all three sit exactly one directory below the package root. `presets` is listed in the manifest's `files`, so the rosters ship with the package.
