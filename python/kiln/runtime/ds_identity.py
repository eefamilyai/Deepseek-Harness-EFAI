#!/usr/bin/env python3
"""One stable device identity per machine, shared by ds_direct and ds_waf.

DeepSeek's anti-abuse stack reads two independent things about a client:

  * the ``device_id`` the web client stores and replays on every login, and
  * the browser fingerprint -- canvas hash, GPU, screen -- carried by the WAF
    challenge signal.

A real browser presents both UNCHANGED for the life of its profile. This
connector minted a fresh random value for each on every attempt, so a routine
token refresh looked like a brand-new machine joining the account. Two
machines doing that from one address is what produces "too many requests" on
/users/login and the flagged-device responses.

Everything below derives from one persisted seed, so this machine keeps one
identity across restarts, token refreshes, and a rebuilt virtualenv.

The seed is not a credential. It is never sent anywhere; it only stops the
values this client already sends from changing under it.
"""

import contextlib
import hashlib
import json
import os
import random
import re
import secrets
import tempfile
import threading
import time

_DIR = os.path.dirname(os.path.abspath(__file__))

# --- the browser this connector presents -------------------------------------
# curl_cffi impersonates a real build over TLS; these are the header values that
# same build sends, so the handshake, the User-Agent and the client hints all
# describe ONE browser. They used to disagree -- a macOS Chrome 120 TLS
# fingerprint under a Windows Chrome 134 User-Agent -- and no real browser
# produces that combination, which is the sort of contradiction an anti-bot
# signal is built to catch.
#
# The version is curl_cffi's CEILING, not the newest Chrome in the wild. Every
# desktop Chrome curl_cffi 0.16.2 can impersonate is the macOS build
# (`edge101` is its only Windows entry and is years old), so a Windows UA here
# would be a browser whose TLS handshake this client cannot produce -- the same
# contradiction, just moved. A stale-looking version is the lesser signal: the
# website's own client has moved on, but a fingerprint that matches the
# handshake it arrives on is at least a browser that exists.
#
# `test_ds_identity.py` pins this against curl_cffi's own tables, so bumping
# curl_cffi or editing one of these lines alone fails the suite instead of
# silently shipping a mismatched identity.
IMPERSONATE = "chrome150"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/150.0.0.0 Safari/537.36")
SEC_CH_UA = '"Not;A=Brand";v="8", "Chromium";v="150", "Google Chrome";v="150"'
SEC_CH_UA_PLATFORM = '"macOS"'
SEC_CH_UA_MOBILE = "?0"

# The platform the presented browser runs on, read OUT of the User-Agent rather
# than restated beside it. A second hand-written copy is exactly how the
# fingerprint drifted before: the headers said Windows Chrome 134 while the UA
# and the TLS handshake said macOS Chrome 120, so every challenge advertised a
# browser that does not exist.
PLATFORM = ("macOS" if "Macintosh" in UA
            else "Windows" if "Windows" in UA
            else "Linux")


def client_hints():
    """The client-hint triple, which must agree with `UA` and `PLATFORM`.

    Every request that carries a User-Agent carries these too, and a challenge
    signal that names a different platform than the request that delivered it is
    the contradiction an anti-abuse signal is built to catch.
    """
    return {
        "sec-ch-ua": SEC_CH_UA,
        "sec-ch-ua-mobile": SEC_CH_UA_MOBILE,
        "sec-ch-ua-platform": SEC_CH_UA_PLATFORM,
    }


# --- the DeepSeek web client riding that browser ------------------------------
# Not browser facts, so curl_cffi knows nothing about them and no fingerprint
# contains them: these identify the chat APPLICATION. A capture of a real
# `users/login` request is the source. `x-client-version` matters most -- the
# server knows which builds it has shipped, so a retired one reads as a stale or
# forged client rather than as a browser quirk, and omitting the group entirely
# does not look like the website at all.
CLIENT_VERSION = "2.5.0"
CLIENT_PLATFORM = "web"
CLIENT_LOCALE = "en_US"
CLIENT_BUNDLE_ID = "com.deepseek.chat"


def timezone_offset():
    """This machine's UTC offset in seconds, as the web client reports it.

    Read from the clock rather than pinned: a real client sends the offset it is
    actually running at, so one hardcoded value is wrong for every operator
    outside a single timezone. ``time.timezone`` is seconds WEST of UTC, so the
    value a client sends is its negation (UTC+8 -> 28800).
    """
    if time.daylight and time.localtime().tm_isdst:
        return -time.altzone
    return -time.timezone


