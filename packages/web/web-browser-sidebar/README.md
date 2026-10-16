# @deepseek-ai/dsh-web-browser-sidebar

## Summary

Carries the agent's browser pages in the Desktop window's right sidebar. The Host half is the `agentBrowser` service the `browser` tool's sidebar driver calls; the browser half, inside the Desktop renderer, keeps one webview per agent Session, performs each page operation on it, and shows it in the **AI Browser** sidebar tab. When the operator opens the sidebar of a conversation whose agent has been browsing, the AI Browser tab is already selected on the page the agent is on.

## How it works

1. The Desktop window subscribes to the `agentBrowser.commands` stream. The newest subscribed window carries every page; a window that disconnects fails the operations it still holds.
2. A Host caller (`@deepseek-ai/dsh-web-browser`) calls `agentBrowser.run(call)` with one low-level operation — `navigate`, `evaluate`, `click`, `insertText`, `key`, `back`, `forward`, `settle`, `screenshot`, or `close` — for one page id. The window answers through `agentBrowser.respond(reply)`; a missing answer fails the operation after its own timeout plus `replyGraceMs`.
3. The window creates the page's webview on first use through the Desktop preload's `dshDesktop.browser` lease, the same main-process policy the sidebar Browser tabs use: sandboxed, isolated, no dialogs, permissions, or downloads, popups turned into navigations of the same page. Its storage partition is the workspace's, so the agent shares cookies and sign-ins with the operator's own Browser tabs.
4. Each webview lives for its whole life in one fixed layer on `document.body`, because moving a webview in the DOM reloads it. While its tab is hidden the page is parked transparent and inert at the configured layout size and keeps working; while the tab is visible the page is laid over the tab viewport and follows it every frame, above the sidebar's own stacking order and below menus and dialogs.
5. The AI Browser tab opens when the agent navigates while the sidebar is expanded, and when the operator expands the sidebar of a conversation with agent activity the operator has not seen. A subagent's page shows in its root conversation.

Outside the Desktop renderer there is no webview to drive, so the browser half registers nothing beyond its Remote namespace, no window subscribes, and the `browser` tool keeps its headless driver.

## Composition

```yaml
- id: web-browser-sidebar
  name: '@deepseek-ai/dsh-web-browser-sidebar'
  config:
    replyGraceMs: 5000
```

Mount it ahead of `web-browser`, whose sidebar driver resolves `ctx.agentBrowser` per call. The row is in `@deepseek-ai/dsh-efai-base`.

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The `agentBrowser` Host service: `run`, `available`, and the Remote `commands` stream and `respond` reply |
| [`src/types.ts`](src/types.ts) | The request and reply vocabulary the Typert generator reads |
| [`src/client/index.ts`](src/client/index.ts) | The browser half: Remote mount, command loop, tab registration, and the reveal rule |
| [`src/client/pages.ts`](src/client/pages.ts) | One webview per agent page, its operations, and its parking and placement |
| [`src/client/keys.ts`](src/client/keys.ts) | Model-facing key names translated to Electron input events |
| [`src/client/AgentBrowserBody.tsx`](src/client/AgentBrowserBody.tsx) | The tab body (toolbar, status, viewport) and its chip title |

No invariant companion is published: the service and the window share one relationship — an operation is held by the window it was delivered to — and the service settles it in the same step it observes the reply or the disconnection, so there is no second observation that could diverge.

## Model Experience

### `agentBrowser` service and the AI Browser tab

#### What the model sees

Nothing from this package. The model sees the `browser` tool from `@deepseek-ai/dsh-web-browser`, and this package only changes which browser carries that tool's page; the results the model reads are the same text snapshots either way.

#### Token effect

This package adds no tool, prompt section, or result text, so it adds no tokens to any request.

#### KV Cache effect

This package contributes nothing to an assembled request, so it cannot invalidate a cached prefix.

## Known Limitations and Deferred Work

- Pages belong to the window: a reload or a closed window ends them, and the next operation opens a fresh page.
- With two Desktop windows connected, the newest carries every page; a conversation shown in the other window shows no AI page.
- Expansion of the right sidebar is noticed by a 400 ms check, because the sidebar publishes no expansion event; the tab can appear that long after the column opens.
- A page laid over its tab is a separate native surface, so a hover card or tooltip drawn by the sidebar itself below z-index 100 can be hidden behind it.
- The page's operations use Electron's `<webview>` tag methods; a Desktop build that removes the tag or the `dshDesktop.browser` lease leaves the `browser` tool on its headless driver.

Fork-owned: `packages/web/web-browser-sidebar` is Tier 1, so it touches no upstream file.
