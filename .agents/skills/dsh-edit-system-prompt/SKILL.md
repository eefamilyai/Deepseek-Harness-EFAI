---
name: dsh-edit-system-prompt
description: Use before changing the model-facing system prompt in this fork. Locates the exact assembled section (harness identity, deployment persona, or a tool guidance), picks the correct plane (fork source seam vs user composition), and keeps the overlay patch and its test in sync.
---

# Editing the system prompt

The model-facing system prompt is not one file. It is assembled per agent turn by
`packages/core/system-prompt` from ordered contributions registered through
`ctx.systemPrompt.section({ name, order, text })`. Identify which contribution owns
the text before editing.

## Where the text lives

| What you see in the prompt | Order | Source |
|---|---|---|
| Fixed opener "...fully enclosed sandbox..." | `HARNESS_IDENTITY` = -1000 | `packages/core/system-prompt/src/index.ts`, the `harness:identity` section in the `SystemPrompt` constructor |
| Web opener "You are a coding agent powered by {{model}}..." | `DEPLOYMENT_PERSONA` = 0 | `packages/bundle/web-app/cordis.patch.yml`, the `system-prompt` row `config.persona` (shadows the empty `packages/bundle/base/cordis.patch.yml` default) |
| Per-agent preset persona | `DEPLOYMENT_PERSONA` = 0 | the preset's `- id: persona` / `@deepseek-ai/dsh-persona` row; registers the same `deployment:persona` name and shadows the Web/base persona for that agent |
| Tool guidance (bash, web_search, filesystem, plan, ...) | `TOOL_*` entries in `SECTION_ORDERS` | the owning tool package's `src/*.ts` |
| Runtime context (sandbox, approval, delegation) | `CONTEXT_ORDERS` (110..120) | the owning package via `ctx.systemPrompt.context(...)` |

The full maps (`SECTION_ORDERS`, `CONTEXT_ORDERS`, `PERSONA_SECTION`) are in
`packages/core/system-prompt/src/index.ts`. Read them before touching any order.

## Choose the plane

1. **User/deployment composition** (no source change, zero merge cost). Prefer this
   for "change my assistant's opening line".
   - Whole Web profile: `%DSH_HOME%/profiles/web/cordis.patch.yml` -> override the
     `system-prompt` row `persona`.
   - One agent preset: `agentPresets.copy(...)` a shipped preset, then edit the copy's
     `agent.cordis.yml` persona row. Never edit the shipped preset install. See the
     `editing-cordis-compositions` skill.
2. **Fork source seam** (what the harness ships). `core/system-prompt/src/index.ts` is
   Tier 2, seam register row 11, tag `brand`.
   - Load `dsh-harness-edit`, follow `HARNESS-EDITS.md`.
   - Place a `DSH-FORK` marker on the change with a concrete `EXIT:` clause — the
     condition under which the fork delta can be dropped.
   - Edit BOTH the source file and `local-overlay/patches/core.patch` (the patch is the
     source of truth for the diff; `node local-overlay/apply.mjs` reapplies it).
   - Register the path in `local-overlay/rules.json` `patchGroups` if no group claims it.
   - Keep `packages/core/system-prompt/tests/system-prompt.spec.ts` `IDENTITY` constant
     byte-identical to the runtime string.

Composition layers: agent preset persona > Web profile persona > base default. The
fixed `harness:identity` opener is suppressed only by an effective `complete: true`.

## Verify

- `git diff --stat` minimal; `git diff --check` clean.
- Source string == spec `IDENTITY` constant.
- Preset: `agentPresets.standingKeyFor(id)`; never treat roster `broken` as validation.
- The seam edit is not proven until the fork's own gate passes. The pre-commit and
  pre-push hooks do not run it, so a seam edit can pass every upstream check while
  leaving the patch set stale:

```sh
pnpm run verify-fork-overlay     # rebuild --check, verify, apply --check
```

  `rebuild --check` proves `local-overlay/patches/*.patch` still describes the tree,
  `verify.mjs` proves base + patches reproduces the worktree byte for byte, and
  `apply.mjs --check` proves the committed patches still apply to a pristine base.
  A system-prompt seam edit that changed the source without regenerating
  `core.patch` passes typecheck and fails `verify-fork-overlay`.

## Do not touch

- `packages/llm/llm-kiln/tests/dsml.spec.ts` holds an unrelated shorter "fully enclosed
  sandbox" sentinel for the Kiln text-only parser, not the harness identity.
- Never hand-merge generated snapshots that embed the old prompt; regenerate them.
