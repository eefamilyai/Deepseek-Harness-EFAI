#!/usr/bin/env python3
"""One persistent Chrome profile per DeepSeek account, and the identity it mints.

DeepSeek's anti-abuse stack does not read one identifier, it reads several, and a
real browser keeps ALL of them stable for the life of a profile:

  * ``device_id``   -- the Shumei fingerprint the web client posts to
                       ``/users/login``;
  * ``x-device-id`` -- a per-profile UUID the client sends as a header on every
                       ``/api/v0/*`` call (NOT the same value as ``device_id``);
  * ``did``         -- a second per-profile UUID, sent as a query parameter on
                       ``/api/v0/client/settings``.

Those values are minted by obfuscated JS over canvas, GPU and audio entropy, so
they cannot be computed here — only read out of a browser that produced them.
The only way to read the SAME values twice is to keep the browser's profile:
a Playwright ``new_context()`` is ephemeral, so re-capturing from one mints a
brand-new device every time, which is exactly the signal being avoided.

This module gives every account its own Chrome user-data directory and records
what that directory minted. One account, one profile, one device identity — the
same shape a person gets by using a separate browser profile per login.

Layout, under ``ds_identity.identity_dir()`` so it is per-user and survives a
rebuild of the virtualenv::

    ~/.kiln_identity/
        profiles/<slug>/     the Chrome user-data dir (cookies, storage, the id)
        accounts/<slug>.json what the profile minted, for ds_direct to replay

Nothing here is a credential. The profile dir holds the session cookies Chrome
saved, so treat it like a browser profile: it stays under the user's home, never
in the repository.
"""

from __future__ import annotations

import argparse
import contextlib
import hashlib
import json
import os
import re
import sys
import tempfile
import time
import urllib.parse

import ds_identity

__all__ = [
    "slug", "profile_dir", "account_record_path", "read_account_identity",
    "write_account_identity", "device_id_for_account", "did_for_account",
    "x_device_id_for_account", "did_from_url", "identity_status",
    "device_id_from_cookie",
    "capture_identity", "list_profiles",
]

# A profile directory name. The account id can be an email (``+``, ``@``, dots)
# or a mobile number, so it is hashed to something a filesystem accepts
# everywhere and kept readable with a short prefix of the sanitised id.
_SLUG_KEEP = re.compile(r"[^A-Za-z0-9._-]+")


def slug(account_id):
    """A stable, filesystem-safe directory name for `account_id`.

    Stable is the whole point: the slug names the profile, and a profile that
    changes name is a profile that was lost — the account would re-mint a device
    instead of recovering the one it already has. So the digest is over the raw
    id, and the readable prefix is only a convenience for a human looking at the
    directory.
    """
    text = str(account_id or "").strip() or "default"
    readable = _SLUG_KEEP.sub("_", text)[:40].strip("._-") or "account"
    digest = hashlib.sha256(text.encode("utf-8")).hexdigest()[:12]
    return "%s-%s" % (readable, digest)


def profile_dir(account_id):
    """This account's Chrome user-data directory. Created on demand elsewhere."""
    return os.path.join(ds_identity.identity_dir(), "profiles", slug(account_id))


def account_record_path(account_id):
    """Where this account's captured identity is recorded."""
    return os.path.join(ds_identity.identity_dir(), "accounts",
                        "%s.json" % slug(account_id))


def _atomic_json(path, obj):
    folder = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".ds-acct-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2, ensure_ascii=False)
            f.flush()
            os.fsync(f.fileno())
        with contextlib.suppress(OSError):
            os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def read_account_identity(account_id):
    """The recorded identity for `account_id`, or ``{}`` when none was captured."""
    try:
        with open(account_record_path(account_id), "r", encoding="utf-8") as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except Exception:
        return {}


