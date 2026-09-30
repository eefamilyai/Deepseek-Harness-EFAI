# End-to-end: does a REAL mute body reaching ds_direct actually write a verdict
# line WITH its preamble into the journal?
#
# WHY THIS IS THE GAP. `test_ds_wirelog.py` proves `ds_wirelog.verdict()` writes
# the artifact when CALLED. It does not prove the call site is reached when a mute
# actually arrives. Those are different claims: the whole value of this instrument
# is that the four `_Muted` raise sites call it, and a wiring mistake there would
# leave the journal silent exactly when it matters -- after a mute, when the
# operator wants the preamble and cannot re-run the experiment.
#
# This drives the real `_mute_verdict_in` reader over a real mute envelope and
# then exercises the stream site's verdict call, using a duck-typed client so no
# network and no account is touched.
#
# Run from this directory:
#     .venv\Scripts\python.exe test_ds_wirelog_integration.py
import json
import os
import shutil
import sys
import tempfile

# Isolate persisted state BEFORE importing ds_direct -- the module resolves its
# state paths at import time.
os.environ["KILN_STATE_DIR"] = tempfile.mkdtemp(prefix="ds-wirelog-int-")
os.environ["KILN_DS_WIRELOG"] = "1"

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402
import ds_wirelog as wl  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print("  %s %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  -- " + str(detail)) if detail and not cond else ""))


# The exact envelope DeepSeek sends for a mute, taken from the live sample.
MUTE_BODY = json.dumps({
    "code": 0, "msg": "",
    "data": {
        "biz_code": 5, "biz_msg": "user is muted",
        "biz_data": {"is_muted": 1, "mute_until": 1790932407.459},
    },
})


def main():
    wl._ON = None
    wl._RING[:] = []

    print("the real reader classifies the real body")
    # This is the function every stream site calls; if it stopped recognising the
    # envelope, the verdict call would never be reached.
    muted = ds._mute_verdict_in(["data: " + MUTE_BODY])
    check("_mute_verdict_in recognises the mute envelope", bool(muted), muted)
    check("and names the expiry", muted and "muted" in muted.lower(), muted)

    print()
    print("the stream site's verdict call writes a preamble artifact")
    # Simulate what the stream site does: a few requests go out first, then the
    # verdict is recorded. That ordering IS the point of the module.
    wl._RING[:] = []
    for i in range(3):
        wl.record("request", account="v@test", seq=i,
                  method="POST", path="chat.deepseek.com/api/v0/chat/completion")
    # The exact call the _Muted site makes (ds_direct.py, stream path).
    wl.verdict("mute", muted, account="v@test")

    path = wl.path()
    check("journal file exists after the verdict", os.path.exists(path), path)
    lines = []
    with open(path, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if line:
                lines.append(json.loads(line))
    check("a verdict line was written", any(l.get("kind") == "verdict" for l in lines))
    v = [l for l in lines if l.get("kind") == "verdict"]
    if v:
        v = v[-1]
        check("verdict records the kind", v.get("verdict") == "mute", v.get("verdict"))
        check("verdict carries the 3-request preamble",
              len(v.get("preamble", [])) == 3,
              "preamble=%d" % len(v.get("preamble", [])))
        check("preamble entries are the requests",
              all(p.get("kind") == "request" for p in v.get("preamble", [])))
        check("verdict is attributed to the account", v.get("account") == "v@test")

    print()
    print("EVERY mute site is wired, not just the stream one")
    # Each place ds_direct raises _Muted must also call ds_wirelog.verdict, or the
    # journal stays silent for mutes arriving on that route -- and a silent journal
    # is the one failure that cannot be recovered after the fact, because the
    # preamble only exists if it was written at the moment the verdict landed.
    #
    # FIVE sites, not four. The four original routes are pow, upload, stream and
    # vision; the fifth is the `event: hint` path added later, where a mute arrives
    # as a server_error instead of an empty body. This check counted four and
    # failed when that fifth was added -- which is the check doing its job: it is
    # what noticed the new site needed wiring too.
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "ds_direct.py"), encoding="utf-8").read()
    n_verdict = src.count('ds_wirelog.verdict("mute"')
    n_raised = src.count("raise _Muted")
    check("five mute sites call ds_wirelog.verdict", n_verdict == 5,
          "found %d" % n_verdict)
    # The two counts must agree: every _Muted raise accompanied by a verdict call.
    # This is the invariant that actually matters -- a new raise site without a
    # verdict call is the defect this check exists to catch.
    check("every _Muted raise site is accompanied by a verdict call",
          n_verdict == n_raised,
          "%d verdict calls vs %d raises" % (n_verdict, n_raised))
    n_install = src.count("ds_wirelog.install(")
    check("the journal is installed once at construction", n_install == 1,
          "found %d" % n_install)

    print()
    print("a non-mute body does NOT produce a verdict")
    wl._RING[:] = []
    before = len([l for l in open(path, encoding="utf-8") if '"kind": "verdict"' in l])
    benign = json.dumps({"code": 0, "msg": "",
                         "data": {"biz_code": 0, "biz_msg": "", "biz_data": None}})
    check("a benign envelope is not read as a mute",
          not ds._mute_verdict_in(["data: " + benign]))
    after = len([l for l in open(path, encoding="utf-8") if '"kind": "verdict"' in l])
    check("and no verdict line was appended", before == after,
          "%d -> %d" % (before, after))

    failed = [c for c in CHECKS if not c[1]]
    print("\n%d check(s), %d failed" % (len(CHECKS), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    finally:
        shutil.rmtree(os.environ.get("KILN_STATE_DIR", ""), ignore_errors=True)
        os.environ.pop("KILN_DS_WIRELOG", None)
        os.environ.pop("KILN_STATE_DIR", None)
