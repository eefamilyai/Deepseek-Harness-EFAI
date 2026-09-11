# @deepseek-ai/dsh-web-browser

A **browser-rendered web fetch** for the harness: a Playwright `WebFetchProvider` for `ctx.web`, so `web_fetch` returns what a real browser sees - JavaScript run, client-rendered content present - instead of the raw HTML the plain HTTP provider gets.

The provider registers into `ctx.web` alongside the `http` provider; the seam's `fetchProvider` config picks which one serves. Nothing here is model-facing on its own: the `web_fetch` tool owns how a rendered body reaches the model.

The Chromium binary is a one-time `npx playwright install chromium`. A launch without it fails with that exact instruction rather than a stack trace.

## Composition

```yaml
- id: web-browser
  name: '@deepseek-ai/dsh-web-browser'
  config:
    headless: true
    fetchProvider: true
```

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The plugin: registers the fetch provider with `ctx.web` |
| [`src/browser.ts`](src/browser.ts) | The shared Chromium and the page a render runs on |
| [`src/page-script.ts`](src/page-script.ts) | The in-page text collector, delivered as a script string |
| [`src/provider.ts`](src/provider.ts) | The browser-rendered `WebFetchProvider` |

## Model Experience

### Browser-rendered `web_fetch` provider

#### What the model sees

Nothing directly. The provider returns a rendered page whose body is the title and text, and the `web_fetch` tool owns how that is rendered into the model's context.

#### Token effect

Only through the `web_fetch` tool result. The provider returns the whole rendered body and marks it untruncated, so the tool's own cap is what bounds the tokens. The page text is capped at `maxTextChars` (default 20000) before the body is built.

#### KV Cache effect

None of its own; the owning `web_fetch` result appends to the transcript.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Requires a separately installed Chromium** - the package ships no browser binary, so a composition without `npx playwright install chromium` fails on first launch.
- **Rendered text only** - the provider returns the page's title and readable text; there is no screenshot, no accessibility tree, and no way to read visual layout.
- **No interactive driving** - the package fetches URLs; it cannot click, type, or navigate a flow. Work that needs that is not served by this provider.
- **One shared browser process** - every fetch reuses one Chromium, so a crash affects all of them.

Fork-owned: `packages/web/web-browser` is Tier 1, so it touches no upstream file.