def write_account_identity(account_id, doc):
    """Record what this account's profile minted; returns the stored document."""
    stored = read_account_identity(account_id)
    stored.update({k: v for k, v in (doc or {}).items() if v})
    rejected = str(stored.get("device_id") or "")
    if ds_identity.valid_device_id(rejected):
        # A GOOD value clears the note a previous bad one left. Keeping the note
        # is how a row came to show a working fingerprint next to "not a
        # fingerprint": the rejection was recorded once and then outlived the
        # value it described, because nothing ever removed it.
        stored.pop("device_id_rejected", None)
    else:
        # A ``device_id`` the current rule rejects is NOT carried forward. Keeping
        # it is how a value an older, looser capture accepted survived every later
        # write: the record went on presenting it, and the operator saw a device
        # id the code in the tree would never have produced. The shape is recorded
        # so the page can say what was dropped and why.
        if rejected:
            stored["device_id_rejected"] = "%s...(len=%d, not a fingerprint)" % (
                rejected[:20], len(rejected))
        # The value and its label go together. ``device_id_origin`` describes
        # where the device_id came from, so purging the value while leaving the
        # label is a dangling origin -- and the row renders it as though a device
        # with that provenance existed.
        stored.pop("device_id", None)
        stored.pop("device_id_origin", None)
        stored.pop("origin", None)
    stored["account_id"] = str(account_id)
    stored["updated_at"] = time.time()
    _atomic_json(account_record_path(account_id), stored)
    return stored


def device_id_for_account(account_id):
    """The ``device_id`` this account should present, or ``None``.

    ``None`` means "this account has no browser-minted identity yet" — the caller
    decides whether to capture one or fall back, because a silent fallback to the
    machine-level value is what made every account look like one device.
    """
    value = str(read_account_identity(account_id).get("device_id") or "").strip()
    return value if ds_identity.valid_device_id(value) else None


def did_for_account(account_id):
    """The ``did`` this account should present, or ``None``.

    ``did`` is the identifier the real client puts in the QUERY STRING of
    ``/api/v0/client/settings?did=<uuid>&scope=provider`` -- a capture of the
    site carries it on 35/35 of those requests, one value for the life of the
    profile. It is a different UUID from ``x-device-id``, which rides a header.

    ``None`` means this account has no browser-minted ``did`` yet; the caller
    decides whether to fall back, for the same reason ``device_id_for_account``
    refuses to invent one: a value that is not the profile's own is the signal
    being avoided.
    """
    value = str(read_account_identity(account_id).get("did") or "").strip()
    return value if _UUID_RE.match(value) else None


def x_device_id_for_account(account_id):
    """The per-profile ``x-device-id`` this account's browser minted, or ``None``.

    Separate from ``did_for_account`` because they are separate UUIDs: the real
    client keeps one for the header and one for the settings query string, and a
    capture shows them differing.
    """
    value = str(read_account_identity(account_id).get("x_device_id") or "").strip()
    return value if _UUID_RE.match(value) else None


def identity_status(account_id):
    """A diagnosable summary of this account's identity, without the secret.

    Reports lengths and origins rather than the values, so a log line or a
    settings row can say whether an account has a real device identity without
    printing a fingerprint.
    """
    rec = read_account_identity(account_id)
    dev = str(rec.get("device_id") or "")
    return {
        "account_id": str(account_id),
        "profile": profile_dir(account_id),
        "profile_exists": os.path.isdir(profile_dir(account_id)),
        "recorded": bool(rec),
        "device_id_length": len(dev),
        "device_id_valid": ds_identity.valid_device_id(dev),
        "has_x_device_id": bool(rec.get("x_device_id")),
        "has_did": bool(rec.get("did")),
        "captured_at": rec.get("updated_at"),
        "origin": rec.get("origin"),
    }


# --- capture -----------------------------------------------------------------
# The SDK persists what it mints, so a second visit to an existing profile can
# read it back even when no login happens. Each slot is probed; a login payload
# wins outright because it is exactly what ds_direct must replay.

