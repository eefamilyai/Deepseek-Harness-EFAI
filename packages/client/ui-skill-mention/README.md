---
description: "The `@skill` picker: the session skill catalog as an `@` trigger source beside @file and @session, landing the literal `@skill <name>` the host pre-step loads."
kind: "package-reference"
---


# @deepseek-ai/dsh-client-ui-skill-mention

## Summary

The `@skill` picker for the composer. It registers one `@` trigger source whose candidates are the session's human-invocable skills, filtered by what follows `skill `, and whose pick lands the literal `@skill <name> ` text that the `tool-skill` pre-step recognizes as a user-explicit load gesture. The catalog is fetched once per session and cached, so filtering costs no RPC; the source answers the composer's synchronous lexicon queries from the settled snapshot and notifies subscribers when it changes.

## Table of Contents

- [Use this package](#use-this-package)
- [Why this is its own package](#why-this-is-its-own-package)
- [Catalog lifetime](#catalog-lifetime)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount it in a browser roster whose composer should offer skill mentions; `packages/bundle/efai-web` does:

```yaml
- id: ui-skill-mention
  name: '@deepseek-ai/dsh-client-ui-skill-mention'
```

It binds the `@` trigger under the group name `skills` at order 3, beside the host's own `@file` and `@session` sources. A composition that mounts it twice with the same name fails at registration: the trigger registry keys a source by `(trigger, name)`.

<a id="why-this-is-its-own-package"></a>
## Why this is its own package

Upstream's skill plugin owns the same feature as a Tier-2 edit on its client half. That package also ships inside the official Desktop's `resources/app.asar`, where the installed copy is resolved ahead of a source checkout, so the edit never renders there. A registry contribution does: `registerSource` is a public key, and the pick is plain text the host already understands.

<a id="catalog-lifetime"></a>
## Catalog lifetime

One fetch per session, shared by every keystroke that filters it. The scope-birth hook prewarms the key; a preset switch drops it, because the catalog is the preset's and a blank session may switch after the warm; a connection reset clears every key, because the host catalog may differ across generations. A failed fetch does not poison the key — the next consumer retries — and the session is retained through the RPC so an in-flight catalog request survives a navigation that would otherwise release it.

No runtime invariant companion is published because the one relation worth asserting — the cache holds at most one in-flight fetch per session — is enforced and observed inside the same `Map` in the same closure, so a companion would re-run the implementation instead of comparing independent observations. The package spec asserts it through the RPC count instead.

## Model Experience

None, as the source registers composer candidates and lands draft text; what the model then reads is the `tool-skill` pre-step's decision, not this package's.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The source contributes to every `@` query, not only to `@skill …`, because the composer's `@` menu is one group list; a fork that wants the group to appear only after the `skill` word needs a composer-side filter upstream does not expose.
