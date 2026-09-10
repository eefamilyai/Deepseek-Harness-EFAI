#!/usr/bin/env python
"""Regression tests for ds_direct's model modes and its file-upload bridge.

Run:  python test_ds_direct_modes.py

Everything here is OFFLINE. The live behaviour these pin was established
against chat.deepseek.com by hand and is recorded in the assertions:

  * the website's picker collapsed to four modes -- plain, thinking, search,
    and thinking+search -- so the retired Expert and Vision ids must still
    RESOLVE (or a saved conversation naming one silently changes model) while
    disappearing from the advertised catalogue;
  * a file now rides an ORDINARY chat as ref_file_ids rather than a separate
    vision tier, verified by uploading a file containing a known phrase and
    reading it back from a model_type="default" turn;
  * /file/fetch_files no longer returns file rows, so file_status() answering
    `{}` is a legitimate "no evidence", not a failure to report.

No network and no credentials: the upload tests drive a fake client.
"""
import inspect
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ds_direct as dd
import token_usage as tu

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


# ── the live mode set ───────────────────────────────────────────────
LIVE = ["deepseek-default", "deepseek-reasoner", "deepseek-search",
        "deepseek-reasoner-search"]
RETIRED = ["deepseek-expert", "deepseek-expert-reasoner", "deepseek-expert-offline",
           "deepseek-expert-search", "deepseek-vision", "deepseek-vision-reasoner"]

check("MODEL_MAP holds exactly the four live modes",
      sorted(dd.MODEL_MAP) == sorted(LIVE), repr(sorted(dd.MODEL_MAP)))

# The picker's advisory catalogue is LABELS, so a retired id listed here puts a
# mode the website no longer offers back in front of the user.
check("LABELS advertises the live modes only",
      sorted(dd.LABELS) == sorted(LIVE), repr(sorted(dd.LABELS)))
check("LABELS and MODEL_MAP describe the same ids",
      set(dd.LABELS) == set(dd.MODEL_MAP))
check("every label is non-empty",
      all(isinstance(v, str) and v.strip() for v in dd.LABELS.values()))

# The four modes are the four flag combinations -- if two ids collapsed onto the
# same flags, one of the website's modes would be unreachable.
check("the four modes cover four distinct flag combinations",
      len({tuple(dd.MODEL_MAP[m]) for m in LIVE}) == 4,
      repr(sorted(tuple(dd.MODEL_MAP[m]) for m in LIVE)))
check("plain mode is the only one with thinking and search both off",
      dd.MODEL_MAP["deepseek-default"] == ("default", False, False))


# ── retired ids still resolve, onto what they used to mean ──────────
for rid in RETIRED:
    check("retired id resolves to a live mode: %s" % rid,
          dd.resolve_model(rid) in dd.MODEL_MAP,
          "-> %r" % dd.resolve_model(rid))

check("live ids resolve to themselves",
      all(dd.resolve_model(m) == m for m in LIVE))
check("an unknown id falls back to the plain mode",
      dd.resolve_model("deepseek-nonesuch") == "deepseek-default")
check("None falls back to the plain mode",
      dd.resolve_model(None) == "deepseek-default")

# The expert tier shipped with thinking ON and search OFF; the expert-search id
# with search ON. Resolving them onto a mode with the wrong flags would change
# how an existing conversation behaves, not just its label.
check("expert ids keep thinking on and search off",
      dd.MODEL_MAP[dd.resolve_model("deepseek-expert")] == ("default", True, False))
check("expert-search keeps search on",
      dd.MODEL_MAP[dd.resolve_model("deepseek-expert-search")][2] is True)
check("vision ids land on a mode that reads files",
      dd.resolve_model("deepseek-vision") in LIVE
      and dd.resolve_model("deepseek-vision-reasoner") in LIVE)


# ── routing ────────────────────────────────────────────────────────
check("is_dsfree accepts live ids", all(dd.is_dsfree(m) for m in LIVE))
check("is_dsfree accepts retired ids (they still route here)",
      all(dd.is_dsfree(m) for m in RETIRED))
check("is_dsfree rejects a qualified id",
      not dd.is_dsfree("openrouter/deepseek-chat"))
check("is_dsfree rejects another provider's id",
      not dd.is_dsfree("gpt-4o") and not dd.is_dsfree(""))


