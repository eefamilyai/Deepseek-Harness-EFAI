---
description: "The fork identity opener: the first line of the system prompt, rewritten on the assembly so it holds however the shipped opener is configured."
kind: "package-reference"
---

# @deepseek-ai/dsh-efai-identity

## Summary

`dsh-efai-identity` replaces the harness's identity opener — the `harness:identity` section at order −1000, the first thing the model reads — with the fork's own. It rewrites the assembled section on `system-prompt/assemble` rather than registering a second section, which is what lets it hold in all three configurations: the shipped opener present, switched off, or already replaced by something else.

## Table of Contents

- [Use this package](#use-this-package)
- [Why a rewrite and not a registration](#why-a-rewrite-and-not-a-registration)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount it in a composition carrying `systemPrompt`; `packages/bundle/efai-base` does.

```yaml
- id: efai-identity
  name: '@deepseek-ai/dsh-efai-identity'
  config:
    text: 'You are an AI agent ...'
```

`text` defaults to the opener this fork ships. An empty string removes the opener entirely, which is the one case a composition cannot express by configuring the prompt package alone.

<a id="why-a-rewrite-and-not-a-registration"></a>
## Why a rewrite and not a registration

`harness:identity` is a unique section name: a second registration under it throws, and a second section at the same order would render *beside* the shipped opener rather than instead of it. The shipped one can also be switched off by `includeHarnessIdentity`, and any later patch layer that restates the prompt row's config can turn it back on without knowing this package exists. Rewriting the assembly — whose return value is authoritative — is the single place where the answer is the same whatever the composition did.

Editing the string inside `packages/core/system-prompt` is the alternative this package exists to avoid: it is an upstream file, and upstream's own tests byte-compare that string.

<a id="dev-note"></a>
## Dev Note

The opener rides at the front of `sections` because the assembly is already sorted when the waterfall sees it; position, not `order`, is what carries −1000 here. Unmounting the plugin restores the shipped opener, which the tests pin.
