
# Model picker: the "extra account" and the invisible 5th login

Job: operator reported (a) an "invalid DeepSeek (free web)" row in the model
picker's account list and (b) that only 5 accounts show even though the
Accounts tab lists more.

## Finding 1 — there is no account cap

Searched the whole route-building chain for `MAX_ACCOUNTS`, `ACCOUNT_LIMIT`,
`accountLimit`, and `accounts.slice(...)`:

- `python/kiln/runtime/ds_admin.py` — `list_accounts()` returns every configured
  account plus every orphaned on-disk profile. No slice.
- `python/kiln/runtime/ds_direct.py` — `account_ids()`; no cap.
- `python/kiln/provider_bridge.py` — `_list_accounts` forwards the list whole.
- `packages/llm/llm-kiln/src/index.ts` — `rebuildRoutes` maps every account in
  the catalog entry to a pinned route. No cap.
- `packages/client/ui-model-selection/` — the only `slice(0, N)` hits in these
  packages are in `packages/llm/llm/tests/assistant-stream.spec.ts`, unrelated.

`ds_admin.list_accounts()` reports exactly 5 rows, all valid:

    0 deepseek.ee.1+7@gmail.com
    1 deepseek.ee.1+9@gmail.com
    2 deepseek.ee.1+kilnsal@gmail.com
    3 deepseek.ee.1+jw1@gmail.com
    4 deepseek.ee.1+parserfix@gmail.com

So nothing is truncated. The visible limit was purely the menu's scroll clamp.

## Finding 2 — the "invalid account" is the unpinned pooled route

`mergeGroups` (ModelSelect.tsx:62-106) builds each merged group's account list as
`[baseChoice, ...accountRoutes]`, where `baseChoice = { provider: group.id,
account: null }`. That is NOT an account: it is the base route, which lets
`ds_direct` pick the login itself (round-robin, fails over on a busy login).

The bug was its label. Line 604 rendered the null account as `group.name`, so it
printed "DeepSeek (free web)" — the provider name — in a list of email
addresses. It read exactly like a duplicate account.

## Finding 3 — why the 5th login was invisible

`.menu` is clamped at `max-height: min(360px, calc(100vh - 96px))` with
`.groups { overflow-y: auto }` scrolling inside it. Base row + 4 emails fills
that window; `+parserfix@gmail.com` was the 5th row, below the fold.

## Changes

`packages/client/ui-model-selection/src/client/ModelSelect.module.css`
- `.menu` max-height 360px → 520px.
- `.accountPicker` gains `max-height: 200px; overflow-y: auto;` so the picker
  scrolls on its own and every login stays reachable however many exist.

`packages/client/ui-model-selection/src/client/ModelSelect.tsx`
- Line 604: the null account now renders `t('account.auto')` instead of
  `group.name`.

`packages/client/ui-model-selection/src/client/locales.ts`
- New key `account.auto` in both dictionaries
  (zh 自动（任选账号） / en Automatic (any account)).

`packages/client/ui-model-selection/tests/model-select.client.spec.tsx`
- The label assertion at :409 pinned the pooled row to `'DeepSeek'` — it encoded
  the bug. Now reads the expected string from the dictionary.
- The `select` stub at :382 resolved a bare `true`; `settleSelection` reads the
  failure branch off the result, so the promise chain rejected with an unhandled
  `TypeError: Cannot read properties of undefined (reading 'code')`. Now
  resolves `{ ok: true }`.

All four files were already modified against the recorded base and claimed by the
`client-model-selection` patch group, so this is an edit to a recorded seam; each
hunk carries a DSH-FORK marker.

## Verification

- `npx vitest run packages/client/ui-model-selection/tests` — 3 files, 49/49
  passed, exit 0, no unhandled rejection.
- `node local-overlay/rebuild.mjs` — exit 0, wrote client-model-selection.patch
  (5 files).
- `node local-overlay/verify.mjs` — exit 0, round-trip exact.
- `node local-overlay/apply.mjs --check` — exit 0, all 17 patches.
- `node local-overlay/verify-seam-frozen.mjs` — exit 0, 87/87.

## Open — the client bundle rebuild did not run

`pnpm run build:lib:client` could not complete in this session. Three attempts:

1. Through pnpm — dies in pnpm's own dependency check, which runs
   `pnpm install --production`; that `postinstall` fails with
   `ERR_MODULE_NOT_FOUND` (and separately refuses to purge `node_modules`
   without a TTY).
2. Direct `tsc -b tsconfig.client.json` in the foreground — the pwsh call
   itself was killed: `Windows Job runner exited with exit code 1`.
3. The same two steps as a background job — killed the same way before it
   reported anything.

The source is correct and its tests pass, but the served bundle is NOT rebuilt,
so the GUI still shows the old picker. The operator needs to run, from
`D:\deepseek-kernel-harness`:

    start.cmd --build-only

then restart the harness (the picker is a client plugin; the running sidecar
serves the previous bundle until the build replaces it and the page reloads).

## Still outstanding from earlier

- `+parserfix@gmail.com` was NOT deleted. The operator's answer to the removal
  prompt was a counter-question about the cap, not a confirmation.
- The Accounts-tab Remove button fix (`account_id=` kwarg, committed
  `b6d01a7a21`) needs a harness restart to be live, then an end-to-end check.
