#!/usr/bin/env python3
"""Merge upstream deepseek-harness into this fork without touching the fork's own work.

Run from anywhere inside the repository (Windows: ``py efai\\merge_upstream.py <command>``):

    plan       Preview the next merge: what upstream brings, which files would
               conflict and how each would be resolved, fork edits upstream now
               carries itself, and anything that collides with the fork's own
               additions. Writes nothing.
    start      Merge in an isolated worktree under .worktrees/, resolve what can
               be resolved safely, prove the fork's additions survived, regenerate,
               rebuild the overlay, validate, and commit on a merge branch.
    continue   Resume after you resolved the conflicts `start` handed back.
    status     Show where the current merge stands.
    finish     Fast-forward the fork branch in your main checkout to the merge.
    abort      Remove the merge worktree and its branch.

What "does not affect my additions" means here, concretely:

* The main checkout is never switched, stashed, reset, or merged into until
  `finish`, and `finish` is a fast-forward that git itself refuses if it would
  overwrite an uncommitted change. Uncommitted work stays exactly where it is.
* Every file the fork ADDED relative to the upstream base (packages, python/kiln,
  docs, launchers, the overlay) keeps the fork's side, and after resolution each
  one is compared blob-for-blob with the fork; a difference is restored and
  reported. Nothing is pushed, ever.
* An upstream file the fork EDITS (the seam, local-overlay/SEAM.json) merges
  with git's own three-way merge. A conflict there is handed back, never
  guessed at: its markers show the base text as well as both sides (zdiff3),
  and the fork's DSH-FORK note for the file is printed beside it. Every
  resolution is remembered (git rerere, in the shared .git), so the same
  conflict in the next release resolves itself. An edit upstream now carries
  drops out of the seam on its own.
* Generated files take upstream's side and are regenerated; overlay artifacts
  are rebuilt. A conflict in anything else is handed back, never discarded.
"""

from __future__ import annotations

import argparse
import datetime as _dt
import json
import os
import queue
import re
import shutil
import signal
import socket
import subprocess
import sys
import tempfile
import threading
import time
from dataclasses import asdict, dataclass, field
from pathlib import Path

# ─── constants ──────────────────────────────────────────────────────────────

OVERLAY = "local-overlay"
# Rebuilt from the tree after the merge: never resolved, never protected.
OVERLAY_REBUILT_FILES = {f"{OVERLAY}/INVENTORY.md"}
OVERLAY_REBUILT_PREFIXES = (f"{OVERLAY}/patches/",)
# Fork-owned files this script itself rewrites during a merge.
SCRIPT_WRITTEN = {f"{OVERLAY}/BASE", f"{OVERLAY}/SEAM.json"}
REPORT_DIR = ".merge-port/merges"
WORKTREES = ".worktrees"
# Tracked files that would mean a credential leaked into git.
CREDENTIAL_PATTERN = re.compile(r"(^|/)(ds_config\.json|ds_sessions\.json|subkernels\.json|\.env|KILN\.md)$", re.I)
# ds_direct checks that run offline; the rest of python/kiln/runtime/test_*.py
# need a live DeepSeek session or a browser.
PY_OFFLINE_TESTS = (
    "test_ds_direct_system.py", "test_ds_direct_clip.py", "test_ds_direct_empty.py",
    "test_ds_direct_accounting.py", "test_ds_direct_delivery.py", "test_tool_result_files.py",
)
PHASES = ("merge", "resolve", "protect", "regenerate", "overlay", "validate", "commit", "committed")
# Package-name tokens too common to say anything about overlap.
COMMON_TOKENS = {"dsh", "deepseek", "ai", "plugin", "client", "ui", "tool", "tools", "core", "base",
                 "web", "the", "and", "for", "a", "of", "to", "in", "with", "from", "harness"}

IS_WINDOWS = os.name == "nt"
# Remember conflict resolutions (in the shared .git/rr-cache) and reuse them in
# the next merge, without changing the repository's own git config.
RERERE = ("-c", "rerere.enabled=true", "-c", "rerere.autoupdate=true")


class MergeError(RuntimeError):
    """A condition the script refuses to paper over."""


# ─── process helpers ────────────────────────────────────────────────────────

def _exe(name: str) -> str:
    """Resolve a command on PATH, including Windows .cmd shims such as pnpm.cmd."""
    found = shutil.which(name)
    if found is None:
        raise MergeError(f"`{name}` is not on PATH")
    return found


def run(cmd: list[str], cwd: Path, *, check: bool = True, timeout: float | None = None,
        env: dict[str, str] | None = None, input_text: str | None = None,
        log: Path | None = None) -> subprocess.CompletedProcess[str]:
    """Run a command, capturing text output; optionally tee it into a log file."""
    exe = [_exe(cmd[0]), *cmd[1:]]
    result = subprocess.run(
        exe, cwd=str(cwd), text=True, encoding="utf-8", errors="replace",
        capture_output=True, timeout=timeout, env=env, input=input_text,
    )
    if log is not None:
        with log.open("a", encoding="utf-8") as handle:
            handle.write(f"\n$ {' '.join(cmd)}  (cwd={cwd}, exit={result.returncode})\n")
            handle.write(result.stdout)
            handle.write(result.stderr)
    if check and result.returncode != 0:
        tail = (result.stdout + result.stderr).strip().splitlines()[-25:]
        raise MergeError(f"`{' '.join(cmd)}` failed (exit {result.returncode}):\n  " + "\n  ".join(tail))
    return result


def git(cwd: Path, *args: str, check: bool = True, input_text: str | None = None) -> str:
    return run(["git", *args], cwd, check=check, input_text=input_text).stdout


def git_ok(cwd: Path, *args: str, input_text: str | None = None) -> bool:
    return run(["git", *args], cwd, check=False, input_text=input_text).returncode == 0


def say(message: str = "") -> None:
    print(message, flush=True)


def phase(title: str) -> None:
    say(f"\n== {title}")


# ─── the fork, as git sees it ───────────────────────────────────────────────

