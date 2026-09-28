#!/usr/bin/env python
"""Regression tests for ACCOUNT ADMINISTRATION (ds_admin).

Run:  python test_ds_admin.py

Everything here is OFFLINE: no browser is launched, no request leaves the
machine, and no real identity directory is touched. What these pin is the
operator surface added for "I cannot tell what is happening when I add an
account, re-login, or run two at once":

  * the event ring is bounded, sequenced, and drained by sequence number, so a
    poll that passes the last seq it saw gets only what is new -- the property
    that keeps two accounts running at once attributable instead of interleaved;
  * ``record`` never raises into its caller. It sits in the middle of logins, and
    a diagnostics call that can fail a login is worse than no diagnostics;
  * ``list_accounts`` reports the identity of a configured account AND a profile
    that outlived its config entry, because the union is what an operator needs
    and neither source shows both;
  * credential fields are reported as PRESENCE, never as values. A token
    authorizes a session; a device id identifies a device. Only one of those
    belongs on the wire, and only one is reported here;
  * each repair refuses with a value rather than raising, and refuses BEFORE it
    touches anything -- an unknown account, a missing password, and an empty id
    must all be distinguishable failures.

The scratch directory is set through KILN_IDENTITY_DIR *before* the modules are
imported, so nothing here can read or write the operator's real identity.
"""
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Point identity at a scratch dir BEFORE importing: the modules read
# KILN_IDENTITY_DIR at call time, and a test must never touch the real identity.
_SCRATCH = tempfile.mkdtemp(prefix="ds-admin-test-")
_IDENTITY_SCRATCH = os.path.join(_SCRATCH, "identity")
os.environ["KILN_STATE_DIR"] = _SCRATCH
os.environ["KILN_IDENTITY_DIR"] = _IDENTITY_SCRATCH
os.environ.pop("DEEPSEEK_DEVICE_ID", None)

import ds_admin  # noqa: E402 -- after the env is pinned
import ds_identity  # noqa: E402
import ds_profile  # noqa: E402


def _reset():
    """A clean log and a clean identity tree for one scenario."""
    ds_admin.clear_log()
    if os.path.isdir(_IDENTITY_SCRATCH):
        shutil.rmtree(_IDENTITY_SCRATCH)
    os.makedirs(_IDENTITY_SCRATCH, exist_ok=True)


def _check(name, ok, detail=""):
    print("%-4s %s%s" % ("PASS" if ok else "FAIL", name,
                         "" if ok else "  <- %s" % detail))
    return bool(ok)


results = []

# --- the log ring -----------------------------------------------------------
_reset()
e1 = ds_admin.record("a@example.com", "add-account", "tested and stored")
e2 = ds_admin.record("b@example.com", "relogin-start", "email=yes")
results.append(_check("record returns the entry it appended",
                      isinstance(e1, dict) and e1.get("seq") == 1 and e1.get("event") == "add-account",
                      repr(e1)))
results.append(_check("seq advances per entry", e2.get("seq") == 2, repr(e2)))
results.append(_check("entry carries its account", e2.get("account") == "b@example.com", repr(e2)))

drained = ds_admin.drain()
results.append(_check("drain returns both entries oldest first",
                      [d["seq"] for d in drained] == [1, 2], repr(drained)))
results.append(_check("drain is a copy, not the live ring",
                      drained[0] is not e1, "returned the stored dict itself"))

after = ds_admin.drain(1)
results.append(_check("drain(since) returns only what is newer",
                      [d["seq"] for d in after] == [2], repr(after)))

# A poll that passes a non-number must not explode; it reads from the start.
results.append(_check("drain tolerates a junk cursor",
                      len(ds_admin.drain("nonsense")) == 2, "junk cursor raised or dropped rows"))

# --- the ring is bounded ----------------------------------------------------
# The sequence counter is process-wide and deliberately never resets, so these
# assertions are stated as invariants of the ring rather than absolute numbers.
_reset()
flood = ds_admin.LOG_LIMIT + 25
for i in range(flood):
    ds_admin.record("flood@example.com", "tick", str(i))
ring = ds_admin.drain()
results.append(_check("the ring holds at most LOG_LIMIT entries",
                      len(ring) == ds_admin.LOG_LIMIT, "len=%d" % len(ring)))
results.append(_check("the newest entry survives the bound",
                      ring[-1]["detail"] == str(flood - 1), repr(ring[-1])))
