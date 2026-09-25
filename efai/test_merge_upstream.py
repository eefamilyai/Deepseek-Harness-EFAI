"""End-to-end checks for `efai/merge_upstream.py`, on a repository built for the test.

The claims worth proving are the ones a merge can silently break: a fork
addition comes through byte for byte, a conflict nobody can resolve by rule is
handed back rather than guessed at, an upstream rename of a seam file is
recognised, the main checkout is never touched until `finish`, and `abort`
leaves nothing behind.

Each check builds a small repository with the same shape as the real one — an
upstream history, a fork that adds files, edits a few upstream files, deletes
one, and carries a `local-overlay/` — and drives the real script over it.

Run: py efai/test_merge_upstream.py
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent))

import merge_upstream as mu  # noqa: E402

FAILURES: list[str] = []


def check(label: str, condition: bool, detail: str = "") -> None:
    if condition:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}{('  — ' + detail) if detail else ''}")
        FAILURES.append(label)


def git(cwd: Path, *args: str) -> str:
    return subprocess.run(["git", *args], cwd=str(cwd), text=True, encoding="utf-8",
                          capture_output=True, check=True).stdout


def write(root: Path, path: str, text: str) -> None:
    target = root / path
    target.parent.mkdir(parents=True, exist_ok=True)
    target.write_text(text, encoding="utf-8", newline="\n")


def build_repo(root: Path) -> None:
    """An upstream base, an upstream release on top of it, and a fork beside it."""
    root.mkdir(parents=True, exist_ok=True)
    git(root, "init", "-q", "-b", "master")
    for key, value in (("user.email", "test@example.com"), ("user.name", "Test"),
                       ("commit.gpgsign", "false"), ("core.autocrlf", "false")):
        git(root, "config", key, value)

    # ── the upstream base ───────────────────────────────────────────────────
    write(root, "package.json", json.dumps({"name": "root", "version": "1.0.0"}, indent=2) + "\n")
    write(root, "src/core.ts", "export const core = 1\nexport const shared = 'base'\n")
    write(root, "src/seam.ts", "".join(f"export const line{n} = {n}\n" for n in range(1, 41)))
    write(root, "src/doomed.ts", "export const doomed = true\n")
    write(root, "src/renamed-later.ts", "".join(f"export const moving{n} = {n}\n" for n in range(1, 41)))
    write(root, "generated.json", json.dumps({"from": "base"}) + "\n")
    write(root, "packages/dropped/index.ts", "export const dropped = 1\n")
    # The real repository gitignores the merge-report directory; model that, so
    # a report that is written but never committed fails a check here.
    write(root, ".gitignore", ".merge-port/\nnode_modules/\n")
    write(root, "local-overlay/rules.json", json.dumps({
        "patchGroups": [{"name": "src", "paths": ["src/"]}, {"name": "root-meta", "paths": ["package.json"]}],
        "generated": [{"path": "generated.json", "regenerate": "node -e gen"}],
        "tier1Prefixes": ["packages/forkpkg/", "local-overlay/"],
    }, indent=2) + "\n")
    write(root, "local-overlay/SEAM.json", json.dumps({"base": "", "paths": []}, indent=2) + "\n")
    write(root, "local-overlay/BASE", "PLACEHOLDER\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "upstream base")
    base = git(root, "rev-parse", "HEAD").strip()

    # ── the upstream release ────────────────────────────────────────────────
    git(root, "switch", "-q", "-c", "upstream")
    write(root, "src/core.ts", "export const core = 2\nexport const shared = 'upstream'\nexport const extra = true\n")
    # Upstream edits the top of the seam file; the fork edits the bottom.
    seam = [f"export const line{n} = {n}\n" for n in range(1, 41)]
    write(root, "src/seam.ts", "export const upstreamTop = 1\n" + "".join(seam))
    write(root, "src/doomed.ts", "export const doomed = true\nexport const changed = 1\n")
    git(root, "mv", "src/renamed-later.ts", "src/renamed-now.ts")
    moved = [f"export const moving{n} = {n}\n" for n in range(1, 41)]
    write(root, "src/renamed-now.ts", "".join(moved) + "export const upstreamAdded = 1\n")
    write(root, "generated.json", json.dumps({"from": "upstream"}) + "\n")
    write(root, "package.json", json.dumps({"name": "root", "version": "2.0.0"}, indent=2) + "\n")
    write(root, "src/new-upstream.ts", "export const fresh = 1\n")
    # Upstream ships a package at the very path the fork already has one.
    write(root, "packages/forkpkg/collide.ts", "export const upstreamVersion = 1\n")
    git(root, "rm", "-q", "-r", "packages/dropped")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "upstream release 2.0.0")

    # ── the fork ────────────────────────────────────────────────────────────
    git(root, "switch", "-q", "master")
    write(root, "packages/forkpkg/index.ts", "export const mine = 'fork'\n")
    write(root, "packages/forkpkg/deep/nested.ts", "export const nested = true\n")
    write(root, "packages/forkpkg/collide.ts", "export const forkVersion = 1\n")
    write(root, "src/core.ts", "export const core = 1\nexport const shared = 'fork'\n")           # conflicts
    write(root, "src/seam.ts", "".join(f"export const line{n} = {n}\n" for n in range(1, 41)) + "export const forkOnly = 1\n")
    write(root, "src/renamed-later.ts",
          "export const forkTouched = 1\n" + "".join(f"export const moving{n} = {n}\n" for n in range(1, 41)))
    git(root, "rm", "-q", "src/doomed.ts")                                                        # the fork deletes it
    write(root, "generated.json", json.dumps({"from": "fork"}) + "\n")
    write(root, "local-overlay/BASE", base + "\n")
    write(root, "local-overlay/SEAM.json", json.dumps({
        "base": base,
        "paths": ["generated.json", "src/core.ts", "src/doomed.ts", "src/renamed-later.ts", "src/seam.ts"],
    }, indent=2) + "\n")
    write(root, "local-overlay/INVENTORY.md", "# generated by rebuild.mjs\n")
    write(root, "local-overlay/patches/src.patch", "# generated\n")
    git(root, "add", "-A")
    git(root, "commit", "-q", "-m", "the fork")


def run(root: Path, *args: str) -> tuple[int, str]:
    """Drive the script the way a shell would, capturing what it prints."""
    from io import StringIO
    from contextlib import redirect_stdout
    buffer = StringIO()
    with redirect_stdout(buffer):
        code = mu.main(["--repo", str(root), *args])
    return code, buffer.getvalue()


PIPELINE = ("--validate", "none", "--no-regenerate", "--no-overlay", "--no-verify")


def case(name: str):
    """A fresh repository per check, removed afterwards."""
    temp = Path(tempfile.mkdtemp(prefix=f"mu-{name}-"))
    root = temp / "repo"
    build_repo(root)
    return temp, root


def cleanup(temp: Path) -> None:
    shutil.rmtree(temp, ignore_errors=True)


# ── plan ────────────────────────────────────────────────────────────────────

temp, root = case("plan")
code, out = run(root, "plan", "--target", "upstream", "--no-fetch")
check("plan exits 0 and writes nothing", code == 0 and not git(root, "status", "--porcelain").strip())
check("plan counts the additions it protects (the overlay's own artifacts are rebuilt, not protected)",
      "Your additions: 3 file(s)" in out, out)
check("plan names the generated file's regenerate command", "generated: node -e gen" in out, out)
check("plan flags the both-added path as a decision", "upstream added this path too" in out, out)
check("plan predicts each conflict's real shape, not a generic one",
      "keep-deleted src/doomed.ts" in out and "human        src/core.ts" in out, out)
check("plan reports the package directory upstream removed", "packages/dropped" not in out, out)
cleanup(temp)

# ── start: stops on a conflict no rule can resolve ──────────────────────────

temp, root = case("start")
code, out = run(root, "start", "--target", "upstream", "--no-fetch", *PIPELINE)
worktree = root / ".worktrees" / "merge-upstream-2.0.0"
check("start stops for the human conflicts", code == 2, out)
check("start leaves the main checkout on the fork commit",
      git(root, "rev-parse", "--abbrev-ref", "HEAD").strip() == "master"
      and not git(root, "status", "--porcelain").strip())
check("start works in its own worktree", worktree.is_dir())
check("the generated file took upstream's side", "regenerate   generated.json" in out, out)
check("the fork's own addition kept the fork's side", "ours         packages/forkpkg/collide.ts" not in out
      or "fork's side kept" in out, out)
check("the deleted upstream file stayed deleted",
      "keep-deleted src/doomed.ts" in out or not (worktree / "src/doomed.ts").exists(), out)

# The two files a rule must not touch are exactly the ones handed back.
unmerged = mu.unmerged(worktree)
check("only the genuine conflicts are left for a human",
      set(unmerged) == {"src/core.ts", "packages/forkpkg/collide.ts"}, str(unmerged))

# Resolve them the way a maintainer would, then continue.
write(worktree, "src/core.ts", "export const core = 2\nexport const shared = 'fork'\nexport const extra = true\n")
write(worktree, "packages/forkpkg/collide.ts", "export const forkVersion = 1\n")
git(worktree, "add", "src/core.ts", "packages/forkpkg/collide.ts")
code, out = run(root, "continue", *PIPELINE)
check("continue completes the merge", code == 0, out)

merged = git(worktree, "rev-parse", "HEAD").strip()
fork_sha = git(root, "rev-parse", "master").strip()
tree = git(worktree, "ls-tree", "-r", "HEAD").splitlines()
blobs = {line.split("\t")[1]: line.split()[2] for line in tree}
fork_blobs = {line.split("\t")[1]: line.split()[2]
              for line in git(root, "ls-tree", "-r", "master").splitlines()}
check("every fork addition survived byte for byte",
      all(blobs.get(p) == fork_blobs[p] for p in
          ("packages/forkpkg/index.ts", "packages/forkpkg/deep/nested.ts")),
      str({p: blobs.get(p) for p in ("packages/forkpkg/index.ts", "packages/forkpkg/deep/nested.ts")}))
check("upstream's new files arrived", "src/new-upstream.ts" in blobs)
check("the fork's deletion held", "src/doomed.ts" not in blobs)
check("the generated file carries upstream's content",
      json.loads(git(worktree, "show", "HEAD:generated.json"))["from"] == "upstream")
renamed = git(worktree, "show", "HEAD:src/renamed-now.ts")
check("the fork's edit followed upstream's rename",
      "forkTouched" in renamed and "upstreamAdded" in renamed, renamed[:200])
seam_now = git(worktree, "show", "HEAD:src/seam.ts")
check("a clean seam merge kept both sides' lines",
      "forkOnly" in seam_now and "upstreamTop" in seam_now, seam_now[:200])
check("the merge is still only on its own branch",
      git(root, "rev-parse", "master").strip() == fork_sha)
report = list((worktree / mu.REPORT_DIR).glob("*.md"))
check("a report was written", len(report) == 1 and "## Conflicts" in report[0].read_text(encoding="utf-8"))
check("the report reached the commit despite the ignore rule",
      any(name.startswith(mu.REPORT_DIR) for name in blobs), str([n for n in blobs if "merge" in n]))

code, out = run(root, "finish")
check("finish fast-forwards the fork branch", code == 0 and git(root, "rev-parse", "master").strip() == merged, out)
check("finish removes the worktree", not worktree.exists())
check("the fork's files are intact in the main checkout",
      (root / "packages/forkpkg/index.ts").read_text(encoding="utf-8") == "export const mine = 'fork'\n")
cleanup(temp)

# ── uncommitted work in the main checkout is never touched ──────────────────

temp, root = case("dirty")
write(root, "packages/forkpkg/index.ts", "export const mine = 'edited, not committed'\n")
write(root, "scratch.txt", "untracked\n")
before = (root / "packages/forkpkg/index.ts").read_text(encoding="utf-8")
run(root, "start", "--target", "upstream", "--no-fetch", *PIPELINE)
check("an uncommitted edit survives the merge untouched",
      (root / "packages/forkpkg/index.ts").read_text(encoding="utf-8") == before)
check("an untracked file survives the merge untouched", (root / "scratch.txt").exists())
_, out = run(root, "plan", "--target", "upstream", "--no-fetch")
check("plan says uncommitted work is excluded", "uncommitted or untracked" in out, out)
code, out = run(root, "abort")
check("abort exits 0", code == 0, out)
check("abort removes the worktree", not (root / ".worktrees" / "merge-upstream-2.0.0").exists())
check("abort leaves no merge branch", "merge/upstream-2.0.0" not in git(root, "branch", "--list"))
check("abort leaves the uncommitted edit alone",
      (root / "packages/forkpkg/index.ts").read_text(encoding="utf-8") == before
      and (root / "scratch.txt").exists())
cleanup(temp)

# ── a second merge reuses the first one's resolution ────────────────────────

temp, root = case("rerere")
run(root, "start", "--target", "upstream", "--no-fetch", *PIPELINE)
worktree = root / ".worktrees" / "merge-upstream-2.0.0"
write(worktree, "src/core.ts", "export const core = 2\nexport const shared = 'fork'\nexport const extra = true\n")
write(worktree, "packages/forkpkg/collide.ts", "export const forkVersion = 1\n")
git(worktree, "add", "src/core.ts", "packages/forkpkg/collide.ts")
run(root, "continue", *PIPELINE)
run(root, "abort") if mu.state_path(root).exists() else None
# Start the same merge again: rerere should replay the recorded resolution.
code, out = run(root, "start", "--target", "upstream", "--no-fetch", *PIPELINE)
check("the repeated conflict resolves itself from the recorded resolution",
      "rerere" in out and "src/core.ts" in out, out)
check("and the merge then needs no human at all", code == 0, out)
repeated = root / ".worktrees" / "merge-upstream-2.0.0"
check("the replayed resolution is the one recorded",
      "shared = 'fork'" in git(repeated, "show", "HEAD:src/core.ts"))
cleanup(temp)

# ── refusals ────────────────────────────────────────────────────────────────

temp, root = case("refuse")
code, out = run(root, "plan", "--target", "master", "--no-fetch")
check("merging a revision the fork already has is a no-op",
      code == 0 and "already contains" in out, out)
code, out = run(root, "continue")
check("continue without a merge in progress refuses", code == 1 and "no merge in progress" in out, out)
run(root, "start", "--target", "upstream", "--no-fetch", *PIPELINE)
code, out = run(root, "start", "--target", "upstream", "--no-fetch", *PIPELINE)
check("a second start refuses while one is in progress", code == 1 and "already in progress" in out, out)
code, out = run(root, "finish")
check("finish refuses before the merge is committed", code == 1 and "not committed" in out, out)
run(root, "abort")
cleanup(temp)

if FAILURES:
    print(f"\n{len(FAILURES)} failure(s)")
    sys.exit(1)
print("\nall checks passed")
