#!/usr/bin/env python3
"""FIX 19: the account list must report live mute state.

The account list is where an operator checks "which of my logins are banned right
now". Before this, it could not answer that: every other per-account fact was on
the row -- token presence, cookie presence, device id, profile folder -- while the
mute lived only in `ds_direct`'s ledger and was printed to a debug log. A report of
"every account except one is muted" therefore could not be checked against
anything, which is exactly what happened.

These tests pin three properties:

* a muted account reports `muted: True` with its expiry and remaining seconds
* an UNREADABLE ledger reports `muted: None` -- unknown, never False, because
  "I could not tell" must not render as "healthy"
* the read is side-effect free: it does not prune, rewrite, or otherwise mutate
  the ledger as a consequence of being listed

Run:  .venv/Scripts/python.exe test_ds_admin_mute_view.py
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
    import ds_admin
    return ds_direct, ds_admin


class MuteView(unittest.TestCase):
    def setUp(self):
        self.tmp = tempfile.mkdtemp(prefix="ds-admin-mute-")
        self.dd, self.ad = _fresh(self.tmp)

    def tearDown(self):
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _write_ledger(self, table):
        path = os.path.join(self.tmp, "ds_muted.json")
        with open(path, "w", encoding="utf-8") as fh:
            json.dump(table, fh)
        return path

    def test_muted_account_reports_true_with_expiry(self):
        until = time.time() + 3600
        self._write_ledger({"a@x.com": until})
        self.dd._muted_until = self.dd._load_muted()
        view = self.ad._mute_view("a@x.com")
        self.assertTrue(view["muted"])
        self.assertAlmostEqual(view["mute_until"], until, places=3)
        self.assertGreater(view["mute_remaining_s"], 3500)
        self.assertEqual(view["mute_source"], "ledger")

    def test_unmuted_account_reports_false(self):
        self._write_ledger({"a@x.com": time.time() + 3600})
        self.dd._muted_until = self.dd._load_muted()
        view = self.ad._mute_view("other@x.com")
        self.assertIs(view["muted"], False)
        self.assertIsNone(view["mute_until"])

    def test_expired_entry_reports_false_without_rewriting(self):
        """An expired penalty is not a penalty, and listing must not prune it."""
        path = self._write_ledger({"a@x.com": time.time() - 10})
        before = open(path, encoding="utf-8").read()
        self.dd._muted_until = self.dd._load_muted()
        view = self.ad._mute_view("a@x.com")
        self.assertIs(view["muted"], False)
        self.assertEqual(open(path, encoding="utf-8").read(), before,
                         "listing rewrote the ledger")

    def test_orphan_row_has_no_account_id_and_is_not_unknown(self):
        view = self.ad._mute_view("")
        self.assertIs(view["muted"], False)
        self.assertEqual(view["mute_source"], "orphan")

    def test_unreadable_ledger_is_unknown_not_healthy(self):
        self.dd._muted_until = None          # simulate a table that cannot be read
        view = self.ad._mute_view("a@x.com")
        self.assertIsNone(view["muted"], "an unreadable ledger must not report healthy")
        self.assertEqual(view["mute_source"], "unavailable")

    def test_list_accounts_rows_carry_the_mute_fields(self):
        self._write_ledger({"deepseek.ee.1+t2@gmail.com": time.time() + 7200})
        self.dd._muted_until = self.dd._load_muted()
        rows = self.ad.list_accounts()
        self.assertIsInstance(rows, list)
        for row in rows:
            for key in ("muted", "mute_until", "mute_until_local",
                        "mute_remaining_s", "mute_source"):
                self.assertIn(key, row, "row missing %s" % key)


if __name__ == "__main__":
    unittest.main(verbosity=2)