# ``x-device-id`` and ``did`` are UUIDs the client generates; anything else in a
# record is a different slot (or a truncated read) and must not be replayed as one.
def did_from_url(url):
    """The ``did`` query parameter of `url`, or ``None`` when it carries none.

    ``did`` is the one identifier the client puts in a QUERY STRING rather than a
    header -- ``/api/v0/client/settings?did=<uuid>&scope=provider`` -- so it is
    read off the URL, percent-decoded, rather than off the headers.
    """
    try:
        query = urllib.parse.urlsplit(str(url or "")).query
        for name, val in urllib.parse.parse_qsl(query):
            if name == "did" and val.strip():
                return val.strip()
    except Exception:
        pass
    return None


_UUID_RE = re.compile(
    r"^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-"
    r"[0-9a-fA-F]{4}-[0-9a-fA-F]{12}$")

# Cookies that can carry the fingerprint itself. The ``smid*`` family is
# deliberately NOT here: reading three real profile jars on this machine showed
# ``smidV2`` holding ``<14-digit timestamp><hex>`` -- the site's own session
# value, 63 characters, single case -- and a capture that stored it as the
# ``device_id`` is exactly the defect this list used to cause.
_COOKIE_SLOTS = ("deviceid", "device_id", "ds_device_id")

# The one cookie the SDK keeps the fingerprint in. Measured against a login body
# the operator captured from a real browser: the body is exactly ``"B"`` followed
# by this cookie's value, so the cookie carries the fingerprint with the leading
# character of its envelope dropped. Storing the cookie verbatim would replay a
# value one character short of the one the client actually sends.
_COOKIE_PREFIXES = (".thumbcache_",)
_DEVICE_ID_PREFIX = "B"


def device_id_from_cookie(name, value):
    """The ``device_id`` a cookie carries, or ``None`` when it carries none.

    A ``.thumbcache_<hash>`` cookie supplies the fingerprint minus the leading
    ``B`` the login body restores; the named slots are taken verbatim. Either way
    the result must pass the shape gate, so a session cookie is refused here
    rather than stored and presented as a device.

    The value is percent-decoded first, because Chrome's jar stores it escaped:
    read out of three real profile jars on this machine, every ``.thumbcache_``
    value ends ``%3D%3D`` rather than ``==`` and is 92 characters on disk against
    88 decoded. ``%`` is not in the base64 alphabet, so feeding the raw text to
    the shape gate failed it, this function returned ``None``, and the capture
    fell through to the machine-level device -- a row read ``origin = machine``
    while the real fingerprint sat in the profile the whole time.

    It is ``unquote`` and not ``unquote_plus``: ``+`` is a DATA character in
    base64, and the ``_plus`` variant rewrites it to a space, which corrupts the
    fingerprint into a value the gate then rejects.
    """
    text = urllib.parse.unquote(str(value or "").strip())
    if not text:
        return None
    low = str(name or "").strip().lower()
    if low.startswith(_COOKIE_PREFIXES):
        candidate = _DEVICE_ID_PREFIX + text
        return candidate if ds_identity.valid_device_id(candidate) else None
    if low in _COOKIE_SLOTS:
        return text if ds_identity.valid_device_id(text) else None
    return None

_STORAGE_PROBE = r"""() => {
  const out = {};
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (/smid|device|did/i.test(k)) out[k] = localStorage.getItem(k);
    }
  } catch (e) {}
  return out;
}"""


def _extract_device_id(value):
    """Pull a Shumei ``device_id`` out of a storage value that may be JSON.

    The SDK does not always store the bare id: a slot can hold
    ``{"deviceId":"..."}`` or a JSON blob with the id nested inside it. Trying the
    bare value first and then the obvious keys costs nothing and rescues the
    common shapes.
    """
    text = str(value or "").strip()
    if not text:
        return None
    if ds_identity.valid_device_id(text):
        return text
    if text[:1] in "{[":
        with contextlib.suppress(Exception):
            doc = json.loads(text)
            stack = [doc]
            while stack:
                cur = stack.pop()
                if isinstance(cur, dict):
                    for key, val in cur.items():
                        if isinstance(val, str) and ds_identity.valid_device_id(val):
                            if re.search(r"device|smid|fingerprint", str(key), re.I):
                                return val
                        elif isinstance(val, (dict, list)):
                            stack.append(val)
                elif isinstance(cur, list):
                    stack.extend(cur)
    return None


