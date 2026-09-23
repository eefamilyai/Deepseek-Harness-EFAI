---
name: dsh-code-review
description: Use when reviewing a pull request in the deepseek-harness repo — orients the reviewer to this codebase's standards (AGENTS.md conventions, defensive patterns, ADRs, quality gates) and the review-specific checks that code alone can't show
---

# Reviewing a DeepSeek-Harness PR

**This skill is guidance, not a complete checklist.** Verify and fetch the PR's live base and exact head, then run `pnpm --silent run change-scope --base <verified-base-ref> --head <verified-head-ref>` before reading the diff and enough surrounding code to understand the design. The report identifies paths and dirty layers but does not replace semantic review. Re-establish the base and rerun it after a retarget or merge. Prioritize correctness, lifecycle, security, and broken required behavior over style; a short review with one substantiated blocker is better than a list of nits.

## Sources of truth

- [AGENTS.md](../../../AGENTS.md) and [packages/AGENTS.md](../../../packages/AGENTS.md): standing repository and package authoring rules.
- [docs/defensive-patterns.md](../../../docs/defensive-patterns.md): subprocess, callback, async-state, and disposal bug classes.
- [docs/AGENTS.md](../../../docs/AGENTS.md): documentation placement and prose discipline.
- [dsh-prose-standard](../dsh-prose-standard/SKILL.md): required coverage and editorial judgment for comments, docs, prompts, and visible strings.
- [dsh-ci-test-reliability](../dsh-ci-test-reliability/SKILL.md): isolation and regression-proof rules for resource-owning, asynchronous, or flaky tests and fixtures.
- [docs/testing.md](../../../docs/testing.md) and the [quality-gates Agent Note](../../notes/implemented/process/2026-06-11-quality-gates.md): required test tiers and gates.
- [Agent Notes](../../notes/README.md): design rationale. Treat disagreement with an Agent Note as a design discussion, not an automatic veto.
- For bilingual changes, read [translation-rules.md](../../../docs/i18n/translation-rules.md) and [terminology.md](../../../docs/i18n/terminology.md); the extended translation skill is outside automatic review and runs only on explicit user invocation.

## Blocking requirements

1. **New prose receives semantic review.** Use [dsh-prose-standard](../dsh-prose-standard/SKILL.md) to critically review every added or changed Markdown passage, JSDoc, comment, prompt, description, diagnostic, and visible string. Verify required coverage, accuracy, placement, and editorial quality against the owning code or behavior; automated checks do not establish those properties.
2. **Docs match the code.** Config, defaults, errors, wire fields, events, and public behavior update the package README and JSDoc in the same diff. Comments state non-obvious contracts; flag implementation narration, test walkthroughs, review history, and duplicated rationale for deletion or a link to their one home.
3. **Core type docs match.** Changes to spine or seam vocabulary update the appropriate [subsystems](../../../docs/subsystems/README.md) page and any `type-equiv` entry. Internal types need no catalog entry.
4. **Registrations clean up.** Verify each new registry contribution passes the disposal tests required by [packages/AGENTS.md](../../../packages/AGENTS.md).
5. **Invariant companions are semantic.** For every touched `./invariant`, require an owner event-stream or mutable-data relationship with independent observations at the point where that package can observe it; service or method presence, plugin metadata or effects, fixed pure examples, and probes that call the same operation they claim to verify belong in load, behavior, or unit tests. When no plausible relationship exists, require the package to omit the companion and publication wiring and record its package-specific reason in the README. Reject empty installers and invented checks ([repository rule](../../../AGENTS.md#conventions); [package invariant rules](../../../packages/AGENTS.md)).
6. **Required evidence exists.** Verify the author ran the [relevant local checks](../../../AGENTS.md#run-relevant-checks-locally) for the diff and that CI covers the exhaustive matrix; review the semantic gaps neither can detect.
7. **Client UI copy is locale-owned.** Reject product text embedded in JSX, templates, helper returns, accessibility attributes, or primitive defaults. Require typed dictionary keys, the standard `t` seat or explicit localized props, `verify-client-ui-i18n`, and behavior evidence in each affected locale; preserve user/model/wire data and code tokens verbatim.

<!-- DSH-FORK(all): this fork freezes upstream-owned files, which upstream review has no concept of. EXIT: permanent fork delta — a pointer, so the substance lives in the fork-owned skill. -->

## Reviewing a change in this fork

This repository is a fork of `deepseek-ai/deepseek-harness`, and a change here carries
one question upstream review does not ask: **does it modify a file upstream owns?**

```sh
pnpm run verify-fork-overlay   # patches current, and the recorded seam did not grow
```

A red `verify-seam-frozen` is a blocking finding, not a formality: the fork just took
on an upstream file it will re-resolve at every release. Ask for the fork-owned
mechanism instead — a bundle row, a plugin on an extension point, a preset, or a
runtime switch. [dsh-harness-edit](../dsh-harness-edit/SKILL.md) owns that decision
order, the marker and register obligations for an edit that genuinely has no other
form, and the recipes for each mechanism.

Do not review `HARNESS.md`, `HARNESS-EDITS.md`, `local-overlay/**`, `efai/**`, or
`.merge-port/**` against upstream conventions. They are fork-owned; upstream has no
counterpart to compare them to.
