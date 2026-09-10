# Local Overlay

All local changes on top of upstream `deepseek-ai/deepseek-harness` are kept
**separate from upstream source** so a future upstream update cannot silently
overwrite or conflict with them.

## Layout

- `patches/*.patch` — `git apply`-able diffs of every upstream file we modified,
  grouped by subsystem. Upstream files themselves stay pristine at this layer.
- `INVENTORY.md` — full manifest of each patch, its files, and its purpose.
- `apply.mjs` — applies every patch, in order, onto a clean upstream checkout.
- New local files (153 of them: `packages/kernel/*`, `packages/client/ui-dock`,
  `packages/llm/llm-kiln`, etc.) are NOT patches — they live directly in the tree
  and are already isolated by construction (they do not exist upstream).

## Updating upstream

1. Fetch + merge/rebase upstream into this repo.
2. Run `node local-overlay/apply.mjs` (patches that still apply cleanly are done;
   any that no longer apply are reported for review).
3. Re-run `pnpm install` to refresh `pnpm-lock.yaml`, then the test/typecheck gates.
