#!/usr/bin/env python
"""Regression tests for ds_direct / ds_waf device identity.

Run:  python test_ds_identity.py

Everything here is OFFLINE. What these pin is the reason a second machine got
"too many requests" and flagged-device responses while sharing one address:

  * the login `device_id` must be the SAME value on every attempt, because it
    was minted fresh per login and a token refresh therefore presented as a
    brand-new device joining the account;
  * the browser must describe itself consistently -- the TLS fingerprint, the
    User-Agent and the client hints have to name ONE build, because a macOS
    Chrome 120 handshake under a Windows Chrome 134 UA is a combination no real
    browser emits;
  * the WAF fingerprint (canvas hash, GPU) must REPEAT exactly between
    challenges, because a real browser returns the same canvas every time.

No credentials and nothing off the machine: the one test that needs to see real
request headers points a request at a loopback server this file starts itself.
"""
import os
import re
import shutil
import sys
import tempfile
import uuid

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Point the identity at a scratch directory BEFORE importing: the module reads
# KILN_IDENTITY_DIR at call time, and a test must not touch the real identity.
# KILN_STATE_DIR is set too, because that is where the pre-move seed lived and
# the adoption path reads it.
_SCRATCH = tempfile.mkdtemp(prefix="ds-identity-test-")
_IDENTITY_SCRATCH = os.path.join(_SCRATCH, "identity")
os.environ["KILN_STATE_DIR"] = _SCRATCH
os.environ["KILN_IDENTITY_DIR"] = _IDENTITY_SCRATCH

import ds_identity as di          # noqa: E402
import ds_direct as dd            # noqa: E402
import ds_waf as dw               # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


# ── curl_cffi is the authority on the browser -------------------------------
# `ds_identity` states a User-Agent and a client-hint triple; curl_cffi supplies
# the TLS handshake that must belong to the SAME build. Nothing in this file can
# assert that pairing from a literal, because a bumped dependency changes what is
# really sent while a hardcoded string keeps passing. So these read curl_cffi's
# own tables and the headers it actually emits, and hold `ds_identity` to them.
# An oracle that cannot answer FAILS these checks rather than skipping them:
# a probe that silently returns "" would fail against a correct identity and
# would also pass a drifted one, which is the whole failure this guards.
def _cffi_targets():
    """Every impersonation target curl_cffi advertises, or () if unavailable."""
    try:
        from curl_cffi.requests.impersonate import BrowserType
        return tuple(b.value for b in BrowserType)
    except Exception as exc:                      # pragma: no cover
        print("      (curl_cffi target table unavailable: %s)" % exc)
        return ()


def _cffi_default_chrome():
    """The desktop-Chrome build curl_cffi treats as current."""
    try:
        from curl_cffi.requests.impersonate import DEFAULT_CHROME
        return DEFAULT_CHROME
    except Exception:                             # pragma: no cover
        return None


def _cffi_sends(target):
    """(user-agent, sec-ch-ua-platform, sec-ch-ua) curl_cffi sends for `target`.

    Read off a real request, because no cheaper answer is honest. curl_cffi
    0.16.2 keeps the impersonation header set inside the compiled
    libcurl-impersonate and applies it while the request is built, so
    `Session(impersonate=...).headers` is EMPTY until the request goes out and
    reading it returns "" for every header -- which fails these checks against a
    correct identity.

    The request does not leave the machine: the server is a thread on an
    ephemeral port bound to 127.0.0.1, and port 0 keeps concurrent runs from
    colliding. No external network, no credentials.
    """
    import http.server
    import threading

    seen = {}

    class _Echo(http.server.BaseHTTPRequestHandler):
        def do_GET(self):
            seen.update({k.lower(): v for k, v in self.headers.items()})
            self.send_response(200)
            self.send_header("Content-Length", "2")
            self.end_headers()
            self.wfile.write(b"{}")

        def log_message(self, *args):
            pass

    try:
        from curl_cffi import requests as _r

        server = http.server.HTTPServer(("127.0.0.1", 0), _Echo)
        try:
            threading.Thread(target=server.serve_forever, daemon=True).start()
            session = _r.Session(impersonate=target)
            try:
                session.get("http://127.0.0.1:%d/" % server.server_address[1],
                            timeout=10)
            finally:
                session.close()
        finally:
            server.shutdown()
            server.server_close()
    except Exception as exc:
        print("      (curl_cffi header probe failed for %r: %s)" % (target, exc))
        return ("", "", "")

    return (seen.get("user-agent", ""), seen.get("sec-ch-ua-platform", ""),
            seen.get("sec-ch-ua", ""))