@dataclass
class Fork:
    """Everything the fork is, relative to the upstream base it sits on."""

    repo: Path
    ref: str
    sha: str
    base: str
    rules: dict
    seam: set[str]
    additions: dict[str, str]          # path -> blob at the fork
    modified: set[str]                 # upstream files the fork edits
    deleted: set[str]                  # upstream files the fork deletes
    generated: dict[str, str]          # path -> regenerate command
    # Upstream renames of files the fork touches, new path -> old path; filled in
    # per target by `track_renames`. Git carries the fork's edit to the new name.
    renamed: dict[str, str] = field(default_factory=dict)

    def track_renames(self, target: str) -> None:
        out = git(self.repo, "diff", "--name-status", "-M", self.base, target)
        touched = self.modified | self.deleted | set(self.generated)
        for line in out.splitlines():
            fields = line.split("\t")
            if fields[0].startswith("R") and len(fields) == 3 and fields[1] in touched:
                self.renamed[fields[2]] = fields[1]

    @classmethod
    def load(cls, repo: Path, ref: str) -> "Fork":
        sha = git(repo, "rev-parse", "--verify", f"{ref}^{{commit}}").strip()
        base_text = git(repo, "show", f"{sha}:{OVERLAY}/BASE")
        base = base_text.splitlines()[0].strip()
        rules = json.loads(git(repo, "show", f"{sha}:{OVERLAY}/rules.json"))
        seam_doc = json.loads(git(repo, "show", f"{sha}:{OVERLAY}/SEAM.json"))
        records = parse_name_status(git(repo, "diff", "--name-status", "--no-renames", base, sha))
        blobs = ls_tree(repo, sha)
        additions = {r.path: blobs[r.path] for r in records if r.status == "A" and r.path in blobs}
        modified = {r.path for r in records if r.status == "M"}
        deleted = {r.path for r in records if r.status == "D"}
        generated = {entry["path"]: entry["regenerate"] for entry in rules.get("generated", [])}
        return cls(repo, ref, sha, base, rules, set(seam_doc.get("paths", [])),
                   additions, modified, deleted, generated)

    def is_overlay_rebuilt(self, path: str) -> bool:
        return path in OVERLAY_REBUILT_FILES or path.startswith(OVERLAY_REBUILT_PREFIXES)

    def protected(self) -> dict[str, str]:
        """Fork additions that must come through the merge byte for byte."""
        return {path: blob for path, blob in self.additions.items()
                if not self.is_overlay_rebuilt(path) and path not in SCRIPT_WRITTEN
                and path not in self.generated and not path.startswith(REPORT_DIR + "/")}


@dataclass
class Change:
    status: str
    path: str


def parse_name_status(text: str) -> list[Change]:
    changes = []
    for line in text.splitlines():
        if not line.strip():
            continue
        fields = line.split("\t")
        changes.append(Change(fields[0][0], fields[-1]))
    return changes


def ls_tree(repo: Path, rev: str) -> dict[str, str]:
    """Every file at a revision, mapped to its blob id."""
    out = git(repo, "ls-tree", "-r", "-z", "--full-tree", rev)
    blobs = {}
    for entry in out.split("\0"):
        if not entry:
            continue
        meta, path = entry.split("\t", 1)
        blobs[path] = meta.split()[2]
    return blobs


# ─── resolution policy ──────────────────────────────────────────────────────

@dataclass
class Resolution:
    path: str
    xy: str
    action: str       # ours | regenerate | rebuild | keep-deleted | rerere | human
    reason: str
    outcome: str = ""
    flags: list[str] = field(default_factory=list)


def decide(fork: Fork, path: str, xy: str) -> Resolution:
    """Decide how one conflicted path is resolved, before touching it.

    ``xy`` is git's two-letter unmerged status, ours = the fork, theirs = upstream:
    UU both modified, AA both added, DU deleted by the fork, UD deleted upstream,
    AU/UA added on one side, DD deleted on both.
    """
    if fork.is_overlay_rebuilt(path):
        return Resolution(path, xy, "rebuild", "overlay artifact, rebuilt from the merged tree")
    if path in fork.generated:
        return Resolution(path, xy, "regenerate", f"generated: {fork.generated[path]}")
    if path in fork.additions:
        if xy == "AA":
            # Upstream shipping the same path usually means it now ships the
            # feature itself; silently keeping the fork's copy could bury the
            # newer one, so this is a decision, not a rule.
            return Resolution(path, xy, "human", "upstream added this path too — keep the fork's, take "
                              "upstream's (and retire the fork's), or combine", flags=["collision"])
        return Resolution(path, xy, "ours", "fork addition")
    if path in fork.deleted:
        if xy in ("DU", "DD"):
            return Resolution(path, xy, "keep-deleted", "the fork deletes this upstream file")
        return Resolution(path, xy, "human", "the fork deletes this file and upstream changed it unexpectedly")
    if path in fork.modified:
        if xy == "UU":
            return Resolution(path, xy, "human", "seam: both sides changed the same lines")
        if xy == "UD":
            return Resolution(path, xy, "human", "upstream deleted a file the fork edits — move the edit")
        return Resolution(path, xy, "human", f"seam file in an unusual state ({xy})")
    old = fork.renamed.get(path)
    if old is not None:
        if old in fork.generated:
            return Resolution(path, xy, "regenerate", f"upstream renamed generated {old}; regenerated")
        return Resolution(path, xy, "human", f"upstream renamed {old} (a file the fork edits) to this path; "
                          "the fork's edit followed it — resolve here", flags=["renamed"])
    return Resolution(path, xy, "human", "not claimed by the fork's rules — resolve by hand")


# ─── patches and hunks ──────────────────────────────────────────────────────

def added_lines(patch: str) -> list[str]:
    """The substantive lines a diff adds, for spotting an edit a merge dropped."""
    out = []
    for line in patch.splitlines():
        if line.startswith("+") and not line.startswith("+++"):
            text = line[1:].strip()
            if len(text) > 3:
                out.append(text)
    return out


def fork_intent(fork: Fork, path: str) -> str:
    """Why the fork edits a seam file: its DSH-FORK notes and where its hunks sit."""
    notes = []
    try:
        content = git(fork.repo, "show", f"{fork.sha}:{path}")
        notes = [line.strip() for line in content.splitlines() if "DSH-FORK" in line][:3]
    except MergeError:
        pass
    patch = git(fork.repo, "diff", "--no-color", fork.base, fork.sha, "--", path)
    hunks = re.findall(r"^@@ -(\d+)", patch, re.M)
    where = f"fork hunks at line(s) {', '.join(hunks[:8])}" if hunks else "fork edit"
    return where + ("; " + " | ".join(n[:120] for n in notes) if notes else "; no DSH-FORK note, see INVENTORY.md")


# ─── worktree state ─────────────────────────────────────────────────────────

@dataclass
class State:
    branch: str
    worktree: str
    fork_ref: str
    fork_sha: str
    target_ref: str
    target_sha: str
    base_before: str
    upstream_version: str
    phase: str = "merge"
    resolutions: list[dict] = field(default_factory=list)
    restored: list[str] = field(default_factory=list)
    warnings: list[str] = field(default_factory=list)
    retired_seam: list[str] = field(default_factory=list)
    seam_added: list[str] = field(default_factory=list)
    generator_changes: list[str] = field(default_factory=list)
    validation: dict = field(default_factory=dict)
    options: dict = field(default_factory=dict)


