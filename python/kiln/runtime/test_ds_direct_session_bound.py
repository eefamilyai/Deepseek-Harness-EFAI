# ds_sessions.json must not grow without bound.
#
# Why. The file reached 46.69 MB for 195 entries, and `last_prompt` was 43.46 MB
# of it -- median 176 KB, max ~1 MB per entry -- with the whole file rewritten
# atomically on every turn. Two growth axes needed bounding: the size of each
# stored prompt, and the number of entries that keep one.
#
# What must NOT change. `last_prompt` has exactly one reader, `_turn_usage`,
# which uses it for `_common_prefix_len(prev_prompt, prompt)`. That is bounded by
# `min(len(a), len(b))`, so a stored PREFIX is exactly equivalent up to the cap.
# The mapping fields -- sid, parent, sent, account -- are what actually resume a
# DeepSeek chat, and this must never touch them.
#
# Run:  .venv\Scripts\python.exe test_ds_direct_session_bound.py
import os
import sys
import tempfile
import time

os.environ["KILN_STATE_DIR"] = tempfile.mkdtemp(prefix="ds-sessbound-test-")

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    ok = bool(cond)
    CHECKS.append((name, ok))
    line = "  %-4s %s" % ("PASS" if ok else "FAIL", name)
    if detail and not ok:
        line += "  -- " + detail
    print(line)


CAP = ds._LAST_PROMPT_CAP
KEEP = ds._LAST_PROMPT_KEEP
print("cap=%d chars, keep=%d entries" % (CAP, KEEP))


def reset(sessions):
    ds._sessions.clear()
    ds._sessions.update(sessions)


# ── 1. the per-entry cap ──────────────────────────────────────────────────────
print()
print("=== 1. a huge prompt is stored as a bounded prefix ===")
BIG = "x" * (CAP * 3)
reset({"k1": {"sid": "s1", "parent": 1, "sent": 5, "account": "a@x",
              "last_prompt": BIG, "_seen": time.time()}})
ds._save_sessions()
st = ds._sessions["k1"]
check("the stored prompt is capped", len(st["last_prompt"]) == CAP,
      "len=%d" % len(st["last_prompt"]))
check("it is a PREFIX of the original", BIG.startswith(st["last_prompt"]))
check("the cap is well below the original", len(st["last_prompt"]) < len(BIG))

print()
print("=== 2. a normal prompt is stored unchanged ===")
SMALL = "y" * 5000
reset({"k2": {"sid": "s2", "parent": 2, "sent": 3, "account": "a@x",
              "last_prompt": SMALL, "_seen": time.time()}})
ds._save_sessions()
check("a small prompt is stored in full",
      ds._sessions["k2"]["last_prompt"] == SMALL)


# ── 3. the mapping fields survive ────────────────────────────────────────────
print()
print("=== 3. the fields that resume a chat are NEVER touched ===")
reset({"k3": {"sid": "SID-3", "parent": 77, "sent": 9, "account": "acct@x",
              "last_prompt": "z" * (CAP * 2), "_seen": time.time()}})
ds._save_sessions()
st = ds._sessions["k3"]
check("sid preserved", st["sid"] == "SID-3")
check("parent preserved", st["parent"] == 77)
check("sent preserved", st["sent"] == 9)
check("account preserved", st["account"] == "acct@x")


# ── 4. retention: old entries lose the prompt, recent ones keep it ──────────
print()
print("=== 4. only the most recently used entries retain a prompt ===")
now = time.time()
many = {}
for i in range(KEEP + 25):
    many["s%03d" % i] = {
        "sid": "sid-%03d" % i, "parent": i, "sent": 1, "account": "a@x",
        "last_prompt": ("p%d" % i) + "q" * 2000,
        # s000 is the OLDEST, s(KEEP+24) the NEWEST
        "_seen": now - (KEEP + 25 - i),
    }
reset(many)
ds._save_sessions()

with_prompt = [k for k, v in ds._sessions.items() if "last_prompt" in v]
check("exactly KEEP entries keep a prompt", len(with_prompt) == KEEP,
      "kept %d" % len(with_prompt))

newest = "s%03d" % (KEEP + 24)
oldest = "s000"
check("the newest entry kept its prompt", "last_prompt" in ds._sessions[newest])
check("the oldest entry lost its prompt", "last_prompt" not in ds._sessions[oldest])
check("every entry STILL EXISTS (none deleted)",
      len(ds._sessions) == KEEP + 25, "n=%d" % len(ds._sessions))
check("a pruned entry kept its sid",
      ds._sessions[oldest].get("sid") == "sid-000")

# the retained set is the KEEP most recent
kept_sorted = sorted(with_prompt)
expected = sorted("s%03d" % i for i in range(25, KEEP + 25))
check("the retained set is exactly the KEEP newest", kept_sorted == expected,
      "got %s" % kept_sorted[:3])


# ── 5. self-healing: a pruned entry re-stores on its next turn ──────────────
print()
print("=== 5. pruning is self-healing, not lossy ===")
reset({"k9": {"sid": "S9", "parent": 1, "sent": 1, "account": "a@x",
              "_seen": now}})
ds._save_sessions()
check("an entry with no prompt stays absent",
      "last_prompt" not in ds._sessions["k9"])
# simulate the next turn's write
ds._sessions["k9"]["last_prompt"] = "refreshed" * 100
ds._sessions["k9"]["_seen"] = time.time()
ds._save_sessions()
check("the next turn restores it",
      ds._sessions["k9"].get("last_prompt", "").startswith("refreshed"))


# ── 6. _turn_usage still works against a truncated previous prompt ──────────
print()
print("=== 6. _turn_usage still consumes a capped prefix ===")
prev = "A" * 10000
cur = prev + "B" * 500
u = ds._turn_usage(prev[:CAP], cur, "out", "think")
check("usage returns the expected keys",
      set(u) == {"input", "cache_read", "output", "reasoning"}, repr(u))
check("all values are ints", all(isinstance(v, int) for v in u.values()), repr(u))
check("a large common prefix yields a cache read", u["cache_read"] > 0, repr(u))

u_none = ds._turn_usage(None, cur, "out", "think")
check("None previous prompt is handled", u_none["cache_read"] == 0, repr(u_none))


# ── 7. the file on disk actually stays small ────────────────────────────────
print()
print("=== 7. the written file is bounded ===")
reset({})
big = {}
for i in range(120):
    big["big%03d" % i] = {
        "sid": "s%d" % i, "parent": i, "sent": 1, "account": "a@x",
        "last_prompt": "Z" * (CAP * 2),
        "_seen": now - (120 - i),
    }
reset(big)
ds._save_sessions()
size = os.path.getsize(ds._SESS_FILE)
# 120 entries x 2x cap stored raw would be ~63 MB; bounded it is ~KEEP x cap
bound = KEEP * CAP * 4 + 200000
check("the file is far below the unbounded size", size < bound,
      "size=%d bound=%d" % (size, bound))
check("no entry exceeds the cap",
      all(len(v.get("last_prompt", "")) <= CAP for v in ds._sessions.values()))


print()
passed = sum(1 for _, ok in CHECKS if ok)
failed = len(CHECKS) - passed
print("=" * 62)
print("session bound: %d checks, %d passed, %d failed" % (len(CHECKS), passed, failed))
if failed:
    print()
    print("FAILED:")
    for name, ok in CHECKS:
        if not ok:
            print("   -", name)
sys.exit(1 if failed else 0)
