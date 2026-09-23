# HARNESS.md — what this harness is, what it mounts, and how it differs from upstream

This is the map of the fork: every plugin it adds, where each one mounts, which switch turns it on, and the whole of what it changes in upstream files. It is the entry point; the other records stay authoritative for their own subject and are named below rather than copied here.

This file is fork-owned — upstream will never create a file at this path — so it never produces a merge conflict.

## One home per fact

| Question | Authority |
|---|---|
| What does the fork add, and what does each piece do? | **this file** |
| Which upstream files does the fork modify, and why does each edit exist? | [`HARNESS-EDITS.md`](HARNESS-EDITS.md) — the merge contract, seam register, and the rules for touching an upstream file |
| Exactly which paths are patched, generated, or fork-owned right now? | [`local-overlay/INVENTORY.md`](local-overlay/INVENTORY.md) — generated from the tree, cannot drift |
| Which patch group owns a path? | [`local-overlay/rules.json`](local-overlay/rules.json) |
| What does the upstream harness itself do? | [`AGENTS.md`](AGENTS.md), [`docs/architecture.md`](docs/architecture.md), and the generated catalogs in `docs/` |
| Which plugins does a shipped profile compose? | [`apps/cli/composition.md`](apps/cli/composition.md) (generated) |
| How do I edit an upstream-owned file safely? | [`.agents/skills/dsh-harness-edit/SKILL.md`](.agents/skills/dsh-harness-edit/SKILL.md) |

Numbers in this file are derived from `git diff` against the recorded base and from the generated inventory; when a count here disagrees with `local-overlay/INVENTORY.md`, the inventory wins.

## The shape of the thing

Upstream `deepseek-ai/deepseek-harness` is an all-plugin Cordis agent harness: 290 packages under `packages/<group>/<pkg>/`, where every capability is a Service Definition / Provider / Consumer seam and every behavior is a plugin row in a YAML composition document.

This fork (`eefamilyai/Deepseek-Harness-EFAI`) keeps that architecture and adds seven things:

1. **A persistent Python kernel** the model acts through, backed by a Python sidecar process (`packages/kernel/*`, `python/kiln/*`).
2. **A recursive-language-model engine** that drives that kernel as a REPL instead of exposing it as a one-shot tool (`packages/rlm/*`).
3. **A multi-provider LLM layer** — sixteen provider presets plus DeepSeek's free web session — with a text-channel tool-call protocol for routes that have no native `tools` field (`packages/llm/llm-kiln`, `llm-dsml`, `llm-system-file`).
4. **Durable memory and post-compaction recovery** (`packages/agent-memory/*`, `packages/session/session-recovery-context`).
5. **Host and client surfaces**: a self-hosted browser, a sidebar terminal, settings sections, and frame-wide visual effects (`packages/web/web-browser`, `packages/host/sidebar-bridge`, `packages/client/ui-*`).
6. **A native Windows desktop shell** that shares one Chromium between the user and the agent over CDP (`desktop/harness-desktop`).
7. **Its own composition layer** — two profile bundles, a preset root, and an identity plugin — so none of the six above is delivered by editing an upstream file (`packages/bundle/efai-*`, `packages/preset/efai-presets`, `packages/core/efai-identity`).

## How a plugin gets mounted

Four layers, applied in this order. The fork contributes to each one from its own packages; it edits none of upstream's.

| Layer | Artifact | What it decides |
|---|---|---|
| Profile | `dsh --profile <name>` | which bundles stack, from the profile's own `dsh.profile.bundles` list under `$DSH_HOME/profiles/<name>` |
| Bundle | `packages/bundle/*/cordis.patch.yml` | the shared roster — upstream's `base` is **84 rows**, and the fork's `efai-base` adds **16** over it |
| Preset | `packages/preset/efai-presets/presets/{standard,minimal,ptc,cordis}/agent.cordis.yml` | the acting roster per agent — `standard` is **32 rows** |
| Settings | the `$DSH_HOME` settings document, read at runtime by the plugin that owns each switch | what the model may see and do this turn |