def client_headers():
    """The ``x-client-*`` headers the web client sends on every request."""
    return {
        "x-client-platform": CLIENT_PLATFORM,
        "x-client-version": CLIENT_VERSION,
        "x-client-locale": CLIENT_LOCALE,
        "x-client-bundle-id": CLIENT_BUNDLE_ID,
        "x-client-timezone-offset": str(timezone_offset()),
    }


def fetch_metadata(dest, mode, site):
    """The ``sec-fetch-*`` triple and ``priority`` Chrome attaches to a fetch.

    Chrome sends these on every request it makes, the login POST included; a
    client that omits them is not shaped like a browser. The values differ per
    request kind, so the caller states them rather than this guessing -- a
    navigation is not an XHR, and the referer differs with it.
    """
    return {
        "sec-fetch-dest": dest,
        "sec-fetch-mode": mode,
        "sec-fetch-site": site,
        "priority": "u=1, i",
    }


def plugins_for_platform(pool):
    """The PDF-plugin list whose platform matches `PLATFORM`.

    A plugin list is platform evidence the same way a WebGL renderer string is:
    the Edge entry exists only on Windows and the WebKit entry only on
    macOS/WebKit builds, so presenting the Windows list under a macOS
    User-Agent advertises a browser that cannot exist. Falls back to the first
    entry rather than raising, matching `gpu_for_platform`.
    """
    for entry in pool:
        if entry.get("platform") == PLATFORM:
            return list(entry.get("plugins") or [])
    return list(pool[0].get("plugins") or []) if pool else []


def gpu_for_platform(pool):
    """The entries of `pool` whose renderer strings match `PLATFORM`.

    A WebGL renderer is platform-specific evidence -- `Direct3D11 ... ps_5_0`
    only exists on Windows, and Metal/`Apple M*` only on macOS -- so presenting
    a Windows GPU under a macOS User-Agent contradicts the same browser
    description the headers assert. Falls back to the whole pool when no entry
    claims the platform, rather than raising: a missing GPU string is a weaker
    signal than a mismatched one.
    """
    matching = [entry for entry in pool if entry.get("platform") == PLATFORM]
    return matching or pool


def state_dir():
    """Where mutable state lives. KILN_STATE_DIR keeps it out of the source
    tree; unset, the runtime directory stands."""
    return os.environ.get("KILN_STATE_DIR") or _DIR


def identity_dir():
    """Where the machine's identity seed lives.

    Deliberately NOT `state_dir()`. The harness sets `KILN_STATE_DIR` to
    `<cwd>/.kiln_kernel_state`, so a state-scoped seed is scoped to the
    LAUNCH DIRECTORY: starting the harness from a second folder minted a second
    `device_id` for the SAME computer. One machine presenting as several devices
    is exactly the signal this module exists to avoid, so the seed lives in one
    per-user location regardless of where the process was started.
    `KILN_IDENTITY_DIR` overrides it.
    """
    override = os.environ.get("KILN_IDENTITY_DIR")
    if override:
        return override
    return os.path.join(os.path.expanduser("~"), ".kiln_identity")


def identity_path():
    return os.path.join(identity_dir(), "ds_identity.json")


def _legacy_identity_path():
    """The state-scoped location the seed used before `identity_dir()`."""
    return os.path.join(state_dir(), "ds_identity.json")


_seed_cache = {}                    # state dir -> seed (see seed())
_seed_lock = threading.Lock()


def _read_seed(path):
    try:
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        value = str((doc or {}).get("seed") or "").strip()
        if len(value) >= 32:
            return value
    except Exception:
        pass
    return None


def _write_seed(path, seed_value):
    folder = os.path.dirname(os.path.abspath(path)) or "."
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".ds-id-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump({"seed": seed_value}, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        with contextlib.suppress(OSError):
            os.chmod(tmp, 0o600)
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def seed():
    """This machine's identity seed, created once and then reused.

    Two processes racing the very first call can both write; the re-read after
    writing means whichever landed second is discarded, so the machine still
    converges on exactly one seed.
    """
    folder = identity_dir()
    with _seed_lock:
        cached = _seed_cache.get(folder)
        if cached:
            return cached
        path = identity_path()
        value = _read_seed(path)
        if not value:
            # Adopt a seed already minted under the old state-scoped location
            # rather than minting a fresh one. A new device_id is one more new
            # device joining the account, which is the very signal being fixed.
            legacy = _legacy_identity_path()
            if os.path.abspath(legacy) != os.path.abspath(path):
                value = _read_seed(legacy)
            if not value:
                value = secrets.token_hex(32)
            with contextlib.suppress(Exception):
                _write_seed(path, value)
            value = _read_seed(path) or value
        _seed_cache[folder] = value
        return value


