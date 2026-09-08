# @deepseek-ai/dsh-client-ui-chromium-surface

The browser-half of the Chromium-style surface: a tabbed pane mounted into its
own private React root, driven entirely by the host's `/chromium` endpoints.

It has its **own** session, tabs, and per-tab history — completely separate from
the agent-facing `browser` tool and the dock's shared browser. The pane never
goes through either of those.

## What it renders

- A tab strip (new tab, activate, close) ordered with the active tab first.
- Back / forward / reload controls enabled from the active tab's history.
- An address bar that navigates on Enter.
- A text snapshot of the active page (the browser is headless, so the pane
  shows the readable text projection, not pixels).

## Wiring

The package registers no Cordis services (`inject: []`) — the endpoints are
plain HTTP/WebSocket — and only contributes a private overlay root for its
activation lifetime.
