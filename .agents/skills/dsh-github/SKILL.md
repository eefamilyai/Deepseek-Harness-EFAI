---
name: dsh-github
description: Use for any GitHub operation in the deepseek-harness repo — committing, branching, pushing (including force pushes), opening or updating pull requests, and merging — so git and gh are used with the repo's safe defaults and never raw --force. Routes stack work to dsh-merging-stacked-prs and pre-flight checks to dsh-pre-push-checks.
---

# GitHub and git for deepseek-harness

Operate GitHub through the repo's own conventions. `AGENTS.md` owns the allowed merge-forward and rebase histories; the git hooks are intentionally narrow (pre-commit lint/whitespace/vendor guard, pre-push incremental typecheck), so do not rely on them for correctness.

## Repository and state first

```sh
git status --short --branch
git rev-parse --show-toplevel
git branch --show-current
```

Never infer the branch, the remote, or cleanliness from anything but these commands. The checkout path and the working directory are separate facts.

## Committing

- Stage only the files that belong to the change. Do not sweep unrelated worktree edits into a commit; list `git diff --cached --name-only` and confirm before committing.
- Use a short imperative subject that states the behavior change, not the ticket number.
- The pre-commit hook fixes staged lint; inspect any file it changes before continuing.

## Branching and pushing

- Prefer a dedicated branch; do not build a PR on `master` directly.
- Ordinary push: `git push -u origin <branch>`.
- History rewrites are allowed for standalone and stacked PR branches, but raw `--force` is never allowed. For a standalone branch, fetch the current remote head, record its exact OID, and publish with:

```sh
git push --force-with-lease=<branch>:<observed-oid>
```

- `gh stack push` / `gh stack sync` supply lease protection for stack-managed branches. See `dsh-merging-stacked-prs` for stack rules — do not recreate stack semantics with manual `gh pr merge` / `gh pr edit` retargeting.
- After any push, verify the remote ref equals local `HEAD`:

```sh
git rev-parse HEAD origin/$(git branch --show-current)
```

## Pull requests and CI

- Run `dsh-pre-push-checks` once before pushing or marking ready for review; do not duplicate checks the pre-push hook already runs.
- Inspect CI after push with `gh pr checks`, and report pending checks as pending. If `gh pr checks` says "no checks reported" and `GET /actions/runs?head_sha=<sha>` returns `total_count: 0`, read mergeability first — `gh pr view <number> --json mergeable,mergeStateStatus` — because a `CONFLICTING`/`DIRTY` PR produces no `pull_request` workflow runs. The fix is resolving the conflict, not empty or `--allow-empty` pushes.

## Merging

- Require GitHub's native stacked-PR feature for dependent PRs and use `gh stack merge` (see `dsh-merging-stacked-prs`).
- For a single PR, use the normal `gh pr merge` path and verify state through `gh pr view` before assuming it merged.

## Credentials

- `AGENTS.md` forbids committing credentials. Before any push, run the credential scan from `HARNESS-EDITS.md` Rule 8; output must be empty. Never print secret values.
