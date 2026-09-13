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
# KILN_STATE_DIR at call time, and a test must not touch the real identity.
_SCRATCH = tempfile.mkdtemp(prefix="ds-identity-test-")
os.environ["KILN_STATE_DIR"] = _SCRATCH

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
    os.environ["KILN_STATE_DIR"] = other
    di._seed_cache.clear()
    check("a different seed yields a different device_id",
          di.device_id() != dev_a, "two machines would share one device_id")
    os.environ["KILN_STATE_DIR"] = _SCRATCH
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