def capture_identity(account_id, headless=True, timeout_ms=45000, on_status=None):
    """Open this account's profile, let the SDK mint its identity, record it.

    The profile is what makes the capture idempotent: running this twice against
    the same account recovers the identity the first run produced instead of
    minting a second one, because the SDK finds its own values already in the
    profile's storage.

    ``headless=False`` shows the window and waits for a hand login, which is the
    reliable path on a brand-new profile: until the SDK has had a reason to
    persist, the storage probes come back empty.

    Returns the recorded document. Raises ``RuntimeError`` with a concrete reason
    when nothing could be read — never a placeholder, because a fabricated value
    is the defect this function exists to remove.
    """
    try:
        from playwright.sync_api import sync_playwright
    except Exception as e:  # noqa: BLE001 -- report the real cause to the caller
        raise RuntimeError(
            "Playwright is not installed in this interpreter, so a browser cannot "
            "be driven to capture a device_id (%s: %s)" % (type(e).__name__, e))

    def note(message):
        if on_status:
            with contextlib.suppress(Exception):
                on_status(message)

    folder = profile_dir(account_id)
    os.makedirs(folder, exist_ok=True)

    found = {}

    def remember(key, value, origin):
        if found.get(key):
            return
        text = str(value or "").strip()
        if key == "device_id":
            text = _extract_device_id(text) or ""
            if not ds_identity.valid_device_id(text):
                return
        if text:
            found[key] = text
            # Origin is recorded PER FIELD, and ``origin`` alone means "the
            # device_id's origin". A single shared key was set by whichever field
            # happened to be captured first -- and the ``x-device-id`` header
            # rides every request, so it always won -- which made a record whose
            # device_id came from a cookie read as though it came from a header.
            found["%s_origin" % key] = origin
            if key == "device_id":
                found["origin"] = origin

    with sync_playwright() as pw:
        # launch_persistent_context, not launch()+new_context(): the profile IS
        # the identity, and an ephemeral context would mint a new device.
        context = pw.chromium.launch_persistent_context(
            user_data_dir=folder,
            headless=bool(headless),
            viewport={"width": 1920, "height": 1080},
            locale="en-US",
            # The SAME User-Agent the rest of the connector presents.
            #
            # This is not cosmetic. Playwright sends its own
            # `HeadlessChrome/<version>` User-Agent unless one is given, and
            # CloudFront answers THAT with HTTP 403 before the application ever
            # renders. Measured on this machine, against the same URL:
            #
            #   curl_cffi, connector UA          -> HTTP 202, real page
            #   Playwright, Playwright's own UA  -> HTTP 403, CloudFront block
            #   Playwright, connector UA         -> HTTP 202, real page
            #
            # A 403 page has no sign-in form and stores nothing, so a fresh
            # profile could never mint an identity at all -- which is why every
            # account fell back to the machine-level device_id and several
            # accounts presented as ONE device. The block was never the profile
            # or the automation flag; it was the User-Agent describing a browser
            # no real user has.
            user_agent=ds_identity.UA,
            args=["--disable-blink-features=AutomationControlled"],
        )
        try:
            page = context.pages[0] if context.pages else context.new_page()

            def on_request(request):
                url = request.url
                if "/users/login" in url:
                    with contextlib.suppress(Exception):
                        body = request.post_data
                        if body:
                            payload = json.loads(body)
                            if isinstance(payload, dict):
                                remember("device_id", payload.get("device_id"),
                                         "login-payload")
                with contextlib.suppress(Exception):
                    for key, val in request.headers.items():
                        low = key.lower()
                        if low == "x-device-id":
                            remember("x_device_id", val, "request-header")
                # `did` is a QUERY PARAMETER, not a header: the client builds it
                # into /api/v0/client/settings?did=<uuid>&scope=provider, which a
                # capture of the site carries 35 times with one value. Reading it
                # here is reading the exact value the browser would replay.
                remember("did", did_from_url(url), "query-param")

            page.on("request", on_request)
            note("opening https://chat.deepseek.com/sign_in in %s" % folder)
            with contextlib.suppress(Exception):
                page.goto("https://chat.deepseek.com/sign_in",
                          wait_until="domcontentloaded", timeout=timeout_ms)

            # The settings call is where the profile's `did` appears, and it is
            # what a real client fetches on load; visiting it costs nothing.
            with contextlib.suppress(Exception):
                page.wait_for_timeout(4000)

            if not headless:
                note("log in in the browser window to capture the device_id")
                with contextlib.suppress(Exception):
                    page.wait_for_timeout(timeout_ms)

            with contextlib.suppress(Exception):
                for cookie in context.cookies():
                    name = str(cookie.get("name") or "").lower()
                    candidate = device_id_from_cookie(name, cookie.get("value"))
                    if candidate:
                        remember("device_id", candidate, "cookie:%s" % name)
            with contextlib.suppress(Exception):
                stored = page.evaluate(_STORAGE_PROBE)
                if isinstance(stored, dict):
                    for key, val in stored.items():
                        remember("device_id", val, "localStorage:%s" % key)

            # The `did` is a query parameter the client builds from its own
            # stored value; read it out of storage if the page exposes it.
            with contextlib.suppress(Exception):
                did = page.evaluate(
                    r"""() => {
                      try {
                        for (let i = 0; i < localStorage.length; i++) {
                          const k = localStorage.key(i);
                          if (/^(did|device[_-]?uuid|ds[_-]?did)$/i.test(k)) {
                            return localStorage.getItem(k);
                          }
                        }
                      } catch (e) {}
                      return null;
                    }""")
                remember("did", did, "localStorage")

            if "device_id" not in found:
                raise RuntimeError(
                    "no device_id could be read from the profile at %s: the SDK had "
                    "stored none and no /users/login request was observed. Re-run "
                    "with headless=False and complete a login by hand once; the "
                    "profile keeps the identity for every later run." % folder)
        finally:
            with contextlib.suppress(Exception):
                context.close()

    note("captured device_id via %s" % found.get("origin"))
    return write_account_identity(account_id, found)


