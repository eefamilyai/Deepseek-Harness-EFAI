# Agent Note: The real-API e2e job skips a keyless repository instead of failing

Status: implemented

English | [中文](2026-09-01-e2e-skips-without-key.zh.md)

## Problem

[.github/workflows/e2e.yml](../../../../.github/workflows/e2e.yml) ran a preflight that turned a missing `DEEPSEEK_API_KEY_EXTERNAL` into `exit 1`, so a self-skipping suite could never report a false green ([the original decision](2026-06-19-real-api-e2e-ci.md)). That guard assumes every repository running the workflow holds the secret. A deployment of this source that does not — a mirror, a downstream copy, a repository whose owner has not configured Actions secrets — gets a job that fails on every push and every nightly, forever, for a reason no commit can fix. A permanently red check trains its readers to ignore it, which costs more signal than the false green the guard was protecting.

## Decision

A `preflight` job reads the secret and publishes `key-present` as a job output; the `e2e` job declares `needs: preflight` and `if: needs.preflight.outputs.key-present == 'true'`. With the secret configured, nothing changes: the same trusted events build the workspace and run `pnpm run test:e2e` against `https://api.deepseek.com`. Without it, `e2e` never starts, and the preflight writes a `::notice::` annotation plus a run-summary section naming the secret and where to configure it.

The decision is split across two jobs because a job-level `if:` cannot read the `secrets` context. Deciding in a job that checks out no code also means a keyless repository spends no runner time on checkout, install, or the bubblewrap setup the escalation suite needs.

The untrusted-PR rule is unchanged and now lives on `preflight`: forked and Dependabot PRs are keyless by construction and skip the whole workflow. Because `e2e` keys on the output rather than on the event, a skipped `preflight` leaves the output empty and `e2e` skips too — one condition covers both the untrusted and the unconfigured case.

## Alternatives considered

**Keep the hard failure.** It is the stronger guard for the repository that owns the secret, and the [original note](2026-06-19-real-api-e2e-ci.md) records why: a deleted or renamed secret silently disables the entire real-API safety net. It loses here only because the failure it produces is indistinguishable from a real break, and a check that is red for reasons outside the diff stops being read at all. A repository that depends on this job for coverage should watch for the skip notice, which is now the only signal that no real-API test ran.

**Gate the steps inside the single job.** Fewer moving parts, but the `if:` on the earliest gated step would have to read an output the preflight step has not produced yet unless the preflight runs first, and every added step needs the same condition repeated. The job boundary states the condition once, in the place GitHub already evaluates it.

**Drop the schedule and keep the job on `workflow_dispatch`.** It ends the recurring red without touching the preflight, but it also ends nightly coverage for the repository that does hold the secret — trading a real signal away to fix a presentation problem.

**Detect the key at the suite level.** `test:e2e` already self-skips without a key; letting that stand and deleting the preflight is the smallest diff. It reports a *passing* job that ran nothing, which is precisely the false green the original note refused, and it wastes a full install and build to reach zero assertions.

## Consequences

A repository without the secret gets a green, skipped job and a run-summary line, and its keyless gates stay the only signal on that commit. A repository with the secret gets the previous behavior at the cost of one extra short-lived job per run. The guard against a vanishing secret weakens from a failing check to a notice a reader has to look for; anyone treating this workflow as the real-API safety net should verify the `e2e` job actually ran rather than trusting the workflow's overall conclusion.
