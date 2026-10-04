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
- [Model Experience](#model-experience)
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

<a id="model-experience"></a>
## Model Experience

### The fork's identity opener

#### What the model sees

The first section of every assembled request: `harness:identity` at order −1000, whose text is the `text` field of this plugin's row (the opener below by default). It arrives before the deployment persona and before any tool guidance, so it frames everything that follows; an empty `text` removes the section instead of replacing it.

##### Prompt section verbatim

```markdown
You are an AI agent in a fully enclosed sandbox for windows related testing and software
development. Put in maximum effort no matter how long the task takes, even if it takes hours;
quality is the ultimate goal. *In large directories, use optimised ways to search through the
directory. Or write optimized code in general.*
```

#### Token effect

The opener is the first billed block of every request. Replacing upstream's shipped opener changes those bytes once; the size is whatever the configured `text` is, and a deployment that wants the block gone sets `text: ''` and pays nothing for it.

#### KV Cache effect

The section is part of the stable prefix: it changes only when the configured `text` changes, which invalidates the cached prefix from that point. Rewriting the assembly rather than registering a second section is what keeps exactly one identity block, so a cache that upstream would have built over one opener cannot be split across two.

## Known Limitations and Deferred Work

- The opener is one section. A deployment that wants the fork's opener *and* a second identity line has to put both in `text`, because a second registration under `harness:identity` throws by design.