def _digest(label, length=32):
    raw = ("%s|%s" % (seed(), label)).encode("utf-8")
    return hashlib.sha256(raw).hexdigest()[:length]


# --- the device_id this machine presents -------------------------------------
# Shumei's ``device_id`` is a device-level fingerprint the real web client mints
# and then replays for the life of its browser profile. It is NOT computable
# here: the SDK runs obfuscated JS over canvas, GPU and audio entropy, so the
# only honest ways to obtain one are to read it out of a real browser, or to be
# handed one. A locally derived string is not a device id at all -- no Shumei
# fingerprint ever produces it, which is why presenting one reads as a brand-new
# device.
#
# Resolution order, first hit wins:
#   1. ``DEEPSEEK_DEVICE_ID``              -- runtime override from the settings UI
#   2. ``ds_device.json``, source=manual   -- a value pasted in once
#   3. ``ds_device.json``, source=captured -- read out of a real browser
#   4. derived fallback                    -- stable, but NOT a real Shumei id
_DEVICE_ID_ENV = "DEEPSEEK_DEVICE_ID"

# A Shumei value is an opaque base64 blob (real ones run ~89 characters). This
# is a SHAPE check, not a checksum: the connector cannot verify a fingerprint's
# contents, and pretending otherwise would be worse than not checking. It exists
# to catch the mistakes that are actually made -- a pasted bearer token, a bare
# seed, a truncated copy -- before one is presented and earns ``code=40029``.
_DEVICE_ID_RE = re.compile(r"^[A-Za-z0-9+/=_-]{16,512}$")


def device_path():
    """Where a manually supplied or captured ``device_id`` is kept."""
    return os.path.join(identity_dir(), "ds_device.json")


def valid_device_id(value):
    """Whether `value` is shaped like a Shumei ``device_id``."""
    return bool(_DEVICE_ID_RE.match(str(value or "").strip()))


def _read_device_doc():
    try:
        with open(device_path(), "r", encoding="utf-8") as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except Exception:
        return {}


def _write_device_doc(doc):
    folder = identity_dir()
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".ds-dev-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        with contextlib.suppress(OSError):
            os.chmod(tmp, 0o600)
        os.replace(tmp, device_path())
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


def set_device_id(value, source="manual"):
    """Persist the ``device_id`` this machine should present; return the stored value.

    Raises ``ValueError`` on a value that is not shaped like one. Storing a
    malformed id and presenting it is what earns ``code=40029`` from
    /users/login -- a rejection that reads like rate limiting and sends the
    operator looking in entirely the wrong place.
    """
    text = str(value or "").strip()
    if not valid_device_id(text):
        raise ValueError(
            "device_id is not shaped like a Shumei value: expected a base64-ish "
            "string of 16-512 characters, got %d character(s)" % len(text))
    doc = _read_device_doc()
    doc["device_id"] = text
    doc["source"] = source
    doc["updated_at"] = time.time()
    _write_device_doc(doc)
    return text


def configured_device_id():
    """The configured ``device_id`` and where it came from, or ``(None, None)``."""
    env = str(os.environ.get(_DEVICE_ID_ENV) or "").strip()
    if valid_device_id(env):
        return env, "env"
    doc = _read_device_doc()
    stored = str(doc.get("device_id") or "").strip()
    if valid_device_id(stored):
        return stored, str(doc.get("source") or "stored")
    return None, None


def device_id():
    """The ``device_id`` every login from this machine sends.

    A configured or captured value is returned VERBATIM. Only when neither
    exists does this fall back to a locally derived string -- stable, so the
    machine at least does not look like a new device every launch, but it is not
    a Shumei fingerprint and accounts may still refuse it as an unknown device.
    """
    value, _source = configured_device_id()
    if value:
        return value
    return _digest("device", 32)


