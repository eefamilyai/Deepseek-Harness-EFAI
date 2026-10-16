# @deepseek-ai/dsh-web-browser

## Summary

A **real browser** for the model: a text-first `browser` tool a vision-less model can drive, plus a Playwright fetch provider for `ctx.web`. In the Desktop app the tool's page lives in the right sidebar's **AI Browser** tab, where the operator watches and can use it; elsewhere it is a headless Chromium.

Every action returns the page as text - its readable content, then each interactive element on a `[n] role: name` line - and the model acts by ref ("click 12") through one tool with an `action` selector.

## What it registers

The refs are only valid until the next action reshapes the DOM, which is exactly the read-act-read loop the tool prompt describes.

One package, two registrations:

- the `browser` tool, with one page per owning Session, carried by the driver the `driver` field selects for each call;
- a browser-rendered `WebFetchProvider`, so `web_fetch` returns what a real browser sees - JavaScript run, client-rendered content present - instead of the raw HTML the plain HTTP provider gets. It always renders headless.

## Drivers

| `driver` | Carries the page | Needs |
|---|---|---|
| `auto` (default) | The Desktop sidebar while a Desktop window is connected, headless otherwise, decided per call | — |
| `sidebar` | The Desktop sidebar only; a call with no window open fails and says so | `@deepseek-ai/dsh-web-browser-sidebar` mounted |
| `headless` | One lazily launched Playwright Chromium in the Host | `npx playwright install chromium` once |

The sidebar driver ([`src/sidebar-driver.ts`](src/sidebar-driver.ts)) composes each action from the low-level page operations the `agentBrowser` service carries to the Desktop window: a click finds the ref'd element by script, scrolls it into view, and clicks its centre as a real pointer; typing focuses and selects the field, then inserts the text as an input method would. The snapshot script is the same one the headless driver runs. A subagent's page shows in its root conversation's sidebar, found by walking `header.parentSession` while `origin` is `subagent`.

A launch of headless Chromium without the binary fails with the install instruction rather than a stack trace.

## Composition

```yaml
- id: web-browser
  name: '@deepseek-ai/dsh-web-browser'
  config:
    driver: auto
    viewportWidth: 1280
    viewportHeight: 800
    headless: true
    fetchProvider: true
```

`viewportWidth` and `viewportHeight` are the size a sidebar page lays out at while its tab is hidden; a visible tab lays the page out at the tab's own size.

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The plugin: config, driver resolution, the tool, its prompt section, and the fetch provider |
| [`src/tool.ts`](src/tool.ts) | The model-facing `browser` tool and its per-action validation |
| [`src/driver.ts`](src/driver.ts) | The operations every driver implements, and the page target they address |
| [`src/browser.ts`](src/browser.ts) | The headless driver: one shared Chromium and one page per Session |
| [`src/sidebar-driver.ts`](src/sidebar-driver.ts) | The sidebar driver over the `agentBrowser` service |
| [`src/page-script.ts`](src/page-script.ts) | The in-page snapshot collector, delivered as a script string |
| [`src/serialize.ts`](src/serialize.ts) | Formats one snapshot as the text block the model reads |
| [`src/provider.ts`](src/provider.ts) | The browser-rendered `WebFetchProvider` |

No runtime invariant companion is published: this package exposes no independent event sequence or mutable data relation beyond contracts enforced at its owning seams.

## Model Experience

### `browser` tool and prompt section

#### What the model sees

One tool named `browser` with an `action` selector - `navigate`, `read`, `click`, `type`, `press`, `scroll`, `back`, `screenshot` - plus the `url`, `ref`, `text`, and `key` fields each action needs. The `tool:browser` prompt section states the read-act-read loop, that every action returns a fresh snapshot with new refs, and that in the desktop app the user sees the page live and can act on it, for example to sign in. A result is the page title, its URL, its readable text, and the numbered interactive elements; which driver carried the page is not part of the result.

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

- **Headless needs a separately installed Chromium** - the package ships no browser binary, so a headless call without `npx playwright install chromium` fails on first launch.
- **A driver switch loses the page** - under `auto`, a call after the Desktop window connects or disconnects lands on the other driver's page, which holds none of the earlier navigation.
- **Sidebar pages live in the window** - they end when the window reloads or closes, and the next call opens a fresh page.
- **Refs are invalidated by the next action** - a ref from an earlier snapshot may address a different element, so a caller must act on the most recent result.
- **Cap of 400 interactive elements per snapshot** - the collector stops tagging after 400 visible controls.
- **One shared headless browser process** - every Session gets its own context, but they share one Chromium, so a crash affects all of them.
- **No form submission or file upload action** - the tool exposes navigate, read, click, type, press, scroll, back, and screenshot; anything else needs a click on the control that performs it.

Fork-owned: `packages/web/web-browser` is Tier 1, so it touches no upstream file.
