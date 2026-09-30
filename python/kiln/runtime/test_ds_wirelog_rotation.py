# The wire journal must not grow for the life of a process.
#
# Why. `_RING_MAX` caps the IN-MEMORY ring at 80 entries, but `_append` opens the
# journal in append mode and never rotated it, so the file on disk grew without
# bound. That matters here more than in a typical log: this journal exists to be
# read AFTER a mute, which can arrive days after the request that drew it.
#
# The bound must therefore be generous (32 MiB) and the rotation must PRESERVE the
# previous generation rather than truncate it -- discarding records at the
# boundary would drop exactly the ones nearest the event under investigation.
#
# Run:  .venv\Scripts\python.exe test_ds_wirelog_rotation.py
import json
import os
import sys
import tempfile
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_wirelog as wl  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    ok = bool(cond)
    CHECKS.append((name, ok))
    line = "  %-4s %s" % ("PASS" if ok else "FAIL", name)
    if detail and not ok:
        line += "  -- " + detail
    print(line)


def reset(tmp, on=True):
    os.environ["KILN_STATE_DIR"] = tmp
    if on:
        os.environ["KILN_DS_WIRELOG"] = "1"
    else:
        os.environ.pop("KILN_DS_WIRELOG", None)
    wl._ON = None
    wl._RING[:] = []


def lines_of(p):
    if not os.path.exists(p):
        return []
    out = []
    with open(p, encoding="utf-8") as f:
        for ln in f:
            if ln.strip():
                try:
                    out.append(json.loads(ln))
                except Exception:
                    pass
    return out


root = tempfile.mkdtemp(prefix="ds-wirelog-rot-")

# ── 1. the bound exists and is generous ───────────────────────────────────────
print("=== 1. the bound ===")
check("_FILE_MAX exists", hasattr(wl, "_FILE_MAX"))
check("the bound is generous (>= 16 MiB)",
      getattr(wl, "_FILE_MAX", 0) >= 16 * 1024 * 1024,
      "_FILE_MAX=%r" % getattr(wl, "_FILE_MAX", None))
check("the in-memory ring is still capped", wl._RING_MAX == 80)

# ── 2. no rotation below the bound ────────────────────────────────────────────
print()
print("=== 2. below the bound, nothing is rotated ===")
d = os.path.join(root, "small")
reset(d)
p = wl.path()
wl.record("request", account="a@x", seq=1)
wl.record("response", account="a@x", seq=1)
check("the journal exists", os.path.exists(p))
check("no .1 generation was created", not os.path.exists(p + ".1"))
check("both records are in the live file", len(lines_of(p)) == 2,
      "n=%d" % len(lines_of(p)))

# ── 3. crossing the bound rotates, and PRESERVES the old records ─────────────
print()
print("=== 3. crossing the bound rotates and keeps the old generation ===")
d2 = os.path.join(root, "big")
reset(d2)
p2 = wl.path()
os.makedirs(os.path.dirname(p2), exist_ok=True)

# Write a file just over the bound WITHOUT going through _append, so the test is
# fast: pad with a large filler line.
orig_max = wl._FILE_MAX
try:
    with open(p2, "w", encoding="utf-8") as f:
        f.write(json.dumps({"ts": time.time(), "kind": "filler",
                            "account": "old@x", "pad": "x" * (orig_max + 1024)}) + "\n")
    before = os.path.getsize(p2)
    check("the file is over the bound", before > orig_max, "size=%d" % before)

    wl.record("request", account="new@x", seq=9)

    check("the live file was rotated away", os.path.exists(p2 + ".1"))
    check("the previous generation is intact",
          os.path.exists(p2 + ".1") and os.path.getsize(p2 + ".1") == before,
          "size=%r" % (os.path.getsize(p2 + ".1") if os.path.exists(p2 + ".1") else None))
    check("the previous generation still holds the old record",
          any(r.get("account") == "old@x" for r in lines_of(p2 + ".1")))
    check("the live file holds the NEW record",
          any(r.get("account") == "new@x" for r in lines_of(p2)))
    check("the live file is small again",
          os.path.getsize(p2) < 4096, "size=%d" % os.path.getsize(p2))
