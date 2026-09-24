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

Upstream `deepseek-ai/deepseek-harness` is an all-plugin Cordis agent harness: 307 packages under `packages/<group>/<pkg>/`, where every capability is a Service Definition / Provider / Consumer seam and every behavior is a plugin row in a YAML composition document.

This fork (`eefamilyai/Deepseek-Harness-EFAI`) keeps that architecture and adds seven things:

1. **A persistent Python kernel** the model acts through, backed by a Python sidecar process (`packages/kernel/*`, `python/kiln/*`).
2. **A recursive-language-model engine** that drives that kernel as a REPL instead of exposing it as a one-shot tool (`packages/rlm/*`).
3. **A multi-provider LLM layer** — sixteen provider presets plus DeepSeek's free web session, with pooled logins — and a text-channel tool-call protocol for routes that have no native `tools` field (`packages/llm/llm-kiln`, `llm-dsml`).
4. **Durable memory, context economy, and post-compaction recovery** (`packages/agent-memory/*`, `packages/compaction/output-masking`, `packages/session/session-recovery-context`).
5. **Host and client surfaces**: a self-hosted text-first browser tool, the Tools and Accounts settings sections, the accent palette, and frame-wide visual effects (`packages/web/web-browser`, `packages/client/ui-*`).
6. **A native Windows desktop shell** that shares one Chromium between the user and the agent over CDP (`desktop/harness-desktop`).
7. **Its own composition layer** — two profile bundles and an identity plugin — so none of the six above is delivered by editing an upstream file (`packages/bundle/efai-*`, `packages/core/efai-identity`).

## How a plugin gets mounted

Four layers, applied in this order. The fork contributes to each one from its own packages; it edits none of upstream's.

| Layer | Artifact | What it decides |
|---|---|---|
| Profile | `dsh --profile <name>` | which bundles stack, from the profile's own `dsh.profile.bundles` list under `$DSH_HOME/profiles/<name>` |
| Bundle | `packages/bundle/*/cordis.patch.yml` | the shared roster — the fork's `efai-base` adds **17** host rows over upstream's `dsh-base` |
| Preset | upstream's `packages/bundle/web-app/presets/*.patch.yml` | the acting roster per agent. The fork ships no preset: its kernel tool is a host row, and the tools registry is layered, so a host registration reaches every preset agent |
| Settings | the profile's own `cordis.patch.yml` | the live config fields each plugin declares with `.volatile()`; Settings edits them by row id and the Loader commits them without a remount |

The fork's own rows live in two fork-owned bundles, `@deepseek-ai/dsh-efai-base` and `@deepseek-ai/dsh-efai-web`, stacked after upstream's `dsh-base` and `dsh-web-app`. What names a bundle is the profile, so `start.cmd`, `start.sh`, and both installers run [`efai/ensure-profile-bundles.mjs`](efai/ensure-profile-bundles.mjs), which places the fork bundles on the profile and writes nothing when they are already there. A profile without them runs upstream's harness unchanged.

### The mode switches

| Field (row) | Default | Enforced by |
|---|---|---|
| `kernel` (`tool-roster`) | **true** | `tool-roster`, per turn — the `kernel` tool and its guidance leave the assembled prompt together, and execution is refused |
| `rlm` (`tool-roster`) | **false** | `tool-roster`, per turn — the `rlm` tool becomes the acting surface and `kernel` is withdrawn; both require `kernel`, because the engine runs on the same seam |
| `enabled` (`tool-roster`) | **true** | `tool-roster`, per turn — the conventional tools leave together, leaving the kernel as the only way to act |
| `enabled` (`agent-memory-mode`) | **false** | the row itself, which mounts and unmounts the engine on `loader/volatile-update` — the engine writes evidence to disk, so its off position has to be "not running" |
| `browserWindow` (`kernel-python`) | **false** | the provider, when the kernel process starts |

Each is a `.volatile()` field of the row that enforces it, so the switch and its enforcement cannot disagree, and no switch needs a settings namespace or a separate "mode" package. No composition row is gated on a setting: a Loader `disabled: !!js …` expression is evaluated once at boot, which makes any setting behind it a restart.

## The fork's plugins

Twenty-six packages. Each is a real workspace package registering on a documented extension point, so none of them costs anything at merge time.

### Composition

