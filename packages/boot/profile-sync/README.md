---
description: "Keeps model providers, plugin enablement, and API key references identical across every profile under the harness home."
kind: "package-reference"
---

# @deepseek-ai/dsh-profile-sync

## Summary

Every profile under `$DSH_HOME/profiles` holds its own copy of the model providers, the plugin switches, and the API keys, so a change made in one profile used to stay there. This plugin keeps them identical: an edit in any profile is written into every other profile, and a running profile reloads it live through its own patch and manifest watchers.

## Table of Contents

- [What is shared](#what-is-shared)
- [How a pass works](#how-a-pass-works)
- [The first pass](#the-first-pass)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="what-is-shared"></a>
## What is shared

| Field | File | Shared unit |
|---|---|---|
| Providers | `cordis.patch.yml` | the whole `config` of each row in `providerRows` (`llm-pi-ai` custom providers, `llm-deepseek`, `llm-deepseek-account`, `llm-kiln`, `ai-accounts`, `deepseek-account`, `model-visibility`) |
| Plugin enablement | `cordis.patch.yml` | each row's `disabled` flag; a row without one is enabled |
| Bundles | `package.json` | `dsh.profile.bundles`, in order |
| API keys | `credentials.yaml` | each `refs` entry; login grants (`records`) are account sessions tied to one profile and are never copied |

Every other part of each file is left byte-for-byte: YAML edits use the comment-preserving document API and keep `!!js` expressions verbatim.

<a id="how-a-pass-works"></a>
## How a pass works

A profile that mounts the row runs a pass on start and 400 ms after any change to its own three files. Under the lock of `$DSH_HOME/profile-sync/state.json`, a pass:

1. reads every synchronized profile and compares it with that profile's baseline, the fields it held right after its previous pass, so only edits made since then count;
2. records each edit in the store, applying profiles in the order their files last changed, so the latest edit wins;
3. writes the store's values into every synchronized profile, taking each profile's `package.json` lock (the lock the settings editor holds for its own writes);
4. links any shared bundle installed in only one profile into the shared `profiles/node_modules`, so every profile can load it.

A profile that is not running receives the write and applies it at its next start.

<a id="the-first-pass"></a>
## The first pass

The first pass on a machine copies every synchronized profile's three files to `$DSH_HOME/profile-sync/backup-<time>/<profile>/`, then merges with the running profile taking precedence: provider entries, bundles, and API keys that only another profile has are added; where both hold a value, the running profile's wins (arrays such as a provider's model list are not merged); a plugin only another profile disables is enabled, because the running profile enables it.

No runtime invariant companion is published: the store is the one authority for shared values, and every profile's files are rewritten from it under one lock, so no second observation can diverge from it.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `enabled` | `true` | Synchronize at all. |
| `exclude` | `headless`, `desktop-test-instance` | Profiles never read or written; one of them running this row does nothing. |
| `providerRows` | see above | Rows whose `config` is shared. |
| `plugins` | `true` | Share `disabled` flags and the bundle list. |
| `credentials` | `true` | Share API key references. |
| `linkBundles` | `true` | Link a bundle installed in one profile into the shared `node_modules`. |
| `debounceMs` | `400` | Quiet time after a change before a pass. |

## Model Experience

None, as this package edits profile files on disk and nothing it holds reaches a model request.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The row is in the `efai-base` bundle; bundle rows load at start, so a profile picks the plugin up after its first restart.
- Disabling `profile-sync` itself is a shared `disabled` flag, so it switches synchronization off in every profile at once.
- A bundle linked into the shared `node_modules` keeps pointing at the profile that installed it; removing it there breaks the link for the others.
