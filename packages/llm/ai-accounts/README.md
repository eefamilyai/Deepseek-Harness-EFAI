---
description: "Account-pool registry: which provider routes accept a login, and the Remote surface a settings page uses to add, inspect, and repair one."
kind: "package-reference"
---


# @deepseek-ai/dsh-ai-accounts

## Summary

The account-pool registry. A provider that can sign in with a stored credential registers an `AccountAdder` (create a login) and an `AccountAdmin` (read, re-authenticate, re-profile, remove, and log one), and this service routes a settings page to them over its own `aiAccounts` Remote namespace. It owns neither the login nor the credential: it names the routes that pool accounts, validates a draft far enough to avoid a pointless network round trip, and turns a local failure into a structured `RemoteError` so the browser shows a reason instead of an internal failure.

## Table of Contents

- [Use this package](#use-this-package)
- [What it owns](#what-it-owns)
- [The `aiAccounts` namespace](#the-aiaccounts-namespace)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the host half wherever a provider registers accounts, and the client half in a browser composition that carries the `remote` service. `packages/bundle/efai-base` mounts the host half and `packages/bundle/efai-web` the client half.

```yaml
- id: ai-accounts
  name: '@deepseek-ai/dsh-ai-accounts'
```

A provider registers on the service it is given, and the returned disposer withdraws the registration with the caller's fiber:

```ts
const dispose = ctx.aiAccounts.registerAccountProvider('kiln-deepseek', addAccount)
const admin = ctx.aiAccounts.registerAccountAdmin('kiln-deepseek', accountAdmin)
```

One handler per route: a second registration for the same route throws rather than silently replacing the first, because two owners of one route is a configuration the service cannot resolve.

<a id="what-it-owns"></a>
## What it owns

| Member | Contract |
|---|---|
| `registerAccountProvider(route, add)` | The route accepts added logins. Returns a disposer. |
| `registerAccountAdmin(route, admin)` | The route's logins can be listed and repaired. Returns a disposer. |
| `listAccountProviders()` | The routes that accept additions, in registration order. |

The `AccountAdmin` interface is the provider's own vocabulary (`list`/`relogin`/`reprofile`/`remove`/`log`); this service forwards to it and owns only the error translation. Nothing here knows what an account is beyond the shapes on the wire, so a second account-pooling provider appears without a change to this package.

<a id="the-aiaccounts-namespace"></a>
## The `aiAccounts` namespace

The namespace is this package's own rather than a corner of `llm`, so the account surface ships, versions, and fails independently of the model registry it happens to sit beside. Its client half mounts that namespace itself, from the descriptors the build generates for this package:

```ts
import contribution from '@deepseek-ai/dsh-ai-accounts/remote'
export const inject = ['remote']
export async function apply(ctx: Context): Promise<void> {
  await ctx.remote.$mount(contribution)
}
```

A composition therefore reaches the namespace by mounting this package, not by owning a line in a shared Remote assembly. A local failure surfaces as `RemoteError` with code `aiAccounts/account-rejected` and the route (plus the account when one was named) in `details`.

No runtime invariant companion is published because both registries are private maps whose only observable relation — a route has exactly one handler while its disposer lives — is established and released inside the same service call, so a companion would re-execute the implementation instead of comparing independent observations. The package spec asserts registration, duplicate rejection, and disposal directly.

## Model Experience

None, as the account surface registers no prompt section, tool schema, or Session event; a login changes which provider routes exist, never what a model request contains.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Error translation is per method, so a new account operation adds its own `try`/`catch` and its own `details` entry in `RemoteErrorDetailsMap`; a shared wrapper would have to carry the details each call site knows.
