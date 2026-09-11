# @deepseek-ai/dsh-web-browser

A **self-hosted headless browser** for the model: a text-first `browser` tool a vision-less model can drive, plus a Playwright fetch provider for `ctx.web`.

The model never sees pixels. Every action returns the page as text - its readable content, then each interactive element on a `[n] role: name` line. The model reads that, picks a ref, and calls the tool again ("click 12"). One tool with an `action` selector keeps the whole loop in a single verb the model does not have to discover piecemeal.

The refs are only valid until the next action reshapes the DOM, which is exactly the read-act-read loop the tool prompt describes.

One package, two registrations:

- the `browser` tool, over one lazily launched Chromium with a page per session key;
- a browser-rendered `WebFetchProvider`, so `web_fetch` returns what a real browser sees - JavaScript run, client-rendered content present - instead of the raw HTML the plain HTTP provider gets.

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
| [`src/index.ts`](src/index.ts) | The plugin: registers the tool, its prompt section, and the fetch provider |
| [`src/tool.ts`](src/tool.ts) | The model-facing `browser` tool and its per-action validation |
| [`src/browser.ts`](src/browser.ts) | The shared Chromium and one page per session key |
| [`src/page-script.ts`](src/page-script.ts) | The in-page snapshot collector, delivered as a script string |
| [`src/serialize.ts`](src/serialize.ts) | Formats one snapshot as the text block the model reads |
| [`src/provider.ts`](src/provider.ts) | The browser-rendered `WebFetchProvider` |

## Model Experience

### `browser` tool and prompt section

#### What the model sees

One tool named `browser` with an `action` selector - `navigate`, `read`, `click`, `type`, `press`, `scroll`, `back` - plus the `url`, `ref`, `text`, and `key` fields each action needs. The `tool:browser` prompt section states the read-act-read loop and that every action returns a fresh snapshot with new refs. A result is the page title, its URL, its readable text, and the numbered interactive elements.

#### Token effect

The tool description, its parameter descriptions, and the prompt section are billed once per request as part of the stable prefix. Each result is capped at `maxOutputChars` (default 40000) and the page text at `maxTextChars` (default 20000); a snapshot over the cap reports how many characters were dropped.

#### KV Cache effect

The description and prompt section are static, so they do not invalidate the cached prefix. Results append to the transcript as ordinary tool results.

### Browser-rendered `web_fetch` provider

#### What the model sees

Nothing directly. The provider returns a rendered page whose body is the title and text, and the `web_fetch` tool owns how that is rendered into the model's context.

#### Token effect

Only through the `web_fetch` tool result. The provider returns the whole rendered body and marks it untruncated, so the tool's own cap is what bounds the tokens.

#### KV Cache effect

None of its own; the owning `web_fetch` result appends to the transcript.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Requires a separately installed Chromium** - the package ships no browser binary, so a composition without `npx playwright install chromium` fails on first launch.
- **Text projection only** - the model receives text and a ref list; there is no screenshot, no accessibility tree, and no way to read visual layout.
- **Refs are invalidated by the next action** - a ref from an earlier snapshot may address a different element, so a caller must act on the most recent result.
- **Cap of 400 interactive elements per snapshot** - the collector stops tagging after 400 visible controls.
- **One shared browser process** - every session key gets its own context, but they share one Chromium, so a crash affects all of them.
- **No form submission or file upload action** - the tool exposes navigate, read, click, type, press, scroll, and back; anything else needs a click on the control that performs it.

Fork-owned: `packages/web/web-browser` is Tier 1, so it touches no upstream file.