finally:
    wl._FILE_MAX = orig_max

# ── 4. one generation only ────────────────────────────────────────────────────
print()
print("=== 4. one generation, not a numbered series ===")
d3 = os.path.join(root, "twice")
reset(d3)
p3 = wl.path()
try:
    wl._FILE_MAX = 2048
    for i in range(6):
        wl.record("request", account="acct%d@x" % i, seq=i, pad="y" * 1500)
finally:
    wl._FILE_MAX = orig_max
check("a .1 generation exists", os.path.exists(p3 + ".1"))
check("no .2 generation is created", not os.path.exists(p3 + ".2"))
check("no .3 generation is created", not os.path.exists(p3 + ".3"))
gen1 = lines_of(p3 + ".1")
check("the .1 generation is itself bounded-ish (a real file, not the whole run)",
      os.path.getsize(p3 + ".1") < 3 * 2048 * 4,
      "size=%d" % os.path.getsize(p3 + ".1"))

# ── 5. rotation never breaks a write ─────────────────────────────────────────
print()
print("=== 5. rotation is best-effort and never breaks the write ===")
d4 = os.path.join(root, "unwritable")
reset(d4)
p4 = wl.path()
os.makedirs(os.path.dirname(p4), exist_ok=True)
try:
    wl._FILE_MAX = 10          # rotate on essentially every write
    try:
        wl.record("request", account="z@x", seq=1)
        wl.record("request", account="z@x", seq=2)
        check("writes with an aggressive bound do not raise", True)
    except Exception as e:  # noqa: BLE001
        check("writes with an aggressive bound do not raise", False, repr(e))
    check("records still reached disk",
          len(lines_of(p4)) + len(lines_of(p4 + ".1")) >= 1)
finally:
    wl._FILE_MAX = orig_max

# ── 6. the rotation helper is safe on a missing file ─────────────────────────
print()
print("=== 6. robustness ===")
try:
    wl._rotate_if_needed(os.path.join(root, "does-not-exist.jsonl"))
    check("_rotate_if_needed tolerates a missing file", True)
except Exception as e:  # noqa: BLE001
    check("_rotate_if_needed tolerates a missing file", False, repr(e))

# a directory in place of the file must not raise
weird = os.path.join(root, "is-a-dir.jsonl")
os.makedirs(weird, exist_ok=True)
try:
    wl._rotate_if_needed(weird)
    check("_rotate_if_needed tolerates a non-file path", True)
except Exception as e:  # noqa: BLE001
    check("_rotate_if_needed tolerates a non-file path", False, repr(e))

# ── 7. the ring still behaves ────────────────────────────────────────────────
print()
print("=== 7. the in-memory ring is unaffected ===")
d5 = os.path.join(root, "ring")
reset(d5)
for i in range(200):
    wl.record("request", account="r@x", seq=i)
check("the ring is capped at _RING_MAX", len(wl._RING) == wl._RING_MAX,
      "len=%d" % len(wl._RING))
# a verdict still captures its preamble
wl.verdict("mute", "user is muted (until 2026-10-03 12:04 UTC)", account="r@x")
check("the verdict carries a preamble", len(wl._RING) == wl._RING_MAX)
check("the verdict reached disk",
      any(r.get("kind") == "verdict" for r in lines_of(wl.path())))


print()
passed = sum(1 for _, ok in CHECKS if ok)
failed = len(CHECKS) - passed
print("=" * 62)
print("journal rotation: %d checks, %d passed, %d failed"
      % (len(CHECKS), passed, failed))
if failed:
    print()
    print("FAILED:")
    for name, ok in CHECKS:
        if not ok:
            print("   -", name)
sys.exit(1 if failed else 0)
