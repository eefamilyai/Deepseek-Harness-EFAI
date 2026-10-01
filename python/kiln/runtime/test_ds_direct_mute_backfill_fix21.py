"""FIX 21: the backfill must not expire a live mute early.

The verdict TEXT formats `mute_until` with `strftime("%Y-%m-%d %H:%M UTC")`,
which drops the seconds. `backfill_muted_from_wirelog` parsed that text and
floored to `:00`, so a recovered expiry could land up to 59 s BEFORE the true
one. Measured on t2: the wire carried 20:53:17.878 and the text rendered
"20:53" -- 17.878 s of truncation, real and observed.

An expiry that is early is not a cosmetic error. `_muted_now` prunes the entry
the moment `until <= now`, and the pool then hands that account a request while
the server still considers it muted -- exactly the escalation class FIX 17
exists to prevent (jw1 went 72 h to 216 h by being retried through a mute).

The recovery is therefore an UPPER BOUND, never a precise figure: round up by
the full minute. Benching an account seconds too long costs one wasted slot;
benching it seconds too short costs an escalation.
"""
import calendar
import importlib.util
import json
import os
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _HERE)

_FAILS = []


def check(name, cond):
    print("%s  %s" % ("PASS" if cond else "FAIL", name))
    if not cond:
        _FAILS.append(name)


def _verdict_line(acct, detail, ts=1790786772.92):
    return json.dumps({"ts": ts, "kind": "verdict", "verdict": "mute",
                       "detail": detail, "account": acct}) + "\n"


def _fresh_module(state_dir):
    """Import ds_direct with its own state dir so nothing real is touched."""
    os.environ["KILN_STATE_DIR"] = state_dir
    for mod in ("ds_direct", "ds_wirelog"):
        sys.modules.pop(mod, None)
    spec = importlib.util.spec_from_file_location(
        "ds_direct", os.path.join(_HERE, "ds_direct.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ds_direct"] = mod
    spec.loader.exec_module(mod)
    return mod


def main():
    detail = "user is muted (until 2026-10-03 20:53 UTC)"

    with tempfile.TemporaryDirectory() as td:
        journal = os.path.join(td, "ds_wirelog.jsonl")
        with open(journal, "w", encoding="utf-8") as fh:
            fh.write(_verdict_line("a@x.com", detail))

        ds = _fresh_module(td)
        got = ds._muted_until.get("a@x.com")
        floored = calendar.timegm((2026, 10, 3, 20, 53, 0, 0, 0, 0))

        check("backfill recorded the account at all", got is not None)
        check("recovered expiry is NOT the floor (FIX 21)",
              got is not None and got != floored)
        check("recovered expiry is the floor + 60 s (upper bound)",
              got == floored + 60)
        check("recovered expiry is never EARLIER than the floor",
              got is not None and got >= floored)
        check("recovered expiry is within one minute of the floor",
              got is not None and got - floored <= 60)

        # The failure mode itself, stated as an assertion: with the old floor,
        # an account whose true expiry is 20:53:17 would be pruned 17 s early.
        true_expiry = 1791060797.878
        check("the floor would have expired this mute EARLY (the bug)",
              floored < true_expiry)
        check("the rounded-up value does NOT expire it early (the fix)",
              got is not None and got >= true_expiry)

        # Merge rule unchanged: a backfill still cannot shorten a live penalty.
        check("merge keeps the LATER expiry",
              ds._merge_muted({"a@x.com": floored + 9999})["a@x.com"] == floored + 9999)

        # An EXPIRED verdict must not enter the ledger.
        old = os.path.join(td, "ds_wirelog.jsonl")
        with open(old, "w", encoding="utf-8") as fh:
            fh.write(_verdict_line("b@x.com", "user is muted (until 2020-01-01 00:00 UTC)"))
        ds2 = _fresh_module(td)
        check("an expired verdict is not recorded",
              "b@x.com" not in ds2._muted_until)

    print()
    if _FAILS:
        print("FAILURES: %d -- %s" % (len(_FAILS), ", ".join(_FAILS)))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