# ── the registry contract ──────────────────────────────────────────
# providers._call decides the calling convention from the signature, so these
# must accept cfg positionally or they raise TypeError inside a correctly-called
# function.
check("model_labels takes cfg", "cfg" in inspect.signature(dd.model_labels).parameters)
check("default_model takes cfg", "cfg" in inspect.signature(dd.default_model).parameters)
check("model_labels returns the live catalogue",
      set(dd.model_labels({})) == set(LIVE))
check("default_model is a live id",
      dd.default_model({}) in dd.MODEL_MAP, repr(dd.default_model({})))


# ── context windows stay in sync ───────────────────────────────────
# A missing entry is not fatal (DEFAULT_LIMIT catches it) but it silently
# under-reports the window, which is how a 1M-token chat starts showing a
# 64k limit.
for mid in LIVE + RETIRED:
    check("token_usage has a window for %s" % mid, mid in tu.MODEL_LIMITS)


# ── the upload bridge ──────────────────────────────────────────────
class _FakeClient:
    """Records uploads; fails the names in `fail` the way the real path does."""

    def __init__(self, fail=()):
        self.fail = set(fail)
        self.seen = []
        self.account = type("A", (), {"id": "acct-1"})()
        self.cookies_persisted = False

    def upload_file(self, filename, blob):
        self.seen.append((filename, blob))
        if filename in self.fail:
            raise RuntimeError("DeepSeek refused the upload: nope (code 40003)")
        return "file-%s" % filename

    def cookie_string(self):
        return ""

    @property
    def sess(self):
        return None


def _with_fake_client(fake, fn):
    """Run fn() with _lease_client and _persist_cookies stubbed."""
    import contextlib
    orig_lease, orig_persist = dd._lease_client, dd._persist_cookies

    @contextlib.contextmanager
    def lease(account_id=None):
        yield fake

    dd._lease_client = lease
    dd._persist_cookies = lambda c: setattr(fake, "cookies_persisted", True)
    try:
        return fn()
    finally:
        dd._lease_client, dd._persist_cookies = orig_lease, orig_persist


check("upload_files is exported", callable(getattr(dd, "upload_files", None)))
check("stream accepts ref_file_ids",
      "ref_file_ids" in inspect.signature(dd.stream).parameters)
check("_stream_with accepts ref_file_ids",
      "ref_file_ids" in inspect.signature(dd._stream_with).parameters)

res = _with_fake_client(_FakeClient(), lambda: dd.upload_files([]))
check("upload_files([]) returns an empty, well-formed result",
      res == {"account": None, "files": [], "errors": []}, repr(res))

fake = _FakeClient()
res = _with_fake_client(fake, lambda: dd.upload_files(
    [("a.txt", b"aaa"), ("b.txt", b"bb")]))
check("upload_files returns one entry per uploaded file", len(res["files"]) == 2,
      repr(res))
check("upload_files names the account the ids belong to",
      res["account"] == "acct-1", repr(res.get("account")))
check("upload_files returns the ids", [f["id"] for f in res["files"]]
      == ["file-a.txt", "file-b.txt"], repr(res["files"]))
check("upload_files reports the byte size", [f["size"] for f in res["files"]] == [3, 2])
check("upload_files persists refreshed cookies", fake.cookies_persisted)

# One unreadable file must not lose the others: the caller is the only party
# that knows whether losing one of five attachments is fatal.
fake = _FakeClient(fail={"bad.txt"})
res = _with_fake_client(fake, lambda: dd.upload_files(
    [("ok.txt", b"x"), ("bad.txt", b"y"), ("also.txt", b"z")]))
check("a per-file failure does not abort the batch",
      [f["name"] for f in res["files"]] == ["ok.txt", "also.txt"], repr(res))
check("a per-file failure is reported under errors",
      len(res["errors"]) == 1 and res["errors"][0]["name"] == "bad.txt", repr(res))
check("the failure message carries the reason",
      "40003" in res["errors"][0]["error"], repr(res["errors"]))

# file_status returning {} means "no evidence", which _describe_once relies on
# to go ahead rather than refusing every file.
check("file_status is documented as best-effort",
      "UNKNOWN" in (dd._Client.file_status.__doc__ or ""))

# An upload against a client that refuses everything yields files=[] and one
# error each -- never an exception the caller has to guard.
fake = _FakeClient(fail={"a.txt", "b.txt"})
res = _with_fake_client(fake, lambda: dd.upload_files(
    [("a.txt", b"1"), ("b.txt", b"2")]))
check("all-files-failed still returns a result, not an exception",
      res["files"] == [] and len(res["errors"]) == 2, repr(res))

print()
if FAILS:
    print("%d FAILURE(S): %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all checks passed")
