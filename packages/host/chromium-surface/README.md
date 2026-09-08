# @deepseek-ai/dsh-host-chromium-surface

A real Chromium-style browser surface with its **own persistent session, tab set,
and per-tab history** — fully separate from the agent-facing `browser` tool and
the dock's shared browser.

The surface is one process-wide Playwright Chromium instance mounted on the
webserver carrier under `/chromium`. It never shares a context with the model's
browser, so browsing here cannot disturb (or be disturbed by) what the agent is
doing.

## Routes

| Route | Method | Purpose |
| --- | --- | --- |
| `/chromium/state` | GET | Full session snapshot: tabs plus each tab's back/forward history |
| `/chromium/act` | POST | One action (`navigate`, `open`, `close`, `activate`, `back`, `forward`, `reload`, `read`, `click`, `type`, `press`, `scroll`) |
| `/chromium/stream` | WS | Change-driven push of the same snapshot |

## Persistence

The session snapshot (tab ids, active tab, and each tab's history model) is
written to `$DSH_CHROMIUM_STATE`, or `~/.dsh/chromium-state.json` by default.
The browser itself is headless and does not survive a host restart; tabs are
recreated on demand, but their history model persists across restarts.

## Config

| Key | Default | Meaning |
| --- | --- | --- |
| `statePath` | `$DSH_CHROMIUM_STATE` / `~/.dsh/chromium-state.json` | Where the session snapshot lives |
| `headless` | `true` | Launch headless; set `false` to see the window while debugging |
