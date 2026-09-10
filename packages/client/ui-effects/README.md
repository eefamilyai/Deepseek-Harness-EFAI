# @deepseek-ai/dsh-client-ui-effects

Frame-wide **visual effects** for the DeepSeek Harness web client: an ambient DeepSeek whale backdrop, a bottom-right focus-lock button, a rotating nature scene with a passcode gate, and the Settings row that controls them.

The overlay renders through a **private React root**, the same self-contained pattern the dock uses, so it needs no slot wiring. Three effects share that root:

- **Whale** — the official DeepSeek FishLogo drifting softly behind the chrome, or pinned static and centered when the user opts in.
- **Focus button** — a bottom-right pill that locks the workspace into a calm, rotating nature scene.
- **Focus lock** — the full-screen photographic nature scene behind a four-digit passcode gate. Each lock advances to the next scene.

Preferences are durable. The Host half registers a user-settings section and the browser half mirrors it, with a process-local fallback when settings are unavailable.

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | Host registration for the visual-effects preference section |
| [`src/effects-settings.ts`](src/effects-settings.ts) | The durable preference schema, shared by the Host and browser scopes |
| [`src/client/index.ts`](src/client/index.ts) | Mounts the private overlay root and contributes the Settings row |
| [`src/client/Overlay.tsx`](src/client/Overlay.tsx) | The whale, focus button, and focus lock |
| [`src/client/EffectsSettingsRow.tsx`](src/client/EffectsSettingsRow.tsx) | The Visual effects row: whale and focus toggles, whale size, opacity, and static placement |
| [`src/client/settings-store.ts`](src/client/settings-store.ts) | Mirrors the Host document into browser state, with a process-local fallback |
| [`src/client/locales.ts`](src/client/locales.ts) | The `settings.effects` copy |

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **The focus gate is a screen-lock, not a security boundary** — the passcode is a fixed client-side constant and the scene is a CSS overlay, so anything behind it remains in the page.
- **Effects are client-local** — the toggle state is a user preference; nothing about the overlay reaches a session, and two browsers on the same session can show different effects.
- **Settings fall back silently** — when the settings document is unavailable the store uses process-local values, so a change made in that state is not durable.
- **No reduced-motion mode** — the drifting whale and the scene rotation have no `prefers-reduced-motion` variant.

Fork-owned: `packages/client/ui-effects` is Tier 1, so it touches no upstream file.
