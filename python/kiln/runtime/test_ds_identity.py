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

No network and no credentials.
"""
import os
import shutil
import sys
import tempfile

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
    ua = di.UA
    check("the User-Agent is the macOS build curl_cffi impersonates",
          "Macintosh" in ua and "Chrome/120" in ua, repr(ua))
    check("the client hints name the same Chrome as the User-Agent",
          "v=\"120\"" in di.SEC_CH_UA, repr(di.SEC_CH_UA))
    check("the client hints name the same platform as the User-Agent",
          di.SEC_CH_UA_PLATFORM == '"macOS"', repr(di.SEC_CH_UA_PLATFORM))

    headers = dd._Client(None)._headers()
    check("the request carries the shared User-Agent",
          headers.get("user-agent") == di.UA, repr(headers.get("user-agent")))
    check("the request carries matching client hints",
          headers.get("sec-ch-ua") == di.SEC_CH_UA
          and headers.get("sec-ch-ua-platform") == di.SEC_CH_UA_PLATFORM)
    login_headers = dd._Client(None)._login_headers()
    check("the login request carries the same User-Agent",
          login_headers.get("user-agent") == di.UA)
    check("the login request carries matching client hints",
          login_headers.get("sec-ch-ua") == di.SEC_CH_UA)

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
    # directory produces) must NOT change the device_id.
    _saved_state = os.environ.get("KILN_STATE_DIR")
    os.environ["KILN_STATE_DIR"] = os.path.join(_SCRATCH, "some-other-cwd-state")
    di._seed_cache.clear()
    check("the device_id survives a different launch directory",
          di.device_id() == dev_a,
          "one machine minted a second device_id from another cwd")
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
finally:
    shutil.rmtree(_SCRATCH, ignore_errors=True)

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all identity checks passed")
