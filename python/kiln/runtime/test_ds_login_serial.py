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
  * Every login carries the SAME device_id, because a per-attempt random one
    presented each refresh as a new device joining the account.

No network and no credentials: the HTTP session is faked.
"""
import os
import sys
import tempfile
import threading
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

os.environ["KILN_STATE_DIR"] = tempfile.mkdtemp(prefix="ds-login-test-")

import ds_direct as dd  # noqa: E402

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
    # that it is the SHARED one, not a fresh secret.
    check("the login used the machine's stable device_id",
          POSTS and POSTS[0] == dd.ds_identity.device_id(),
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
          POSTS and POSTS[0] == dd.ds_identity.device_id(), repr(POSTS))

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
