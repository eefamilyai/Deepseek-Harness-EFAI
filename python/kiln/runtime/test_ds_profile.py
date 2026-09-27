#!/usr/bin/env python
"""Regression tests for PER-ACCOUNT browser identity (ds_profile + ds_direct).

Run:  python test_ds_profile.py

Everything here is OFFLINE. No browser is launched and no request leaves the
machine. What these pin is the second half of the flagging defect: the first half
was "one device_id, re-minted per login". This half is "one device_id shared by
every account", which is the same signal read from the other side. Several
accounts logging in from one machine presented ONE Shumei fingerprint, so the
anti-abuse stack saw one device cycling through many accounts -- the shape a
credential-stuffing farm has.

The fix is a per-account Chrome profile: one account, one profile, one device.
That makes three things load-bearing, and each is pinned below.

  * ``device_id_for_account`` must return ``None`` -- not the machine-level
    value -- when an account has no identity of its own. A silent substitution
    here is the entire defect, because it is invisible: the login succeeds and
    the device is shared.
  * Two accounts must resolve to two different profiles, records and slugs, and
    neither may collide with the machine-level profile.
  * The recorded value must be SHAPE-checked on the way out. A truncated or
    pasted-token record degrades to ``None`` (and so to a capture attempt), not
    to a malformed login that earns ``code=40029 TOO_MANY_REQUESTS``.

The scratch directory is set through KILN_IDENTITY_DIR *before* the modules are
imported, so nothing here can read or write the operator's real identity.
"""
import json
import os
import re
import shutil
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Point identity at a scratch dir BEFORE importing: the modules read
# KILN_IDENTITY_DIR at call time, and a test must never touch the real identity.
_SCRATCH = tempfile.mkdtemp(prefix="ds-profile-test-")
_IDENTITY_SCRATCH = os.path.join(_SCRATCH, "identity")
os.environ["KILN_STATE_DIR"] = _SCRATCH
os.environ["KILN_IDENTITY_DIR"] = _IDENTITY_SCRATCH
os.environ.pop("DEEPSEEK_DEVICE_ID", None)

import ds_identity as di          # noqa: E402
import ds_profile as dp           # noqa: E402
import ds_direct as dd            # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


# Two distinct, well-shaped Shumei values. The shape is what the connector can
# check; the CONTENTS of a real fingerprint are unknowable here, so these are
# stand-ins that pass the same shape gate a captured value does.
REAL_A = ("BdQNjmtlDqa0FTFU7mQKwc5VqKKTaIzQuhev79oEmf9dJPQgY24bGBqjLuUZ2nv6d"
          "PaBsLuCULkcRwLQSctydZg==")
REAL_B = ("ZxWvUtSrQpOnMlKjIhGfEdCbA9876543210zyxwvutsrqponmlkjihgfedcbaZYXWV"
          "UtsrQpoNmlKjhGfEdCbA==")
ACCT_A = "alpha@example.com"
ACCT_B = "beta@example.com"