def state_path(repo: Path) -> Path:
    common = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").strip())
    folder = common / "merge-upstream"
    folder.mkdir(exist_ok=True)
    return folder / "state.json"


def save_state(repo: Path, state: State) -> None:
    state_path(repo).write_text(json.dumps(asdict(state), indent=2), encoding="utf-8")


def load_state(repo: Path) -> State:
    path = state_path(repo)
    if not path.exists():
        raise MergeError("no merge in progress — run `start` first")
    return State(**json.loads(path.read_text(encoding="utf-8")))


def log_file(repo: Path) -> Path:
    return state_path(repo).with_name("merge.log")


# ─── analysis shared by plan and start ──────────────────────────────────────

def package_names(repo: Path, rev: str, paths: list[str]) -> dict[str, str]:
    """npm name -> package dir for the package.json files among ``paths``."""
    names = {}
    for path in paths:
        if re.fullmatch(r"packages/[^/]+/[^/]+/package\.json", path):
            try:
                doc = json.loads(git(repo, "show", f"{rev}:{path}"))
            except (MergeError, json.JSONDecodeError):
                continue
            if isinstance(doc.get("name"), str):
                names[doc["name"]] = {"dir": path.rsplit("/", 1)[0], "description": doc.get("description", "")}
    return names


def tokens(text: str) -> set[str]:
    return {t for t in re.split(r"[^a-z0-9]+", text.lower()) if len(t) > 2 and t not in COMMON_TOKENS}


def analyse(fork: Fork, target: str) -> dict:
    """What a merge of ``target`` would do to the fork, without touching any tree."""
    repo = fork.repo
    fork.track_renames(target)
    upstream = parse_name_status(git(repo, "diff", "--name-status", "--no-renames", fork.base, target))
    touched = {c.path for c in upstream}
    upstream_added = [c.path for c in upstream if c.status == "A"]
    upstream_deleted = [c.path for c in upstream if c.status == "D"]

    # Conflicts, predicted by a real merge that writes objects but no tree.
    predictions = [decide(fork, path, xy) for path, xy in sorted(predict_conflicts(repo, fork.sha, target).items())]

    # Fork edits upstream now carries itself: the fork's diff reverses cleanly
    # onto upstream's new version of the file.
    retirable = []
    with tempfile.TemporaryDirectory() as tmp:
        for path in sorted(fork.modified & touched):
            patch = git(repo, "diff", "--no-color", fork.base, fork.sha, "--", path)
            if not patch or "Binary files" in patch:
                continue
            try:
                content = run(["git", "show", f"{target}:{path}"], repo).stdout
            except MergeError:
                continue
            target_file = Path(tmp) / path
            target_file.parent.mkdir(parents=True, exist_ok=True)
            target_file.write_text(content, encoding="utf-8", newline="")
            if run(["git", "apply", "--reverse", "--check", "--whitespace=nowarn", "-"], Path(tmp),
                   check=False, input_text=patch).returncode == 0:
                retirable.append(path)

    # Collisions with the fork's additions.
    fork_packages = package_names(repo, fork.sha, [p for p in fork.additions if p.endswith("package.json")])
    new_packages = package_names(repo, target, [p for p in upstream_added if p.endswith("package.json")])
    name_collisions = sorted(set(fork_packages) & set(new_packages))
    path_collisions = sorted(set(upstream_added) & set(fork.additions))
    overlaps = []
    for name, info in new_packages.items():
        mine = tokens(name) | tokens(info["description"])
        for fork_name, fork_info in fork_packages.items():
            theirs = tokens(fork_name) | tokens(fork_info["description"])
            by_name = tokens(name) & tokens(fork_name)
            shared = sorted(by_name) if len(by_name) >= 2 else (
                sorted(mine & theirs) if len(mine & theirs) >= 4 else [])
            if shared and name != fork_name:
                overlaps.append({"upstream": name, "fork": fork_name, "shared": shared})

    # Fork files left behind in a package directory upstream removed.
    removed_dirs = {"/".join(p.split("/")[:3]) for p in upstream_deleted if p.startswith("packages/")}
    target_files = ls_tree(repo, target)
    live_dirs = {"/".join(p.split("/")[:3]) for p in target_files if p.startswith("packages/")}
    orphaned = sorted(p for p in fork.additions
                      if "/".join(p.split("/")[:3]) in removed_dirs - live_dirs)

    return {
        "commits": int(git(repo, "rev-list", "--count", f"{fork.base}..{target}").strip() or 0),
        "upstream_files": len(touched),
        "conflicts": predictions,
        "retirable": retirable,
        "name_collisions": name_collisions,
        "path_collisions": path_collisions,
        "overlaps": overlaps,
        "orphaned": orphaned,
        "seam_touched": sorted((fork.modified | fork.deleted) & touched),
    }


def predict_conflicts(repo: Path, ours: str, theirs: str) -> dict[str, str]:
    """Conflicted paths and their two-letter status, without building a tree.

    `git merge-tree --write-tree` reports each conflicted path once per index
    stage — 1 base, 2 ours, 3 theirs — and which stages are present is what
    says whether a side modified, deleted, or newly added the path. Deriving
    the status here is what lets `plan` predict the same resolution `start`
    will reach, rather than assuming every conflict is an ordinary both-edited
    one.
    """
    result = run(["git", "merge-tree", "--write-tree", "--no-messages", ours, theirs], repo, check=False)
    if result.returncode != 1:
        return {}
    stages: dict[str, set[int]] = {}
    for line in result.stdout.splitlines()[1:]:
        if "\t" not in line:
            continue
        meta, path = line.split("\t", 1)
        fields = meta.split()
        if len(fields) == 3 and fields[2].isdigit():
            stages.setdefault(path, set()).add(int(fields[2]))
    status = {}
    for path, present in stages.items():
        if present == {1, 2, 3}:
            status[path] = "UU"
        elif present == {1, 2}:
            status[path] = "UD"        # upstream deleted what the fork kept
        elif present == {1, 3}:
            status[path] = "DU"        # the fork deleted what upstream kept
        elif present == {2, 3}:
            status[path] = "AA"        # both sides added the path
        elif present == {2}:
            status[path] = "AU"
        elif present == {3}:
            status[path] = "UA"
        else:
            status[path] = "DD"
    return status


def upstream_version(repo: Path, rev: str) -> str:
    try:
        return json.loads(git(repo, "show", f"{rev}:package.json")).get("version", rev[:10])
    except (MergeError, json.JSONDecodeError):
        return rev[:10]


def uncommitted(repo: Path) -> list[str]:
    return [line for line in git(repo, "status", "--porcelain").splitlines() if line.strip()]


