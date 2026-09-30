# The mute ledger: the exact mute_until is kept, and a muted account is not preferred.
#
# Why. Two defects shared one missing piece of state.
#
#   1. `_mute_verdict_in` already parsed `mute_until` as a FLOAT and then formatted
#      it to a minute before returning, so the only second-precision record of when
#      a penalty was imposed was destroyed at the moment it existed. Every
#      post-mortem on this machine could place an issue instant no more precisely
#      than the minute.
#   2. `_account_order` was a pure ring with no notion of account health, so an
#      account DeepSeek had refused until Friday was still handed the next brand-new
#      conversation. Each such turn spent a request, a round trip, and a retry ladder
#      to rediscover a verdict already in hand.
#
# The ledger records the float and deprioritises muted accounts. It deliberately
# does NOT remove them: if the whole pool is muted the caller must still get the
# real verdict rather than "no accounts configured", and an expired entry must come
# back on its own.
#
# Run:  .venv\Scripts\python.exe test_ds_direct_mute_ledger.py
import json
import os
import sys
import tempfile
import time

# Isolate persisted state BEFORE importing ds_direct: the module resolves its state
# paths at import time, and the ledger writes a file. Without this the suite would
# write into the REAL state directory and leave fabricated mute expiries behind,
# which a later production run would then read as accounts that are still muted.
_STATE = tempfile.mkdtemp(prefix="ds-muteledger-test-")
os.environ["KILN_STATE_DIR"] = _STATE

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


def reset_ledger():
    """Clear the in-memory ledger and the file, so each case starts clean."""
    with ds._mute_lock:
        ds._muted_until.clear()
    ds._save_muted()


NOW = time.time()
FUTURE = NOW + 72 * 3600          # a live mute
PAST = NOW - 60                   # one that already lapsed


# ── 1. the exact float survives, at second precision ──────────────────────────
print("=== 1. the exact mute_until is recovered, not the formatted minute ===")
EXACT = 1790972380.757            # the sample the module's own docstring cites
ENVELOPE = {
    "code": 0, "msg": "",
    "data": {"biz_code": 14, "biz_msg": "user is muted",
             "biz_data": {"is_muted": 1, "mute_until": EXACT}},
}
got = ds._mute_until_of(ENVELOPE)
check("_mute_until_of returns the raw float", got == EXACT, "got %r" % (got,))

raw = ['data: ' + json.dumps(ENVELOPE)]
got_in = ds._mute_until_in(raw)
check("_mute_until_in returns the raw float from a raw body", got_in == EXACT,
      "got %r" % (got_in,))

# The whole point: second precision that the string form loses.
msg = ds._mute_verdict_in(raw)
check("the message form is still the minute-rounded string",
      msg is not None and "until" in msg, "got %r" % (msg,))
check("the float is NOT recoverable from that string (the defect)",
      str(EXACT) not in str(msg))

check("_mute_of still returns a message, unchanged",
      isinstance(ds._mute_of(ENVELOPE), str))

# false positives
check("a non-mute envelope yields None",
      ds._mute_until_of({"code": 0, "msg": "", "data": {"biz_code": 0}}) is None)
check("a model's prose about being muted is not an envelope",
      ds._mute_until_of({"text": "the account is muted"}) is None)
check("bool is rejected as a timestamp",
      ds._mute_until_of({"code": 0, "msg": "",
                         "data": {"biz_code": 5, "biz_msg": "user is muted",
                                  "biz_data": {"is_muted": 1, "mute_until": True}}}) is None)
check("a zero/negative mute_until is rejected",
      ds._mute_until_of({"code": 0, "msg": "",
                         "data": {"biz_code": 5, "biz_msg": "user is muted",
                                  "biz_data": {"is_muted": 1, "mute_until": 0}}}) is None)


# ── 2. the ledger records, persists, and expires ──────────────────────────────
print()
print("=== 2. the ledger records, persists, and expires ===")
reset_ledger()
ds._note_mute("a@x.com", FUTURE)
check("a live mute is reported as muted", ds._muted_now("a@x.com") is True)
check("an account never seen is not muted", ds._muted_now("b@x.com") is False)

# persisted?
p = ds._MUTE_STATE_FILE
check("the ledger file was written", os.path.exists(p), p)
if os.path.exists(p):
    with open(p, encoding="utf-8") as f:
        doc = json.load(f)
    check("the file holds the account", "a@x.com" in doc)
    check("the file holds the exact float, not a rounded string",
          isinstance(doc.get("a@x.com"), float) and abs(doc["a@x.com"] - FUTURE) < 1e-6,
          "got %r" % (doc.get("a@x.com"),))

# a fresh process must see it -- that is why it is persisted at all
reloaded = ds._load_muted()
check("a reload sees the mute", reloaded.get("a@x.com") is not None)
check("the reloaded value is exact",
      abs(reloaded["a@x.com"] - FUTURE) < 1e-6)

# expiry comes back on its own
ds._note_mute("old@x.com", PAST)
check("an already-expired mute is not muted", ds._muted_now("old@x.com") is False)
check("an expired entry is pruned from memory", "old@x.com" not in ds._muted_until)

# keep the later expiry
reset_ledger()
ds._note_mute("c@x.com", NOW + 3600)
ds._note_mute("c@x.com", NOW + 7200)
check("the LATER expiry is kept", abs(ds._muted_until["c@x.com"] - (NOW + 7200)) < 1
      if "c@x.com" in ds._muted_until else False)
ds._note_mute("c@x.com", NOW + 1800)
check("a shorter expiry does not shorten the recorded one",
      abs(ds._muted_until["c@x.com"] - (NOW + 7200)) < 1
      if "c@x.com" in ds._muted_until else False)

