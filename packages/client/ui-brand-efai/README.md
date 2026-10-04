---
description: "The fork's DeepSeek Harness brand occupants for the Web client's sidebar slots: the whale mark and a wordmark whose highlight travels through its glyphs."
kind: "package-reference"
---


# @deepseek-ai/dsh-client-ui-brand-efai

## Summary

The sidebar brand for this fork: a whale mark beside the product name. It registers two occupants — `sidebar.brand.mark` and `sidebar.brand.name` — and nothing else; the conversation hero keeps its declaring package's animated fish. It exists as its own package because upstream's brand occupants register only in an `official` client build, and because every package that ships inside the official Desktop's `app.asar` is resolved ahead of this checkout, so a fork cannot express its own identity by editing upstream's package.

## Table of Contents

- [Use this package](#use-this-package)
- [Why the name is live text](#why-the-name-is-live-text)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount it in a browser roster whose identity is DeepSeek Harness; `packages/bundle/efai-web` does, and switches upstream's `ui-brand-official` row off in the same layer:

```yaml
- id: ui-brand-official
  disabled: true

- insert:
    - id: ui-brand-efai
      name: '@deepseek-ai/dsh-client-ui-brand-efai'
```

The occupants register on mount, whatever `DSH_CLIENT_BUILD_PROFILE` says, and leave with the plugin fiber.

<a id="why-the-name-is-live-text"></a>
## Why the name is live text

The wordmark is a `<span>` of ordinary text, not a name artwork, so the specular band can be painted into the glyphs (`background-clip: text`) and travel through the letters. Where the browser cannot clip a background to text the mark renders in the plain primary ink, and `prefers-reduced-motion: reduce` asks for exactly that static form.

No runtime invariant companion is published because the package holds no state: two slot occupants install and leave through one declaration-aware effect, which the package spec proves in both declaration orders.

## Model Experience

None, as the package registers two sidebar occupants and no prompt section, tool schema, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The mark is upstream's `FishLogo` at whatever size the host surface asks for; a fork with a different mark would replace that import rather than the registration.