def device_id_status():
    """What this machine will present and why, for the settings UI and logs.

    Reports the resolved value's LENGTH and origin rather than the value itself,
    so a misconfiguration is diagnosable without printing a fingerprint into a
    log or across a wire.
    """
    value, source = configured_device_id()
    if value:
        return {"configured": True, "source": source, "length": len(value)}
    return {
        "configured": False,
        "source": "derived",
        "length": 32,
        "warning": (
            "no Shumei device_id is configured for this machine, so a locally "
            "derived value is being sent; it is not a real device fingerprint "
            "and the account may refuse it as an unknown device"),
    }


def capture_device_id(headless=True, timeout_ms=45000, on_status=None):
    """Read a real Shumei ``device_id`` out of a browser and persist it.

    The id is minted by the SDK's obfuscated JS, so the only way to obtain the
    genuine article is to let a real browser produce it and read it back. Three
    sources are probed, in order of authority:

      * the ``device_id`` field of the ``/users/login`` request payload, which is
        exactly the value the web client sends and therefore exactly what this
        connector must replay;
      * the SDK's own cookie slot, populated on page load; and
      * its localStorage slot, for the same reason.

    ``headless=False`` additionally lets the operator complete a login by hand
    when the storage probes come up empty, which is the case on a fresh profile
    until the SDK has had a reason to persist.

    Returns the stored value. Raises ``RuntimeError`` with a concrete reason when
    nothing could be read -- never a placeholder, because a fabricated value here
    is precisely the defect this function exists to remove.
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

    captured = {}

    def remember(value, origin):
        text = str(value or "").strip()
        # A login payload wins outright; the storage slots only fill a gap.
        if text and valid_device_id(text) and (
                "value" not in captured or origin == "login-payload"):
            captured["value"] = text
            captured["origin"] = origin

    with sync_playwright() as pw:
        browser = pw.chromium.launch(headless=bool(headless))
        try:
            context = browser.new_context()
            page = context.new_page()

            def on_request(request):
                if "/users/login" not in request.url:
                    return
                try:
                    body = request.post_data
                except Exception:
                    return
                if not body:
                    return
                with contextlib.suppress(Exception):
                    payload = json.loads(body)
                    if isinstance(payload, dict):
                        remember(payload.get("device_id"), "login-payload")

            page.on("request", on_request)
            note("opening https://chat.deepseek.com/sign_in")
            with contextlib.suppress(Exception):
                page.goto("https://chat.deepseek.com/sign_in",
                          wait_until="domcontentloaded", timeout=timeout_ms)

            # Give the SDK a moment to initialise and persist its slot.
            with contextlib.suppress(Exception):
                page.wait_for_timeout(4000)

            if not headless:
                note("log in in the browser window to capture the device_id")
                with contextlib.suppress(Exception):
                    page.wait_for_timeout(timeout_ms)

            with contextlib.suppress(Exception):
                for cookie in context.cookies():
                    name = str(cookie.get("name") or "").lower()
                    if name in ("smidv2", "smidv1", "smid", "deviceid", "device_id"):
                        remember(cookie.get("value"), "cookie:%s" % name)
            with contextlib.suppress(Exception):
                found = page.evaluate("""() => {
                    const out = {};
                    try {
                        for (let i = 0; i < localStorage.length; i++) {
                            const k = localStorage.key(i);
                            if (/smid|device/i.test(k)) out[k] = localStorage.getItem(k);
                        }
                    } catch (e) {}
                    return out;
                }""")
                if isinstance(found, dict):
                    for key, val in found.items():
                        remember(val, "localStorage:%s" % key)

            if "value" not in captured:
                raise RuntimeError(
                    "no device_id could be read: the SDK had stored none and no "
                    "/users/login request was observed. Re-run with a visible browser "
                    "(headless=False) and complete a login by hand.")
            context.close()
        finally:
            with contextlib.suppress(Exception):
                browser.close()

    note("captured device_id via %s" % captured.get("origin"))
    return set_device_id(captured["value"], source="captured")


def fingerprint_rng():
    """A fresh deterministic RNG over the identity seed.

    Fresh on every call on purpose. The values it produces -- the canvas hash,
    the GPU -- must come out IDENTICAL each time rather than advancing like a
    stream, because that is what a real browser does. Anything that should
    genuinely vary per challenge (timings, the signal envelope id) keeps using
    the ``random`` module instead.
    """
    return random.Random(int(_digest("fingerprint", 16), 16))
