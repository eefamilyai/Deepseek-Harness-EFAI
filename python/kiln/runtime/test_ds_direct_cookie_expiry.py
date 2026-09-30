"""The cookie round-trip must preserve domain/path/expiry, and must not resurrect a lapsed cookie.

Why this suite exists. `cookie_string()` used to emit only `name=value`, and
`apply_account()` re-installed the result with a bare `set(name, value)`. Neither
can carry an expiry, so every cookie the harness persisted came back as a SESSION
cookie -- presented on every request forever, including after DeepSeek had lapsed
it server-side. A browser cannot be in that state: the site answers a dead session
by sending the page to the sign-in route, and the sign-in page never carries the
dead session id, so the only client that presents one on the next call is a client
that never saw the redirect. Measured on this machine, the captured Chrome profile
holds `aws-waf-token` as a PERSISTENT cookie at host `.deepseek.com` with a real
expiry, so the real client does expire these.

The tests pin both halves of the fix: the attributes survive the round-trip, and a
cookie whose own expiry has passed is dropped instead of restored.

Run:  .venv\\Scripts\\python.exe test_ds_direct_cookie_expiry.py
"""
import os
import sys
import time

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


class FakeCookies:
    """A jar that only offers set/get_dict/clear, like the duck-typed test jars."""

    def __init__(self):
        self.d = {}
        self.kwargs_seen = []

    def set(self, k, v, **kw):
        self.kwargs_seen.append(kw)
        self.d[k] = v

    def get_dict(self):
        return dict(self.d)

    def clear(self):
        self.d.clear()


class FakeSess:
    def __init__(self):
        self.cookies = FakeCookies()


class FakeAcct:
    id = "probe@example.com"
    token = "tok"
    mtime = 0.0
    headers = {}

    def __init__(self, cookie):
        self.cookie = cookie


def client_with(sess):
    """A _Client built without __init__, the way the other suites do it."""
    c = object.__new__(ds._Client)
    c.sess = sess
    c.token = ""
    c.account = None
    c.creds_mtime = 0.0
    return c


