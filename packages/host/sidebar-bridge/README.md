# @deepseek-ai/dsh-host-sidebar-bridge

A **self-contained host surface for the sidebar panels**, served over the `webServer` carrier so it needs none of the RPC protocol.

It owns two endpoints for the client dock and one shared resource behind them:

| Route | Use |
|---|---|
| `WS /kiln/terminal` | A **dedicated** user shell (a real PTY via `ctx.subprocess`) in the chat's working directory |
| `WS /kiln/browser/stream` | Change-driven push of the agent's live browser, driven by `fs.watch` rather than polling |
| `GET /kiln/browser/shot/<name>` | A screenshot PNG |
| `POST /kiln/browser/act` | Drives `browser_use` on the **shared** browser |

The user shell is its own session, independent of whatever the model runs in its terminal tool, so typing in the dock never disturbs a command the agent is running.

The browser is one process-wide `KilnBrowser` inside the kernel, so the model and the user drive the **same** browser. The pane reads its state straight off disk — no kernel round-trip, so it never queues behind a model cell — and posts actions through the kernel only when the user actually does something. When the model is idle the shared browser is, to the user, an ordinary browser.

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Registers the terminal and browser routes on the web-server carrier |
| [`src/invariant.ts`](src/invariant.ts) | The package-owned invariant companion |

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Requires the webserver carrier** — the routes are registered on `ctx.webServer`, so a composition without it mounts nothing.
- **The shared browser is process-wide** — one instance serves every session and the user, so two sessions cannot each hold their own browser.
- **No RPC surface** — the bridge deliberately bypasses the Remote protocol, so its routes are only reachable from a client that speaks these exact paths.
- **The user shell has no sandbox policy of its own** — it runs with the host's privileges, not the model tool's confinement.

Fork-owned: `packages/host/sidebar-bridge` is Tier 1, so it touches no upstream file.