The fork's own rows live in two fork-owned bundles, `@deepseek-ai/dsh-efai-base` and `@deepseek-ai/dsh-efai-web`, stacked after upstream's `dsh-base` and `dsh-web-app`. What names a bundle is the profile, so `start.cmd`, `start.sh`, and both installers run [`efai/ensure-profile-bundles.mjs`](efai/ensure-profile-bundles.mjs), which places the fork bundles on the profile and writes nothing when they are already there. A profile without them runs upstream's harness unchanged.

### The three mode switches

| Setting | Default | Owner | Enforced by |
|---|---|---|---|
| `kernel.enabled` | **true** | `kernel-mode` | `tool-roster`, per turn — the `kernel` tool and its guidance leave the assembled prompt together, and execution is refused |
| `rlm.enabled` | **false** | `rlm-mode` | `tool-roster`, per turn — the `rlm` tool becomes the acting surface and `kernel` is withdrawn; both require `kernel.enabled`, because the engine runs on the same seam |
| `agent-memory.enabled` | **false** | `agent-memory-mode` | the switch itself, which mounts and unmounts the engine — the engine observes every tool result and writes evidence to disk, so its off position has to be "not running" |

No composition row is gated on a setting. A Loader `disabled: !!js …` expression is evaluated once at boot, which makes any setting behind it a restart and unmounts the plugin that would publish the switch in its own off position. Deciding at runtime is what makes all three live, and it is why none of these switches costs an upstream edit.

## The fork's plugins

Thirty-one packages, one of them still in flight. Each is a real workspace package registering on a documented extension point, so none of them costs anything at merge time.

### Composition

