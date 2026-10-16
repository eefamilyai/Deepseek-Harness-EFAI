---
description: "The fork's shared rows as a profile bundle: the identity opener, Kiln routes, the kernel stack, durable memory, the browser, and the runtime tool roster, stacked over dsh-base."
kind: "package-reference"
---

# @deepseek-ai/dsh-efai-base

## Summary

`dsh-efai-base` is how this fork adds plugins to a profile without editing upstream's composition. It is an ordinary profile bundle — a `cordis.patch.yml` declared through `dsh.bundle.patch` — stacked after `@deepseek-ai/dsh-base` by the profile's own layer list. Every row the fork contributes to a base-backed profile lives here, and upstream's `base` bundle stays pristine.

## Table of Contents

- [Use this package](#use-this-package)
- [What it mounts](#what-it-mounts)
- [Why no row is gated on a setting](#why-no-row-is-gated-on-a-setting)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Nothing imports this package; a profile names it. The fork's launchers and installers run [`efai/ensure-profile-bundles.mjs`](../../../efai/ensure-profile-bundles.mjs), which places `@deepseek-ai/dsh-efai-base` directly after `@deepseek-ai/dsh-base` in `$DSH_HOME/profiles/<name>/package.json` and names it in that manifest's `dependencies`, writing nothing when it is already there. The layer list decides whether the bundle composes; the dependency decides whether the Web **Plugins** page lists it and lets its rows be switched one by one, because that page reads a bundle as installed only when the profile declares it. A profile that does not name it boots upstream's harness unchanged, which is the correct behavior for a profile the fork was never asked to extend.

Every package a row names must be a `dependencies` entry of this manifest. The profile module fallback links the installation's dependency closure, so a package outside it fails at boot with `Cannot find package`, long after every test has passed.

<a id="what-it-mounts"></a>
## What it mounts

Rows grouped by subject: the identity opener (`efai-identity`), the LLM layer (`llm-text-toolcalls`, `llm-kiln`), context economy and post-compaction grounding (`output-masking`, `session-recovery-context`), the acting surface (`kernel`, `kernel-python`, `tool-kernel`), durable memory (`agent-memory`), the session-info command, upstream's `tool-str-replace-editor`, the agent's browser in the Desktop sidebar (`web-browser-sidebar`) and the `browser` tool over it or a self-hosted headless Chromium (`web-browser`), the harness development tools (`harness-dev-tools`), and the runtime roster (`tool-roster`), whose live fields carry the kernel and conventional-tool switches.

The file itself documents each row. Read it rather than this list, which cannot stay current on its own.

<a id="why-no-row-is-gated-on-a-setting"></a>
## Why no row is gated on a setting

A Loader `disabled: !!js …` expression is evaluated once at boot. Gating a row on a settings flag therefore makes that flag a restart, and unmounts the very plugin that would publish the switch in its off position. The two switches this fork ships decide at runtime instead: `tool-roster` filters the assembled prompt and guards execution per turn for `kernel.enabled` and the conventional-tool switches, and `agent-memory` mounts and unmounts the memory engine itself, because that engine writes to disk and a hidden tool would not stop it.

<a id="dev-note"></a>
## Dev Note

A later bundle layer may replace a row's whole `config` and switch a row off by id, but it never merges into a config — a patch that restates one field deletes the others. `efai-web` uses both facilities: it disables upstream's `agent-presets` row and the host-plane `tool-kernel` row from this bundle.

<a id="model-experience"></a>

No runtime invariant companion is published: a profile bundle is composition data with no runtime of its own; the Loader reports rows that fail to load.

## Model Experience

### The host profile's composition

#### What the model sees

Nothing of its own: this bundle mounts rows, and each row owns its model-visible contribution. What it decides is that those rows exist for every agent at once — the `kernel` tool and its prompt sections, the roster that filters tool schemas and `tool:<name>` guidance, and `llm-kiln`'s request shaping for the web routes.

#### Token effect

The rows it mounts decide the cost. `tool-roster` is the one that removes schema and guidance bytes from every request, and the kernel's prompt sections are the largest fixed addition this bundle makes; the bundle file itself adds nothing to a request.

#### KV Cache effect

None of its own. Changing this file changes which plugins are mounted, which is a restart rather than a mid-session prefix change; the rows it mounts own their own prefix behavior.

## Known Limitations and Deferred Work

- A later layer replaces a row's whole `config` rather than merging one field, so a bundle that restates a row must repeat every field it wants to keep. Nothing here detects that a replacement dropped a value upstream had set.