| Package | What it does |
|---|---|
| `bundle/efai-base` | the fork's rows for any base-backed profile: the identity opener, the Kiln routes, the kernel and RLM stack, memory, the browser, the runtime roster |
| `bundle/efai-web` | the fork's rows for the browser profile: the `/version` route, the effects and accent layers, and the Tools and Accounts settings sections. It disables nothing of upstream's |
| `core/efai-identity` | rewrites the identity opener on `system-prompt/assemble`, so the first line of the prompt is the fork's without editing the prompt package |
| `host/version-route` | `GET /version` answers with the commit the running host was started from |
| `llm/token-usage-lifetime` | a second usage projection that survives compaction, which is what `/session-info` reports |
| `skill/skill-injection` | a second `agent/pre-step` listener: the `@skill <name>` gesture, and skill bodies that re-enter after compaction prunes them |
| `client/ui-flow-accents` | the per-family accent palette, as a theme override layer (the row chrome that reads those tokens still lives in upstream's module stylesheets) |

### Kernel and acting stack

| Package | What it does | Mounts in |
|---|---|---|
| `kernel/kernel` | the `ctx.kernel` capability seam: owns backend **selection policy**, resolved at execution time, never at registration | efai-base |
| `kernel/kernel-python` | the Kiln-backed provider that satisfies that seam; owns the live `browserWindow` field | efai-base |
| `kernel/tool-kernel` | the model-facing `kernel` tool — Python in a persistent namespace. One host row serves every preset agent: each call resolves the agent that made it | efai-base |
| `kernel/kernel-rlm-context` | agent-loop seam reading the kernel's `answer`/binds back as runtime context | efai-base |
| `kernel/roster` | per-turn tool visibility over `system-prompt/assemble`; owns the `kernel`, `rlm`, and conventional-tools switches as live fields. Composed as the `tool-roster` row | efai-base |
| `rlm/rlm` | the recursive driver loop: call LLM → run `python` cells through `ctx.kernel` → feed output back → read `rlm_dump()` → stop when the model sets an answer | efai-base; the roster decides whether its tool is offered |

### LLM routing

| Package | What it does |
|---|---|
| `llm/llm-kiln` | registers every Kiln provider as a harness route named `<prefix><id>` (default `kiln-`): Anthropic, OpenAI, Gemini, OpenRouter, DeepSeek paid, Groq, xAI, Mistral, Together, Fireworks, Perplexity, Cerebras, NVIDIA, Ollama, LM Studio, and `ds_direct` (the free DeepSeek web session), one route per pooled login. Keys are never configuration — each preset names an environment variable. A compaction request gets a summarizer system statement instead of the tool protocol, whichever compaction engine sent it; on `ds_direct`, one too large for a single capped prompt is folded in parts so the summarizer sees all of it. The compaction checkpoint and the recovery handoff are pinned, so a re-primed web chat never clips them. |
| `llm/llm-dsml` | the provider-neutral reader for **text-channel** tool calls (`<tool_calls>`, `<function_calls>`, DeepSeek's pipe-wrapped DSML tokens). Runs on **every** route, because which markup a model writes comes from the model, not the transport. `llm-kiln` is the only adapter that *teaches* the format — except when a model refuses native tools outright (OpenRouter's "No endpoints found that support tool use"): then this pass resends the request with the tools stated as text and runs the calls from the reply, and keeps that model on the text channel for the rest of the process. |
| `llm/llm-system-file` | **work in progress:** delivers the system prompt as a provider file upload instead of inline text. Written and registered, not yet wired to a consumer, and not mounted by any bundle |

### Session, memory, and context

| Package | What it does |
|---|---|
| `agent-memory/agent-memory` | durable evidence on the storage domain plus a bounded, token-stable index re-injected each turn through `system-prompt/assemble`; a host observer on `tools/result` captures automatically, and `memory_add` / `memory_recall` / `memory_map` are the model-facing path |
| `agent-memory/agent-memory-mode` | owns the engine's live `enabled` switch and the mount it controls |
| `session/session-recovery-context` | folds a ledger of the session as the log commits — the operator's words, files touched, commands, unresolved errors, todos — and, in the same step a compaction happens, adds one handoff restating it with the current contents of the most recently changed files and the exact place to resume; the turn keeps running. A focus line keeps the in-progress todo and next step in view afterwards. Registers `{{session_log}}`, `{{session_dir}}`, `{{session_id}}` as prompt facts |
| `compaction/output-masking` | once half the routed window is in use, replaces old, large, successful tool outputs with one-line stubs in one batch, ahead of compaction, using the tool-result pruner's own replacement protocol |
| `session/command-session-info` | slash command reporting token usage, context pressure, and activity |
| `fs/tool-notebook-edit` | view / read / replace / insert / delete over Jupyter `.ipynb` files through the filesystem service |

### Surfaces

| Package | What it does |
|---|---|
| `web/web-browser` | a self-hosted headless browser: a text-first `browser` tool a vision-less model can drive by element ref, plus a Playwright fetch provider that stays dormant until `web_fetch` points at it. Needs a one-time `npx playwright install chromium`. |
| `client/ui-effects` | frame-wide visuals: ambient whale backdrop, a focus-lock button with a rotating scene and passcode gate, and their Settings toggles (live fields of its own row) |
| `client/ui-settings-accounts` | add a DeepSeek web login (email or mobile plus password) from Settings |
| `client/ui-settings-tools` | the kernel, RLM, and conventional-tools switches — the UI over the `tool-roster` row's live fields |

### The Python side

`packages/kernel/kernel-python` speaks to `python/kiln/provider_bridge.py`, a stdio sidecar that keeps the provider registry and the kernel in untouched Python. Forty-nine tracked files under `python/kiln/`; the load-bearing ones:

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

### The desktop shell

`desktop/harness-desktop` is an Electron `BaseWindow` with `WebContentsView` panes: the DSH web UI and a real Chromium side by side, with `--remote-debugging-port` exposing that Chromium as a CDP target so `browser_tools.py` drives the page the user is watching. It sits deliberately outside every workspace glob and every tsconfig, so it is never a pnpm workspace member, never enters the lockfile, and never enters a project reference.

## What differs from upstream

Base commit `00102833df` (`deepseek-harness` 0.1.7-alpha.2), recorded in `local-overlay/BASE`. Measured against it, the fork modifies **75 upstream files** across 16 patch groups and regenerates 25 more. Everything else it adds — 26 packages, the Python runtime, the desktop shell, the tooling — is a path upstream does not own, and therefore costs nothing at merge time.

That 75 is the fork's entire recurring cost, and the list is **frozen**: `local-overlay/SEAM.json` records it, and `pnpm run verify-seam-frozen` fails a tree that modifies an upstream file absent from it. The list may shrink freely; growing it is a recorded decision that shows up in review as a new path.

### What the 0.1.7-alpha.2 merge retired

Upstream shipped its own version of several things the fork had built, so the fork's copies were removed rather than carried:

| Retired | Replaced by upstream's |
|---|---|
| `host/sidebar-bridge`, `client/ui-sidebar-terminal` (fork) | `api/terminal-controller` and `client/ui-sidebar-terminal`, mounted by `dsh-web-app`. The bridge's `/kiln/browser` endpoints had no consumer left in the tree |
| `preset/efai-presets` and its four forked rosters | the `agent-preset-registry` + `agent-preset` rows; the kernel tool now stays a host row that every preset agent sees |
| `kernel/kernel-mode`, `rlm/rlm-mode` | live `.volatile()` config fields on the rows that enforce them |
| `client/ui-settings-advanced` (raw JSON over every namespace) | the generated per-plugin settings pages and **Open configuration file** |
| per-tool switches on the Tools page | the preset editor, which chooses each preset's tools |
| `compaction/compaction-efai` | presets now isolate their own `compaction-basic`, so a host engine no longer reaches a web session. Its summarizer statement moved into `llm-kiln`; its prune-before-manual and wait-for-idle refinements were dropped |
| the folded Turn-process row (8 `ui-chat` files) | upstream's live process row, partial-history handling, and interleaved-input rule |
| the code-block Run/Download chrome and `terminal-bridge` | upstream's code toolbar (language, copy, wrap) |
| the `{ }` code-row glyph | upstream's rebuilt Regular/Medium icon set |
| the transcript-width drag fix | upstream's ref-based drag handler, which no longer re-renders per move |

### What is left, and why each piece is still there

| Group | Files | Why it cannot be a plugin today |
|---|---|---|
| `client-shell`, `client-chat`, `client-primitives`, `client-brand`, `client-model-selection`, `client-input-trigger`, `client-settings` | 43 | **Modifications to upstream's own components**, not additions beside them: the accent chrome, the pooled-login model groups, and the trigger-menu sections change rules inside CSS modules whose class names are hashed at build time and components with no extension point. `client-settings` is the settings-freeze fix (memoizing a decoded section), carried across upstream's `settings-scope.ts` → `config-form.ts` rename. |
| `build`, `core`, `session-format-migration` | 12 | **Upstream defects and generator manifests.** Two are bugs any upstream user hits (`model-selection.ts` accessor re-entrancy on resume, tsdown adopting manifest-less directories); four are migration fixes so the v0 codec can read real released session corpora; the rest name fork packages inside generator tables that have no config file to read. All belong upstream as pull requests. |
| `root-meta`, `tsconfig`, `apps` | 11 | **Registration lists and infrastructure.** `.gitignore`, `.gitattributes`, the README triple, the root `package.json` scripts, project references, and the two bundle names in `apps/cli`'s dependency closure. A package that lives in this repository has to be listed by this repository. |
| `llm`, `docs` | 6 | **The account registry** (`registerAccountProvider` on `LlmRuntime`) and the API docs generated from it, plus the Chinese tool catalog's entries for the fork's two tools (the English one is generated; its translation is kept by hand). Upstream's new `deepseek-account` is a different product (an OAuth login to the paid Platform API), so it does not replace pooled free-web logins. Owed upstream. |
| `agent-skills` | 2 | **Fork pointers in upstream's review and pre-push skills.** An agent reaching for "how do I review a change here" loads those files; a fork-owned skill it never opens would not be read. |

### The mod layer

`local-overlay/` holds the fork's side of every seam edit as `git apply`-able patches, so an upstream update is a re-application rather than a negotiation. Classification is mechanical: a path **added** relative to `BASE` is fork-owned automatically; a **modified** path must be claimed by a patch group or listed as generated, or the rebuild fails. (`tier1Prefixes` in `rules.json` is documentation for readers — no script consults it.)

```bash
pnpm run verify-fork-overlay
```

That runs four checks: `rebuild.mjs --check` (the patches describe the tree), `verify.mjs` (base + patches reproduces the tree byte for byte), `apply.mjs --check` (the patches on disk still apply), and `verify-seam-frozen.mjs` (no upstream file was taken on that the recorded seam does not already list). It is green as of this writing: *16 patches, 75 seam files, base 00102833df*.

Full merge procedure, the seam register with an exit plan per row, and the rules for a new seam edit: [`HARNESS-EDITS.md`](HARNESS-EDITS.md).

## Where the mess actually is

Honest accounting, all verified against the tree.

**Fixed:**

1. ~~Composition lived in upstream files.~~ The fork's rows live in `packages/bundle/efai-base` and `efai-web`, and its identity opener in `packages/core/efai-identity`. The launcher puts the fork bundles on the profile.
2. ~~Settings were gated by boot-time Loader expressions, then by fork-owned settings namespaces.~~ Every fork switch is a `.volatile()` field of the row that enforces it, edited by row id through upstream's own settings forms.
3. ~~The fork maintained its own presets, terminal, settings editor, turn-process fold, and code-block chrome.~~ Upstream ships each of them now; see the retirement table above.
4. ~~Generated catalogs were being hand-merged as if they were source.~~ They are declared generated, so a conflict in one is resolved by running its command. The tool catalog generator, which had been failing on the fork, runs again.
5. ~~Nothing stopped the seam from growing.~~ `verify-seam-frozen` fails any build that modifies an upstream file the fork has not already recorded.

**Still open:**

6. **43 of the 75 seam files are client UI** modifications to upstream's components. Retiring them is a component-forking project, or an upstream extension point for row chrome, not a mechanism gap.
7. **Twelve files are work owed upstream**: two genuine upstream bugs, four session-format migration fixes, and generator manifests that name fork packages. Each is a pull request nobody has opened.
8. **Saved switch positions from before the merge are not carried over.** Upstream imports the old `settings.yaml` into the profile by row id; the fork's old sections were named `kernel`, `rlm`, and `tools`, not by row id, so those switches start from their defaults once.
9. **Two features are in flight outside this branch** — system-prompt-as-file-upload and tool-result file delivery — with their state in root `SESSION-*.md` work logs. They were written against the pre-merge APIs (`MessageSource` `plugin` kinds, tool-result content blocks) and need the same port this merge applied.
10. **Credentials still rest on `.gitignore` alone** — `ds_config.json` (DeepSeek password and WAF cookie) and `python/kiln/runtime/ds_sessions.json` (live session tokens) sit in the working tree. Nothing matching them is tracked today; one `git add -f` changes that.