# ─── commands ───────────────────────────────────────────────────────────────

def fetch(repo: Path, args: argparse.Namespace) -> None:
    if args.no_fetch:
        return
    remote = args.target.split("/", 1)[0] if "/" in args.target else None
    if remote and git_ok(repo, "remote", "get-url", remote):
        say(f"fetching {remote} …")
        git(repo, "fetch", remote, "--prune")


def cmd_plan(repo: Path, args: argparse.Namespace) -> int:
    fetch(repo, args)
    fork = Fork.load(repo, args.fork_ref)
    target = git(repo, "rev-parse", "--verify", f"{args.target}^{{commit}}").strip()
    say(f"fork     {fork.ref} @ {fork.sha[:10]}  (upstream base {fork.base[:10]})")
    say(f"upstream {args.target} @ {target[:10]}  version {upstream_version(repo, target)}")
    if git_ok(repo, "merge-base", "--is-ancestor", target, fork.sha):
        say("\nThe fork already contains this upstream revision. Nothing to merge.")
        return 0
    report = analyse(fork, target)
    protected = fork.protected()
    say(f"\nUpstream brings {report['commits']} commit(s) touching {report['upstream_files']} file(s).")
    say(f"Your additions: {len(protected)} file(s) kept byte for byte; "
        f"seam: {len(fork.modified)} edited + {len(fork.deleted)} deleted upstream file(s).")
    say(f"Seam files upstream changed: {len(report['seam_touched'])}")

    say(f"\nPredicted conflicts: {len(report['conflicts'])}")
    for res in report["conflicts"]:
        say(f"  {res.action:<12} {res.path}  — {res.reason}")
    auto = sum(1 for r in report["conflicts"] if r.action != "human")
    if report["conflicts"]:
        say(f"  → {auto} resolved by rule, {len(report['conflicts']) - auto} for you "
            "(fewer if git rerere has seen the same conflict before)")
    if report["retirable"]:
        say("\nFork edits upstream now carries (the seam will shrink):")
        for path in report["retirable"]:
            say(f"  {path}")
    for key, title in (("name_collisions", "Package names upstream now also uses"),
                       ("path_collisions", "Paths upstream added where the fork already has a file"),
                       ("orphaned", "Fork files inside a package directory upstream removed")):
        if report[key]:
            say(f"\n{title}:")
            for item in report[key]:
                say(f"  {item}")
    if report["overlaps"]:
        say("\nNew upstream packages that may duplicate fork functionality (review, then retire one):")
        for item in report["overlaps"]:
            say(f"  {item['upstream']}  ~  {item['fork']}   ({', '.join(item['shared'])})")
    dirty = uncommitted(repo)
    if dirty:
        say(f"\nYour main checkout has {len(dirty)} uncommitted or untracked path(s). They are not part of the merge "
            "and the script never touches them; commit them first if the merge should include them.")
    return 0


def create_worktree(repo: Path, branch: str, fork_sha: str) -> Path:
    root = repo / WORKTREES
    root.mkdir(exist_ok=True)
    exclude = Path(git(repo, "rev-parse", "--path-format=absolute", "--git-common-dir").strip()) / "info" / "exclude"
    exclude.parent.mkdir(exist_ok=True)
    existing = exclude.read_text(encoding="utf-8") if exclude.exists() else ""
    if f"/{WORKTREES}/" not in existing.splitlines():
        exclude.write_text(existing.rstrip("\n") + f"\n/{WORKTREES}/\n", encoding="utf-8")
    worktree = root / branch.replace("/", "-")
    if worktree.exists():
        raise MergeError(f"{worktree} already exists — `abort` the previous merge first")
    if git_ok(repo, "rev-parse", "--verify", f"refs/heads/{branch}"):
        raise MergeError(f"branch {branch} already exists — `abort` or delete it first")
    git(repo, "worktree", "add", "-b", branch, str(worktree), fork_sha)
    return worktree


def unmerged(worktree: Path) -> dict[str, str]:
    """Unmerged paths and their two-letter status."""
    out = git(worktree, "status", "--porcelain=v1", "-z", "--untracked-files=no")
    result = {}
    for entry in out.split("\0"):
        if len(entry) > 3 and entry[:2] in ("DD", "AU", "UD", "UA", "DU", "AA", "UU"):
            result[entry[3:]] = entry[:2]
    return result


def cmd_start(repo: Path, args: argparse.Namespace) -> int:
    if state_path(repo).exists():
        raise MergeError("a merge is already in progress — `status`, `continue`, or `abort`")
    fetch(repo, args)
    fork = Fork.load(repo, args.fork_ref)
    target = git(repo, "rev-parse", "--verify", f"{args.target}^{{commit}}").strip()
    if git_ok(repo, "merge-base", "--is-ancestor", target, fork.sha):
        say("The fork already contains this upstream revision. Nothing to merge.")
        return 0
    fork.track_renames(target)
    version = upstream_version(repo, target)
    branch = args.branch or f"merge/upstream-{version}"
    phase(f"worktree for {branch}")
    worktree = create_worktree(repo, branch, fork.sha)
    say(f"  {worktree}")
    state = State(branch=branch, worktree=str(worktree), fork_ref=fork.ref, fork_sha=fork.sha,
                  target_ref=args.target, target_sha=target, base_before=fork.base,
                  upstream_version=version, options=pipeline_options(args))
    dirty = uncommitted(repo)
    if dirty:
        state.warnings.append(f"{len(dirty)} uncommitted change(s) in the main checkout were not included "
                              "(and were not touched)")
    save_state(repo, state)

    phase(f"merging {args.target} ({target[:10]}, {version})")
    result = run(["git", *RERERE, "-c", "merge.conflictStyle=zdiff3", "merge", "--no-ff", "--no-commit", target],
                 worktree, check=False, log=log_file(repo))
    if result.returncode not in (0, 1) or ("CONFLICT" not in result.stdout and result.returncode == 1):
        raise MergeError("git merge failed:\n" + (result.stdout + result.stderr)[-2000:])
    for reused in re.findall(r"(?:Resolved|Staged) '([^']+)' using previous resolution", result.stdout + result.stderr):
        state.resolutions.append(asdict(Resolution(reused, "UU", "rerere", "a past resolution of this conflict",
                                                   outcome="reused and staged")))
        say(f"  rerere       {reused}  reused a past resolution")
    state.phase = "resolve"
    save_state(repo, state)
    return resolve_and_continue(repo, state, fork)


