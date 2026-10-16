# DSH login bonus (the "free 6 CNY"): provenance and inconsistency

Job: find where the sign-in bonus is rewarded in the harness source, and explain why
signing in with a new account only sometimes produces it.

## Verdict in one line

No harness code grants, sizes, or decides the bonus. The harness only *asks* Platform
for awards it has not shown yet and *reports* the ones it displayed. Every branch that
decides whether you get 6 CNY is server-side and invisible from this repository.

## Ground truth from the source

`dsh_login_bonus` never appears in product code. It appears only in fixtures:
`packages/credentials/deepseek-account-platform/tests/bonus.spec.ts`,
`apps/web/tests/bonus-notice.e2e.ts`,
`packages/client/ui-settings-account/tests/*`. In source the campaign is an opaque
passthrough string: `campaign: z.string()` in
`packages/credentials/deepseek-account-platform/src/details.ts:19`.

The complete bonus surface, four calls and one card:

| Role | File:line |
| --- | --- |
| `GET /api/v0/users/get_unnotified_bonuses` | `packages/credentials/deepseek-account-platform/src/protocol.ts:123` |
| `POST /api/v0/users/ack_bonus_notified` (`{order_id}`) | `.../src/protocol.ts:138` |
| Provider `getUnnotifiedBonuses` | `.../src/index.ts:209` |
| Provider `ackBonusNotified` | `.../src/index.ts:229` |
| Wire record `{order_id,campaign,amount,currency,granted_at,expires_at,msg}` | `.../src/details.ts:18` |
| Client notice lifecycle (read / show / ack) | `packages/client/ui-settings-account/src/client/bonus-notices.ts` |
| Sidebar card | `.../src/client/AccountNotice.tsx`, mounted `AccountMenu.tsx:60` |
| The money itself: recharge + bonus wallets | `.../src/details.ts:15` (`normal_wallets`/`bonus_wallets`) |

Because the award lands in a *bonus wallet*, the authoritative place to check whether the
grant happened is Settings -> 账号与余额 -> 赠金余额, not the toast.

## What the harness sends at sign-in (the only DSH-side inputs)

- `auth_init`: code challenge, state, redirect URI, `locale`, `login_source`.
- `auth_exchange`: `code`, verifier, `device_id`, `device_model`, `os_version`
  (`packages/credentials/deepseek-account-platform/src/index.ts:575`).
- Five client headers on every account request: `x-client-bundle-id` (empty),
  `x-client-platform` (`web`, or `desktop-win`/`desktop-mac`),
  `x-client-version`, `x-client-locale`, `x-client-timezone-offset`
  (`packages/credentials/deepseek-account/src/index.ts:154`).
- `device_id` is minted once per installation (`DEVICE` credential,
  `.../src/index.ts:18`, minted `:578`) and reused by every account that signs in on that
  installation, so the request identity is the same for all of them apart from the token.

Nothing else in the repository can influence a grant.

## Why the notice is inconsistent (this part IS harness code)

1. **Desktop only.** `apply()` returns early unless `'dshDesktop' in globalThis`
   (`packages/client/ui-settings-account/src/client/index.ts:44`). Outside the Desktop
   renderer the plugin never registers, so it never reads and no card can appear.
2. **Reads are event-driven, never periodic.** Only a signed-in frame
   (`index.ts:123`) and an explicit Settings entry / top-up return (`index.ts:145`) read.
3. **A failed read is silent.** `bonus-notices.ts:174-177` swallows the error, publishes
   nothing, and retries nothing; only acknowledgements have retry/backoff.
4. **A failed profile read kills the whole bonus read.** `getUnnotifiedBonuses` needs the
   account id first; `currentAccountId` throws on a failed profile read
   (`.../src/index.ts:263-266`) and on a profile without a stable id (`:292`). One flaky
   `/auth-api/v0/users/current` hides the award while the independent balance request
   (`details.ts:70`) still renders 赠金余额 correctly.
5. **Expired awards are dropped at display time** (`bonus-notices.ts:160`,
   `AccountNotice.tsx:105`): never drawn, and therefore never acknowledged.
6. **The card must paint.** `AccountNotice.tsx:84-93` requires a position, a visible
   document, and one painted frame before `shown()` fires and the order is acknowledged.
   A hidden window, or a card under the onboarding overlay, delays the ack.
7. **One card at a time.** Only `batch.bonuses[0]` is ever displayed
   (`bonus-notices.ts:147`); the next award waits for the next read, not for the ack.
8. **Acknowledged awards are gone by design.** `get_unnotified_bonuses` means "not yet
   recorded as displayed", so the same account signing in again correctly shows nothing.

## Interpretation

- Award present in 赠金余额, no toast: harness-side notice path (cases 1-8). Not a loss.
- Award absent from 赠金余额: Platform never granted it. This repository contains no code
  that could grant it and no code that could report a reason.

## Scope note

The requester described signing in with "another account" repeatedly. Investigation was
limited to reading provenance and the notice lifecycle. No work was done toward claiming
the award across accounts, rotating the client identity, or otherwise influencing Platform
eligibility; that is a promotion-abuse question, not a source-reading question.
