# Upstream sync: what is done and what is left

This branch merges `deepseek-ai/deepseek-harness` (`upstream/master`) into this
repository's `master`. The merge is **committed with 14 files still carrying
conflict markers** so the remaining decisions are visible in the tree rather
than lost in a local merge state. The tree does not build until they are
resolved.

## How to pick this up

```sh
git fetch origin && git checkout claude/upstream-sync
grep -rln '^<<<<<<< HEAD' --exclude-dir=node_modules .   # the 14 files below
```

Resolve a file, remove its markers, then `git add` it. When all 14 are clean:

```sh
pnpm install && pnpm run build
pnpm run typecheck && pnpm run test
pnpm run gen-cordis-catalog && pnpm run gen-tool-catalog && pnpm run gen-config-catalog
pnpm run doc-sync
```

## The shape of the merge

| | count | note |
|---|---|---|
| Upstream commits merged | 11,947 | base was `47f94385`, 2026-08-13 |
| Our new packages | 146 files, ~50k lines | no upstream path collision; merged untouched |
| Files upstream deleted under us | 12 | resolved as deletions, see below |
| Conflicts already resolved | 12 | see below |
| Conflicts left for review | 14 | see below |

## Already resolved

- `tsconfig.{base,client,host}.json` — unioned: upstream's project references plus
  `packages/kernel/*/src`, `ui-dock`, `ui-effects`, `sidebar-bridge`.
- `apps/cli/package.json`, `packages/bundle/base/package.json` — dependency unions,
  sorted. The `apiproxy` dependency is gone with the package.
- `packages/bundle/web-app/cordis.patch.yml` — upstream's preset-roster prose plus our
  `tool-kernel: disabled: true` row.
- `packages/llm/llm/src/index.ts` — our account-provider API (`LlmAccountDraft`,
  `LlmAccountAddResult`, `LlmAccountAdder`, `registerAccountProvider`,
  `listAccountProviders`, `addAccount`) on upstream's `TypertRemoteService` base, keeping
  upstream's `@Remote('discoverModels')` adapter.
- `packages/client/ui-settings-general/src/client/locales.ts` — both key sets.
- `pnpm-lock.yaml`, `docs/subsystems/code-runtime.{md,zh.md,i18n.yaml}` — took upstream;
  regenerate at the end.

## Upstream deleted the ApiProxy package

Commit `4f00a8b8` ("refactor(api): remove ApiProxy package", 2026-08-27) removed
`packages/host/apiproxy` after migrating it into `packages/api/{gateway,remotes,
session-controller,settings-controller,workspace-controller}`. Twelve of our modified
files went with it. The deletions are accepted on this branch and **our changes to them
are preserved as a patch**: [`apiproxy-and-fixtures.patch`](apiproxy-and-fixtures.patch).

Port it into the new controllers. One decision is already made for us: our widening of
`exposedNamespaces()` matches upstream, whose settings controller serves
`settings.describe({ redactSecrets: true })` for every registered namespace
(`packages/api/settings-controller/src/index.ts`). The rest of the patch — the sidebar
and kernel additions to the RPC surface — needs a home in the controller that now owns
each domain.

## The 14 files left

Each entry is: what our side does, what upstream did, and the suggested resolution.

**`packages/client/ui-model-selection/src/client/{ModelSelect.tsx,ModelSelect.module.css,directory.ts,service.ts}` and `tests/model-select.client.spec.tsx`** — ours adds the per-account route picker for pooled DeepSeek logins; upstream rebuilt the component and moved the transport from `connection.api.*` to `this.ctx.remote.*`. Take upstream's structure and re-apply the account-route affordance on top of the new transport. This is the largest of the fourteen.

**`packages/client/connection/src/index.ts`** — both sides edit `PRIVILEGED_METHODS`. Union the entries, then delete any naming a method the ApiProxy removal took away.

**`packages/client/connection/src/client/fixture.ts`** — test fixture tracking the same transport change. Follow whatever `service.ts` resolves to.

**`packages/core/system-prompt/src/index.ts`** — ours replaces the harness identity line with a Windows-sandbox persona at a hardcoded `order: -100`; upstream uses `this.getSectionOrder('HARNESS_IDENTITY')` and the stock text. **A product decision, not a merge artifact:** keep the custom text if it is wanted, but move it onto `getSectionOrder`.

**`packages/client/ui-conversation/src/client/skeleton/EmptyHero.tsx`** — ours renders `hero.headline`, upstream renders a `hero.preview` badge. Pick one; both locale keys exist.

**`packages/client/ui-tool/src/client/tool/models/tool-call-model.ts`** — upstream replaced the literal `TOOL_TITLES` map with i18n `TOOL_TITLE_KEYS`. Adopt upstream's map and add a `tool.title.kernel` key (ours had `kernel: 'Python'`) with its locale entries.

**`packages/llm/token-meter/src/index.ts`** — ours wraps projection registration in `ctx.inject(['sessionProjections'])` so a composition without the registry still works, and adds `tokenUsageLifetimeProjectionDefinition`. Keep both, over upstream's current definition set.

**`packages/llm/token-meter/src/usage-projection.ts`** — divergent prose and sampling around the same projection. Reconcile against whatever `index.ts` registers.

**`packages/preset/agent-presets/presets/minimal/agent.cordis.yml`** — upstream moved this tree out of `apps/cli/config/`. Ours documents the `kernel.enabled` switch in the preset header. Keep upstream's location and text, re-adding the kernel paragraph.

**`packages/core/tools/tests/gen-tool-catalog.spec.ts`** — an expected tool-name list. **Resolve this one last**: once every other conflict is settled, run the test and take the actual list, which is derived from the assembled composition.

## Known follow-ups, not conflicts

- `kernel.enabled` defaults to `true`, which switches off `tool-bash`, `tool-pwsh`,
  `tool-jobs`, `tool-fs`, and `tool-fs-search`. The headless example still expects a bash
  round trip, so `examples/headless-agent/tests/headless.snapshot.ts` records
  `Error: unknown tool "bash"`. Either pin `kernel.enabled: false` for that example or
  rewrite it around the kernel tool, then re-record.
- The new packages still owe their documentation: 10 have no README, and
  `verify-export-jsdoc` reports 57 missing contracts. `pnpm run doc-sync` names them.
