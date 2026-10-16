---
description: "Provider visibility: a switch on every provider card in the Models settings page that hides the provider from the model picker."
kind: "package-reference"
---

# @deepseek-ai/dsh-client-ui-model-visibility

## Summary

A switch on every provider card of the Models settings page, plus a list at the end of the page for the providers that have no card, such as pooled account logins. A provider switched off is left out of the model picker and `/model`; a session already running on it keeps working. The choice lives in the `model-visibility` row, which `profile-sync` shares, so it applies in every profile.

## Table of Contents

- [How it works](#how-it-works)
- [Configuration](#configuration)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="how-it-works"></a>
## How it works

The Host half wraps `llm.listProviders()` for as long as the row is mounted and drops every provider whose route id is in `hidden`. The picker catalog (`session.modelCatalog`), the picker's selection check, and ACP's model list all read that list. Turns resolve through the registry's adapter table instead, so hiding never breaks a running session. The wrapper reads `hidden` on every call and the field is volatile, so no restart is needed; the settings write emits `settings/document-updated`, on which the picker reloads its catalog.

The switch inside a card registers on the `settings.models.provider-card` keyed slot. That slot is keyed by the card's settings namespace, so the browser half registers the switch under every namespace `llm.listConfigurableProviders()` declares, and again when providers change. It also registers under the empty key, which a registered-but-undeclared provider's card dispatches with. It registers at priority 100, so a namespace's own companion plugin at the default priority renders instead.

A mounted card switch marks its provider as carded. The list at the end of the page shows only providers that no card shows: catalog groups and failed providers without a card, plus hidden providers whose card went away with them, so a hidden provider can always be switched back on. Each hidden entry records the provider's name when it was hidden so it can still be listed.

No runtime invariant companion is published: the hidden set has one owner, the row's own config, and the filter reads it on every call, so no second observation can diverge from it.

<a id="configuration"></a>
## Configuration

| Field | Default | Meaning |
|---|---|---|
| `hidden` | `[]` | `{ id, name }` entries: provider route ids left out of the picker, and the name the settings list shows for each. |

## Model Experience

None, as hiding a provider changes which routes the picker offers and nothing it holds reaches a model request.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The filter wraps one method of the shared LLM registry; another plugin that replaces `listProviders` the same way composes with it in mount order.
- A provider whose adapter is not registered at all (for example, a disabled plugin) is not listed, because the catalog never sees it.
- A card whose namespace has its own `settings.models.provider-card` registrant at the default priority shows that registrant instead of the switch, and its provider is listed at the end of the page.
