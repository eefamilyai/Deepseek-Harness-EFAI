# Checks for ds_wirelog: the per-request journal that must exist AFTER a mute.
#
# Run from this directory:
#     .venv\Scripts\python.exe test_ds_wirelog.py
#
# The journal's whole purpose is to be readable once something has already gone
# wrong, so the failure modes that matter are the silent ones: writing nothing,
# writing the wrong thing, or leaking a credential into a file that gets pasted
# into reports. Each of those has a check here.
import json
import os
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_wirelog as wl  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print("  %s %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  -- " + str(detail)) if detail and not cond else ""))


def reset(tmp):
    """Point the journal at a fresh directory and drop the cached enabled flag."""
    os.environ["KILN_STATE_DIR"] = tmp
    os.environ.pop("KILN_DS_WIRELOG", None)
    wl._ON = None
    wl._RING[:] = []


def read_lines():
    p = wl.path()
    if not os.path.exists(p):
        return []
    with open(p, encoding="utf-8") as f:
        return [json.loads(l) for l in f if l.strip()]


def main():
    root = tempfile.mkdtemp(prefix="ds-wirelog-test-")
    # The operator may have switched the journal on for this machine. `enabled()`
    # reads the marker, so "off by default" is untestable while one exists. Hide
    # it for the run and restore it in `finally` -- never delete it, and never
    # leave it hidden.
    real_marker = os.path.join(os.path.dirname(os.path.abspath(wl.__file__)),
                               "ds_wirelog.on")
    stashed = real_marker + ".suitebak"
    hid_marker = False
    if os.path.exists(real_marker):
        os.replace(real_marker, stashed)
        hid_marker = True
        wl._ON = None
    try:
        # --- enabled resolution -------------------------------------------------
        print("enabled resolution")
        reset(os.path.join(root, "a"))
        check("off by default (no env, no marker)", not wl.enabled())

        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None
        check("on via KILN_DS_WIRELOG=1", wl.enabled())

        os.environ["KILN_DS_WIRELOG"] = "0"
        wl._ON = None
        check("off via KILN_DS_WIRELOG=0", not wl.enabled())

        os.environ["KILN_DS_WIRELOG"] = "false"
        wl._ON = None
        check("off via KILN_DS_WIRELOG=false", not wl.enabled())

        reset(os.path.join(root, "b"))
        marker = os.path.join(os.path.dirname(os.path.abspath(wl.__file__)),
                              "ds_wirelog.on")
        # Save/restore, never clobber. This marker is an OPERATOR SWITCH: a real
        # one may already exist on the machine, and removing it in `finally`
        # turned the wire journal off for every process started afterwards. Only
        # a marker THIS test created may be removed.
        had_marker = os.path.exists(marker)
        try:
            open(marker, "w").close()
            wl._ON = None
            check("on via ds_wirelog.on marker", wl.enabled())
        finally:
            if not had_marker and os.path.exists(marker):
                os.remove(marker)
            wl._ON = None

        # --- the silent-failure bug: a state dir nobody created -----------------
        print("write path")
        fresh = os.path.join(root, "does", "not", "exist", "yet")
        reset(fresh)
        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None
        check("state dir absent before first write", not os.path.isdir(fresh))
        wl.record("request", account="a@x", seq=1)
        check("record creates the missing parent directory", os.path.isdir(fresh))
        check("and actually writes a line", len(read_lines()) == 1,
              "wrote %d lines" % len(read_lines()))

        # --- disabled means NOTHING is written ----------------------------------
        print("disabled writes nothing")
        reset(os.path.join(root, "c"))
        wl.record("request", account="a@x", seq=1)
        wl.verdict("mute", "user is muted", account="a@x")
        check("no file created while disabled", not os.path.exists(wl.path()))

        # --- fingerprints, never values -----------------------------------------
        print("fingerprints")
        check("fingerprint is 10 hex chars",
              len(wl._fp("Bearer abc")) == 10 and
              all(c in "0123456789abcdef" for c in wl._fp("Bearer abc")))
        check("same value -> same fingerprint",
              wl._fp("Bearer abc") == wl._fp("Bearer abc"))
        check("different value -> different fingerprint",
              wl._fp("Bearer abc") != wl._fp("Bearer abd"))
        check("None stays None (no header)", wl._fp(None) is None)

        names = wl._cookie_names({"cookie": "ds_session_id=SESS; aws-waf-token=WAF"})
        check("cookie NAMES are recorded",
              sorted(names) == ["aws-waf-token", "ds_session_id"])
        check("cookie VALUES are fingerprints",
              "SESS" not in json.dumps(names) and "WAF" not in json.dumps(names))

        # --- the JAR read, which the headers dict cannot replace ------------------
        # curl_cffi applies cookies at the libcurl level, so a request carrying a
        # full jar usually has NO `cookie` header in kwargs. Reading only headers
        # reported "no cookies" on every request -- the worst failure for an
        # investigation into stale-cookie behaviour, because it is silent.
        print("jar cookies (headers cannot replace this)")
        import time as _t

        class Cookie:
            def __init__(self, name, value, expires=None, domain=".deepseek.com"):
                self.name = name
                self.value = value
                self.expires = expires
                self.domain = domain

        class Jar:
            def __init__(self, cookies):
                self._c = cookies
            def __iter__(self):
                return iter(self._c)
            def __len__(self):
                return len(self._c)

        class JarSess:
            def __init__(self, cookies):
                self.cookies = type("C", (), {"jar": Jar(cookies)})()

        now = _t.time()
        js = JarSess([
            Cookie("ds_session_id", "SESSVALUE", now + 3600),
            Cookie("aws-waf-token", "WAFVALUE", now - 7200),
            Cookie("session_only", "SESSCOOKIE", None),
        ])
        jar = wl._jar_cookies(js)
        check("all three jar cookies seen", sorted(jar) ==
              ["aws-waf-token", "ds_session_id", "session_only"], sorted(jar))
        check("live cookie not marked expired", jar["ds_session_id"]["expired"] is False)
        check("lapsed cookie IS marked expired", jar["aws-waf-token"]["expired"] is True)
        check("age of the lapsed cookie is ~7200 s",
              abs(jar["aws-waf-token"]["age_s"] - 7200) <= 2,
              jar["aws-waf-token"]["age_s"])
        check("session cookie has no expiry",
              jar["session_only"]["expires"] is None and
              jar["session_only"]["expired"] is False)
        check("domain recorded", jar["ds_session_id"]["domain"] == ".deepseek.com")
        check("jar cookie VALUES are fingerprints, not values",
              jar["ds_session_id"]["fp"] == wl._fp("SESSVALUE") and
              "SESSVALUE" not in json.dumps(jar))

        check("no jar at all -> empty, not a crash",
              wl._jar_cookies(type("S", (), {"cookies": None})()) == {})
        check("jar that raises -> empty, not a crash",
              wl._jar_cookies(type("S", (), {"cookies": type("C", (), {
                  "jar": property(lambda self: (_ for _ in ()).throw(RuntimeError("x")))
              })()})()) == {})

        # --- url + size helpers --------------------------------------------------
        print("helpers")
        check("scheme and query stripped",
              wl._path_of("https://chat.deepseek.com/a/b?c=d") ==
              "chat.deepseek.com/a/b")
        check("http scheme too",
              wl._path_of("http://x/y") == "x/y")
        check("body size of a dict is its JSON length",
              wl._size({"a": 1}) == len(json.dumps({"a": 1})))
        check("body size of None is 0", wl._size(None) == 0)

        # --- the point of the module: verdict + preamble -------------------------
        print("verdict carries its preamble")
        reset(os.path.join(root, "d"))
        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None
        for i in range(3):
            wl.record("request", account="a@x", seq=i, path="chat.deepseek.com/chat/completion")
        wl.verdict("mute", "user is muted (until X)", account="a@x")
        lines = read_lines()
        check("verdict is the last line", lines[-1]["kind"] == "verdict")
        check("verdict records the detail", "muted" in lines[-1]["detail"])
        check("verdict carries ALL 3 preceding requests",
              len(lines[-1]["preamble"]) == 3,
              "preamble=%d" % len(lines[-1]["preamble"]))
        check("preamble entries are the requests themselves",
              all(p["kind"] == "request" for p in lines[-1]["preamble"]))

        # --- ring is bounded ------------------------------------------------------
        print("ring is bounded")
        reset(os.path.join(root, "e"))
        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None
        for i in range(wl._RING_MAX + 25):
            wl.record("request", account="a@x", seq=i)
        check("ring does not grow past the cap",
              len(wl._RING) == wl._RING_MAX, "ring=%d" % len(wl._RING))
        wl.verdict("mute", "x", account="a@x")
        check("preamble is capped at the ring size",
              len(read_lines()[-1]["preamble"]) <= wl._RING_MAX)

        # --- install() wraps the ONE method get/post both use ----------------------
        print("install wraps get/post through request")
        reset(os.path.join(root, "f"))
        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None

        class Resp:
            status_code = 200
            headers = {"content-type": "text/event-stream"}

        class Sess:
            def __init__(self):
                self.calls = []
            def request(self, method, url, **kw):
                self.calls.append((method, url))
                return Resp()
            def get(self, url, **kw):
                return self.request("GET", url, **kw)
            def post(self, url, **kw):
                return self.request("POST", url, **kw)

        s = Sess()
        wl.install(s, account="a@x")
        s.get("https://chat.deepseek.com/client/settings",
              headers={"cookie": "ds_session_id=SECRETVALUE"})
        s.post("https://chat.deepseek.com/chat/completion",
               headers={"authorization": "Bearer SECRETTOKEN",
                        "cookie": "aws-waf-token=WAFSECRET"},
               json={"chat_session_id": "s1"}, stream=True)
        lines = read_lines()
        reqs = [l for l in lines if l["kind"] == "request"]
        resps = [l for l in lines if l["kind"] == "response"]
        check("both get and post were journaled", len(reqs) == 2, "reqs=%d" % len(reqs))
        check("both responses were journaled", len(resps) == 2, "resps=%d" % len(resps))
        check("method recorded", reqs[1]["method"] == "POST")
        check("path recorded without scheme",
              reqs[1]["path"] == "chat.deepseek.com/chat/completion")
        check("stream flag recorded", reqs[1]["stream"] is True)
        check("body KEYS recorded, not body",
              reqs[1]["body_keys"] == ["chat_session_id"])
        check("cookies seen on both calls",
              reqs[0]["cookie_names"] == {"ds_session_id": wl._fp("SECRETVALUE")})

        raw = open(wl.path(), encoding="utf-8").read()
        check("LEAK: bearer token absent", "SECRETTOKEN" not in raw)
        check("LEAK: cookie value absent", "SECRETVALUE" not in raw)
        check("LEAK: waf token absent", "WAFSECRET" not in raw)

        # --- install is idempotent (pooled clients share a session) -----------------
        print("install is idempotent")
        reset(os.path.join(root, "g"))
        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None
        s2 = Sess()
        wl.install(s2, account="a@x")
        wl.install(s2, account="a@x")
        s2.get("https://x/y", headers={})
        check("double install does not double-log",
              len([l for l in read_lines() if l["kind"] == "request"]) == 1)

        # --- an error on the wire is recorded, then re-raised -----------------------
        print("transport error is recorded and re-raised")
        reset(os.path.join(root, "h"))
        os.environ["KILN_DS_WIRELOG"] = "1"
        wl._ON = None

        class Boom(Sess):
            def request(self, method, url, **kw):
                raise ConnectionError("socket died")

        b = Boom()
        wl.install(b, account="a@x")
        raised = False
        try:
            b.get("https://x/y", headers={})
        except ConnectionError:
            raised = True
        check("the original exception still propagates", raised)
        errs = [l for l in read_lines() if l["kind"] == "error"]
        check("the failure was journaled", len(errs) == 1, "errs=%d" % len(errs))
        check("error type recorded", errs[0]["error"] == "ConnectionError")

    finally:
        shutil.rmtree(root, ignore_errors=True)
        os.environ.pop("KILN_DS_WIRELOG", None)
        os.environ.pop("KILN_STATE_DIR", None)
        if hid_marker and os.path.exists(stashed):
            os.replace(stashed, real_marker)
        wl._ON = None

    failed = [c for c in CHECKS if not c[1]]
    print("\n%d check(s), %d failed" % (len(CHECKS), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
