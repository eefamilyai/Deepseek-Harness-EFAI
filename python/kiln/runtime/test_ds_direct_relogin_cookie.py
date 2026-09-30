#!/usr/bin/env python
"""Regression tests for the STALE SESSION COOKIE replayed on a re-login.

Run:  python test_ds_direct_relogin_cookie.py

What the defect was. `_login_attempt` posted /users/login while the session jar
still held the `ds_session_id` of the session DeepSeek had just rejected. That
is a state a browser cannot reach: the site answers an expired session by
sending the page to the sign-in route, and the sign-in page carries no dead
session id. So the only client presenting one at the login call is a client that
never saw the redirect -- which is exactly the tell this file exists to keep out.

What the fix does. `_drop_dead_session_cookie` removes `ds_session_id` before the
login body is built, and KEEPS `aws-waf-token`: the WAF clearance is what makes
the login reach DeepSeek at all, replacing it costs a solved challenge, and a
stale one is already answered by the branch that knows how to re-solve it.

Pinned here, in order:
  * the dead session cookie is gone by the time /users/login is posted;
  * the WAF clearance SURVIVES that removal -- the fix must not solve one stale
    cookie by throwing away the good one next to it;
  * an account with no session cookie at all still logs in (the removal is
    unconditional, so it has to be a no-op rather than an error);
  * a successful login still stores the new token and the refreshed cookies.

No network and no credentials: the tests drive a fake session.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


class RecordingJar(dict):
    """A cookie jar that remembers every state it was in when read.

    The assertion that matters is about the jar at ONE instant -- the moment the
    login POST is built -- so the jar keeps a snapshot per read rather than only
    its final contents. A fix that dropped the cookie after the post would look
    identical to a correct one from the end state alone.
    """

    def __init__(self, initial=None):
        super().__init__(initial or {})
        self.snapshots = []

    def set(self, k, v, **kw):
        self[k] = v

    def get_dict(self):
        snap = dict(self)
        self.snapshots.append(snap)
        return snap

    def clear(self):
        dict.clear(self)

    def __delitem__(self, k):
        dict.__delitem__(self, k)


class Resp:
    status_code = 200
    headers = {}

    def __init__(self, token):
        self._token = token

    def json(self):
        return {"data": {"biz_data": {"user": {"token": self._token}}}}


class Sess:
    """Records the jar AT POST TIME, which is the whole point of this file."""

    def __init__(self, jar, token="fresh-token"):
        self.cookies = jar
        self._token = token
        self.jar_at_post = None
        self.posts = 0

    def get(self, *a, **k):
        return Resp("")

    def post(self, *a, **k):
        self.posts += 1
        self.jar_at_post = dict(self.cookies)
        return Resp(self._token)


class Acct:
    """Only the attributes `_login_attempt` reads."""

    def __init__(self):
        self.id = "acct-under-test"
        self.email = "a@example.com"
        self.mobile = ""
        self.area_code = "+86"
        self.password = "pw"
        self.token = "stale-token"
        self.cookie = ""
        self.device_id = ""
        self.did = ""
        self.headers = {}
        self.mtime = 0.0
        self.saved = []
        self.last_login_token = None
        self.last_login_at = 0.0
        self.last_login_cookie = ""
        self.login_lock = None

    def save(self, **kwargs):
        self.saved.append(kwargs)


def client_with(jar, token="fresh-token"):
    """A `_Client` bound to a fake session, built without touching cURL."""
    c = object.__new__(ds._Client)
    c.sess = Sess(jar, token)
    c.account = Acct()
    c.token = "stale-token"
    c.last_login_error = None
    c.last_login_device_risk = False
    c.creds_mtime = 0.0
    return c


# ─── 1. the dead session cookie is gone by the time the login is posted ──────

jar = RecordingJar({
    "ds_session_id": "dead-session-id",
    "aws-waf-token": "live-waf-clearance",
})
c = client_with(jar)
tok = c._login_attempt("a@example.com", "", "+86", "pw")

check("the login succeeded", tok == "fresh-token", "got %r" % (tok,))
check("the login was actually posted once", c.sess.posts == 1,
      "posts=%d" % c.sess.posts)
check("no dead ds_session_id rode the login request",
      c.sess.jar_at_post is not None and "ds_session_id" not in c.sess.jar_at_post,
      "jar at post: %r" % (c.sess.jar_at_post,))

# ─── 2. the WAF clearance must SURVIVE the removal ───────────────────────────

check("the aws-waf-token was KEPT on the login request",
      c.sess.jar_at_post is not None
      and c.sess.jar_at_post.get("aws-waf-token") == "live-waf-clearance",
      "jar at post: %r" % (c.sess.jar_at_post,))
check("the WAF clearance is still in the jar afterwards",
      jar.get("aws-waf-token") == "live-waf-clearance")

# ─── 3. an account with no session cookie still logs in ──────────────────────

bare = client_with(RecordingJar({"aws-waf-token": "w"}))
tok2 = bare._login_attempt("a@example.com", "", "+86", "pw")
check("a jar with no session cookie is a no-op, not an error",
      tok2 == "fresh-token", "got %r" % (tok2,))

empty = client_with(RecordingJar({}))
tok3 = empty._login_attempt("a@example.com", "", "+86", "pw")
check("an entirely empty jar still logs in", tok3 == "fresh-token",
      "got %r" % (tok3,))

# ─── 4. the successful login still persists its result ───────────────────────

saved = [s for s in c.account.saved if s.get("token")]
check("the new token was saved to the account", len(saved) == 1,
      "saved=%r" % (c.account.saved,))
check("the account adopted the new token in memory",
      c.account.last_login_token == "fresh-token")

# ─── 5. the helper itself is honest about what it did ────────────────────────

j = RecordingJar({"ds_session_id": "x", "aws-waf-token": "y"})
check("_drop_dead_session_cookie reports a real removal",
      ds._drop_dead_session_cookie(Sess(j)) is True)
check("it removed ONLY the session cookie",
      "ds_session_id" not in j and j.get("aws-waf-token") == "y", "jar=%r" % (dict(j),))

j2 = RecordingJar({"aws-waf-token": "y"})
check("it reports False when there was nothing to remove",
      ds._drop_dead_session_cookie(Sess(j2)) is False)

check("_forget_cookie tolerates a session with no jar",
      ds._forget_cookie(object(), "ds_session_id") is False)

print()
if FAILS:
    print("FAILED (%d): %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all re-login cookie checks passed")