| Package | What it does |
|---|---|
| `bundle/efai-base` | the fork's rows for any base-backed profile: the identity opener, the Kiln routes, the kernel and RLM stack, memory, the browser, the runtime roster |
| `bundle/efai-web` | the fork's rows for the browser profile: the sidebar bridge and its terminal tab, the effects layer, the two settings sections, the `/version` route, and the preset-roster swap |
| `preset/efai-presets` | mounts upstream's roster machinery against the fork's own preset root and drops the shipped one, so the four roster ids carry the kernel acting surface |
| `core/efai-identity` | rewrites the identity opener on `system-prompt/assemble`, so the first line of the prompt is the fork's without editing the prompt package |
| `host/version-route` | `GET /version` answers with the commit the running host was started from |
| `compaction/compaction-efai` | upstream's engine subclassed on its `summarize` hook: a summarizer system prompt for text-only routes, a prune before the manual path, and a `/compact` that waits out the turn in flight |
| `llm/token-usage-lifetime` | a second usage projection that survives compaction, which is what `/session-info` reports |
| `skill/skill-injection` | a second `agent/pre-step` listener: the `@skill <name>` gesture, and skill bodies that re-enter after compaction prunes them |
| `client/ui-settings-advanced` | the Advanced settings section, as a `settings.section` slot registration |
| `client/ui-flow-accents` | the per-family accent palette, as a theme override layer (the row chrome that reads those tokens still lives in upstream's module stylesheets) |

### Kernel and acting stack

| Package | What it does | Mounts in |
|---|---|---|
| `kernel/kernel` | the `ctx.kernel` capability seam: owns backend **selection policy**, resolved at execution time, never at registration | efai-base |
| `kernel/kernel-python` | the Kiln-backed provider that satisfies that seam | efai-base |
| `kernel/tool-kernel` | the model-facing `kernel` tool — Python in a persistent namespace | efai-base (host plane, off in the web profile) and every fork preset (agent plane) |
| `kernel/kernel-mode` | owns `kernel.enabled` | efai-base |
| `kernel/kernel-rlm-context` | agent-loop seam reading the kernel's `answer`/binds back as runtime context | efai-base |
| `kernel/tool-roster` | per-turn tool visibility over `system-prompt/assemble`; mounted last so its seeded defaults see the whole registry | efai-base (final row) |
| `rlm/rlm` | the recursive driver loop: call LLM → run `python` cells through `ctx.kernel` → feed output back → read `rlm_dump()` → stop when the model sets an answer | efai-base; the roster decides whether its tool is offered |
| `rlm/rlm-mode` | owns `rlm.enabled` | efai-base |

### LLM routing

| Package | What it does |
|---|---|
| `llm/llm-kiln` | registers every Kiln provider as a harness route named `<prefix><id>` (default `kiln-`): Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek paid, Groq, xAI, Mistral, Together, Fireworks, Perplexity, Cerebras, NVIDIA, Ollama, LM Studio, and `ds_direct` (the free DeepSeek web session), plus any custom OpenAI-compatible provider the settings document adds. Keys are never configuration — each preset names an environment variable. |
| `llm/llm-dsml` | the provider-neutral reader for **text-channel** tool calls (`<tool_calls>`, `<function_calls>`, DeepSeek's pipe-wrapped DSML tokens). Runs on **every** route, because which markup a model writes comes from the model, not the transport. `llm-kiln` is the only adapter that *teaches* the format. |
| `llm/llm-system-file` | **in flight, untracked**: deliver the system prompt as an uploaded provider file, reusing one file id until the provider rejects it. The package is written and registered but has no consumers yet — see `SESSION-system-prompt-as-file-upload.md`. |

### Session, memory, and context

| Package | What it does |
|---|---|
| `agent-memory/agent-memory` | durable evidence on the storage domain plus a bounded, token-stable index re-injected each turn through `system-prompt/assemble`; a host observer on `tools/result` captures automatically, and `memory_add` / `memory_recall` / `memory_map` are the model-facing path |
| `agent-memory/agent-memory-mode` | owns `agent-memory.enabled` |
| `session/session-recovery-context` | after a compaction, injects one message carrying the operator's own prompts and the tail of the session log, and registers `{{session_log}}`, `{{session_dir}}`, `{{session_id}}` as prompt facts |
| `session/command-session-info` | slash command reporting token usage, context pressure, and activity |
| `fs/tool-notebook-edit` | view / read / replace / insert / delete over Jupyter `.ipynb` files through the filesystem service |

### Surfaces

| Package | What it does |
|---|---|
| `web/web-browser` | a self-hosted headless browser: a text-first `browser` tool a vision-less model can drive by element ref, plus a Playwright fetch provider that stays dormant until `web_fetch` points at it. Needs a one-time `npx playwright install chromium`. |
| `host/sidebar-bridge` | host endpoints over the webserver carrier: a user PTY at `ws /kiln/terminal` and the agent's shared browser at `/kiln/browser` (live state, screenshots, drive-by-action) |
| `client/ui-sidebar-terminal` | the sidebar tab type rendering that PTY as a live shell in the session workspace |
| `client/ui-effects` | frame-wide visuals: ambient whale backdrop, a focus-lock button with a rotating scene and passcode gate, and their Settings toggles |
| `client/ui-settings-accounts` | add a DeepSeek login (email or mobile plus password) from Settings |
| `client/ui-settings-tools` | the kernel switch, the conventional-tool switch, and one switch per registered tool — the UI over `tool-roster` |

### The Python side

`packages/kernel/kernel-python` speaks to `python/kiln/provider_bridge.py`, a stdio sidecar that keeps the provider registry and the kernel in untouched Python. Forty-four tracked files under `python/kiln/`; the load-bearing ones:

| Module | Role |
|---|---|
| `provider_bridge.py` | the stdio sidecar exposing the registry to Node |
| `runtime/providers.py` | provider registry; every adapter implements one contract |
| `runtime/{openai,anthropic,gemini}_provider.py` | the three wire adapters (OpenAI-compatible also serves OpenRouter, DeepSeek paid, and custom presets) |
| `runtime/ds_direct.py` | talks to chat.deepseek.com directly — the free web session |
| `runtime/ds_waf.py`, `ds_identity.py`, `_pow_solver.cjs`, `sha3_wasm_bg.wasm` | the AWS WAF challenge solver and one stable per-machine device identity behind it |
| `runtime/kernel_child.py` | the kernel process itself — the persistent namespace |
| `runtime/browser_tools.py` | sandboxed Chromium automation, windowless by default; attaches over CDP to the desktop shell when one is running |
| `runtime/vision_tools.py` | the one tool that returns pixels: screen, monitor, window, or embedded browser |
| `runtime/kiln_memory.py`, `context_store.py` | durable memory tier and an incremental code-aware BM25 index over a directory |
| `runtime/compaction.py` | context-rot control, ported from PrimeIntellect's prime-agent |
| `runtime/rlm_context.py` | the `__KILN_RLM_STATE__` read-back protocol the TS `rlm` engine parses |
| `runtime/token_usage.py` | token accounting, estimated for the browser backend which reports none |
| `runtime/{app_settings,config,sse_client,provider_errors}.py` | settings, `KILN_*` env configuration, a stdlib SSE client, and readable provider errors |
| `runtime/{provider_uploads,tool_result_files}.py` | **in flight, untracked**: per-provider file upload so an oversized tool result is delivered as a file instead of inline prompt text — see `SESSION-tool-output-file-delivery.md` |

### The desktop shell

`desktop/harness-desktop` is an Electron `BaseWindow` with `WebContentsView` panes: the DSH web UI and a real Chromium side by side, with `--remote-debugging-port` exposing that Chromium as a CDP target so `browser_tools.py` drives the page the user is watching. It sits deliberately outside every workspace glob and every tsconfig, so it is never a pnpm workspace member, never enters the lockfile, and never enters a project reference.

## What differs from upstream

Base commit `c291e7961a` (`deepseek-harness` 0.1.5-rc.2), recorded in `local-overlay/BASE`. Measured against it, the fork modifies **92 upstream files** across 17 patch groups, regenerates 23 more, and deletes one symlink (`.claude/skills`). Everything else it adds — 31 packages, the Python runtime, the desktop shell, the tooling — is a path upstream does not own, and therefore costs nothing at merge time.

That 92 is the fork's entire recurring cost, and the list is **frozen**: `local-overlay/SEAM.json` records it, and `pnpm run verify-seam-frozen` fails a tree that modifies an upstream file absent from it. The list may shrink freely; growing it is a recorded decision that shows up in review as a new path.

### What is left, and why each piece is still there

| Group | Files | Why it cannot be a plugin today |
|---|---|---|
| `client-shell`, `client-chat`, `client-primitives`, `client-brand`, `client-model-selection`, `client-input-trigger`, `client-settings`, `client-locale` | 62 | **Modifications to upstream's own components**, not additions beside them: the folded Turn-process row rewrites `ui-chat`'s store and presentation contracts; the accent chrome, collapsed model groups, and trigger-menu sections change rules inside CSS modules whose class names are hashed at build time. A stylesheet or slot registration from outside cannot reach either. Moving them means forking the components — the same copy-and-drift trade as the presets, for thirteen components at once. |
| `build`, `core`, `session-format-migration` | 12 | **Upstream defects and generator manifests.** Two are bugs any upstream user hits (`model-selection.ts` accessor re-entrancy on resume, tsdown adopting manifest-less directories); four are migration fixes so the v0 codec can read real released session corpora; the rest name fork packages inside generator tables that have no config file to read. All belong upstream as pull requests. |
| `root-meta`, `tsconfig`, `apps` | 11 | **Registration lists and infrastructure.** `.gitignore`, `.gitattributes`, the README triple, the root `package.json` scripts, project references, and the two bundle names in `apps/cli`'s dependency closure. A package that lives in this repository has to be listed by this repository. |
| `llm`, `docs` | 5 | **The account registry** (`registerAccountProvider` on `LlmRuntime`) and the API docs generated from it. Moving it means a fork-owned Typert remote service carrying a password from the browser to the host; rolling that transport rather than using the harness's authenticated RPC is the wrong trade. Owed upstream — pooling several logins per provider route is not fork-specific. |
| `agent-skills` | 2 | **Fork pointers in upstream's review and pre-push skills.** An agent reaching for "how do I review a change here" loads those files; a fork-owned skill it never opens would not be read. Both hunks are now short pointers into `dsh-harness-edit`. |
### The mod layer

`local-overlay/` holds the fork's side of every seam edit as `git apply`-able patches, so an upstream update is a re-application rather than a negotiation. Classification is mechanical: a path **added** relative to `BASE` is fork-owned automatically; a **modified** path must be claimed by a patch group or listed as generated, or the rebuild fails. (`tier1Prefixes` in `rules.json` is documentation for readers — no script consults it.)

```bash
pnpm run verify-fork-overlay
```

That runs five checks: `rebuild.mjs --check` (the patches describe the tree), `verify.mjs` (base + patches reproduces the tree byte for byte), `apply.mjs --check` (the patches on disk still apply), `verify-seam-frozen.mjs` (no upstream file was taken on that the recorded seam does not already list), and `verify-efai-presets.mjs` (upstream has not moved a preset the fork forked). It is green as of this writing: *20 patches, 124 seam files, base c291e7961a*.

Full merge procedure, the seam register with an exit plan per row, and the rules for a new seam edit: [`HARNESS-EDITS.md`](HARNESS-EDITS.md).

## Where the mess actually is

Honest accounting, all verified against the tree.

**Fixed:**

1. ~~Composition lived in upstream files.~~ The fork's rows moved into `packages/bundle/efai-base` and `efai-web`, its rosters into `packages/preset/efai-presets`, and its identity opener into `packages/core/efai-identity`. Upstream's two bundles, four presets, `app-boot`, and `system-prompt` are pristine, and the launcher puts the fork bundles on the profile.
2. ~~Three settings were gated by boot-time Loader expressions.~~ `kernel.enabled`, `rlm.enabled`, and `agent-memory.enabled` are decided at runtime, which deleted `dshSettingFlag` from upstream's `app-boot`. A boot-time switch is now in force on the first turn rather than after the first turn boundary.
3. ~~Compaction, skills, usage, and the settings/theme surfaces were edits inside upstream packages.~~ They are now `compaction-efai` (a subclass on the documented `summarize` hook), `skill-injection` (a second `agent/pre-step` listener), `token-usage-lifetime` (its own projection unit), `ui-settings-advanced` (a `settings.section` slot registration), and `ui-flow-accents` (a theme override layer).
4. ~~Four generated catalogs were being hand-merged as if they were source.~~ They are declared generated, so a conflict in one is resolved by running its command.
5. ~~Nothing stopped the seam from growing.~~ `verify-seam-frozen` fails any build that modifies an upstream file the fork has not already recorded, and it is wired into `verify-fork-overlay`.

**Still open:**

6. **62 of the 92 seam files are client UI**, and they are modifications to upstream's components rather than additions beside them — see the table above. Retiring them is a component-forking project, not a mechanism gap.
7. **Twelve files are work owed upstream**: two genuine upstream bugs, four session-format migration fixes, and generator manifests that name fork packages. Each is a pull request nobody has opened.
8. **Five `doc-sync` gates are red at baseline**, mostly fork package READMEs missing the `## Summary` / Table of Contents / Dev Note skeleton and a `.zh.md` pair. The packages added in this pass carry the skeleton; the older ones still do not.
9. **Two features are in flight and untracked** — system-prompt-as-file-upload (TS package written, no consumers) and tool-result file delivery (Python side) — with their state in root `SESSION-*.md` work logs rather than Agent Notes.
10. **Root-level scratch.** `.tmp-*.cjs`, `.tmp-*.txt`, `_show_block.txt`, `acl_scan_output.txt`, `notes_output.txt`, `_t.png`, `e2e-shot.png`, and the `.freebuff/`, `.scratch/`, `.vfinal/`, `.merge-port/redo/`, `.research-compaction/` directories are working residue. Several are tracked.
11. **Credentials still rest on `.gitignore` alone** — `ds_config.json` (DeepSeek password and WAF cookie) and `python/kiln/runtime/ds_sessions.json` (live session tokens) sit in the working tree. Nothing matching them is tracked today; one `git add -f` changes that.