def resolve_and_continue(repo: Path, state: State, fork: Fork) -> int:
    worktree = Path(state.worktree)
    phase("resolving conflicts")
    conflicts = unmerged(worktree)
    say(f"  {len(conflicts)} conflicted path(s)")
    for path, xy in sorted(conflicts.items()):
        res = decide(fork, path, xy)
        if res.action in ("ours", "rebuild"):
            if git_ok(worktree, "cat-file", "-e", f"{fork.sha}:{path}"):
                git(worktree, "checkout", fork.sha, "--", path)
                git(worktree, "add", "--", path)
            else:
                git(worktree, "rm", "-q", "--", path)
            res.outcome = "fork's side kept"
        elif res.action == "regenerate":
            if xy in ("DU", "DD") or not git_ok(worktree, "cat-file", "-e", f"{state.target_sha}:{path}"):
                git(worktree, "rm", "-q", "--", path)
            else:
                git(worktree, "checkout", state.target_sha, "--", path)
                git(worktree, "add", "--", path)
            res.outcome = "upstream's side, regenerated later"
        elif res.action == "keep-deleted":
            git(worktree, "rm", "-q", "--", path)
            res.outcome = "kept deleted"
        elif path in fork.modified or path in fork.deleted:
            res.outcome = fork_intent(fork, path)
        if res.action != "human":
            say(f"  {res.action:<12} {path}  {res.outcome}")
        state.resolutions.append(asdict(res))
    save_state(repo, state)
    remaining = unmerged(worktree)
    if remaining:
        say(f"\n{len(remaining)} path(s) need you. Resolve them in {worktree}, `git add` each, then run:")
        say("    py efai/merge_upstream.py continue")
        for path, xy in sorted(remaining.items()):
            reason = next((r["reason"] for r in state.resolutions if r["path"] == path), "")
            outcome = next((r["outcome"] for r in state.resolutions if r["path"] == path), "")
            say(f"  {xy} {path}\n       {reason}{'; ' + outcome if outcome else ''}")
        return 2
    state.phase = "protect"
    save_state(repo, state)
    return run_pipeline(repo, state)


def cmd_continue(repo: Path, args: argparse.Namespace) -> int:
    state = load_state(repo)
    if state.phase == "committed":
        say("The merge is committed. Next: `finish`.")
        return 0
    worktree = Path(state.worktree)
    if state.phase in ("merge", "resolve"):
        remaining = unmerged(worktree)
        if remaining:
            say(f"{len(remaining)} path(s) are still unmerged:")
            for path, xy in sorted(remaining.items()):
                say(f"  {xy} {path}")
            return 2
        markers = git(worktree, "diff", "--cached", "--check", check=False)
        if "conflict marker" in markers:
            raise MergeError("staged files still contain conflict markers:\n" + markers[-1500:])
        git(worktree, *RERERE, "rerere", check=False)   # remember these resolutions for the next merge
        state.phase = "protect"
        save_state(repo, state)
    state.options.update({k: v for k, v in pipeline_options(args).items() if v not in (None, False)})
    return run_pipeline(repo, state)


def pipeline_options(args: argparse.Namespace) -> dict:
    keys = ("validate", "no_boot", "no_regenerate", "no_overlay", "no_commit", "no_verify",
            "commit_anyway", "allow_seam_growth", "stop_after")
    return {key: getattr(args, key, None) for key in keys}


def run_pipeline(repo: Path, state: State) -> int:
    fork = Fork.load(repo, state.fork_sha)
    fork.track_renames(state.target_sha)
    worktree = Path(state.worktree)
    stop_after = state.options.get("stop_after")
    steps = [("protect", protect), ("regenerate", regenerate), ("overlay", rebuild_overlay),
             ("validate", validate), ("commit", commit)]
    start = PHASES.index(state.phase)
    for name, step in steps:
        if PHASES.index(name) < start:
            continue
        state.phase = name
        save_state(repo, state)
        step(repo, worktree, state, fork)
        if stop_after == name:
            state.phase = PHASES[PHASES.index(name) + 1]
            save_state(repo, state)
            say(f"\nStopped after {name} as asked. Resume with `continue`.")
            return 0
    state.phase = "committed"
    save_state(repo, state)
    summary(state)
    return 0 if not state.validation.get("failed") else 1


# ─── pipeline steps ─────────────────────────────────────────────────────────

def protect(repo: Path, worktree: Path, state: State, fork: Fork) -> None:
    """Prove every fork addition came through unchanged; restore any that did not."""
    phase("protecting the fork's additions")
    index = {}
    for entry in git(worktree, "ls-files", "-s", "-z").split("\0"):
        if entry:
            meta, path = entry.split("\t", 1)
            index[path] = meta.split()[1]
    protected = fork.protected()
    restored = []
    for path, blob in protected.items():
        if index.get(path) != blob:
            git(worktree, "checkout", fork.sha, "--", path)
            git(worktree, "add", "--", path)
            restored.append(path)
    state.restored = restored
    say(f"  {len(protected)} addition(s) checked, {len(restored)} restored")
    for path in restored:
        say(f"    restored {path}")
    for path in fork.deleted:
        if path in index and path not in fork.generated:
            state.warnings.append(f"{path}: the fork deletes this file but the merge brought it back")
    # A seam file git merged on its own can still have lost a fork line.
    for path in sorted(fork.modified):
        if path not in index or any(r["path"] == path for r in state.resolutions):
            continue
        patch = git(repo, "diff", "--no-color", fork.base, fork.sha, "--", path)
        wanted = added_lines(patch)
        if not wanted:
            continue
        try:
            merged = (worktree / path).read_text(encoding="utf-8", errors="replace")
        except OSError:
            continue
        missing = [line for line in wanted if line not in merged]
        if missing:
            state.warnings.append(f"{path}: {len(missing)} line(s) the fork added are absent after the "
                                  f"auto-merge, e.g. {missing[0][:80]!r}")
    for warning in state.warnings:
        say(f"  ! {warning}")


def regenerate(repo: Path, worktree: Path, state: State, fork: Fork) -> None:
    if state.options.get("no_regenerate"):
        return
    phase("regenerating")
    log = log_file(repo)
    run(["pnpm", "install", "--no-frozen-lockfile"], worktree, timeout=3600, log=log)
    say("  pnpm install")
    commands = ["pnpm run gen-tsconfig-paths"]
    for command in fork.generated.values():
        if command not in commands and "install" not in command:
            commands.append(command)
    watched = sorted(fork.protected())
    before = ls_worktree_blobs(worktree, watched)
    for command in commands:
        heavy = "snapshot" in command
        if heavy and state.options.get("validate") in ("none", "quick"):
            state.warnings.append(f"skipped `{command}` (validate={state.options.get('validate')})")
            continue
        result = run(command.split(), worktree, check=False, timeout=3600, log=log)
        status = "ok" if result.returncode == 0 else f"FAILED (exit {result.returncode})"
        say(f"  {command}: {status}")
        if result.returncode != 0:
            state.warnings.append(f"`{command}` failed — see {log}")
    after = ls_worktree_blobs(worktree, watched)
    state.generator_changes = sorted(p for p, b in before.items() if after.get(p) != b)
    for path in state.generator_changes:
        say(f"  ! a generator rewrote the fork's {path} (kept; review it in the diff)")
    git(worktree, "add", "-A")


