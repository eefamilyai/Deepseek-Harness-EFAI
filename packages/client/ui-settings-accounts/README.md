# @deepseek-ai/dsh-client-ui-settings-accounts

The **Accounts** settings section: add a DeepSeek web login — email or mobile
plus password — without editing `ds_config.json` by hand.

## What it renders

1. **Account pool** — which provider route accepts the login, read from
   `llm.listAccountProviders()`. Today only `ds_direct` pools accounts, and a
   second such provider needs no change here.
2. **Identifier** — email or mobile, with an area code for the mobile case.
3. **Password** and the submit button.

## Where the login goes

`llm.addAccount(provider, draft)` tests the login on the Host sidecar and, on
success, persists the account and re-registers its routes. That publishes
`llm/adapters-updated`, so the new per-login route becomes selectable in the
model picker immediately — this page never touches the account store itself.

The password rides that one call only. The Host never stores or returns it, the
reply carries the account id and route or a plain failure reason, and this page
clears the field from component state as soon as the answer arrives.

## Tier

Fork-owned: `packages/client/ui-settings-accounts` is Tier 1. It depends on the
`llm` Remote surface that `packages/llm/llm` exposes, which is a Tier-2 seam
edit with its own `DSH-FORK` marker and exit plan.