results.append(_check("the oldest are the ones dropped",
                      ring[0]["detail"] == str(flood - ds_admin.LOG_LIMIT), repr(ring[0])))
results.append(_check("the retained window is contiguous and monotonic",
                      [e["seq"] for e in ring] == list(range(ring[0]["seq"], ring[-1]["seq"] + 1)),
                      "seq window is not contiguous"))

# --- record never raises, and never drops the event -------------------------
_reset()
class _Explode(object):
    def __str__(self):
        raise RuntimeError("bad __str__")
weird = ds_admin.record(_Explode(), "odd", _Explode())
results.append(_check("record survives a value that cannot be stringified",
                      isinstance(weird, dict) and isinstance(weird.get("seq"), int)
                      and weird["seq"] > 0, repr(weird)))
results.append(_check("the event is recorded anyway, not dropped",
                      len(ds_admin.drain()) == 1, "ring lost the entry"))
results.append(_check("the unprintable account degrades to a named placeholder",
                      weird.get("account") == "<unprintable _Explode>", repr(weird.get("account"))))
results.append(_check("an unprintable detail degrades too",
                      weird.get("detail") == "<unprintable _Explode>", repr(weird.get("detail"))))
results.append(_check("the event name is preserved verbatim",
                      weird.get("event") == "odd", repr(weird.get("event"))))
results.append(_check("record(None, ...) writes an empty account, not \"None\"",
                      ds_admin.record(None, "none-account").get("account") == "",
                      repr(ds_admin.drain()[-1])))

# --- clear_log --------------------------------------------------------------
_reset()
ds_admin.record("a@example.com", "one")
dropped = ds_admin.clear_log()
results.append(_check("clear_log reports how many it dropped", dropped == 1, repr(dropped)))
results.append(_check("the ring is empty afterwards", ds_admin.drain() == [], "not empty"))

# --- list_accounts: presence only, union of config and disk -----------------
_reset()
os.makedirs(os.path.join(_IDENTITY_SCRATCH, "accounts"), exist_ok=True)
os.makedirs(os.path.join(_IDENTITY_SCRATCH, "profiles"), exist_ok=True)

# An orphaned profile: on disk, not named by any config entry.
orphan_slug = ds_profile.slug("orphan@example.com")
ORPHAN_DEVICE = ("BdQNjmtlDqa0FTFU7mQKwc5VqKKTaIzQuhev79oEmf9dJPQgY24bGBqjLuUZ2nv6d"
                 "PaBsLuCULkcRwLQSctydZg==")
os.makedirs(os.path.join(_IDENTITY_SCRATCH, "profiles", orphan_slug), exist_ok=True)
with open(os.path.join(_IDENTITY_SCRATCH, "accounts", "%s.json" % orphan_slug),
          "w", encoding="utf-8") as f:
    json.dump({"device_id": ORPHAN_DEVICE, "x_device_id": "x" * 36, "did": "did-1",
               "origin": "capture", "updated_at": 1700000000}, f)

rows = ds_admin.list_accounts()
ids = [r["id"] for r in rows]
slugs = [r["slug"] for r in rows]
results.append(_check("an orphaned profile is listed, not hidden",
                      orphan_slug in slugs, repr(slugs)))
orphan = [r for r in rows if r["slug"] == orphan_slug][0]
results.append(_check("an orphaned profile reports configured=False",
                      orphan["configured"] is False, repr(orphan)))
results.append(_check("an orphaned profile reports the device it minted",
                      orphan["device_id"] == ORPHAN_DEVICE,
                      repr(orphan.get("device_id"))))
results.append(_check("an orphaned profile reports its x-device-id and did",
                      orphan["x_device_id"] == "x" * 36 and orphan["did"] == "did-1",
                      repr(orphan)))
results.append(_check("a row never carries a credential VALUE",
                      set(orphan) >= {"has_token", "has_cookie", "has_password"}
                      and not any(k in orphan for k in ("token", "cookie", "password")),
                      repr(sorted(orphan))))

# --- an orphan row applies the SAME shape rule as a configured row ----------
# Reading the record raw here made one page disagree with itself: a configured
# row refused a value the rule rejects while the orphan row beside it presented
# that value as the device. Both halves now answer to `valid_device_id`.
_rejected_slug = ds_profile.slug("rejected@example.com")
os.makedirs(os.path.join(_IDENTITY_SCRATCH, "profiles", _rejected_slug), exist_ok=True)
with open(os.path.join(_IDENTITY_SCRATCH, "accounts", "%s.json" % _rejected_slug),
          "w", encoding="utf-8") as f:
    json.dump({"device_id": "20260927205138c1162ca82345e0596922756f0c61e0c700db2371f23a1cd10",
               "origin": "capture"}, f)