def ls_worktree_blobs(worktree: Path, files: list[str]) -> dict[str, str]:
    """Blob ids of working-tree files, hashed as git would store them."""
    blobs = {}
    for start in range(0, len(files), 400):
        chunk = files[start:start + 400]
        present = [p for p in chunk if (worktree / p).is_file()]
        if not present:
            continue
        out = git(worktree, "hash-object", "--", *present)
        blobs.update(zip(present, out.split()))
    return blobs


def rebuild_overlay(repo: Path, worktree: Path, state: State, fork: Fork) -> None:
    if state.options.get("no_overlay"):
        return
    phase("rebuilding the overlay")
    (worktree / OVERLAY / "BASE").write_text(state.target_sha + "\n", encoding="utf-8")
    result = run(["node", f"{OVERLAY}/rebuild.mjs"], worktree, check=False, log=log_file(repo))
    output = result.stdout + result.stderr
    if "no rule claims" in output:
        unclaimed = [line.strip() for line in output.splitlines() if re.match(r"\s+[AMD]\s", line)]
        raise MergeError("the merge left upstream files modified that no patch group claims:\n  "
                         + "\n  ".join(unclaimed[:30])
                         + "\nMove each edit into a fork-owned file, or add a patchGroups entry in rules.json.")
    if result.returncode != 0:
        raise MergeError("rebuild.mjs failed:\n" + output[-2000:])
    # The seam may shrink freely; growing it is a recorded decision.
    tier2 = set()
    for change in parse_name_status(git(worktree, "diff", "--name-status", "--no-renames", state.target_sha)):
        if change.status in ("M", "D") and change.path not in fork.generated:
            tier2.add(change.path)
    seam_file = worktree / OVERLAY / "SEAM.json"
    seam_doc = json.loads(seam_file.read_text(encoding="utf-8"))
    recorded = set(seam_doc["paths"])
    moved = {new: old for new, old in fork.renamed.items() if old in recorded and new in tier2}
    for new, old in sorted(moved.items()):
        state.warnings.append(f"seam file moved upstream: {old} -> {new} (check rules.json still claims it)")
    state.retired_seam = sorted(recorded - tier2 - set(moved.values()))
    state.seam_added = sorted(tier2 - recorded - set(moved))
    if state.seam_added and not state.options.get("allow_seam_growth"):
        raise MergeError("the merge grows the frozen seam by:\n  " + "\n  ".join(state.seam_added)
                         + "\nIf that is intended, re-run `continue --allow-seam-growth`.")
    seam_doc["paths"] = sorted(tier2)
    seam_doc["base"] = state.target_sha
    seam_file.write_text(json.dumps(seam_doc, indent=2) + "\n", encoding="utf-8")
    run(["node", f"{OVERLAY}/rebuild.mjs"], worktree, log=log_file(repo))
    git(worktree, "add", "-A")
    say(f"  base → {state.target_sha[:10]}; seam {len(recorded)} → {len(tier2)} file(s)"
        + (f"; retired: {', '.join(state.retired_seam)}" if state.retired_seam else ""))
    for check in (["node", f"{OVERLAY}/rebuild.mjs", "--check"], ["node", f"{OVERLAY}/verify.mjs"],
                  ["node", f"{OVERLAY}/apply.mjs", "--check"], ["node", f"{OVERLAY}/verify-seam-frozen.mjs"]):
        run(check, worktree, log=log_file(repo))
    say("  overlay verified: patches apply to the new base and reproduce the tree")


def validate(repo: Path, worktree: Path, state: State, fork: Fork) -> None:
    level = state.options.get("validate", "standard")
    if level == "none":
        return
    phase(f"validating ({level})")
    log = log_file(repo)
    results: dict[str, str] = {}

    def step(name: str, cmd: list[str], cwd: Path = worktree, timeout: float = 3600,
             env: dict | None = None, required: bool = True) -> bool:
        result = run(cmd, cwd, check=False, timeout=timeout, env=env, log=log)
        ok = result.returncode == 0
        results[name] = "ok" if ok else ("FAILED" if required else "failed (informational)")
        say(f"  {name}: {results[name]}")
        return ok

    leaked = [p for p in git(worktree, "ls-files").splitlines() if CREDENTIAL_PATTERN.search(p)]
    results["credentials"] = "ok" if not leaked else "FAILED: " + ", ".join(leaked)
    say(f"  credentials: {results['credentials']}")
    step("typecheck", ["pnpm", "run", "typecheck"])
    fork_test_dirs = sorted({"/".join(p.split("/")[:3]) for p in fork.additions
                             if re.match(r"packages/[^/]+/[^/]+/tests/", p)})
    if fork_test_dirs:
        step("fork package tests", ["pnpm", "exec", "vitest", "run", *fork_test_dirs])
    venv = repo / "python/kiln/runtime/.venv" / ("Scripts/python.exe" if IS_WINDOWS else "bin/python")
    if venv.exists():
        runtime = worktree / "python/kiln/runtime"
        failed = [t for t in PY_OFFLINE_TESTS if (runtime / t).exists()
                  and run([str(venv), t], runtime, check=False, timeout=600, log=log).returncode != 0]
        results["python checks"] = "ok" if not failed else "FAILED: " + ", ".join(failed)
        say(f"  python checks: {results['python checks']}")
    else:
        results["python checks"] = "skipped (no python/kiln/runtime/.venv in the main checkout)"
    if level in ("standard", "full"):
        if step("build", ["pnpm", "run", "build"]) and not state.options.get("no_boot"):
            results["boot"] = boot_smoke(worktree, fork, log)
            say(f"  boot: {results['boot']}")
    if level == "full":
        step("full test suite", ["pnpm", "run", "test"], required=False)
        step("lint", ["pnpm", "run", "lint"], required=False)
    state.validation = {"results": results,
                        "failed": sorted(k for k, v in results.items() if v.startswith("FAILED"))}
    save_state(repo, state)
    if state.validation["failed"] and not state.options.get("commit_anyway"):
        raise MergeError("validation failed: " + ", ".join(state.validation["failed"])
                         + f"\nFix it in {worktree}, then `continue` (or `continue --commit-anyway`).")


