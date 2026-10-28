# Upstream update to deepseek-harness 0.2.2-alpha.2

The fork sat on `0.2.1-rc.2` (687f282e86). This job ports `upstream/master` @
`f3803c9697` (`release(dsh): 0.2.2-alpha.2`, 2026-10-28) onto it: 2176 upstream
commits over 7435 files.

Driven by `efai/merge_upstream.py` (`plan`, `start`, `continue`, `finish`), which
merges in a throwaway worktree under `.worktrees/`, protects every fork addition
byte for byte, and rebuilds the overlay before it commits.

## What the merge produced

- **Merge commit** `aa36512cc6` on `master` (fast-forwarded, not pushed at the
  time of writing), plus `279e817167` for the overlay record.
- **Conflicts: 378.** 13 resolved by rule (generated docs, the lockfile,
  `tsconfig.base.json`), 365 by hand:
  - **345 were package versions.** The fork used to pin every workspace
    `package.json` to its own release version, which collided with upstream's
    bump on every file. They now follow upstream, so a future merge has no
    version conflict at all. `package.json` and `apps/cli/package.json` kept the
    fork's own edits (the `verify-fork-overlay` scripts and the two `efai-*`
    bundle dependencies).
  - **20 real seam conflicts** (`ui-schedule` page and its locals/tests, the
    schedule service import list, `model-selection.ts`, `MarkdownText.tsx`,
    `desktop-host/src/index.ts`, `apps/cli/package.json`, `.gitattributes`,
    `package-dependency-policy.ts`, `gen-tool-catalog.spec.ts`, the two schedule
    README pairs).
- **Seam: 71 → 68 → 71.** Retired: `packages/core/agent/src/model-selection.ts`
  and its spec (upstream removed the shared `modelSelection` accessor, which is
  what the fork's per-scope fix existed for), and two `README.i18n.yaml`
  records. Re-added: the schedule README pairs and their records, which the
  fork's own prose owns, plus one new path,
  `packages/experimental/liveshare/src/endpoint-classification.ts` — upstream's
  completeness gate for Remote endpoints, which the fork's `schedule/create`
  endpoint must be classified in.

## What upstream's changes broke in the fork (fixed here)

| Area | Change | Fix |
|---|---|---|
| Session projections | `register()` returns an awaitable handle; `stateOf(session, key)` is deprecated and answers `unknown` | `output-masking`, `token-usage-lifetime` and `skill-injection` await registration and read through the handle |
| Tool declarations | `system-prompt/assemble` no longer carries `tools`; a step's admitted set is the only source | `kernel/roster` drops guidance sections in the waterfall and denies the tool in the Agent scope at `agent/pre-step` (see the regression note below) |
| Tool execution | `ctx.tools.execute()` takes a raw call batch, not one call | `kernel-python`'s seam and the kernel/devtools seams' tests migrated |
| Agent route | the step's provider/model is fixed before `agent/request` | `session-recovery-context` specs create their agents on the mock route instead of overriding it later |
| `Agent` | requires `model` | test stubs use the testkit's `unsupportedModel()` |
| `PreStepDecision` | `{ kind: 'reject' } | { kind: 'enter', messages }` | spec payloads updated |
| Executors | `assemble()` and `execute()` need a mounted tool executor | native executor mounted in the fork specs that lacked one |
| Agent registry | injects `sessionProjections` | `tool-notebook-edit` mounts the registry first |
| Tool fixtures | `defineContentToolFixture` moved to `@deepseek-ai/dsh-tool-testkit` | imports updated, dependency declared |
| Official bundles | `PROFILE_TEMPLATES` moved out of `app-boot` | `profile-hub` imports `@deepseek-ai/dsh-official-bundles` |
| Command info | `ctx.modelSelection` is gone | reads `agent.model.current()` |

## Known regression: per-tool switches no longer remove every schema

Upstream now derives tool declarations from each step's admitted set and says so
explicitly ("a returned `tools` field is ignored"). A plugin can therefore no
longer delete another owner's declaration from the waterfall. The roster now:

- masks the tools the registry will let it mask (`tools.restrict` in the Agent's
  own scope) so those leave the request entirely, and
- drops the tool's `tool:<name>` guidance section, and
- keeps refusing calls through the monotonic `tools.guard()`.

A tool that a preset registers **in its own scope** cannot be masked there
(`restrict` refuses scope-local names), so its schema still appears in the
request while a call to it is refused with the settings message. Fixing that
needs either an upstream extension point for third-party tool admission or
moving those registrations into the fork's own scope.

## Validation

- `pnpm run typecheck`: 5/5 gates green in the merge worktree.
- `pnpm run build` and the throwaway-home boot smoke: green, every fork row
  composed in the `web` profile.
- Fork package tests: 4211 passed, **12 failed in 3 files**, of which 5 are
  pre-existing on `0.2.1-rc.3` (verified by running the same files on the
  pre-merge checkout):
  - `packages/llm/llm-kiln/tests/dsml.spec.ts` (4) — the translator emits its
    note text where these cases still expect the raw block as prose.
  - `packages/compaction/compaction-basic/tests/runtime-context-admission.spec.ts`
    (1) — proactive compaction does not fire in that case.
  - `packages/skill/skill-injection` (7) — **fixed** in this merge.
- Overlay: `rebuild --check`, `verify`, `apply --check`, `verify-seam-frozen`
  all green at base `f3803c9697`, seam frozen at 71 files.
- `pnpm run test:snapshot:record` cannot run here: the headless cases need
  `DEEPSEEK_API_KEY`. Its partial run was reverted, so the two
  `lifecycle-chrome` expectations are upstream's; the fork's hero drops the
  preview badge, so those two cases will record a one-word difference next time
  a key is available.

## Decisions worth keeping

- **The version pin is gone.** The fork no longer rewrites 345 `package.json`
  versions, which removes about 340 conflicts from every future merge. Fork
  releases are identified by git tag (`efai-desktop-v<version>`) and release
  notes, not by the workspace version. This also ends the tag collision with
  upstream's own `dsh-v0.2.1-rc.3`/`rc.4` releases.
- **`liveshare` is a new seam path.** Upstream's client-face gate enumerates
  every Remote endpoint, so a fork-owned endpoint cannot exist without editing
  it. The path carries a `DSH-FORK(schedule)` marker with its exit condition.
- **`efai/record-snapshots.mjs`** exists because upstream's
  `test:snapshot:record` sets `DSH_SNAPSHOT` inline, which `cmd.exe` cannot run;
  `rules.json` regenerates those expectations through this wrapper instead.
- **The Desktop shell still needs its own pass.** `apps/desktop/src/main.ts`
  keeps the fork's acrylic material and `paths.ts` its profile selection; both
  were reviewed against upstream's new code and still fit, but the Desktop
  bundle was not launched from the merged tree in this job.
