"""FIX 23: the backfill must never overwrite a value the wire supplied.

Both the wire path and the backfill read the SAME verdict, but the wire carries
the exact float while the detail text is minute-accurate and rounds UP. So the
backfill has strictly LESS information than the entry it would replace.

Measured on t2: the wire value 1791060797.878 (20:53:17) was replaced by
1791060840.0 (20:54:00), losing 42 s of precision for no gain. FIX 21 made that
replacement safe in direction (never early) but it was still a downgrade.

The repair exists to fill GAPS -- an account absent from the ledger because the
mute predates the ledger file -- not to refine entries that are already there.
Escalation across two genuine verdicts is `_note_mute`'s job.
"""
import importlib.util
import json
import os
import shutil
import sys
import tempfile

_HERE = os.path.dirname(os.path.abspath(__file__))
_FAILS = []


def check(name, cond, extra=""):
    print("%s  %s%s" % ("PASS" if cond else "FAIL", name, ("  -- " + str(extra)) if extra and not cond else ""))
    if not cond:
        _FAILS.append(name)


WIRE = 1791060797.878
TEXT = "user is muted (until 2026-10-03 20:53 UTC)"
FLOOR_PLUS_60 = 1791060840.0


def _load(td):
    os.environ["KILN_STATE_DIR"] = td
    for m in ("ds_direct", "ds_wirelog"):
        sys.modules.pop(m, None)
    if td not in sys.path:
        sys.path.insert(0, td)
    spec = importlib.util.spec_from_file_location("ds_direct", os.path.join(td, "ds_direct.py"))
    mod = importlib.util.module_from_spec(spec)
    sys.modules["ds_direct"] = mod
    spec.loader.exec_module(mod)
    return mod


def _scaffold(td):
    for f in ("ds_direct.py", "ds_wirelog.py", "ds_identity.py", "ds_profile.py", "ds_hif.py"):
        s = os.path.join(_HERE, f)
        if os.path.exists(s):
            shutil.copy2(s, os.path.join(td, f))
    with open(os.path.join(td, "ds_wirelog.jsonl"), "w", encoding="utf-8") as fh:
        fh.write(json.dumps({"ts": WIRE, "kind": "verdict", "verdict": "mute",
                             "detail": TEXT, "account": "a@x.com"}) + "\n")


def main():
    # 1. an entry the wire already supplied must survive untouched
    with tempfile.TemporaryDirectory() as td:
        _scaffold(td)
        json.dump({"a@x.com": WIRE}, open(os.path.join(td, "ds_muted.json"), "w"))
        ds = _load(td)
        got = ds._muted_until.get("a@x.com")
        check("exact wire value is preserved", got == WIRE, repr(got))
        check("it was NOT rounded up to floor+60", got != FLOOR_PLUS_60, repr(got))
        check("the backfill reported no change", ds.backfill_muted_from_wirelog() == 0)

    # 2. a genuine GAP must still be filled
    with tempfile.TemporaryDirectory() as td:
        _scaffold(td)
        json.dump({}, open(os.path.join(td, "ds_muted.json"), "w"))
        ds = _load(td)
        got = ds._muted_until.get("a@x.com")
        check("an absent account IS filled from the journal", got is not None, repr(got))
        check("the gap-fill uses the safe upper bound", got == FLOOR_PLUS_60, repr(got))
        check("the gap-fill is never earlier than the true expiry", got is not None and got >= WIRE)

    # 3. the tolerance separates "same verdict, coarser text" from "newer verdict".
    with tempfile.TemporaryDirectory() as td:
        _scaffold(td)
        # 3a. inside the tolerance -> treated as the SAME penalty, exact value kept
        json.dump({"a@x.com": WIRE}, open(os.path.join(td, "ds_muted.json"), "w"))
        ds = _load(td)
        check("a within-tolerance difference keeps the ledger's exact value",
              ds._muted_until.get("a@x.com") == WIRE,
              repr(ds._muted_until.get("a@x.com")))

    with tempfile.TemporaryDirectory() as td:
        _scaffold(td)
        # 3b. BEYOND the tolerance -> a genuinely later verdict, and the ledger
        #     must adopt it, because the ledger may predate the verdict.
        stale = WIRE - 10000
        json.dump({"a@x.com": stale}, open(os.path.join(td, "ds_muted.json"), "w"))
        ds = _load(td)
        check("a beyond-tolerance later verdict IS adopted",
              ds._muted_until.get("a@x.com") == FLOOR_PLUS_60,
              repr(ds._muted_until.get("a@x.com")))
        check("the adopted value is still never earlier than the true expiry",
              ds._muted_until.get("a@x.com") >= WIRE)

    # 4. _note_mute keeps its own rule: a genuinely later verdict extends.
    with tempfile.TemporaryDirectory() as td:
        _scaffold(td)
        json.dump({"a@x.com": WIRE}, open(os.path.join(td, "ds_muted.json"), "w"))
        ds = _load(td)
        later = WIRE + 5000
        ds._note_mute("a@x.com", later)
        check("_note_mute extends on a genuine second verdict",
              ds._muted_until.get("a@x.com") == later,
              repr(ds._muted_until.get("a@x.com")))
        ds._note_mute("a@x.com", WIRE)          # an EARLIER verdict must not shorten
        check("_note_mute never shortens an existing penalty",
              ds._muted_until.get("a@x.com") == later,
              repr(ds._muted_until.get("a@x.com")))

    print()
    if _FAILS:
        print("FAILURES: %d -- %s" % (len(_FAILS), ", ".join(_FAILS)))
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