def free_port() -> int:
    with socket.socket() as sock:
        sock.bind(("127.0.0.1", 0))
        return sock.getsockname()[1]


def fork_row_ids(worktree: Path) -> list[str]:
    ids = []
    for bundle in ("packages/bundle/efai-base/cordis.patch.yml", "packages/bundle/efai-web/cordis.patch.yml"):
        path = worktree / bundle
        if path.exists():
            ids += re.findall(r"^\s+- id:\s*([\w-]+)", path.read_text(encoding="utf-8"), re.M)
    return ids


def boot_smoke(worktree: Path, fork: Fork, log: Path) -> str:
    """Boot the merged build on a throwaway home; the user's ~/.dsh is never touched."""
    # The host's own sessions, and a credentials path that does not exist, both
    # live in the temp directory; a Windows file lock left behind is not fatal.
    with tempfile.TemporaryDirectory(ignore_cleanup_errors=True) as tmp:
        env = dict(os.environ, DSH_HOME=str(Path(tmp) / "home"),
                   KILN_DS_CONFIG=str(Path(tmp) / "ds_config.json"))
        cli = str(worktree / "apps/cli/lib/bin.js")
        run(["node", str(worktree / "efai/ensure-profile-bundles.mjs"), "web"], Path(tmp), env=env, log=log)
        dump = run(["node", cli, "--profile", "web", "--dump-config"], Path(tmp), env=env, check=False, log=log)
        missing = [row for row in fork_row_ids(worktree) if f"id: {row}" not in dump.stdout]
        if missing:
            return "FAILED: fork rows missing from the composed profile: " + ", ".join(missing)
        port = free_port()
        process = subprocess.Popen([_exe("node"), cli, "web", "--port", str(port), "--no-open"],
                                   cwd=tmp, env=env, stdout=subprocess.PIPE, stderr=subprocess.STDOUT,
                                   text=True, encoding="utf-8", errors="replace")
        # Read on a thread, so a host that goes quiet cannot block past the deadline.
        lines: queue.Queue[str | None] = queue.Queue()
        reader = threading.Thread(target=lambda: [lines.put(line) for line in process.stdout] + [lines.put(None)],
                                  daemon=True)
        reader.start()
        output: list[str] = []
        deadline = time.time() + 120
        try:
            while time.time() < deadline:
                try:
                    line = lines.get(timeout=1)
                except queue.Empty:
                    continue
                if line is None:
                    break
                output.append(line)
                if "dsh web: http" in line:
                    time.sleep(5)
                    if process.poll() is None:
                        return "ok (web host up, every fork row composed)"
                if "startup failed" in line:
                    break
        finally:
            if process.poll() is None:
                if IS_WINDOWS:
                    subprocess.run(["taskkill", "/PID", str(process.pid), "/T", "/F"], capture_output=True)
                else:
                    process.send_signal(signal.SIGTERM)
            process.wait(timeout=30)
            with log.open("a", encoding="utf-8") as handle:
                handle.write("\n$ boot smoke\n" + "".join(output))
        return "FAILED: " + ("".join(output[-15:]).strip() or "no output")


def write_report(worktree: Path, state: State) -> Path:
    today = _dt.date.today().isoformat()
    path = worktree / REPORT_DIR / f"{today}-{state.upstream_version}.md"
    path.parent.mkdir(parents=True, exist_ok=True)
    res = state.resolutions
    lines = [
        f"# Upstream merge: deepseek-harness {state.upstream_version}", "",
        f"Merged `{state.target_ref}` @ `{state.target_sha[:10]}` into `{state.fork_ref}` @ `{state.fork_sha[:10]}` "
        f"(previous base `{state.base_before[:10]}`), by `efai/merge_upstream.py` on {today}.", "",
        "## Conflicts", "",
        "| Path | Git | Resolution | Outcome |", "|---|---|---|---|",
        *[f"| `{r['path']}` | {r['xy']} | {r['action']} | {r['outcome'] or r['reason']} |" for r in res],
        "", "## The fork's additions", "",
        f"{len(state.restored)} restored after the merge changed them."
        if state.restored else "Every addition came through byte for byte.",
        *[f"- `{p}`" for p in state.restored],
        "", "## Seam", "",
        f"Retired (upstream now carries the edit): {', '.join(f'`{p}`' for p in state.retired_seam) or 'none'}.",
        f"Grown: {', '.join(f'`{p}`' for p in state.seam_added) or 'none'}.",
        "", "## Warnings", "", *([f"- {w}" for w in state.warnings] or ["None."]),
        "", "## Validation", "",
        *[f"- {k}: {v}" for k, v in state.validation.get("results", {}).items()],
        "",
    ]
    path.write_text("\n".join(lines), encoding="utf-8")
    return path


def commit(repo: Path, worktree: Path, state: State, fork: Fork) -> None:
    if state.options.get("no_commit"):
        say("\nLeaving the merge uncommitted (--no-commit).")
        return
    phase("committing")
    report = write_report(worktree, state)
    git(worktree, "add", "-A")
    # .merge-port/ is gitignored here, the way MERGE-STATUS.md already is, so
    # the report needs an explicit add or it would never reach the commit.
    git(worktree, "add", "-f", "--", report.relative_to(worktree).as_posix())
    auto = sum(1 for r in state.resolutions if r["action"] != "human")
    message = (
        f"merge: deepseek-harness {state.upstream_version} into the fork\n\n"
        f"Merges {state.target_ref} @ {state.target_sha[:10]} onto {state.fork_ref} @ {state.fork_sha[:10]}.\n"
        f"{len(state.resolutions)} conflict(s): {auto} resolved by rule, {len(state.resolutions) - auto} by hand.\n"
        f"Fork additions restored after the merge: {len(state.restored)}. "
        f"Seam retired: {len(state.retired_seam)}, grown: {len(state.seam_added)}.\n"
        f"Report: {report.relative_to(worktree).as_posix()}\n"
    )
    args = [*RERERE, "commit", "-q", "-F", "-"] + (["--no-verify"] if state.options.get("no_verify") else [])
    result = run(["git", *args], worktree, check=False, input_text=message, timeout=3600, log=log_file(repo))
    if result.returncode != 0:
        raise MergeError("commit failed (a pre-commit hook?):\n" + (result.stdout + result.stderr)[-2500:]
                         + "\nFix it, then `continue`; `continue --no-verify` skips the hooks.")
    say(f"  {git(worktree, 'log', '--oneline', '-1').strip()}")


def summary(state: State) -> None:
    say("\n== done")
    say(f"Branch {state.branch} holds the merge, in {state.worktree}.")
    if state.warnings:
        say("Warnings to review:")
        for warning in state.warnings:
            say(f"  ! {warning}")
    say("Next: `py efai/merge_upstream.py finish` fast-forwards your "
        f"{state.fork_ref} to it. Nothing has been pushed.")


