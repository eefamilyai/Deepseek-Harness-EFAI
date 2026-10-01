#!/usr/bin/env python3
"""Regression tests for the wirelog verdict-nesting runaway (FIX 18).

`ds_wirelog.verdict()` keeps the verdict it builds in `_RING`, and every later
verdict's `preamble` is a copy of that ring. Kept whole, verdict N's preamble
contains verdict N-1, whose preamble contains N-2, and so on, so the record
written for one verdict is bigger than every earlier one combined.

Measured on the live journal before the fix: ONE 11.47 GB line carrying
1,048,545 nested mute verdicts, written by a single `f.write()` that took 28
minutes to reach disk -- which is also why rotation never fired on it.

Run:  .venv/Scripts/python.exe test_ds_wirelog_nesting.py
"""
import json
import os
import shutil
import sys
import tempfile
import unittest

RT = os.path.dirname(os.path.abspath(__file__))


def _fresh(state):
    os.environ["KILN_STATE_DIR"] = state
    os.environ["KILN_DS_WIRELOG"] = "1"
    sys.modules.pop("ds_wirelog", None)
    if RT not in sys.path:
        sys.path.insert(0, RT)
    import ds_wirelog
    return ds_wirelog


def _req(w, i):
    w.record("request", account="p@e.invalid", seq=i, method="GET",
             path="chat.deepseek.com/api/v0/client/settings",
             header_order=["accept"], header_fp={"accept": "0" * 10},
             cookie_names={}, jar={}, body_keys=None, body_bytes=0,
             stream=False)


class Nesting(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="wirelog-nest-")
        self.w = _fresh(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _lines(self):
        with open(self.w.path(), encoding="utf-8") as fh:
            return [l for l in fh.read().splitlines() if l.strip()]

    def test_verdict_record_has_no_nested_preamble(self):
        """A written verdict carries one preamble and nothing nested inside it."""
        for i in range(1, 30):
            _req(self.w, i)
            self.w.verdict("mute", "user is muted", account="p@e.invalid")
        lines = self._lines()
        self.assertEqual(len(lines), 58)
        for ln in lines:
            if json.loads(ln).get("kind") != "verdict":
                continue
            self.assertEqual(ln.count('"preamble"'), 1,
                             "a verdict record nested another preamble")

    def test_growth_is_linear_not_exponential(self):
        """300 verdicts stay small; before the fix 20 already reached 402 MB."""
        sizes = {}
        for i in range(1, 301):
            _req(self.w, i)
            self.w.verdict("mute", "user is muted", account="p@e.invalid")
            if i in (50, 150, 300):
                sizes[i] = os.path.getsize(self.w.path())
        self.assertLess(sizes[300], 20 * 1024 * 1024,
                        "300 verdicts exceeded 20 MB")
        self.assertLess(sizes[300], 100 * sizes[50])

    def test_ring_never_holds_a_preamble(self):
        for i in range(1, 200):
            _req(self.w, i)
            self.w.verdict("mute", "user is muted", account="p@e.invalid")
        for o in self.w._RING:
            if isinstance(o, dict) and o.get("kind") == "verdict":
                self.assertNotIn("preamble", o)

    def test_every_record_is_under_the_ceiling(self):
        for i in range(1, 120):
            _req(self.w, i)
            self.w.verdict("mute", "user is muted", account="p@e.invalid")
        for ln in self._lines():
            self.assertLessEqual(len(ln), self.w._RECORD_MAX)

    def test_oversized_record_is_replaced_not_written(self):
        self.w._append({"ts": 0.0, "kind": "probe", "blob": "z" * (2 * 1024 * 1024)})
        lines = self._lines()
        self.assertEqual(len(lines), 1)
        d = json.loads(lines[0])
        self.assertTrue(d.get("truncated"), "oversized record was written whole")
        self.assertLess(len(lines[0]), 4096)


if __name__ == "__main__":
    unittest.main(verbosity=2)
