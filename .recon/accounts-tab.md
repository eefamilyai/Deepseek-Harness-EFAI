# Accounts tab: debug messages, relogin, reprofile

## Request
Operator cannot see what happens when adding an account, re-logging in, or running
two accounts at once. Wants: (1) debug messages, (2) a **Relogin** button beside
every account, (3) a **Reprofile** button beside every account, (4) all accounts
listed under an **Accounts tab in Settings**, each **expandable** to show its
identity (`x device id` and every other field).

## Where the browser profile lives (answered)
`C:\Users\eejar\.kiln_identity\profiles\<slug>\` — one Chrome user-data dir
per account. `<slug>` = `<readable-prefix>-<sha256(account_id)[:12]>`.
Records: `C:\Users\eejar\.kiln_identity\accounts\<slug>.json`.
Root: `ds_identity.identity_dir()` (override `KILN_IDENTITY_DIR`), deliberately
NOT `KILN_STATE_DIR`.

## Seams (all Tier 1 — no upstream file is touched)
| Piece | Path | Ownership |
|---|---|---|
| Accounts settings section | `packages/client/ui-settings-accounts` | FORK (upstream=0) |
| Kiln host adapter | `packages/llm/llm-kiln` | FORK (upstream=0) |
| Sidecar | `python/kiln/{provider_bridge.py,runtime/ds_profile.py}` | FORK |
| `llm` Remote namespace | `packages/llm/llm/src/index.ts` | upstream BUT already in seam, already carries `DSH-FORK(kiln)` markers and the `listAccountProviders`/`addAccount` precedent |

The Remote namespace is derived from the `@typert service <key>` tag; `LlmRuntime`
owns `llm`. Extending it with three more `@Remote` methods is the same act the
fork already made on the same file, under the same marker convention. A new
namespace would need its own `TypertRemoteService` plus codegen — more moving
parts for no gain.

## Plan
1. **Sidecar** — `python/kiln/provider_bridge.py`: add commands
   `accounts_list`, `account_relogin`, `account_reprofile`, `account_log`.
   Implement over `ds_profile.list_profiles()` / `capture_identity()`.
   Add a bounded in-memory log ring the bridge drains.
2. **Host** — `packages/llm/llm-kiln/src/bridge.ts`: `listAccounts()`,
   `reloginAccount(id)`, `reprofileAccount(id)`, `drainLog()`.
   `src/index.ts`: register the new `llm` Remote methods + account provider ops.
3. **Client** — `packages/client/ui-settings-accounts`: expandable account rows
   with every identity field, Relogin + Reprofile beside each, and a debug log
   panel that streams the bridge's messages.
4. Tests for the new Python surface; run the fork gates; commit.

## Debug-message surface
Every operator-visible event (add, relogin, reprofile, second account starting a
concurrent request) is written to the sidecar's log ring with a stable prefix and
drained by the UI on a poll. That is what makes "two accounts at once" legible:
each entry names the account, so interleaved requests are attributable.