def cmd_status(repo: Path, args: argparse.Namespace) -> int:
    state = load_state(repo)
    say(f"merge of {state.target_ref} ({state.upstream_version}) into {state.fork_ref}")
    say(f"branch {state.branch}, worktree {state.worktree}")
    say(f"phase: {state.phase}")
    if Path(state.worktree).exists():
        remaining = unmerged(Path(state.worktree))
        if remaining:
            say(f"{len(remaining)} unmerged path(s):")
            for path, xy in sorted(remaining.items()):
                say(f"  {xy} {path}")
    for warning in state.warnings:
        say(f"  ! {warning}")
    return 0


def cmd_finish(repo: Path, args: argparse.Namespace) -> int:
    state = load_state(repo)
    if state.phase != "committed":
        raise MergeError(f"the merge is at phase `{state.phase}`, not committed — `continue` first")
    current = git(repo, "rev-parse", "--abbrev-ref", "HEAD").strip()
    fork_branch = state.fork_ref if git_ok(repo, "rev-parse", "--verify", f"refs/heads/{state.fork_ref}") else None
    if fork_branch is None or current != fork_branch:
        raise MergeError(f"the main checkout is on `{current}`; switch it to `{state.fork_ref}` yourself first")
    if git(repo, "rev-parse", "HEAD").strip() != state.fork_sha:
        if not git_ok(repo, "merge-base", "--is-ancestor", "HEAD", state.branch):
            raise MergeError(f"{state.fork_ref} moved since the merge started — merge {state.branch} "
                             "into it yourself, or `abort` and `start` again")
    # A fast-forward keeps uncommitted changes, and git refuses outright if one
    # would be overwritten. Nothing is stashed or reset.
    result = run(["git", "merge", "--ff-only", state.branch], repo, check=False)
    if result.returncode != 0:
        raise MergeError("fast-forward refused — usually an uncommitted change in a file the merge updates:\n"
                         + (result.stdout + result.stderr)[-1500:])
    say(f"{state.fork_ref} → {git(repo, 'log', '--oneline', '-1').strip()}")
    if not args.keep_worktree:
        remove_worktree(repo, Path(state.worktree))
        git(repo, "branch", "-d", state.branch, check=False)
    state_path(repo).unlink()
    say("\nThe running build is not the merged one yet:")
    say("  pnpm install && pnpm run build")
    if state.upstream_version:
        say("First start of a new upstream release migrates ~/.dsh one way; older builds cannot read it after.")
    say("Nothing has been pushed.")
    return 0


def remove_worktree(repo: Path, worktree: Path) -> None:
    git(repo, "worktree", "remove", "--force", str(worktree), check=False)
    if worktree.exists():
        # pnpm links packages with directory junctions; `rmdir /s` removes a
        # junction itself and never follows it into the shared store.
        if IS_WINDOWS:
            subprocess.run(["cmd", "/c", "rmdir", "/s", "/q", str(worktree)], capture_output=True)
        else:
            shutil.rmtree(worktree, ignore_errors=True)
    git(repo, "worktree", "prune")


def cmd_abort(repo: Path, args: argparse.Namespace) -> int:
    state = load_state(repo)
    worktree = Path(state.worktree)
    if worktree.exists():
        git(worktree, "merge", "--abort", check=False)
        remove_worktree(repo, worktree)
    git(repo, "branch", "-D", state.branch, check=False)
    state_path(repo).unlink()
    say(f"Removed {worktree} and {state.branch}. The main checkout was never touched.")
    return 0


# ─── entry ──────────────────────────────────────────────────────────────────

def repo_root() -> Path:
    here = Path(__file__).resolve().parent
    return Path(git(here, "rev-parse", "--show-toplevel").strip())


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(prog="merge_upstream", description=__doc__,
                                     formatter_class=argparse.RawDescriptionHelpFormatter)
    parser.add_argument("--repo", type=Path, help="repository root (default: the one this script lives in)")
    sub = parser.add_subparsers(dest="command", required=True)

    def common(p: argparse.ArgumentParser) -> None:
        p.add_argument("--target", default="upstream/master", help="upstream revision to merge")
        p.add_argument("--fork-ref", default="master", help="the fork branch to merge into")
        p.add_argument("--no-fetch", action="store_true", help="do not fetch the target's remote first")

    def pipeline(p: argparse.ArgumentParser) -> None:
        p.add_argument("--validate", choices=("none", "quick", "standard", "full"), default=None,
                       help="quick: typecheck + fork tests; standard adds build + boot (default); full adds the whole suite")
        p.add_argument("--no-boot", action="store_true", help="skip the throwaway-home boot test")
        p.add_argument("--no-regenerate", action="store_true", help="skip pnpm install and the generators")
        p.add_argument("--no-overlay", action="store_true", help="skip the overlay rebuild and checks")
        p.add_argument("--no-commit", action="store_true", help="stop before committing")
        p.add_argument("--no-verify", action="store_true", help="commit without git hooks")
        p.add_argument("--commit-anyway", action="store_true", help="commit even if validation failed")
        p.add_argument("--allow-seam-growth", action="store_true", help="accept new upstream files in the seam")
        p.add_argument("--stop-after", choices=PHASES[2:7], help="stop after this phase")

    p = sub.add_parser("plan", help="preview the next merge; writes nothing")
    common(p)
    p.set_defaults(func=cmd_plan)
    p = sub.add_parser("start", help="merge in an isolated worktree")
    common(p)
    pipeline(p)
    p.add_argument("--branch", help="merge branch name (default merge/upstream-<version>)")
    p.set_defaults(func=cmd_start)
    p = sub.add_parser("continue", help="resume after resolving conflicts")
    pipeline(p)
    p.set_defaults(func=cmd_continue)
    p = sub.add_parser("status", help="show the merge in progress")
    p.set_defaults(func=cmd_status)
    p = sub.add_parser("finish", help="fast-forward the fork branch in the main checkout")
    p.add_argument("--keep-worktree", action="store_true")
    p.set_defaults(func=cmd_finish)
    p = sub.add_parser("abort", help="remove the merge worktree and branch")
    p.set_defaults(func=cmd_abort)

    args = parser.parse_args(argv)
    if getattr(args, "validate", None) is None and args.command == "start":
        args.validate = "standard"
    try:
        repo = args.repo.resolve() if args.repo else repo_root()
        return args.func(repo, args)
    except MergeError as error:
        say(f"\nerror: {error}")
        return 1


if __name__ == "__main__":
    sys.exit(main())
