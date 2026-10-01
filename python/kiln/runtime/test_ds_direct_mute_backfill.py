#!/usr/bin/env python3
"""FIX 20: the mute ledger must be repairable from the wirelog.

`_muted_until` only holds mutes some process PERSISTED. A mute observed before the
ledger existed was written to the wirelog and nowhere else, so the account reads
`muted: False` while DeepSeek still refuses it. Measured live: t1 was muted until
2026-10-04 00:40 and absent from the ledger entirely.

`backfill_muted_from_wirelog()` recovers those from verdict lines the journal
genuinely captured, merging on the LATER expiry so a backfill can never shorten a
live penalty.

Run:  .venv/Scripts/python.exe test_ds_direct_mute_backfill.py
"""
import importlib
import json
import os
import shutil
import sys
import tempfile
import time
import unittest

RT = os.path.dirname(os.path.abspath(__file__))


def _fresh(state):
    os.environ["KILN_STATE_DIR"] = state
    for name in [n for n in list(sys.modules) if n.startswith("ds_")]:
        del sys.modules[name]
    if RT not in sys.path:
        sys.path.insert(0, RT)
    import ds_direct
    return ds_direct


def _verdict_line(acct, until_text):
    return json.dumps({
        "ts": time.time(), "kind": "verdict", "verdict": "mute",
        "detail": "user is muted (until %s UTC)" % until_text,
        "account": acct, "preamble": [],
    }) + "\n"


class Backfill(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ds-backfill-")
        self.dd = _fresh(self.tmp)
        self.journal = os.path.join(self.tmp, "ds_wirelog.jsonl")

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write(self, lines):
        with open(self.journal, "w", encoding="utf-8") as fh:
            fh.writelines(lines)

    def test_recovers_a_mute_the_ledger_never_held(self):
        self._write([_verdict_line("a@x.com", "2026-10-04 00:40")])
        moved = self.dd.backfill_muted_from_wirelog(paths=[self.journal])
        self.assertEqual(moved, 1)
        self.assertTrue(self.dd._muted_now("a@x.com"))

    def test_never_shortens_a_live_penalty(self):
        """The merge rule is the LATER expiry, so a backfill cannot reduce one."""
        self.dd._muted_until["a@x.com"] = time.time() + 999 * 3600
        self._write([_verdict_line("a@x.com", "2026-10-04 00:40")])
        self.dd.backfill_muted_from_wirelog(paths=[self.journal])
        self.assertGreater(self.dd._muted_until["a@x.com"], time.time() + 900 * 3600)

    def test_extending_an_entry_is_reported(self):
        self.dd._muted_until["a@x.com"] = time.time() + 60
        self._write([_verdict_line("a@x.com", "2026-10-04 00:40")])
        self.assertEqual(self.dd.backfill_muted_from_wirelog(paths=[self.journal]), 1)

    def test_expired_verdicts_are_not_restored(self):
        self._write([_verdict_line("a@x.com", "2020-01-01 00:00")])
        moved = self.dd.backfill_muted_from_wirelog(paths=[self.journal])
        self.assertEqual(moved, 0)
        self.assertFalse(self.dd._muted_now("a@x.com"))

    def test_a_missing_journal_is_not_fatal(self):
        self.assertEqual(
            self.dd.backfill_muted_from_wirelog(paths=[self.journal + ".nope"]), 0)

    def test_a_corrupt_journal_is_not_fatal(self):
        with open(self.journal, "w", encoding="utf-8") as fh:
            fh.write("not json\n" + _verdict_line("a@x.com", "2026-10-04 00:40"))
        moved = self.dd.backfill_muted_from_wirelog(paths=[self.journal])
        self.assertEqual(moved, 1)

    def test_an_unrelated_verdict_is_ignored(self):
        self._write([json.dumps({
            "ts": time.time(), "kind": "verdict", "verdict": "too_many_ref_files",
            "detail": "too many ref files", "account": "a@x.com", "preamble": [],
        }) + "\n"])
        self.assertEqual(self.dd.backfill_muted_from_wirelog(paths=[self.journal]), 0)


if __name__ == "__main__":
    unittest.main(verbosity=2)
