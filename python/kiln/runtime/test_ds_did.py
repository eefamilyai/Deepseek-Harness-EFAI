#!/usr/bin/env python
"""Regression tests for the `did` identifier and the client/settings call.

Run:  python test_ds_did.py

Everything here is OFFLINE. What these pin, from a capture of chat.deepseek.com:

  * ``did`` is the ONE anti-abuse identifier that rides a QUERY STRING, not a
    header: ``GET /api/v0/client/settings?did=<uuid>&scope=provider``. The
    capture carries it on 35/35 of those requests, one value for the life of the
    profile, and it is a DIFFERENT uuid from ``x-device-id``.
  * ds_direct made that request ZERO times, so it never presented `did` at all --
    a request the browser makes on every load and this client never made.
  * The value has to come out of a real browser profile, so the capture path has
    to read it off the wire, and it has to be replayable afterwards.

The identifier is a per-profile UUID, so a malformed or fabricated value is worse
than none: a value the profile never minted is a second identity the browser
never had. ``_did_for`` therefore has NO machine-level fallback, unlike
``_device_id_for``, and ``client_settings`` makes no request at all when the
account has no captured `did`.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Identity must point at a scratch dir BEFORE the import: the modules read
# KILN_IDENTITY_DIR at call time, and a test must never touch the operator's
# real profile directory.
_SCRATCH = tempfile.mkdtemp(prefix="ds-did-test-")
os.environ["KILN_STATE_DIR"] = _SCRATCH
os.environ["KILN_IDENTITY_DIR"] = os.path.join(_SCRATCH, "identity")

import ds_direct as dd          # noqa: E402
import ds_profile as dp         # noqa: E402
import ds_identity              # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


# The exact values the capture holds, as shapes: a v4 UUID for each, and the one
# real `did` from the HAR's client/settings query string.
SAMPLE_DID = "492cad22-8864-43df-8788-b7465d166631"
SAMPLE_X_DEVICE_ID = "54b12f3c-7918-4bb8-ab56-7debe7cdd68d"
SAMPLE_SETTINGS_URL = (
    "https://chat.deepseek.com/api/v0/client/settings"
    "?did=%s&scope=provider" % SAMPLE_DID)


def main():
    # ── reading `did` off the wire ──────────────────────────────────
    # It is a query parameter, so the capture reads it from the URL rather than
    # from the headers. `did_from_url` is that read, isolated so it is testable
    # without a browser.
    check("did is read from the client/settings query string",
          dp.did_from_url(SAMPLE_SETTINGS_URL) == SAMPLE_DID,
          repr(dp.did_from_url(SAMPLE_SETTINGS_URL)))
    check("a percent-encoded did is decoded",
          dp.did_from_url("https://chat.deepseek.com/api/v0/client/settings"
                          "?did=492cad22%2D8864%2D43df%2D8788%2Db7465d166631"
                          "&scope=provider") == SAMPLE_DID,
          repr(dp.did_from_url(
              "https://chat.deepseek.com/api/v0/client/settings"
              "?did=492cad22%2D8864%2D43df%2D8788%2Db7465d166631&scope=provider")))
    check("a URL with no did yields None",
          dp.did_from_url("https://chat.deepseek.com/api/v0/chat/completion") is None)
    check("an empty did is not a value",
          dp.did_from_url("https://x/api?did=&scope=provider") is None,
          repr(dp.did_from_url("https://x/api?did=&scope=provider")))
    check("a did-only query is still read",
          dp.did_from_url("https://x/api?did=%s" % SAMPLE_DID) == SAMPLE_DID)
    check("scope is not mistaken for did",
          dp.did_from_url("https://x/api?scope=provider") is None)
    check("did_from_url tolerates junk rather than raising",
          dp.did_from_url(None) is None and dp.did_from_url(12345) is None)

    # ── the account record carries it ───────────────────────────────
    acct_id = "did-user@example.com"
    check("a fresh account has no did yet",
          dp.did_for_account(acct_id) is None,
          repr(dp.did_for_account(acct_id)))

    dp.write_account_identity(acct_id, {"did": SAMPLE_DID,
                                        "x_device_id": SAMPLE_X_DEVICE_ID})
    check("a captured did is recorded and read back",
          dp.did_for_account(acct_id) == SAMPLE_DID,
          repr(dp.did_for_account(acct_id)))
    check("did and x-device-id are separate values in one record",
          dp.did_for_account(acct_id) != dp.x_device_id_for_account(acct_id),
          "%r vs %r" % (dp.did_for_account(acct_id),
                        dp.x_device_id_for_account(acct_id)))
    check("x_device_id_for_account reads the header value",
          dp.x_device_id_for_account(acct_id) == SAMPLE_X_DEVICE_ID,
          repr(dp.x_device_id_for_account(acct_id)))

    # A record holding a non-UUID in the did slot must not be replayed as one:
    # `did` is a UUID the client generates, so anything else is a different slot.
    dp.write_account_identity(acct_id, {"did": "not-a-uuid"})
    check("a non-UUID did is refused, not replayed",
          dp.did_for_account(acct_id) is None,
          repr(dp.did_for_account(acct_id)))
    dp.write_account_identity(acct_id, {"did": SAMPLE_DID})

    check("identity_status reports the did without printing it",
          dp.identity_status(acct_id).get("has_did") is True
          and SAMPLE_DID not in str(dp.identity_status(acct_id)),
          repr(dp.identity_status(acct_id)))

    # ── ds_direct's resolution order ────────────────────────────────
    class _Acct:
        def __init__(self, **kw):
            self.id = kw.pop("id", "")
            self.email = kw.pop("email", "")
            self.mobile = kw.pop("mobile", "")
            self.did = kw.pop("did", "")
            for k, v in kw.items():
                setattr(self, k, v)

    a = _Acct(id=acct_id)
    check("_did_for prefers the account's captured did",
          dd._did_for(a) == SAMPLE_DID, repr(dd._did_for(a)))

    a2 = _Acct(id="other@example.com")
    check("_did_for is None when the account never captured one",
          dd._did_for(a2) is None, repr(dd._did_for(a2)))

    a3 = _Acct(id="cfg@example.com", did=SAMPLE_X_DEVICE_ID)
    check("an explicit did in config wins over the record",
          dd._did_for(a3) == SAMPLE_X_DEVICE_ID, repr(dd._did_for(a3)))

    check("_did_for has NO machine-level fallback",
          dd._did_for(a2) is None
          and dd._did_for(None) is None,
          "a fabricated did is a second identity the browser never had")

    # ── the request itself ──────────────────────────────────────────
    # A fake session that records what it was asked to send.
    class _Resp:
        status_code = 200

        def json(self):
            return {"data": {"biz_data": {"provider": []}}}

    class _Sess:
        def __init__(self):
            self.calls = []

        def get(self, url, **kw):
            self.calls.append((url, kw))
            return _Resp()

    client = dd._Client.__new__(dd._Client)
    client.sess = _Sess()
    client.account = a
    client.token = "tok"

    body = client.client_settings()
    check("client_settings makes exactly one request", len(client.sess.calls) == 1,
          repr(len(client.sess.calls)))
    url, kw = client.sess.calls[0]
    check("it targets /api/v0/client/settings",
          url.endswith("/api/v0/client/settings"), url)
    check("it passes did and scope as query parameters",
          kw.get("params") == {"did": SAMPLE_DID, "scope": "provider"},
          repr(kw.get("params")))
    check("the response body is returned",
          body == {"data": {"biz_data": {"provider": []}}}, repr(body))

    h = kw.get("headers") or {}
    check("it sends the account's x-device-id",
          h.get("x-device-id") == SAMPLE_X_DEVICE_ID, repr(h.get("x-device-id")))
    # The triple, not the nine: chat.deepseek.com advertises no Accept-CH, so a
    # real Chrome sends only these three. Sending the high-entropy six asserts a
    # browser state this origin cannot produce (commit 8b8e59fd7c).
    check("it sends the client-hint triple, not the ungranted nine",
          sorted(k for k in h if k.startswith("sec-ch-ua"))
          == ["sec-ch-ua", "sec-ch-ua-mobile", "sec-ch-ua-platform"],
          repr(sorted(k for k in h if k.startswith("sec-ch-ua"))))
    check("it sends the x-client-* group",
          h.get("x-client-platform") == "web", repr(h.get("x-client-platform")))
    check("it drops the navigation-only headers",
          h.get("sec-fetch-user") is None
          and h.get("upgrade-insecure-requests") is None,
          repr({k: v for k, v in h.items() if k.startswith(("sec-fetch", "upgrade"))}))
    check("it is a same-origin XHR",
          h.get("sec-fetch-dest") == "empty" and h.get("sec-fetch-mode") == "cors",
          repr({k: v for k, v in h.items() if k.startswith("sec-fetch")}))
    check("it carries no content-type (it is a GET)",
          "content-type" not in h, repr(h.get("content-type")))
    check("it carries no Authorization header",
          "authorization" not in h, repr(h.get("authorization")))

    # No captured did -> NO request. Omitting the call is right; inventing a
    # value, or calling without one, is the mismatch this pins.
    c2 = dd._Client.__new__(dd._Client)
    c2.sess = _Sess()
    c2.account = a2
    c2.token = "tok"
    got = c2.client_settings()
    check("an account with no did makes NO client/settings request",
          c2.sess.calls == [] and got is None,
          repr(c2.sess.calls))

    # A failure is swallowed: a settings fetch must never fail a completion.
    class _Boom(_Sess):
        def get(self, url, **kw):
            raise RuntimeError("network down")

    c3 = dd._Client.__new__(dd._Client)
    c3.sess = _Boom()
    c3.account = a
    c3.token = "tok"
    check("a failed settings fetch returns None rather than raising",
          c3.client_settings() is None)

    # ── the once-per-client guard ───────────────────────────────────
    c4 = dd._Client.__new__(dd._Client)
    c4.sess = _Sess()
    c4.account = a
    c4.token = "tok"
    c4._settings_once()
    c4._settings_once()
    c4._settings_once()
    check("_settings_once fetches at most once per client",
          len(c4.sess.calls) == 1, "made %d requests" % len(c4.sess.calls))

    c5 = dd._Client.__new__(dd._Client)
    c5.sess = _Sess()
    c5.account = a2
    c5.token = "tok"
    c5._settings_once()
    check("_settings_once is silent with no did",
          c5.sess.calls == [])

    # ── new_session makes the call ──────────────────────────────────
    src = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                            "ds_direct.py"), encoding="utf-8").read()
    ns = src[src.index("    def new_session(self):"):]
    ns = ns[:ns.index("    def _pow(")]
    check("new_session triggers the settings call",
          "self._settings_once()" in ns, repr(ns[:200]))
    check("the settings call precedes session creation",
          ns.index("_settings_once()") < ns.index("chat_session/create"),
          "the browser reads settings around session setup")

    print()
    if FAILS:
        print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
        return 1
    print("all did checks passed")
    return 0


try:
    rc = main()
finally:
    import shutil
    shutil.rmtree(os.environ["KILN_STATE_DIR"], ignore_errors=True)

sys.exit(rc)
