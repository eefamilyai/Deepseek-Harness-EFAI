# @deepseek-ai/dsh-client-ui-dock

The **right-side dock**: a slide-in drawer over the chat with a live Terminal pane.

The pane shows live host state rather than a copy of it: the Terminal tab is a live WebSocket to the dedicated user shell the sidebar bridge owns, independent of whatever the model runs through its own tools.

The client half of the plugin mounts the dock into a **private React root** appended to the document body, so the drawer needs no slot wiring. It also contributes two conversation-header utilities through the slot system: a persistent sidebar toggle, and a three-dot overflow menu that re-hosts the Session-log download beside a few dock-centric actions.

The host half is intentionally inert. Everything with a server side — the user terminal — lives in [`@deepseek-ai/dsh-host-sidebar-bridge`](../../host/sidebar-bridge/README.md); this half exists so the package presents a node entry to the loader.

## Layout

| File | Role |
|---|---|
| [`src/client/index.ts`](src/client/index.ts) | Mounts the private dock root and contributes the header slots |
| [`src/client/Dock.tsx`](src/client/Dock.tsx) | The drawer shell; the terminal pane stays mounted so the session survives a collapse |
| [`src/client/Terminal.tsx`](src/client/Terminal.tsx) | The line-based piped shell over `/kiln/terminal` |
| [`src/client/ansi.ts`](src/client/ansi.ts) | The dependency-free ANSI renderer for the terminal scrollback |
| [`src/client/header-actions.tsx`](src/client/header-actions.tsx) | The sidebar toggle and the overflow menu |
| [`src/client/dock-events.ts`](src/client/dock-events.ts) | The same-origin event bus bridging the overlay root to the header slots |
| [`src/index.ts`](src/index.ts) | The inert host entry |

## Endpoints

The dock reads and writes host state over the sidebar bridge's own route, so it needs none of the RPC protocol.

| Route | Use |
|---|---|
| `WS /kiln/terminal` | The dedicated user shell |

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **No PTY in the terminal pane** — Windows has no PTY, so the shell is line-based: a whole line is sent on Enter and echoed locally as you type. Full-screen TUIs such as `vim` or `htop` are out of scope for a piped shell.
- **Not a full terminal emulator** — the ANSI renderer covers SGR colors and weights, `\r` line overwrites, and the OSC title and bare cursor sequences it drops silently. Absolute cursor addressing is not rendered.
- **Dock state is per-browser** — the open flag and the drawer width persist in `localStorage`, so they do not follow a session across machines.

Fork-owned: `packages/client/ui-dock` is Tier 1, so it touches no upstream file.
