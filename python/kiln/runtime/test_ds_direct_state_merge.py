# Cross-process state merging: a second process must not erase the first's entries.
#
# Why. Both `ds_last_turn.json` and `ds_muted.json` are written by a process that
# loaded the file ONCE at import and then dumps its WHOLE in-memory dict. Two
# processes sharing a state directory therefore clobber each other: the last
# writer's view wins, and every account the other process added after that import
# is erased.
#
# This was observed, not theorised. The t1 and t2 soaks both run without
# KILN_STATE_DIR, so both write `runtime/ds_last_turn.json`. t2 vanished from that
# file while its own soak was still making requests -- t1's process had imported
# earlier and kept writing a dict that never contained t2.
#
# The cost is real for both files:
#   * `_resume_hygiene` reads `prev` and returns immediately when it is None, so
#     an erased account gets NO stale-cookie drop after an overnight gap -- the
#     exact case the persistence exists for;
#   * the mute ledger forgets a benched account, so the pool hands it the next new
#     conversation.
#
# Run:  .venv\Scripts\python.exe test_ds_direct_state_merge.py
import os
import sys
import tempfile
import time

os.environ["KILN_STATE_DIR"] = tempfile.mkdtemp(prefix="ds-statetmerge-test-")

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


NOW = time.time()

# ── 1. ds_last_turn: the observed clobber ─────────────────────────────────────
print("=== 1. ds_last_turn.json survives a second process ===")
ds._atomic_json(ds._LAST_TURN_FILE, {"a@x.com": NOW - 100})
# A fresh process would load what is on disk; this one's memory holds only its own.
ds._last_turn_at.clear()
ds._last_turn_at["b@x.com"] = NOW
ds._save_last_turn()
disk = ds._load_last_turn()
check("the other process's account survives", "a@x.com" in disk, repr(disk))
check("this process's account is written", "b@x.com" in disk, repr(disk))
check("both are present", set(disk) == {"a@x.com", "b@x.com"}, repr(disk))

# the later stamp wins for one account
ds._atomic_json(ds._LAST_TURN_FILE, {"c@x.com": NOW - 500})
ds._last_turn_at.clear()
ds._last_turn_at["c@x.com"] = NOW
ds._save_last_turn()
disk = ds._load_last_turn()
check("the later stamp wins", abs(disk.get("c@x.com", 0) - NOW) < 1, repr(disk))

ds._atomic_json(ds._LAST_TURN_FILE, {"d@x.com": NOW})
ds._last_turn_at.clear()
ds._last_turn_at["d@x.com"] = NOW - 500
ds._save_last_turn()
disk = ds._load_last_turn()
check("an older in-memory stamp does not overwrite a newer one",
      abs(disk.get("d@x.com", 0) - NOW) < 1, repr(disk))

# ── 2. the mute ledger: the same clobber ──────────────────────────────────────
print()
print("=== 2. ds_muted.json survives a second process ===")
with ds._mute_lock:
    ds._muted_until.clear()
ds._atomic_json(ds._MUTE_STATE_FILE, {"m1@x.com": NOW + 72 * 3600})
with ds._mute_lock:
    ds._muted_until.clear()
    ds._muted_until["m2@x.com"] = NOW + 72 * 3600
ds._save_muted()
disk = ds._load_muted()
check("the other process's mute survives", "m1@x.com" in disk, repr(disk))
check("this process's mute is written", "m2@x.com" in disk, repr(disk))
check("both mutes are present", set(disk) == {"m1@x.com", "m2@x.com"}, repr(disk))

# the later expiry wins
ds._atomic_json(ds._MUTE_STATE_FILE, {"m3@x.com": NOW + 3600})
with ds._mute_lock:
    ds._muted_until.clear()
    ds._muted_until["m3@x.com"] = NOW + 7200
ds._save_muted()
check("the later expiry wins",
      abs(ds._load_muted().get("m3@x.com", 0) - (NOW + 7200)) < 1)

ds._atomic_json(ds._MUTE_STATE_FILE, {"m4@x.com": NOW + 7200})
with ds._mute_lock:
    ds._muted_until.clear()
    ds._muted_until["m4@x.com"] = NOW + 3600
ds._save_muted()
check("a shorter expiry does not shorten the recorded one",
      abs(ds._load_muted().get("m4@x.com", 0) - (NOW + 7200)) < 1)

# ── 3. robustness ─────────────────────────────────────────────────────────────
print()
print("=== 3. robustness ===")
with open(ds._LAST_TURN_FILE, "w", encoding="utf-8") as f:
    f.write("{not json")
ds._last_turn_at.clear()
ds._last_turn_at["e@x.com"] = NOW
try:
    ds._save_last_turn()
    check("a corrupt file does not raise", True)
except Exception as e:  # noqa: BLE001
    check("a corrupt file does not raise", False, repr(e))
check("the in-memory value still reached disk",
      "e@x.com" in ds._load_last_turn())

with open(ds._MUTE_STATE_FILE, "w", encoding="utf-8") as f:
    f.write("{not json")
with ds._mute_lock:
    ds._muted_until.clear()
    ds._muted_until["m5@x.com"] = NOW + 3600
try:
    ds._save_muted()
    check("a corrupt mute file does not raise", True)
except Exception as e:  # noqa: BLE001
    check("a corrupt mute file does not raise", False, repr(e))
check("the in-memory mute still reached disk",
      "m5@x.com" in ds._load_muted())


print()
passed = sum(1 for _, ok in CHECKS if ok)
failed = len(CHECKS) - passed
print("=" * 60)
print("state merge: %d checks, %d passed, %d failed" % (len(CHECKS), passed, failed))
if failed:
    print()
    print("FAILED:")
    for name, ok in CHECKS:
        if not ok:
            print("   -", name)
sys.exit(1 if failed else 0)