try:
    # ── the slug names the profile, so it must be stable and safe ────
    # A profile is the identity. A profile whose NAME changed would be a profile
    # that was lost, and the account would re-mint a device -- so the slug is
    # pinned to be a pure function of the account id.
    check("the slug is stable across calls",
          dp.slug(ACCT_A) == dp.slug(ACCT_A))
    check("the slug is filesystem-safe for an email",
          bool(re.fullmatch(r"[A-Za-z0-9._-]+", dp.slug(ACCT_A))),
          repr(dp.slug(ACCT_A)))
    check("the slug is filesystem-safe for a mobile number with a plus",
          bool(re.fullmatch(r"[A-Za-z0-9._-]+", dp.slug("+8613800138000"))),
          repr(dp.slug("+8613800138000")))
    check("the slug is filesystem-safe for a plus-addressed email",
          bool(re.fullmatch(r"[A-Za-z0-9._-]+", dp.slug("a+b@example.com"))),
          repr(dp.slug("a+b@example.com")))
    check("the slug carries no path separator",
          "/" not in dp.slug("a/b@example.com")
          and "\\" not in dp.slug("a\\b@example.com"),
          repr(dp.slug("a/b@example.com")))
    check("the slug is bounded in length", len(dp.slug("x" * 400)) < 80,
          repr(len(dp.slug("x" * 400))))
    check("an empty account id still yields a usable slug",
          bool(dp.slug("")) and bool(re.fullmatch(r"[A-Za-z0-9._-]+", dp.slug(""))),
          repr(dp.slug("")))

    # The readable prefix is NOT the identity: two ids that sanitise to the same
    # prefix must still land in different directories, or one account would
    # silently overwrite another's recorded device.
    check("a sanitised collision does not collide on disk",
          dp.slug("a@b.com") != dp.slug("a_b.com"),
          "both sanitise to the same readable prefix: %r vs %r"
          % (dp.slug("a@b.com"), dp.slug("a_b.com")))
    check("different accounts get different slugs", dp.slug(ACCT_A) != dp.slug(ACCT_B))

    # ── one account, one profile, one record ────────────────────────
    check("different accounts get different profile directories",
          dp.profile_dir(ACCT_A) != dp.profile_dir(ACCT_B),
          repr(dp.profile_dir(ACCT_A)))
    check("different accounts get different record paths",
          dp.account_record_path(ACCT_A) != dp.account_record_path(ACCT_B))
    check("the profile lives under the identity dir",
          os.path.abspath(dp.profile_dir(ACCT_A)).startswith(
              os.path.abspath(di.identity_dir())),
          repr(dp.profile_dir(ACCT_A)))
    check("the record lives under the identity dir",
          os.path.abspath(dp.account_record_path(ACCT_A)).startswith(
              os.path.abspath(di.identity_dir())),
          repr(dp.account_record_path(ACCT_A)))
    check("the profile and the record are different paths",
          dp.profile_dir(ACCT_A) != dp.account_record_path(ACCT_A))
    # `capture_device_id(account_id=None)` drives a literal "machine" profile.
    # If an account could own that name, a single-account install and a captured
    # account would fight over one directory.
    check("the machine-level profile is not an account profile",
          dp.profile_dir("machine") != dp.profile_dir(ACCT_A)
          and dp.profile_dir("machine") != dp.profile_dir(ACCT_B),
          repr(dp.profile_dir("machine")))
    check("no profile directory exists before anything is captured",
          not os.path.isdir(dp.profile_dir(ACCT_A)))

    # ── an account with no identity says so, and never borrows one ──
    # THIS is the load-bearing contract. Returning the machine-level value here
    # would make every account present one device -- silently, because the login
    # still succeeds.
    check("an account with no record has no device_id",
          dp.device_id_for_account(ACCT_A) is None,
          repr(dp.device_id_for_account(ACCT_A)))
    check("ds_identity's view of that account agrees",
          di.device_id_for_account(ACCT_A) is None,
          repr(di.device_id_for_account(ACCT_A)))
    check("an unknown account has no record", dp.read_account_identity("nobody@x") == {})

    # The fallback EXISTS; it is deliberately not Shumei-shaped. A machine with no
    # configured or captured device_id presents a locally derived value, and
    # test_ds_identity pins that value as 32 hex characters. Asking whether it
    # passes the Shumei shape gate asks the wrong question: the gate exists to
    # recognise a fingerprint, and this value is documented as not being one.
    machine_value = di.device_id()
    check("the machine-level value exists to fall back to",
          isinstance(machine_value, str) and bool(machine_value),
          repr(machine_value[:16]))
    check("the per-account value is NOT the machine-level value",
          dp.device_id_for_account(ACCT_A) != machine_value,
          "an uncaptured account silently inherited the machine device")

    # ── recording an identity is per account ────────────────────────
    stored = dp.write_account_identity(ACCT_A, {"device_id": REAL_A,
                                                "x_device_id": "11111111-aaaa",
                                                "did": "22222222-bbbb",
                                                "origin": "login-payload"})
    check("writing records the account id", stored.get("account_id") == ACCT_A)
    check("writing stamps a time", bool(stored.get("updated_at")))
    check("the record is on disk", os.path.exists(dp.account_record_path(ACCT_A)))
    check("the record holds the value verbatim",
          dp.read_account_identity(ACCT_A).get("device_id") == REAL_A)
    check("the account now resolves its own device_id",
          dp.device_id_for_account(ACCT_A) == REAL_A,
          repr(dp.device_id_for_account(ACCT_A)))
    check("the account's device_id is still not the machine value",
          dp.device_id_for_account(ACCT_A) != machine_value)

    # The second account must be untouched by the first account's write. This is
    # the whole point: two accounts on one machine are two devices.
    check("a second account is still unidentified",
          dp.device_id_for_account(ACCT_B) is None,
          repr(dp.device_id_for_account(ACCT_B)))
    dp.write_account_identity(ACCT_B, {"device_id": REAL_B})
    check("two accounts resolve two different devices",
          dp.device_id_for_account(ACCT_A) != dp.device_id_for_account(ACCT_B),
          repr((dp.device_id_for_account(ACCT_A)[:12],
                dp.device_id_for_account(ACCT_B)[:12])))
    check("each account resolves the value it recorded",
          dp.device_id_for_account(ACCT_A) == REAL_A
          and dp.device_id_for_account(ACCT_B) == REAL_B)
    check("each account has its own record file",
          dp.account_record_path(ACCT_A) != dp.account_record_path(ACCT_B)
          and os.path.exists(dp.account_record_path(ACCT_A))
          and os.path.exists(dp.account_record_path(ACCT_B)))

    # ── a write merges, and an empty probe never erases a good record ─
    # A capture run that read nothing useful reports empty slots. If that
    # overwrote a recorded device, every failed re-capture would throw away a
    # working identity and force a fresh mint -- a new device per attempt.
    dp.write_account_identity(ACCT_A, {"device_id": "", "x_device_id": "",
                                       "note": "second pass"})
    check("an empty write does not erase the recorded device_id",
          dp.device_id_for_account(ACCT_A) == REAL_A,
          repr(dp.device_id_for_account(ACCT_A)))
    check("a merge keeps fields the second write did not mention",
          dp.read_account_identity(ACCT_A).get("did") == "22222222-bbbb")
    check("a merge keeps the field the second write did add",
          dp.read_account_identity(ACCT_A).get("note") == "second pass")

    # ── a malformed record is refused, not sent ─────────────────────
    # A wrong-SHAPE value earns `code=40029 TOO_MANY_REQUESTS`, which reads like
    # rate limiting and sends the operator looking in the wrong place. So the
    # record must fail closed: no value at all, so the caller captures one.
    for bad, label in (("", "empty"), ("abc", "too short"),
                       ("has spaces in it", "whitespace"),
                       ("x" * 600, "too long"),
                       ("Bearer sk-abcdefghijklmnop", "a pasted token")):
        dp.write_account_identity("bad@example.com", {"device_id": bad})
        check("a %s record resolves to None" % label,
              dp.device_id_for_account("bad@example.com") is None,
              repr(dp.device_id_for_account("bad@example.com")))

    check("the shape gate accepts a real value", di.valid_device_id(REAL_A))
    check("the shape gate accepts a second real value", di.valid_device_id(REAL_B))
    check("the shape gate refuses an empty value", not di.valid_device_id(""))
    check("the shape gate refuses a short value", not di.valid_device_id("abc"))
    check("the shape gate refuses whitespace",
          not di.valid_device_id("has spaces in it"))
    check("the shape gate refuses an oversized value",
          not di.valid_device_id("x" * 600))
    check("the shape gate refuses None", not di.valid_device_id(None))
    # The identifiers a real request carries are DIFFERENT SHAPES, and the gate
    # has to tell them apart instead of treating either as "some string". The
    # login block the operator supplied sends a lowercase UUID in the
    # ``x-device-id`` header alongside a mixed-case base64 fingerprint in the
    # body's ``device_id``. The site's own ``smidV2`` cookie is a third shape
    # again -- a 14-digit timestamp followed by lowercase hex -- and it is a
    # session value, not a fingerprint, which is the mistake this pins.
    check("the shape gate refuses an x-device-id UUID",
          not di.valid_device_id("54b12f3c-7918-4bb8-ab56-7debe7cdd68d"))
    check("the shape gate refuses the site's own smid session cookie",
          not di.valid_device_id(
              "20260927205138c1162ca82345e0596922756f0c61e0c700db2371f23a1cd10"))
    check("the smid session cookie is not read as a device_id",
          not any("smid" in str(slot) for slot in dp._COOKIE_SLOTS),
          repr(dp._COOKIE_SLOTS))

    # ── the cookie the SDK actually keeps the fingerprint in ────────
    # A login body captured from a real browser is exactly `B` followed by this
    # cookie's value, so the cookie is the fingerprint minus that one leading
    # character. Reading it verbatim would replay a value one character short of
    # the one the client sends -- which is a different device.
    LOGIN_BODY = ("BEvPTfsU3YjM/uUozsalKIVcdVXc3+WrdjgDjAQfyRusRmEC4n32H3BgqB4"
                  "kIEDuY+9L7RBLStE3n/6Niki8rjg==")
    THUMB_COOKIE = LOGIN_BODY[1:]
    SMID_COOKIE = ("20260927205138c1162ca82345e0596922756f0c61e0c700db2371f23a1cd10")
    check("the thumbcache cookie restores the login body's prefix",
          dp.device_id_from_cookie(".thumbcache_6b2e5483f9d8", THUMB_COOKIE)
          == LOGIN_BODY,
          repr(dp.device_id_from_cookie(".thumbcache_6b2e5483f9d8", THUMB_COOKIE)))
    check("a named slot is taken verbatim",
          dp.device_id_from_cookie("deviceid", REAL_A) == REAL_A)
    check("the smid session cookie yields no device_id",
          dp.device_id_from_cookie("smidV2", SMID_COOKIE) is None,
          "a session value must never be stored as a device")
    check("an x-device-id UUID yields no device_id",
          dp.device_id_from_cookie(".thumbcache_x",
                                   "54b12f3c-7918-4bb8-ab56-7debe7cdd68d") is None)
    check("an empty cookie yields nothing",
          dp.device_id_from_cookie(".thumbcache_x", "") is None)

    # ── a rejected device_id is dropped on write, not carried forward ──
    # A value the current rule rejects must not survive a later write. Keeping it
    # is how a shape an older, looser capture accepted went on being presented
    # long after the rule tightened, which is exactly what the operator saw. The
    # shape is recorded instead, so a row can say what was lost and why.
    dp.write_account_identity("stale@example.com", {"device_id": SMID_COOKIE})
    stale = dp.read_account_identity("stale@example.com")
    check("a rejected device_id is not stored",
          not stale.get("device_id"), repr(stale))
    check("the rejected shape is recorded for the row",
          "not a fingerprint" in str(stale.get("device_id_rejected")), repr(stale))
    dp.write_account_identity("stale@example.com",
                              {"x_device_id": "11111111-aaaa"})
    again = dp.read_account_identity("stale@example.com")
    check("a later write does not resurrect the rejected device_id",
          not again.get("device_id"), repr(again))
    check("the later write keeps the field it was given",
          again.get("x_device_id") == "11111111-aaaa", repr(again))

    # ── each identity field records its OWN origin ─────────────────
    # One shared `origin` key was set by whichever field was captured first, and
    # the x-device-id header rides every request -- so it always won, and a
    # device_id that actually came from a cookie read as though it came from a
    # header. That mislabel is what sent the investigation after the wrong slot.
    dp.write_account_identity("origins@example.com", {
        "device_id": REAL_A,
        "device_id_origin": "cookie:.thumbcache_6b2e5483f9d8",
        "x_device_id": "11111111-aaaa",
        "x_device_id_origin": "request-header",
        "did": "22222222-bbbb",
        "did_origin": "query-param",
        "origin": "cookie:.thumbcache_6b2e5483f9d8",
    })
    orec = dp.read_account_identity("origins@example.com")
    check("the device_id keeps its own origin",
          orec.get("device_id_origin") == "cookie:.thumbcache_6b2e5483f9d8",
          repr(orec))
    check("the x-device-id keeps its own origin",
          orec.get("x_device_id_origin") == "request-header", repr(orec))
    check("the did keeps its own origin",
          orec.get("did_origin") == "query-param", repr(orec))

    # ── reading a value out of a JSON storage blob ──────────────────
    # The SDK does not always store the bare id; a slot can hold
    # `{"deviceId": "..."}` or a blob with the id nested inside it. The extractor
    # has to rescue those shapes and still refuse a value that only LOOKS close.
    check("a bare value is returned as-is",
          dp._extract_device_id(REAL_A) == REAL_A)
    check("an empty slot yields nothing", dp._extract_device_id("") is None)
    check("a short value yields nothing", dp._extract_device_id("abc") is None)
    check("a deviceId key is rescued",
          dp._extract_device_id(json.dumps({"deviceId": REAL_A})) == REAL_A)
    check("a nested device_id is rescued",
          dp._extract_device_id(json.dumps({"a": {"device_id": REAL_A}})) == REAL_A)
    check("an smid list entry is rescued",
          dp._extract_device_id(json.dumps([{"smid": REAL_A}])) == REAL_A)
    check("an unrelated key is NOT taken as a device_id",
          dp._extract_device_id(json.dumps({"unrelated": REAL_A})) is None,
          "a value under the wrong key is a different identifier entirely")
    check("malformed JSON yields nothing",
          dp._extract_device_id("{not json") is None)

    # ── status is diagnosable and never echoes the secret ───────────
    st = dp.identity_status(ACCT_A)
    check("status names the account", st.get("account_id") == ACCT_A)
    check("status reports the record as valid", st.get("device_id_valid") is True,
          repr(st))
    check("status reports the recorded length",
          st.get("device_id_length") == len(REAL_A), repr(st))
    check("status reports the x-device-id is present",
          st.get("has_x_device_id") is True, repr(st))
    check("status reports the capture origin",
          st.get("origin") in ("login-payload", None), repr(st))
    check("status does NOT echo the device_id",
          REAL_A not in repr(st), repr(st))
    check("status does not echo the per-profile uuid",
          "11111111-aaaa" not in repr(st), repr(st))

    st_none = dp.identity_status(ACCT_B)
    check("status of an unrecorded field reports invalid rather than raising",
          isinstance(st_none.get("device_id_valid"), bool), repr(st_none))

    # ── the write is atomic and private ─────────────────────────────
    accounts_dir = os.path.join(di.identity_dir(), "accounts")
    litter = [n for n in os.listdir(accounts_dir) if n.startswith(".ds-acct-")]
    check("an atomic write leaves no temp file behind", not litter, repr(litter))
    # The 0o600 is best-effort: it is the whole of the protection on POSIX, and
    # inexpressible on Windows, where `os.chmod` only toggles the read-only bit
    # and the ACL governs. Asserting a POSIX mode on Windows would fail for a
    # platform reason that says nothing about whether the secret leaked, so the
    # mode is checked where it means something and the write is checked
    # everywhere.
    if os.name == "posix":
        mode = os.stat(dp.account_record_path(ACCT_A)).st_mode & 0o777
        check("the record is not group- or world-readable", mode & 0o077 == 0,
              oct(mode))
    check("the record is a regular file",
          os.path.isfile(dp.account_record_path(ACCT_A)))
    check("list_profiles names every account with a record",
          dp.slug(ACCT_A) in dp.list_profiles()
          and dp.slug(ACCT_B) in dp.list_profiles(),
          repr(dp.list_profiles()))

    # ── ds_direct presents the account's own device ─────────────────
    # Resolution order, first hit wins: an explicit per-account setting, then the
    # account's own recorded device, then -- only as a last resort -- the machine
    # value, so a login is never refused for want of any identity at all.
    acct_a = dd._Account(id=ACCT_A, email=ACCT_A, password="x", source=("probe",))
    acct_b = dd._Account(id=ACCT_B, email=ACCT_B, password="x", source=("probe",))
    acct_c = dd._Account(id="gamma@example.com", email="gamma@example.com",
                         password="x", source=("probe",))

    check("ds_direct presents account A's own device",
          dd._device_id_for(acct_a) == REAL_A, repr(dd._device_id_for(acct_a)))
    check("ds_direct presents account B's own device",
          dd._device_id_for(acct_b) == REAL_B, repr(dd._device_id_for(acct_b)))
    check("two accounts present two different devices",
          dd._device_id_for(acct_a) != dd._device_id_for(acct_b),
          "one device serving two accounts is the signal being removed")
    check("an uncaptured account falls back to the machine value",
          dd._device_id_for(acct_c) == machine_value,
          repr(dd._device_id_for(acct_c)))
    check("the fallback is the documented last resort, not a shared record",
          dd._device_id_for(acct_c) not in (REAL_A, REAL_B))

    acct_a.device_id = "EXPLICITvalue1234567890"
    check("an explicit per-account setting outranks the recorded device",
          dd._device_id_for(acct_a) == "EXPLICITvalue1234567890",
          repr(dd._device_id_for(acct_a)))
    acct_a.device_id = ""
    check("clearing the explicit setting returns the recorded device",
          dd._device_id_for(acct_a) == REAL_A,
          repr(dd._device_id_for(acct_a)))
    check("an account of None still resolves something",
          bool(dd._device_id_for(None)), repr(dd._device_id_for(None)))

    # ── the per-profile header is not the Shumei id ─────────────────
    # A browser sends `x-device-id` on 47/47 /api/v0 requests in the reference
    # capture; it is a per-profile UUID, NOT the Shumei fingerprint in the login
    # body. Sending the body id in its place would be a client no browser
    # produces -- and so would sending nothing, which is what this used to do.
    # The header is therefore NEVER absent: an uncaptured account falls back to
    # a derived, stable, UUID-shaped value.
    hdr_c = dd._extra_identity_headers(acct_c)
    check("an account with no recorded uuid still sends the header",
          "x-device-id" in hdr_c, repr(hdr_c))
    # The header's own shape, which is a UUID -- not the login body's base64
    # fingerprint. Checking it with the fingerprint gate would be checking the
    # wrong field's shape and would pass only while the gate was too loose.
    check("that fallback is a well-formed uuid",
          bool(dp._UUID_RE.match(str(hdr_c.get("x-device-id") or ""))),
          repr(hdr_c.get("x-device-id")))
    check("the fallback is stable across calls",
          hdr_c.get("x-device-id") == dd._extra_identity_headers(acct_c).get("x-device-id"))
    hdr_none = dd._extra_identity_headers(None)
    check("no account still sends a well-formed header",
          bool(dp._UUID_RE.match(str(hdr_none.get("x-device-id") or ""))),
          repr(hdr_none))
    check("the header set is exactly the two identity headers",
          set(hdr_c) == {"x-device-id", "x-device-model"}, repr(sorted(hdr_c)))
    check("x-device-model is present and empty, as on the wire",
          hdr_c.get("x-device-model") == "", repr(hdr_c.get("x-device-model")))
    hdr = dd._extra_identity_headers(acct_a)
    check("a recorded uuid reaches the headers",
          hdr.get("x-device-id") == "11111111-aaaa", repr(hdr))
    check("the recorded uuid outranks the derived fallback",
          hdr.get("x-device-id") != hdr_c.get("x-device-id"))
    check("the header value is not the Shumei device_id",
          hdr.get("x-device-id") != REAL_A,
          "the two identifiers are different values on a real request")

    # ── minting is per account, and impossible without one ──────────
    try:
        dd._mint_identity_for(None)
        check("minting without an account is refused", False, "it was accepted")
    except RuntimeError:
        check("minting without an account is refused", True)
    except Exception as exc:                          # pragma: no cover
        check("minting without an account is refused", False,
              "raised %s instead of RuntimeError" % type(exc).__name__)

    # ── a DEVICE verdict is classified, not read as a bad password ──
    # DeepSeek answers /users/login with HTTP 200 and code 0/11
    # RISK_DEVICE_DETECTED when the anti-abuse stack distrusts the machine.
    # Treating that as an auth failure made the caller rotate accounts, posting a
    # fresh login for every credential -- which is how one device verdict became
    # a burst of logins.
    check("a device verdict is recognised",
          dd._is_device_risk("login rejected - HTTP 200, code=0/11 RISK_DEVICE_DETECTED"))
    check("the code alone is recognised", dd._is_device_risk("0/11 RISK_DEVICE_DETECTED"))
    check("a device verdict is recognised case-insensitively",
          dd._is_device_risk("risk_device_detected"))
    check("a wrong password is not a device verdict",
          not dd._is_device_risk("login rejected - HTTP 200, code=1/1 wrong password"))
    check("a WAF refusal is not a device verdict",
          not dd._is_device_risk("login blocked by AWS WAF"))
    check("an empty message is not a device verdict",
          not dd._is_device_risk("") and not dd._is_device_risk(None))

    # ── the login path carries the account's identity ───────────────
    # These are source checks on purpose: the login itself needs a network, but
    # the PROPERTY that matters is a structural one -- the payload must read the
    # per-account resolver, and the retry must be bounded at one re-mint. A
    # literal assertion cannot see either.
    import inspect
    src = inspect.getsource(dd)
    check("the login payload resolves the account's device_id",
          "device_id\": _device_id_for(acct)" in src,
          "the payload must read the per-account resolver, not a global")
    check("the login path does not mint a random device",
          "secrets.token_hex" not in src,
          "a random per-login id presents as a brand-new device every time")
    check("a refused device is answered by ONE capture",
          "_mint_identity_for(self.account, on_status=config.dbg)" in src)
    check("the re-mint is bounded so a refusal cannot loop",
          "for _identity_attempt in range(2)" in src,
          "an unbounded retry is itself the request burst being avoided")
    check("a first login mints this account's own identity",
          "_mint_identity_for(acct, on_status=config.dbg)" in src,
          "without this a fresh account starts on the shared machine value")
    check("the first-login mint is gated on having no recorded identity",
          "not ds_profile.device_id_for_account(key)" in src,
          "an unconditional capture would re-mint a device on every login")
    check("a failed first-login capture does not fail the login",
          "a capture is best effort" in src,
          "the machine value still works; a browser must not be mandatory")
    check("the request path carries the per-profile headers",
          src.count("_extra_identity_headers(self.account)") >= 2,
          "both the API and the login request must carry x-device-id")

finally:
    shutil.rmtree(_SCRATCH, ignore_errors=True)

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all per-account identity checks passed")