def list_profiles():
    """Every account slug that has a profile or a recorded identity, sorted."""
    base = ds_identity.identity_dir()
    names = set()
    for sub, suffix in (("profiles", ""), ("accounts", ".json")):
        folder = os.path.join(base, sub)
        with contextlib.suppress(Exception):
            for entry in os.listdir(folder):
                if suffix and not entry.endswith(suffix):
                    continue
                names.add(entry[:-len(suffix)] if suffix else entry)
    return sorted(names)


def _main(argv=None):
    """Command line: inspect, or capture, one account's identity.

    Exists so the operator can mint an identity without starting the harness —
    a fresh profile usually needs one visible login, and doing that from a CLI is
    far less awkward than driving it from a chat turn.
    """
    parser = argparse.ArgumentParser(description=__doc__.split("\n")[0])
    sub = parser.add_subparsers(dest="cmd")

    sub.add_parser("list", help="every account with a profile or a recorded identity")

    st = sub.add_parser("status", help="what an account would present (no secrets)")
    st.add_argument("account_id")

    cap = sub.add_parser("capture", help="open the profile and record its identity")
    cap.add_argument("account_id")
    cap.add_argument("--visible", action="store_true",
                     help="show the window and allow a hand login")
    cap.add_argument("--timeout-ms", type=int, default=45000)

    args = parser.parse_args(argv)
    if args.cmd == "list":
        for name in list_profiles():
            print(name)
        return 0
    if args.cmd == "status":
        print(json.dumps(identity_status(args.account_id), indent=2))
        return 0
    if args.cmd == "capture":
        def note(msg):
            print("[ds_profile] %s" % msg, flush=True)
        doc = capture_identity(args.account_id, headless=not args.visible,
                               timeout_ms=args.timeout_ms, on_status=note)
        print(json.dumps({k: (v if k != "device_id" else "<%d chars>" % len(v))
                          for k, v in doc.items()}, indent=2))
        return 0
    parser.print_help()
    return 2


if __name__ == "__main__":
    sys.exit(_main())