rows = ds_admin.list_accounts()
bad = [r for r in rows if r["slug"] == _rejected_slug][0]
results.append(_check("an orphan row does not present a value the rule rejects",
                      bad["device_id"] == "", repr(bad.get("device_id"))))
results.append(_check("it still reports the device it actually has as invalid",
                      bad["device_id_valid"] is False, repr(bad)))

# --- the write path keeps a field and its label together --------------------
# `device_id_origin` says where the device_id came from, so purging the value
# while leaving the label is a dangling origin: the row renders a provenance
# for a device that no longer exists.
_reset()
rec = ds_profile.write_account_identity("labels@example.com", {
    "device_id": ORPHAN_DEVICE,
    "device_id_origin": "login-payload",
    "origin": "login-payload",
})
results.append(_check("a good write stores the value and both labels",
                      rec.get("device_id") == ORPHAN_DEVICE
                      and rec.get("device_id_origin") == "login-payload",
                      repr(rec)))
rec = ds_profile.write_account_identity("labels@example.com", {
    "device_id": "20260927205138c1162ca82345e0596922756f0c61e0c700db2371f23a1cd10",
    "device_id_origin": "cookie:smidV2",
    "origin": "cookie:smidV2",
})
results.append(_check("a rejected write purges the value",
                      not rec.get("device_id"), repr(rec)))
results.append(_check("a rejected write purges the dangling origin with it",
                      not rec.get("device_id_origin") and not rec.get("origin"),
                      repr(sorted(rec))))
results.append(_check("a rejected write records what it dropped",
                      "not a fingerprint" in str(rec.get("device_id_rejected")),
                      repr(rec)))

# A later GOOD value must clear the note the bad one left, or the row shows a
# working fingerprint next to "not a fingerprint".
rec = ds_profile.write_account_identity("labels@example.com",
                                        {"device_id": ORPHAN_DEVICE,
                                         "origin": "login-payload"})
results.append(_check("a good value clears the stale rejection note",
                      not rec.get("device_id_rejected"), repr(rec)))
results.append(_check("the good value itself is stored",
                      rec.get("device_id") == ORPHAN_DEVICE, repr(rec)))

# --- the repairs refuse as values ------------------------------------------
_reset()
for name, res in (
    ("relogin refuses an empty id",
     ds_admin.relogin("")),
    ("reprofile refuses an empty id",
     ds_admin.reprofile("")),
    ("relogin refuses an unknown account",
     ds_admin.relogin("nobody@example.com")),
):
    results.append(_check(name,
                          isinstance(res, dict) and res.get("ok") is False
                          and bool(res.get("error")),
                          repr(res)))

# A refusal is written down: the operator asked to be able to see what happened.
events = [e["event"] for e in ds_admin.drain()]
results.append(_check("a refused relogin is recorded in the log",
                      "relogin-missing" in events, repr(events)))

# --- reprofile removes the profile on purpose ------------------------------
_reset()
target = "fresh@example.com"
folder = ds_profile.profile_dir(target)
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, "marker.txt"), "w", encoding="utf-8") as f:
    f.write("stale profile state")

res = ds_admin.reprofile(target, fresh=True, capture=False)
results.append(_check("reprofile(fresh=True, capture=False) succeeds",
                      res.get("ok") is True, repr(res)))
results.append(_check("it reports that it removed the old profile",
                      res.get("removed") is True, repr(res)))
results.append(_check("the old user-data directory is gone",
                      not os.path.isdir(folder), "still on disk"))
results.append(_check("capture=False means no capture is claimed",
                      res.get("captured") is False, repr(res)))

# fresh=False must NOT delete: re-reading an existing profile is a different ask.
os.makedirs(folder, exist_ok=True)
with open(os.path.join(folder, "marker.txt"), "w", encoding="utf-8") as f:
    f.write("kept")
res = ds_admin.reprofile(target, fresh=False, capture=False)
results.append(_check("reprofile(fresh=False) keeps the profile",
                      os.path.isdir(folder) and res.get("removed") is False, repr(res)))

print()
print("%d/%d checks passed" % (sum(1 for r in results if r), len(results)))
sys.exit(0 if all(results) else 1)
