#!/usr/bin/env python3
"""Publish this DeepSeek Harness checkout to a public GitHub repo.

Idempotent: safe to run repeatedly. Keeps upstream as upstream and points
origin at the public repo under the currently gh-authenticated account.
"""
from __future__ import annotations

import argparse
import os
import pathlib
import subprocess
import sys

REPO_NAME = "Deepseek-Harness-EFAI"
UPSTREAM_URL = "https://github.com/deepseek-ai/deepseek-harness.git"
BRANCH = "master"

SENSITIVE_IGNORES = [
    ".freebuff/",
    "KILN.md",
    "acl_scan_output.txt",
    "notes_output.txt",
    "schtasks_system_scan.tsv",
    "start.cmd",
    ".waf-refs/",

    "python/kiln/runtime/ds_sessions.json",

    "python/kiln/runtime/subkernels.json",

    "python/kiln/runtime/.kiln_memory/",
]


def run(cmd, check=True):
    print("+", " ".join(cmd))
    proc = subprocess.run(cmd, text=True, capture_output=True)
    if check and proc.returncode != 0:
        sys.stdout.write(proc.stdout)
        sys.stderr.write(proc.stderr)
        sys.exit(proc.returncode)
    return proc


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--repo", default=REPO_NAME)
    parser.add_argument("--branch", default=BRANCH)
    parser.add_argument("--private", action="store_true",
                        help="create a private repository instead of public")
    args = parser.parse_args()

    root = pathlib.Path(__file__).resolve().parent
    os.chdir(root)

    if run(["gh", "auth", "status"], check=False).returncode != 0:
        sys.exit("gh is not authenticated. Run: gh auth login, then retry.")

    owner = run(["gh", "api", "user", "--jq", ".login"]).stdout.strip()
    print("GitHub account:", owner)

    gitignore = root / ".gitignore"
    existing = set()
    for line in gitignore.read_text(encoding="utf-8", errors="replace").splitlines():
        existing.add(line.strip().rstrip("/"))
    missing = [p for p in SENSITIVE_IGNORES if p.strip().rstrip("/") not in existing]
    if missing:
        with gitignore.open("a", encoding="utf-8") as fh:
            fh.write(os.linesep + "# Local machine recon / agent memory - never publish")
            for pattern in missing:
                fh.write(os.linesep + pattern)
            fh.write(os.linesep)
        print("Added to .gitignore:", ", ".join(missing))
    else:
        print(".gitignore already covers all sensitive paths.")

    for pattern in SENSITIVE_IGNORES:
        if run(["git", "check-ignore", "-q", "--", pattern], check=False).returncode != 0:
            print("WARNING: not ignored:", pattern, file=sys.stderr)

    remotes = set(run(["git", "remote"]).stdout.split())
    if "upstream" not in remotes:
        run(["git", "remote", "add", "upstream", UPSTREAM_URL])
    origin_url = "https://github.com/" + owner + "/" + args.repo + ".git"
    if "origin" in remotes:
        current = run(["git", "remote", "get-url", "origin"]).stdout.strip()
        if current != origin_url:
            run(["git", "remote", "set-url", "origin", origin_url])
    else:
        run(["git", "remote", "add", "origin", origin_url])

    run(["git", "config", "user.name", owner])
    run(["git", "config", "user.email", owner + "@users.noreply.github.com"])

    run(["git", "add", "-A"])
    status = run(["git", "status", "--porcelain"], check=False).stdout.strip()
    if status:
        run(["git", "commit", "-m", "Publish DeepSeek Harness"])
    else:
        print("No changes to commit.")

    exists = run(["gh", "repo", "view", owner + "/" + args.repo, "--json", "name"], check=False)
    if exists.returncode != 0:
        visibility = "--private" if args.private else "--public"
        run(["gh", "repo", "create", owner + "/" + args.repo, visibility,
             "--description", "DeepSeek Harness"])

    run(["git", "push", "-u", "origin", args.branch])
    print("Published: https://github.com/" + owner + "/" + args.repo)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