try:
    # ── the seed ────────────────────────────────────────────────────
    seed_a = di.seed()
    check("the seed persists", len(seed_a) >= 32, repr(len(seed_a)))
    check("the seed is stable across calls", di.seed() == seed_a)

    di._seed_cache.clear()            # force a re-read from disk
    check("the seed survives a cache reset", di.seed() == seed_a,
          "a re-read produced a different seed, so the file did not persist")

    # ── device_id ───────────────────────────────────────────────────
    dev_a = di.device_id()
    di._seed_cache.clear()
    check("device_id is stable across processes (same seed)",
          di.device_id() == dev_a)
    check("device_id is stable within a process",
          di.device_id() == di.device_id())
    check("device_id is 32 hex chars", len(dev_a) == 32 and
          all(c in "0123456789abcdef" for c in dev_a), repr(dev_a))
    check("device_id is not the seed itself", dev_a != seed_a)

    # Two DIFFERENT seeds must give different device ids, or every machine
    # would look identical to DeepSeek.
    other = os.path.join(_SCRATCH, "other")
    os.makedirs(other, exist_ok=True)
    os.environ["KILN_IDENTITY_DIR"] = other
    di._seed_cache.clear()
    check("a different seed yields a different device_id",
          di.device_id() != dev_a, "two machines would share one device_id")
    os.environ["KILN_IDENTITY_DIR"] = _IDENTITY_SCRATCH
    di._seed_cache.clear()

    # ── a REAL device_id is replayed verbatim ───────────────────────
    # The derived fallback above is stable, but it is NOT a Shumei
    # fingerprint: no SDK ever produces it, so DeepSeek reads it as an unknown
    # device. A configured or captured value must therefore reach the login
    # payload UNCHANGED -- hashing it, truncating it or "deriving" from it puts
    # the connector straight back where it started.
    REAL = ("BdQNjmtlDqa0FTFU7mQKwc5VqKKTaIzQuhev79oEmf9dJPQgY24bGBqjLuUZ2nv6d"
            "PaBsLuCULkcRwLQSctydZg==")
    os.environ.pop("DEEPSEEK_DEVICE_ID", None)

    check("nothing configured reports derived",
          di.device_id_status()["configured"] is False,
          repr(di.device_id_status()))
    check("the derived status carries a warning",
          bool(di.device_id_status().get("warning")))

    di.set_device_id(REAL, source="manual")
    check("a configured device_id is returned verbatim",
          di.device_id() == REAL,
          "got %r" % (di.device_id()[:24],))
    check("the configured value replaced the derived one", di.device_id() != dev_a)
    check("status reports manual",
          di.device_id_status()["source"] == "manual",
          repr(di.device_id_status()))
    check("status does not echo the value",
          REAL not in repr(di.device_id_status()))
    check("the device_id is persisted next to the seed",
          os.path.exists(di.device_path()))

    # A value that is the wrong SHAPE is refused rather than sent. Presenting a
    # malformed one earns `code=40029 TOO_MANY_REQUESTS`, which reads like rate
    # limiting and sends the operator looking in the wrong place entirely.
    for bad, label in (("", "empty"), ("abc", "too short"),
                       ("has spaces in it", "whitespace"), ("x" * 600, "too long")):
        try:
            di.set_device_id(bad)
            check("a %s device_id is refused" % label, False, "it was accepted")
        except ValueError:
            check("a %s device_id is refused" % label, True)

    # The runtime override outranks the file, and removing it falls back.
    os.environ["DEEPSEEK_DEVICE_ID"] = "ENVOVERRIDEvalue1234567890"
    check("the env override outranks the stored value",
          di.device_id() == "ENVOVERRIDEvalue1234567890")
    check("status reports env", di.device_id_status()["source"] == "env")
    os.environ.pop("DEEPSEEK_DEVICE_ID", None)
    check("the stored value returns when the override clears",
          di.device_id() == REAL)

    # ── ds_direct presents it on the login payload ──────────────────
    # The account carries its own slot, and an account with none inherits the
    # machine identity -- the fingerprint belongs to the DEVICE, so an operator
    # who set it once should not have to repeat it per account.
    acct = dd._Account(id="probe@example.com", email="probe@example.com",
                       password="x", source=("probe",))
    check("an account with no device_id inherits the machine identity",
          dd._device_id_for(acct) == REAL, repr(dd._device_id_for(acct)))
    acct.device_id = "PERACCOUNTvalue1234567890"
    check("a per-account device_id wins over the machine identity",
          dd._device_id_for(acct) == "PERACCOUNTvalue1234567890",
          repr(dd._device_id_for(acct)))
    acct.device_id = ""
    check("clearing the account slot falls back to the machine identity",
          dd._device_id_for(acct) == REAL)

    # The account list must carry a configured id through a load, or a restart
    # silently reverts to the derived value.
    dd._load_accounts(force=True)
    check("a loaded account resolves a real device_id",
          all(dd._device_id_for(a) == REAL for a in dd._accounts),
          repr([dd._device_id_for(a)[:12] for a in dd._accounts]))

    # ── the browser identity is one browser ─────────────────────────
    check("ds_direct and ds_identity agree on the User-Agent",
          dd.UA == di.UA)
    check("ds_waf and ds_identity agree on the User-Agent",
          dw._UA == di.UA)
    check("ds_direct impersonates what ds_identity names",
          dd.IMPERSONATE == di.IMPERSONATE)

    # A macOS TLS fingerprint must not carry a Windows User-Agent. That
    # contradiction is what this fork shipped, and it is the shape an anti-bot
    # signal is built to catch.
    #
    # The VERSION is not asserted literally. curl_cffi owns both the TLS
    # handshake and the default headers, so a bumped dependency silently
    # changes what is really sent, and a hardcoded "120" would keep passing
    # while the identity drifted. These checks read curl_cffi's own answer and
    # hold `ds_identity` to it.
    ua = di.UA
    check("the User-Agent is a macOS build", "Macintosh" in ua, repr(ua))
    check("ds_direct impersonates a target curl_cffi actually ships",
          di.IMPERSONATE in _cffi_targets(),
          "%r is not in curl_cffi's table; every request would raise"
          % di.IMPERSONATE)
    check("the impersonation is curl_cffi's newest desktop Chrome",
          di.IMPERSONATE == _cffi_default_chrome(),
          "curl_cffi defaults to %r; naming an older build is the stale-client"
          " signal this exists to avoid" % _cffi_default_chrome())

    # What curl_cffi REALLY sends for the named target, which is the only
    # authority on the handshake/header pair.
    real_ua, real_plat, real_brands = _cffi_sends(di.IMPERSONATE)
    # Without this, a probe that quietly returned nothing would read as the
    # identity being wrong -- which is exactly the mistake this file exists to
    # catch, aimed the wrong way.
    check("curl_cffi's own headers could be observed at all",
          bool(real_ua and real_plat and real_brands),
          "\n    user-agent: %r\n    sec-ch-ua-platform: %r\n    sec-ch-ua: %r"
          "\n    (an empty result means the probe is broken, not the identity)"
          % (real_ua, real_plat, real_brands))
    check("the User-Agent matches what curl_cffi sends",
          real_ua == ua, "\n    ours: %s\n    real: %s" % (ua, real_ua))
    check("the client hints name the same Chrome as the User-Agent",
          real_brands == di.SEC_CH_UA,
          "\n    ours: %s\n    real: %s" % (di.SEC_CH_UA, real_brands))
    # Pull the version out of each place it is stated instead of slicing the
    # brand list: the list carries three brands plus a grease entry, and the one
    # naming Chrome is not at a stable offset, so an index picks the wrong one.
    _ua_ver = re.search(r"Chrome/(\d+)", ua)
    _brand_vers = re.findall(r'"(?:Google Chrome|Chromium)";v="(\d+)"',
                             di.SEC_CH_UA)
    check("the UA version and the hint brands are the same Chrome",
          bool(_ua_ver) and len(_brand_vers) == 2
          and _ua_ver.group(1) == _brand_vers[0] == _brand_vers[1],
          "\n    UA says Chrome %s\n    hints say %s"
          % (_ua_ver.group(1) if _ua_ver else "nothing", _brand_vers or "nothing"))
    check("the client hints name the same platform as the User-Agent",
          real_plat == di.SEC_CH_UA_PLATFORM == '"%s"' % di.PLATFORM,
          "\n    hints: %s\n    real:  %s\n    derived: %s"
          % (di.SEC_CH_UA_PLATFORM, real_plat, di.PLATFORM))

    # ── the client headers identify a shipped build ─────────────────
    # These are not browser facts and no fingerprint contains them, so curl_cffi
    # cannot check them: they name the chat APPLICATION, and only a capture of a
    # real request knows the value. What is assertable is that they are present,
    # internally consistent, and not the retired build this fork used to send.
    ch = di.client_headers()
    check("the client headers carry a version",
          bool(ch.get("x-client-version")), repr(ch))
    check("the client headers are not the retired 2.3.0 build",
          ch.get("x-client-version") != "2.3.0",
          "2.3.0 is the version this fork shipped before the login capture")
    check("the client headers name the web platform",
          ch.get("x-client-platform") == "web", repr(ch))
    check("the timezone offset is a real offset, not a pinned constant",
          -12 * 3600 <= int(ch["x-client-timezone-offset"]) <= 14 * 3600,
          repr(ch.get("x-client-timezone-offset")))
    check("the timezone offset is this machine's, read from the clock",
          int(ch["x-client-timezone-offset"]) == di.timezone_offset())

    headers = dd._Client(None)._headers()
    check("the request carries the shared User-Agent",
          headers.get("user-agent") == di.UA, repr(headers.get("user-agent")))
    check("the request carries matching client hints",
          headers.get("sec-ch-ua") == di.SEC_CH_UA
          and headers.get("sec-ch-ua-platform") == di.SEC_CH_UA_PLATFORM)
    # A client that omits the sec-fetch group is not shaped like a browser:
    # Chrome attaches it to every request it makes, the login POST included.
    check("the request carries the sec-fetch metadata Chrome always sends",
          headers.get("sec-fetch-dest") == "empty"
          and headers.get("sec-fetch-mode") == "cors"
          and headers.get("sec-fetch-site") == "same-origin",
          repr({k: v for k, v in headers.items() if k.startswith("sec-fetch")}))
    check("the request carries the client headers",
          headers.get("x-client-version") == ch["x-client-version"]
          and headers.get("x-client-timezone-offset") == ch["x-client-timezone-offset"])
    login_headers = dd._Client(None)._login_headers()
    check("the login request carries the same User-Agent",
          login_headers.get("user-agent") == di.UA)
    check("the login request carries matching client hints",
          login_headers.get("sec-ch-ua") == di.SEC_CH_UA)
    check("the login request carries the client headers",
          login_headers.get("x-client-version") == ch["x-client-version"])
    check("the login request carries the sec-fetch metadata",
          login_headers.get("sec-fetch-dest") == "empty"
          and login_headers.get("sec-fetch-site") == "same-origin")
    # The real client posts /users/login from the sign-in page, so its referer
    # is /sign_in. Sending "/" is a shape the website never produces.
    check("the login referer is the sign-in page",
          login_headers.get("referer", "").endswith("/sign_in"),
          repr(login_headers.get("referer")))
    check("a login never carries a Bearer token",
          "authorization" not in {k.lower() for k in login_headers},
          "an expired token on a fresh login is itself the failure being fixed")

    # ── the chat paths send the TRIPLE, not the high-entropy nine ───
    # Chrome sends the six high-entropy hints only to an origin that granted
    # them via Accept-CH. Measured against chat.deepseek.com with real desktop
    # Chrome: no response and no meta tag carries that grant, and Chrome sends
    # the triple on every request. Six hints this origin never asked for
    # describe a browser state that cannot exist here.
    triple = di.client_hints()
    check("the chat hint set is the triple", len(triple) == 3, repr(sorted(triple)))
    _extra = set(di.client_hint_extras())
    for name, hdrs in (("the request", headers), ("the login request", login_headers)):
        check("%s carries the client-hint triple" % name,
              all(hdrs.get(k) == v for k, v in triple.items()),
              repr({k: hdrs.get(k) for k in triple if hdrs.get(k) != triple[k]}))
        leaked = sorted(_extra & set(hdrs))
        check("%s sends NO ungranted high-entropy hint" % name, not leaked,
              "this origin grants no Accept-CH, so these advertise a browser "
              "state that cannot exist: %s" % leaked)

    # The high-entropy half is DERIVED from the User-Agent, so the version in
    # the hint and the version in the UA cannot drift apart. Nothing on the chat
    # path sends it (see above), but the derivation is still held to the UA here
    # so it stays sound for any origin that DOES grant the set.
    full = di.client_hints_full()
    check("the derivable set is still the triple plus six extras",
          len(full) == 9 and set(full) == set(di.client_hints()) | _extra,
          repr(sorted(full)))
    check("the full-version hint is the User-Agent's version",
          full["sec-ch-ua-full-version"] == '"%s"' % di._ua_version(),
          "%s vs UA %s" % (full["sec-ch-ua-full-version"], di._ua_version()))
    check("the full-version LIST repeats the same brands as sec-ch-ua",
          all(b in full["sec-ch-ua-full-version-list"] for b in ("Google Chrome",
                                                                "Chromium")),
          repr(full["sec-ch-ua-full-version-list"]))
    check("the model hint is empty on desktop, like a real desktop Chrome",
          full["sec-ch-ua-model"] == '""', repr(full["sec-ch-ua-model"]))
    check("the arch hint agrees with the macOS User-Agent",
          full["sec-ch-ua-arch"] == '"x86"', repr(full["sec-ch-ua-arch"]))
    check("the platform-version hint is a dotted OS version",
          re.fullmatch(r'"\d+(?:\.\d+)+"', full["sec-ch-ua-platform-version"]),
          repr(full["sec-ch-ua-platform-version"]))

    # ── the device headers: present on chat, on every request ───────
    # Both ride 47/47 chat.deepseek.com requests in the capture. Omitting one is
    # the loudest version of the mismatch, so neither may be absent.
    for name, hdrs in (("the request", headers), ("the login request", login_headers)):
        check("%s carries x-device-model" % name,
              "x-device-model" in hdrs, repr(sorted(hdrs)))
        check("%s sends x-device-model empty" % name,
              hdrs.get("x-device-model") == "",
              "the browser sends this header with an empty value on desktop")
        check("%s carries x-device-id" % name,
              bool(hdrs.get("x-device-id")), repr(sorted(hdrs)))

    # It is a UUID and it is STABLE, so an account without a captured profile
    # keeps one device identity instead of a new one per launch.
    derived = di.derived_x_device_id()
    check("the derived x-device-id is a UUID",
          bool(uuid.UUID(derived)), repr(derived))
    check("the derived x-device-id is stable across calls",
          di.derived_x_device_id() == derived)
    check("the fallback keeps the UUID shape on the wire",
          bool(uuid.UUID(headers["x-device-id"])), repr(headers["x-device-id"]))
    # It must NOT be the Shumei device_id: those are two different identifiers
    # and a real browser never sends one as the other.
    check("x-device-id is not the Shumei device_id",
          headers["x-device-id"] != di.device_id(),
          "the login body id and the header id are separate values")
    check("device_model() is the empty string",
          di.device_model() == "", repr(di.device_model()))

    # A captured per-account value must WIN over the derived fallback, or the
    # whole per-profile identity machinery is bypassed.
    probe = dd._Account(id="xdev-probe@example.com", email="xdev-probe@example.com",
                        password="x", source=("probe",))
    captured = "11111111-2222-3333-4444-555555555555"
    import ds_profile as dp
    dp.write_account_identity(dd._account_key(probe), {"x_device_id": captured})
    check("a captured per-account x-device-id wins over the fallback",
          dd._extra_identity_headers(probe).get("x-device-id") == captured,
          repr(dd._extra_identity_headers(probe)))
    check("a captured identity still carries x-device-model",
          "x-device-model" in dd._extra_identity_headers(probe))

    # ── no navigation-only headers on an XHR ────────────────────────
    # curl_cffi shapes a request like a browser NAVIGATION and adds these. No
    # fetch the chat page makes carries either: sec-fetch-user is absent from
    # all 47 chat requests, upgrade-insecure-requests from all 374 entries.
    check("the navigation-only header set is declared",
          set(dd._NOT_A_NAVIGATION) == {"sec-fetch-user",
                                        "upgrade-insecure-requests"},
          repr(dd._NOT_A_NAVIGATION))
    check("a None value is what removes a curl_cffi default",
          all(v is None for v in dd._NOT_A_NAVIGATION.values()),
          "an empty string would SEND the header blank instead of dropping it")
    for name, hdrs in (("the request", headers), ("the login request", login_headers)):
        # curl_cffi DROPS a default by being handed ``None``, so the key is
        # present in the dict and its value is None. Asserting absence would
        # fail a correct implementation; assert the None.
        check("%s drops sec-fetch-user" % name,
              "sec-fetch-user" in hdrs and hdrs["sec-fetch-user"] is None,
              repr(hdrs.get("sec-fetch-user", "<absent>")))
        check("%s drops upgrade-insecure-requests" % name,
              "upgrade-insecure-requests" in hdrs
              and hdrs["upgrade-insecure-requests"] is None,
              repr(hdrs.get("upgrade-insecure-requests", "<absent>")))
        # The sec-fetch triple Chrome DOES send must survive.
        check("%s keeps the sec-fetch triple" % name,
              hdrs.get("sec-fetch-dest") == "empty"
              and hdrs.get("sec-fetch-mode") == "cors",
              repr({k: v for k, v in hdrs.items() if k.startswith("sec-fetch")}))

    # ── an empty token is not a token ──────────────────────────────
    # `Bearer ` with nothing after it is a shape the browser never emits, and
    # it is what an expired-token retry looked like -- one more "not the
    # website" marker, sent exactly when the request is already suspect.
    bare_client = dd._Client.__new__(dd._Client)
    bare_client.token = ""
    bare_client.account = None
    bare_client.sess = None
    check("an empty token sends no authorization header",
          "authorization" not in bare_client._headers(),
          repr(bare_client._headers().get("authorization")))
    bare_client.token = "REALTOKENvalue"
    check("a real token is sent as a Bearer",
          bare_client._headers().get("authorization") == "Bearer REALTOKENvalue",
          repr(bare_client._headers().get("authorization")))

    # ── the WAF fingerprint repeats ─────────────────────────────────
    a = dw._build_signal({"capabilities": 3})
    b = dw._build_signal({"capabilities": 3})
    check("the canvas hash repeats between challenges",
          a["canvas"]["hash"] == b["canvas"]["hash"],
          "a per-challenge canvas hash is itself a bot signal")
    check("the canvas histogram repeats between challenges",
          a["canvas"]["histogramBins"] == b["canvas"]["histogramBins"])
    check("the GPU repeats between challenges",
          a["gpu"] == b["gpu"])

    # These MUST still vary, or the envelope looks frozen. Timings live in
    # _build_metrics -- _build_signal only echoes the fp_metrics it is handed,
    # so comparing two signals built from one dict would prove nothing.
    check("the signal envelope id still varies",
          a["id"] != b["id"], "a constant id would look replayed")
    m_a, fp_a = dw._build_metrics(has_token=False)
    m_b, fp_b = dw._build_metrics(has_token=False)
    check("collector timings still vary",
          m_a != m_b, "frozen timings look synthetic")
    check("the per-challenge metrics reach the signal",
          dw._build_signal(fp_a)["metrics"] == fp_a,
          "_build_signal must carry the metrics it was given")

    # ── the WAF path describes the same browser ────────────────────
    # The headers the WAF challenge is solved under are the SAME identity.
    # A hardcoded pair here is how the fingerprint drifted: the signal claimed
    # Windows Chrome 134 while the request that delivered it was macOS
    # Chrome 120.
    nav = dw._nav_headers()
    check("the WAF navigation carries matching client hints",
          nav.get("sec-ch-ua") == di.SEC_CH_UA
          and nav.get("sec-ch-ua-platform") == di.SEC_CH_UA_PLATFORM,
          repr({k: v for k, v in nav.items() if k.startswith("sec-ch-ua")}))
    check("the WAF navigation carries the shared User-Agent",
          nav.get("user-agent") == di.UA)
    api = dw._api_headers(True)
    check("the WAF api call carries matching client hints",
          api.get("sec-ch-ua") == di.SEC_CH_UA
          and api.get("sec-ch-ua-platform") == di.SEC_CH_UA_PLATFORM)
    check("the WAF api call carries the shared User-Agent",
          api.get("user-agent") == di.UA)

    # The platform is derived from the User-Agent, not restated beside it, so
    # the two cannot disagree.
    check("the platform is read out of the User-Agent",
          di.PLATFORM == "macOS", repr(di.PLATFORM))
    check("the client-hint platform matches the derived platform",
          di.SEC_CH_UA_PLATFORM == '"%s"' % di.PLATFORM,
          "%s vs %s" % (di.SEC_CH_UA_PLATFORM, di.PLATFORM))

    # ── the GPU cannot contradict the platform ──────────────────────
    # A WebGL renderer string is platform evidence: Direct3D11 only exists on
    # Windows, an ANGLE Metal renderer only on macOS. Both shipped entries were
    # Windows renderers, so every macOS challenge presented a Windows GPU.
    check("the GPU pool is tagged by platform",
          all("platform" in g for g in dw._GPU_POOL),
          "an untagged pool cannot be filtered")
    picked = di.gpu_for_platform(dw._GPU_POOL)
    check("the platform filter keeps only this platform's GPUs",
          picked and all(g["platform"] == di.PLATFORM for g in picked),
          repr([g.get("platform") for g in picked]))
    check("a macOS identity has a macOS GPU to present",
          any(g["platform"] == "macOS" for g in dw._GPU_POOL),
          "filtering would have fallen back to a Windows renderer")
    for g in picked:
        check("the macOS GPU is not a Windows renderer: %s" % g["model"][:38],
              "Direct3D11" not in g["model"] and "PCIe/SSE2" not in g["model"],
              "a Windows renderer under a macOS UA contradicts the request")
    # An unknown platform must not raise; a weaker signal beats a crash.
    check("the filter falls back rather than raising",
          di.gpu_for_platform([{"platform": "Plan9", "vendor": "v", "model": "m"}])
          == [{"platform": "Plan9", "vendor": "v", "model": "m"}])

    # ── a refused DEVICE is not a bad credential ────────────────────
    # DeepSeek answers /users/login with HTTP 200, code 0/11,
    # RISK_DEVICE_DETECTED when the anti-abuse stack distrusts the machine.
    # Classifying that as an auth failure made the caller rotate accounts,
    # posting a fresh login for every credential in ds_config.json.
    risk = ("login rejected — HTTP 200, code=0/11 RISK_DEVICE_DETECTED")
    check("a device verdict is recognised", dd._is_device_risk(risk))
    check("the code=0/11 biz_msg alone is recognised",
          dd._is_device_risk("0/11 RISK_DEVICE_DETECTED"))
    check("a device verdict is recognised case-insensitively",
          dd._is_device_risk("risk_device_detected"))
    check("an ordinary refusal is not a device verdict",
          not dd._is_device_risk("login rejected — HTTP 200, code=1/1 wrong password"))
    check("a WAF refusal is not a device verdict",
          not dd._is_device_risk("login blocked by AWS WAF"))
    check("an empty message is not a device verdict",
          not dd._is_device_risk("") and not dd._is_device_risk(None))

    # The pool must not rotate on it, and the retry loop must not re-login.
    import inspect as _inspect
    src_direct_all = _inspect.getsource(dd)
    check("the rotation path checks the device verdict",
          "last_login_device_risk" in src_direct_all,
          "without this the pool burns every account on one device verdict")
    check("the device verdict is recorded at the login rejection",
          "_is_device_risk(detail)" in src_direct_all)
    check("the device verdict is cleared on a successful login",
          "self.last_login_device_risk = False" in src_direct_all)
    check("a device verdict raises instead of rotating",
          "refused this device" in src_direct_all)

    # ── the seed is per MACHINE, not per launch directory ───────────
    # `KILN_STATE_DIR` is `<cwd>/.kiln_kernel_state`, so a state-scoped seed
    # gave one computer a different device_id per launch directory: the same
    # machine presented as several devices, which is the signal being fixed.
    check("the identity lives outside the launch-directory state dir",
          os.path.abspath(di.identity_dir()) != os.path.abspath(di.state_dir()),
          "identity_dir must not follow KILN_STATE_DIR")
    check("identity_dir honours KILN_IDENTITY_DIR",
          di.identity_dir() == os.environ["KILN_IDENTITY_DIR"])
    check("the seed file is inside identity_dir",
          di.identity_path() == os.path.join(di.identity_dir(), "ds_identity.json"))

    # The decisive property: changing KILN_STATE_DIR (what a different launch
    # directory produces) must NOT change the device_id. Compared against the
    # value in force HERE, not against `dev_a`: the block above deliberately
    # configures a real Shumei id, which is the value that must survive.
    _saved_state = os.environ.get("KILN_STATE_DIR")
    _before_cwd_switch = di.device_id()
    os.environ["KILN_STATE_DIR"] = os.path.join(_SCRATCH, "some-other-cwd-state")
    di._seed_cache.clear()
    check("the device_id survives a different launch directory",
          di.device_id() == _before_cwd_switch,
          "one machine minted a second device_id from another cwd")
    check("a configured device_id is not re-derived from the state dir",
          di.device_id() == REAL,
          "a launch-directory change discarded the configured id")
    os.environ["KILN_STATE_DIR"] = _saved_state
    di._seed_cache.clear()

    # ── the plugin list must match the platform ─────────────────────
    # A PDF-plugin list is platform evidence the same way a GPU string is: the
    # Edge entry exists only on Windows and the WebKit entry only on
    # macOS/WebKit builds, so the Windows list under a macOS UA advertises a
    # browser that cannot exist.
    check("the plugin pool is tagged by platform",
          all("platform" in e for e in dw._PLUGIN_POOL),
          "an untagged pool cannot be filtered")
    sel_plugins = di.plugins_for_platform(dw._PLUGIN_POOL)
    names = [p["name"] for p in sel_plugins]
    check("the plugin list is non-empty", bool(names), repr(names))
    if di.PLATFORM == "macOS":
        check("a macOS identity does not advertise a Windows-only plugin",
              not any("Edge" in n for n in names),
              "the Edge PDF viewer exists only on Windows: " + repr(names))
    check("the plugins_for_platform fallback does not raise",
          di.plugins_for_platform([]) == []
          and len(di.plugins_for_platform([{"platform": "Plan9", "plugins": [{"name": "p", "str": "p "}]}])) == 1)

    # The signal must carry the platform-scoped list, not the raw pool head.
    sig2 = dw._build_signal({"capabilities": 3})
    check("the WAF signal carries the platform-scoped plugins",
          sig2["plugins"] == sel_plugins,
          "the signal still ships the unfiltered list")
    check("dupedPlugins is derived from the selected plugins",
          sig2["dupedPlugins"].startswith("".join(p["str"] for p in sel_plugins)))

    # ── a device verdict has exactly one handling path ──────────────
    # Two checks used to guard the same condition; the first was unreachable
    # and produced the terse message, so the informative one never ran.
    import inspect
    src_all = inspect.getsource(dd)
    check("the device verdict has exactly one handling site",
          src_all.count('getattr(client, "last_login_device_risk", False)') == 1,
          "a second guard was unreachable and shadowed the informative message")
    check("the handling message names the real remedy",
          "Sign in" in src_all and "real browser" in src_all,
          "the message must tell the operator what actually clears the flag")

    # ── the source of truth is not duplicated ───────────────────────
    import inspect
    src_direct = inspect.getsource(dd)
    check("ds_direct no longer mints a random device_id",
          "secrets.token_hex" not in src_direct)
    check("ds_direct's login uses the shared device_id",
          "ds_identity.device_id()" in src_direct)
    check("ds_direct no longer hardcodes a Chrome 134 User-Agent",
          "Chrome/134" not in src_direct)
    check("ds_waf no longer hardcodes a Chrome 134 User-Agent",
          "Chrome/134" not in inspect.getsource(dw))

    # ── accept-language: a header every browser sends, curl_cffi does not ──
    # curl_cffi reproduces the TLS handshake and the header ORDER but not this
    # value, so a client that never sets it sends a request no browser produces.
    # Measured against the site: real Chrome carried accept-language on 15/15
    # chat.deepseek.com requests while the harness carried none.
    check("a browser accept-language is declared",
          getattr(di, "ACCEPT_LANGUAGE", "") == "en-US,en;q=0.9",
          "got %r" % (getattr(di, "ACCEPT_LANGUAGE", None),))
    check("browser_headers() exposes it",
          di.browser_headers().get("accept-language") == "en-US,en;q=0.9",
          repr(di.browser_headers()))
    check("it is not the underscore locale spelling",
          "_" not in di.ACCEPT_LANGUAGE,
          "en_US is the client's locale field, not a BCP-47 language tag")
    _src_direct = inspect.getsource(dd)
    check("the request headers carry it",
          _src_direct.count("**ds_identity.browser_headers(),") >= 2,
          "expected it on both _headers and _login_headers")
finally:
    shutil.rmtree(_SCRATCH, ignore_errors=True)

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all identity checks passed")
