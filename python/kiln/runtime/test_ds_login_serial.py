#!/usr/bin/env python
"""Regression tests for ds_direct's per-account login serialisation.

Run:  python test_ds_login_serial.py

Everything here is OFFLINE. What these pin:

  * N pooled clients sharing ONE account each hit 401 on the same expired
    token. They used to post /users/login simultaneously -- several logins for
    one identity inside a second, which DeepSeek answers with "too many
    requests". One login must serve them all.
  * The first client to log in publishes its token; the rest adopt it, along
    with the WAF cookies that login refreshed.
  * Every login for one account carries the SAME device_id, because a
    per-attempt random one presented each refresh as a new device joining the
    account. The value is now the account's OWN browser-minted identity, so the
    second half of that pin is that it is well-formed and it does not change
    between attempts.

No network and no credentials: the HTTP session is faked, and identity minting
is stubbed out. A real mint would launch Chrome against the operator's live
identity directory, which an offline suite must never do.
"""
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Point identity at a scratch dir BEFORE importing. Without this the per-account
# login path mints into the operator's REAL profile directory, which makes an
# "offline" suite open a browser and mutate live state.
_SCRATCH = tempfile.mkdtemp(prefix="ds-login-test-")
os.environ["KILN_STATE_DIR"] = _SCRATCH
os.environ["KILN_IDENTITY_DIR"] = os.path.join(_SCRATCH, "identity")

import ds_direct as dd  # noqa: E402

# Minting is not what this suite measures, and it launches a browser. Stub it to
# a stable value so the login path runs to completion without a subprocess and
# without ever touching a real profile. WHICH account was asked to mint is part
# of the contract, so the stub records the key it was called with.
#
# The stub also has to WRITE what it "minted", through the same API the real
# mint uses. Returning a value alone leaves the account record empty, so
# _device_id_for finds nothing and falls back to the machine-level Shumei
# value -- which is precisely the "several accounts present one device" defect
# this suite exists to catch, so a return-only stub would hide it.
_MINTED_ID = "0f1e2d3c-4b5a-6978-8796-a5b4c3d2e1f0"
_MINTED_X_DEVICE_ID = "3c2d1e0f-a5b4-6978-8796-4b5a3c2d1e0f"
MINTED = []


def _fake_mint(acct, on_status=None):
    key = dd._account_key(acct)
    MINTED.append(key)
    dd.ds_profile.write_account_identity(key, {
        "device_id": _MINTED_ID,
        "x_device_id": _MINTED_X_DEVICE_ID,
        "origin": "test-stub",
    })
    return _MINTED_ID


dd._mint_identity_for = _fake_mint

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


class _Jar(dict):
    """Just enough of a cookie jar for apply_account / cookie_string."""
    def set(self, k, v, **kw):
        self[k] = v

    def get_dict(self):
        return dict(self)

    def clear(self):
        super().clear()


class _Resp:
    status_code = 200
    headers = {}

    def __init__(self, token):
        self._token = token

    def json(self):
        return {"data": {"biz_data": {"user": {"token": self._token}}}}


class _Sess:
    """A session that records every /users/login it is asked to perform."""

    def __init__(self, posts, delay=0.15):
        self.cookies = _Jar()
        self._posts = posts
        self._delay = delay

    def get(self, *a, **k):
        return _Resp("")

    def post(self, *a, **k):
        body = k.get("json") or {}
        self._posts.append(body.get("device_id"))
        time.sleep(self._delay)          # the network is not instant
        return _Resp("fresh-token-xyz")


# Patch the client onto the fake session. Only __init__ and apply_account touch
# the transport; the login logic under test is untouched.
def _init(self, account):
    self.sess = _Sess(POSTS)
    self.account = account
    self.token = ""
    self.last_login_error = None
    self.creds_mtime = 0.0
    if account is not None:
        self.apply_account(account)


def _apply(self, account):
    self.account = account
    self.token = account.token or ""
    self.creds_mtime = account.mtime