# bad inputs never raise
reset_ledger()
for bad in (None, "", "not-a-number", 0, -5, True):
    try:
        ds._note_mute("d@x.com", bad)
    except Exception as e:  # noqa: BLE001
        check("_note_mute(%r) does not raise" % (bad,), False, repr(e))
        break
else:
    check("_note_mute tolerates junk without raising", True)
check("junk never recorded a mute", ds._muted_now("d@x.com") is False)
ds._note_mute(None, FUTURE)
check("a missing account id records nothing", len(ds._muted_until) == 0)


# ── 3. selection deprioritises muted accounts ─────────────────────────────────
print()
print("=== 3. _account_order deprioritises muted accounts ===")
reset_ledger()


class FakeAcct:
    def __init__(self, i):
        self.id = i
        self.token = "t"
        self.disabled = False


REAL_ACCOUNTS = ds._accounts
REAL_SESSIONS = ds._sessions
try:
    ds._accounts = [FakeAcct("m1@x.com"), FakeAcct("ok1@x.com"),
                    FakeAcct("m2@x.com"), FakeAcct("ok2@x.com")]
    ds._sessions = {}
    ds._note_mute("m1@x.com", FUTURE)
    ds._note_mute("m2@x.com", FUTURE)

    order = ds._account_order("some-brand-new-conversation")
    check("every account is still returned (none removed)", sorted(order) ==
          sorted(["m1@x.com", "ok1@x.com", "m2@x.com", "ok2@x.com"]),
          "got %r" % (order,))
    check("the first pick is NOT muted", order[0] in ("ok1@x.com", "ok2@x.com"),
          "got %r" % (order,))
    check("both muted accounts sort LAST",
          set(order[-2:]) == {"m1@x.com", "m2@x.com"}, "got %r" % (order,))
    check("healthy accounts come first",
          set(order[:2]) == {"ok1@x.com", "ok2@x.com"}, "got %r" % (order,))

    # a pin is an explicit instruction and must be honoured, mute or not
    pinned = ds._account_order("another-conversation", pinned="m1@x.com")
    check("a pinned muted account is still FIRST", pinned[0] == "m1@x.com",
          "got %r" % (pinned,))
    check("a pinned account is not duplicated",
          len(pinned) == len(set(pinned)), "got %r" % (pinned,))

    # if EVERYTHING is muted the pool still serves one, so the caller gets the
    # real verdict instead of a confusing "no accounts configured"
    reset_ledger()
    for a in ds._accounts:
        ds._note_mute(a.id, FUTURE)
    allmuted = ds._account_order("third-conversation")
    check("an all-muted pool still returns every account",
          len(allmuted) == 4, "got %r" % (allmuted,))
    check("an all-muted pool still picks something (real verdict > empty error)",
          allmuted and allmuted[0] is not None, "got %r" % (allmuted,))

    # An expired mute must be indistinguishable from no mute at all. Two traps
    # here, both of which caught an earlier version of this check:
    #
    #   * selection is round-robin, so which account leads depends on `_rr_index`,
    #     not on health -- comparing two calls without freezing it compares ring
    #     state and proves nothing;
    #   * the ring advances only when a conversation has no sticky account, which
    #     is exactly this case, so the index moves on every single call.
    #
    # Freezing `_rr_index` before each call makes the two orders comparable, and
    # the property then asserted is the one that matters: an expired entry changes
    # NOTHING.
    real_rr = ds._rr_index
    try:
        reset_ledger()
        ds._rr_index = 0
        control = ds._account_order("fifth-conversation")

        reset_ledger()
        ds._note_mute("m1@x.com", PAST)
        ds._rr_index = 0
        with_expired = ds._account_order("fifth-conversation")

        check("an expired mute changes the order not at all",
              with_expired == control,
              "control=%r expired=%r" % (control, with_expired))
        check("an expired account is not benched to the end",
              with_expired.index("m1@x.com") == control.index("m1@x.com"),
              "control=%r expired=%r" % (control, with_expired))
    finally:
        ds._rr_index = real_rr
finally:
    ds._accounts = REAL_ACCOUNTS
    ds._sessions = REAL_SESSIONS
    reset_ledger()


# ── 4. every raise site actually records ──────────────────────────────────────
print()
print("=== 4. each _Muted raise site records the float ===")
src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "ds_direct.py"),
           encoding="utf-8").read()
n_calls = src.count("_note_mute(")
# 1 definition + 1 docstring mention is not a call; count call sites precisely
call_sites = [ln for ln in src.splitlines()
              if "_note_mute(" in ln and not ln.strip().startswith("#")
              and "def _note_mute" not in ln]
check("there are 4 recording call sites (4 envelope-bearing raise sites)",
      len(call_sites) == 4, "found %d: %r" % (len(call_sites), call_sites))
check("the float is read at those sites",
      src.count("_mute_until_of(payload)") == 2 and
      src.count("_mute_until_in(raw_sink)") == 2,
      "_mute_until_of=%d _mute_until_in=%d"
      % (src.count("_mute_until_of(payload)"), src.count("_mute_until_in(raw_sink)")))
check("the wording-only site is documented as having no float",
      "no\n                # `mute_until` to record" in src)


print()
passed = sum(1 for _, ok in CHECKS if ok)
failed = len(CHECKS) - passed
print("=" * 60)
print("mute-ledger: %d checks, %d passed, %d failed" % (len(CHECKS), passed, failed))
if failed:
    print()
    print("FAILED:")
    for name, ok in CHECKS:
        if not ok:
            print("   -", name)
sys.exit(1 if failed else 0)