def main():
    now = time.time()

    print("=== _parse_cookie_field: the legacy flat form ===")
    flat = ds._parse_cookie_field("aws-waf-token=AAA; ds_session_id=BBB")
    check("legacy form yields both cookies", len(flat) == 2, repr(flat))
    check("legacy form carries no domain", all(c["domain"] == "" for c in flat))
    check("legacy form reads as session cookies",
          all(c["expires"] is None for c in flat))
    check("legacy names preserved",
          [c["name"] for c in flat] == ["aws-waf-token", "ds_session_id"])

    print()
    print("=== _parse_cookie_field: the attributed form ===")
    exp = int(now) + 3600
    attr = ("aws-waf-token=AAA; Domain=.deepseek.com; Path=/; Expires=%d; "
            "ds_session_id=BBB; Domain=chat.deepseek.com; Path=/; Expires=%d"
            % (exp, exp))
    parsed = ds._parse_cookie_field(attr)
    check("attributed form yields two cookies", len(parsed) == 2, repr(parsed))
    waf = next((c for c in parsed if c["name"] == "aws-waf-token"), None)
    ses = next((c for c in parsed if c["name"] == "ds_session_id"), None)
    check("the WAF cookie kept its domain",
          waf and waf["domain"] == ".deepseek.com", repr(waf))
    check("the session cookie kept its domain",
          ses and ses["domain"] == "chat.deepseek.com", repr(ses))
    check("the expiry round-tripped as an int",
          waf and waf["expires"] == exp, repr(waf))
    check("the path was kept", waf and waf["path"] == "/", repr(waf))
    check("attributes did not become cookies",
          all(c["name"] not in ("Domain", "Path", "Expires") for c in parsed))

    print()
    print("=== _parse_cookie_field: shapes that must not misfire ===")
    check("empty input yields nothing", ds._parse_cookie_field("") == [])
    check("None input yields nothing", ds._parse_cookie_field(None) == [])
    # A cookie genuinely NAMED expires, appearing first, is a cookie -- an attribute
    # can only follow a cookie it belongs to.
    named = ds._parse_cookie_field("expires=5; other=1")
    check("a leading cookie named 'expires' stays a cookie",
          [c["name"] for c in named] == ["expires", "other"], repr(named))
    # An unreadable date must degrade to "session cookie", never to a crash.
    bad = ds._parse_cookie_field("a=1; Expires=not-a-date")
    check("an unparseable Expires degrades to a session cookie",
          len(bad) == 1 and bad[0]["expires"] is None, repr(bad))
    # A valueless cookie (a bare name) is still a cookie.
    bare = ds._parse_cookie_field("lonely")
    check("a valueless cookie is kept",
          len(bare) == 1 and bare[0]["name"] == "lonely", repr(bare))

    print()
    print("=== _cookie_expired ===")
    check("a session cookie never expires",
          ds._cookie_expired({"expires": None}) is False)
    check("a past expiry is expired",
          ds._cookie_expired({"expires": int(now) - 60}) is True)
    check("a future expiry is not expired",
          ds._cookie_expired({"expires": int(now) + 60}) is False)
    check("the boundary counts as expired",
          ds._cookie_expired({"expires": int(now)}, now=now) is True)

    print()
    print("=== apply_account: the fix itself ===")
    dead = int(now) - 3600
    live = int(now) + 3600
    cookie = ("aws-waf-token=AAA; Domain=.deepseek.com; Path=/; Expires=%d; "
              "ds_session_id=BBB; Domain=chat.deepseek.com; Path=/; Expires=%d"
              % (dead, live))
    sess = FakeSess()
    client_with(sess).apply_account(FakeAcct(cookie))
    jar = sess.cookies.get_dict()
    check("the EXPIRED cookie was NOT restored",
          "aws-waf-token" not in jar, repr(jar))
    check("the live cookie WAS restored",
          "ds_session_id" in jar, repr(jar))
    check("the live cookie's value is intact",
          jar.get("ds_session_id") == "BBB", repr(jar))

    print()
    print("=== apply_account: a legacy flat cookie still installs (back-compat) ===")
    sess2 = FakeSess()
    client_with(sess2).apply_account(FakeAcct("aws-waf-token=OLD; ds_session_id=OLD2"))
    jar2 = sess2.cookies.get_dict()
    check("a flat cookie with no expiry is still restored",
          jar2.get("aws-waf-token") == "OLD" and jar2.get("ds_session_id") == "OLD2",
          repr(jar2))

    print()
    print("=== apply_account: an all-expired cookie leaves the jar empty ===")
    sess3 = FakeSess()
    client_with(sess3).apply_account(FakeAcct(
        "a=1; Expires=%d; b=2; Expires=%d" % (dead, dead)))
    check("nothing expired is restored", sess3.cookies.get_dict() == {},
          repr(sess3.cookies.get_dict()))

    print()
    print("=== cookie_string: the jar's attributes are emitted ===")
    real = None
    try:
        from curl_cffi import requests as cffi
        from http.cookiejar import Cookie
        real = cffi.Session()
        real.cookies.jar.set_cookie(Cookie(
            version=0, name="aws-waf-token", value="AAA", port=None,
            port_specified=False, domain=".deepseek.com", domain_specified=True,
            domain_initial_dot=True, path="/", path_specified=True, secure=True,
            expires=int(now) + 7200, discard=False, comment=None, comment_url=None,
            rest={}, rfc2109=False))
    except Exception as e:  # noqa: BLE001
        print("  SKIP curl_cffi jar checks (%s: %s)" % (type(e).__name__, e))

    if real is not None:
        s = client_with(real).cookie_string()
        check("cookie_string emits the name and value", "aws-waf-token=AAA" in s, s)
        check("cookie_string emits the domain", "Domain=.deepseek.com" in s, s)
        check("cookie_string emits the path", "Path=/" in s, s)
        check("cookie_string emits the expiry", "Expires=" in s, s)
        # And the emitted string must survive a parse back into the same facts.
        back = ds._parse_cookie_field(s)
        check("the emitted string parses back to one cookie", len(back) == 1, repr(back))
        check("the domain survived string -> parse",
              back and back[0]["domain"] == ".deepseek.com", repr(back))
        check("the expiry survived string -> parse",
              back and back[0]["expires"] == int(now) + 7200, repr(back))

    print()
    print("=== cookie_string: a jar with no .jar still works ===")
    flat_sess = FakeSess()
    flat_sess.cookies.d = {"a": "1", "b": "2"}
    out = client_with(flat_sess).cookie_string()
    check("a plain jar falls back to name=value",
          "a=1" in out and "b=2" in out, out)

    print()
    print("=== _install_cookie: a jar that rejects kwargs still gets the value ===")
    class StrictCookies:
        def __init__(self):
            self.d = {}

        def set(self, k, v):
            self.d[k] = v

        def get_dict(self):
            return dict(self.d)

    class StrictSess:
        def __init__(self):
            self.cookies = StrictCookies()

    ss = StrictSess()
    ok = ds._install_cookie(ss, {"name": "x", "value": "y",
                                 "domain": "d", "path": "/", "expires": None})
    check("a kwargs-rejecting jar still installs", ok and ss.cookies.d.get("x") == "y",
          repr(ss.cookies.d))

    print()
    failed = [n for n, ok in CHECKS if not ok]
    print("%d check(s), %d failed" % (len(CHECKS), len(failed)))
    if failed:
        for n in failed:
            print("  FAILED: %s" % n)
        return 1
    print("ALL GREEN")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
