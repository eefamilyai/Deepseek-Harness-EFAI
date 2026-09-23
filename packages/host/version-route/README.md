---
description: "Diagnostics route answering with the checkout commit the running host was started from, at GET /version."
kind: "package-reference"
---

# @deepseek-ai/dsh-host-version-route

## Summary

`dsh-host-version-route` answers `GET /version` with the commit the running host was started from: the full hash, a seven-character prefix, and whether that checkout had uncommitted changes. An operator or an agent can then confirm that the process serving the page is the code they just edited, without poking the filesystem or the process table.

## Table of Contents

- [Use this package](#use-this-package)
- [What it answers](#what-it-answers)
- [Dev Note](#dev-note)

<a id="use-this-package"></a>
## Use this package

Mount it in a composition carrying `webServer`; `packages/bundle/efai-web` does.

```yaml
- id: version-route
  name: '@deepseek-ai/dsh-host-version-route'
  config:
    root: /path/to/checkout
```

`root` defaults to the checkout this package was loaded from, which is the answer a source launch wants.

<a id="what-it-answers"></a>
## What it answers

`{ "commit": "<40 hex>", "short": "<7 hex>", "dirty": <boolean> }`, as `application/json`. A packed or vendored install has no `.git`, so every field falls back to a stable `unknown` rather than failing the row that mounted this.

<a id="dev-note"></a>
## Dev Note

The snapshot is taken once, when the plugin applies: the answer describes the code the process is running, not the code on disk right now. Registration goes through `ctx.effect`, so the route is withdrawn when the mounting fiber is disposed.