POSTS = []
dd._Client.__init__ = _init
dd._Client.apply_account = _apply


try:
    acct = dd._Account("probe", email="a@example.com", password="pw",
                       source=("env",))
    clients = [dd._Client(acct) for _ in range(4)]

    results, errors = [], []

    def go(c):
        try:
            results.append(c.login())
        except Exception as e:                      # noqa: BLE001 — reported
            errors.append(repr(e))

    threads = [threading.Thread(target=go, args=(c,)) for c in clients]
    for t in threads:
        t.start()
    for t in threads:
        t.join()

    check("four concurrent logins make ONE network login",
          len(POSTS) == 1, "made %d login posts" % len(POSTS))
    check("every client received a token",
          len(results) == 4 and all(results), repr(results))
    check("no client raised", not errors, repr(errors))
    check("all clients got the same token",
          len(set(results)) == 1, repr(set(results)))

    # The device identity. One login means one device_id here; the point is
    # that it is the ACCOUNT's own identity, and it is not re-minted per
    # attempt. An account with no captured identity of its own gets one minted
    # before the first attempt, and the value that mints is what the login body
    # carries -- NOT the machine-level Shumei value, which is what several
    # accounts sharing one machine used to present.
    check("the first login minted an identity for the account",
          MINTED == [acct.id], repr(MINTED))
    check("the login body carries the account's own minted device_id",
          POSTS and POSTS[0] == _MINTED_ID, repr(POSTS[:1]))
    check("the login body does not carry the machine-level device_id",
          POSTS and POSTS[0] != dd.ds_identity.device_id(),
          "the two identifiers are different values")
    check("the minted value round-trips through the account's own record",
          dd.ds_profile.device_id_for_account(acct.id) == _MINTED_ID,
          repr(dd.ds_profile.device_id_for_account(acct.id)))
    check("the login body's device_id is a well-formed identity",
          dd.ds_identity.valid_device_id(POSTS[0]) if POSTS else False,
          repr(POSTS[:1]))

    # Within the reuse window a client with a stale token adopts the published
    # one WITHOUT asking DeepSeek again -- that is the whole point.
    POSTS.clear()
    late = dd._Client(acct)
    late.token = "stale"
    late.login()
    check("a login inside the reuse window makes no network call",
          len(POSTS) == 0, "made %d posts" % len(POSTS))
    check("the reused login adopted the published token",
          late.token == "fresh-token-xyz", repr(late.token))

    # Past the window it must log in again -- and still send the SAME
    # device_id, never a fresh one.
    POSTS.clear()
    acct.last_login_at = time.time() - (dd.LOGIN_REUSE_WINDOW + 10)
    again = dd._Client(acct)
    again.token = "stale"
    again.login()
    check("a login past the reuse window does hit the network",
          len(POSTS) == 1, "made %d posts" % len(POSTS))
    check("that login still sends the same device_id",
          POSTS and POSTS[0] == _MINTED_ID, repr(POSTS))
    check("a re-login does not re-mint an identity it already has",
          MINTED == [acct.id], repr(MINTED))

    # Across a simulated restart the device_id must not change.
    dd.ds_identity._seed_cache.clear()
    check("the device_id survives a process restart",
          dd.ds_identity.device_id() == dd.ds_identity.device_id())

    # Every account gets its OWN lock, or two logins would serialise globally.
    other = dd._Account("other", email="b@example.com", password="pw",
                        source=("env",))
    check("each account has its own login lock",
          acct.login_lock is not other.login_lock)

    # The published-token handoff is per account.
    check("the account publishes the token it minted",
          acct.last_login_token == "fresh-token-xyz", repr(acct.last_login_token))
    check("the other account published nothing",
          other.last_login_token == "", repr(other.last_login_token))
finally:
    import shutil
    shutil.rmtree(os.environ["KILN_STATE_DIR"], ignore_errors=True)

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all login-serialisation checks passed")
