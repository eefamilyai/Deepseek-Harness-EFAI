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


# --- the high-entropy half of the client hints ---------------------------------
# The triple above is what Chrome sends everywhere. Six MORE hints ride the
# same-origin requests to chat.deepseek.com, and a capture of that site shows all
# nine on every one of its 47 requests -- completion, pow-challenge, settings --
# while `hif-*.deepseek.com`, `gator.volces.com` and the CDN get the triple only.
# The split is the browser's, not a choice: the extra hints are granted per
# origin (by `Accept-CH` or its meta equivalent, and the grant persists), so a
# client that sends the triple to DeepSeek's API is advertising a browser that
# declined a grant the real one accepted.
#
# Nothing here is invented. Chrome derives every one of these from the same two
# facts this module already owns -- the browser version and the OS -- so they are
# READ OUT of `UA` and `PLATFORM` rather than written down beside them. A
# hand-written second copy is how the fingerprint drifted before: the version in
# these headers and the version in the UA must come from one source or they
# disagree the moment either is bumped.
def _ua_version():
    """The full ``Chrome/x.y.z.w`` version out of `UA`, or the major brand."""
    m = re.search(r"Chrome/(\d+(?:\.\d+)*)", UA)
    if m:
        return m.group(1)
    m = re.search(r'v="(\d+)"', SEC_CH_UA)
    return m.group(1) if m else "0"


def _ua_arch():
    """``x86`` or ``arm``, from the CPU the User-Agent names.

    An Intel Mac and a Windows PC are both ``x86``; an Apple-silicon Mac is
    ``arm``. Reporting the wrong one beside a platform string is exactly the
    contradiction these hints exist to expose, so this is read from the UA
    rather than assumed from the platform name.
    """
    if "Macintosh" in UA or "Mac OS X" in UA:
        return "arm" if "ARM" in UA or "aarch64" in UA else "x86"
    return "arm" if "aarch64" in UA or "arm" in UA.lower() else "x86"


def _ua_platform_version():
    """The OS version, in the dotted form the hint uses.

    macOS arrives in the UA as ``10_15_7`` and is reported as ``10.15.7``;
    Windows has no version in its UA at all, so it keeps the value a current
    Windows 11 build reports.
    """
    if PLATFORM == "macOS":
        m = re.search(r"Mac OS X (\d+(?:_\d+)*)", UA)
        if m:
            return m.group(1).replace("_", ".")
    if PLATFORM == "Windows":
        return "19.0.0"
    return "0.0.0"


def client_hint_extras():
    """The six hints Chrome adds once an origin is granted the high-entropy set."""
    full = _ua_version()
    return {
        "sec-ch-ua-arch": '"%s"' % _ua_arch(),
        "sec-ch-ua-bitness": '"64"',
        "sec-ch-ua-full-version": '"%s"' % full,
        # Same brands as `sec-ch-ua`, each major version padded to the full
        # four-part form -- Chrome builds this list FROM the low-entropy one, so
        # deriving it here keeps the two from ever disagreeing.
        "sec-ch-ua-full-version-list": re.sub(
            r'v="(\d+)"', lambda m: 'v="%s"' % (m.group(1) + ".0.0.0"), SEC_CH_UA),
        # Always empty on desktop: the hint exists for phones and tablets.
        "sec-ch-ua-model": '""',
        "sec-ch-ua-platform-version": '"%s"' % _ua_platform_version(),
    }


def client_hints_full():
    """All nine client hints -- the set a granted origin receives.

    Use this for ``chat.deepseek.com``, whose grant a real browser holds. Use
    ``client_hints()`` for every other origin: the grant is per-origin, and a
    third-party host that receives hints the browser would not have sent it is
    as wrong as one that receives too few.
    """
    return {**client_hints(), **client_hint_extras()}


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
    """The ``x-client-*`` headers the web client sends on every request.

    These ride ``chat.deepseek.com`` AND the two ``hif-*.deepseek.com`` hosts,
    which is why they live apart from the chat-origin-only group below.
    """
    return {
        "x-client-platform": CLIENT_PLATFORM,
        "x-client-version": CLIENT_VERSION,
        "x-client-locale": CLIENT_LOCALE,
        "x-client-bundle-id": CLIENT_BUNDLE_ID,
        "x-client-timezone-offset": str(timezone_offset()),
    }


# --- headers only chat.deepseek.com receives ----------------------------------
# A capture of the site splits its headers THREE ways, and the split is the
# browser's, not a choice:
#
#   chat.deepseek.com       all nine client hints, the x-client-* group, AND
#                           x-device-id + x-device-model (47/47 requests)
#   hif-*.deepseek.com      the client-hint triple and the x-client-* group only
#   gator.volces.com, CDN   neither group; the triple and a User-Agent at most
#
# So the device headers are scoped to ONE origin. A client that sends them to
# ``hif-*.deepseek.com`` presents a header the real browser never sends there,
# which is as wrong as omitting one it does send.
def device_model():
    """The ``x-device-model`` value: always empty on desktop.

    The browser sends this header -- present, empty -- on every chat.deepseek.com
    request. It names a phone or tablet model, so on a desktop build the value is
    the empty string, exactly like ``sec-ch-ua-model``.
    """
    return ""


def derived_x_device_id():
    """A stable UUID for ``x-device-id`` when no browser minted one.

    ``x-device-id`` is a per-profile UUID the real client keeps for the life of
    its browser profile. A real one can only be read out of a browser (see
    ``ds_profile``), and that is what should be presented.

    This is the fallback for when none has been captured, and it exists because
    OMITTING the header is the worse option: the browser sends it on all 47
    requests in the capture, so a request without it is visibly not the website's
    client, while a stable locally-derived UUID at least keeps the same shape and
    does not change between launches. It is honest about being a fallback --
    ``ds_profile.identity_status`` reports which accounts are still on it.

    UUID-shaped and derived from the machine seed, so it is stable across
    restarts and distinct per machine.
    """
    raw = _digest("x-device-id", 32)
    return "%s-%s-%s-%s-%s" % (raw[0:8], raw[8:12], raw[12:16], raw[16:20], raw[20:32])


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
_DEVICE_ID_RE = re.compile(
    # Standard base64, MIXED CASE, and no hyphen or underscore.
    #
    # A real fingerprint is 89 base64 characters of canvas, GPU and audio
    # entropy, so it carries both cases essentially always -- the chance of 89
    # draws from the base64 alphabet landing with no uppercase at all is about
    # 1e-16. Every shape that was being accepted by mistake is single-case
    # instead: the site's `smidV2` session cookie is a 14-digit timestamp
    # followed by lowercase hex, a bare `token_hex(32)` seed is lowercase hex,
    # and `x-device-id` is a lowercase UUID. Distinguishing those three from a
    # real value without a checksum is exactly what this rule can honestly
    # promise -- and a value that fails it is refused rather than presented,
    # because presenting one earns `code=40029` and reads as rate limiting.
    #
    # This is why `.thumbcache_<hash>` is NOT refused: it holds the fingerprint
    # itself (the login body is `B` followed by that cookie), and it carries
    # both cases like the value it is.
    r"^(?=.*[A-Z])(?=.*[a-z])[A-Za-z0-9+/=]{16,512}$")


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
            "device_id is not shaped like a Shumei value: expected standard "
            "base64 of 16-512 characters carrying both cases, got %d "
            "character(s)" % len(text))
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


def capture_device_id(headless=True, timeout_ms=45000, on_status=None,
                      account_id=None):
    """Read a real Shumei ``device_id`` out of a browser and persist it.

    Thin wrapper over `ds_profile.capture_identity`, which owns the profile and
    does the probing. The import is deferred because `ds_profile` imports this
    module for `identity_dir`; at module scope that would be a cycle.

    `account_id` selects WHICH Chrome profile is driven. It matters: a profile is
    the identity, so capturing for a second account against the first account's
    profile would hand both the same device. ``None`` uses one machine-level
    profile, which is right only for a single-account install.

    Returns the stored value. Raises ``RuntimeError`` with a concrete reason when
    nothing could be read -- never a placeholder, because a fabricated value here
    is precisely the defect this function exists to remove.
    """
    import ds_profile                       # deferred: see docstring

    doc = ds_profile.capture_identity(account_id or "machine",
                                      headless=headless, timeout_ms=timeout_ms,
                                      on_status=on_status)
    return doc["device_id"]


def device_id_for_account(account_id):
    """The browser-minted ``device_id`` recorded for `account_id`, or ``None``.

    A thin, cycle-free view of `ds_profile.device_id_for_account` for callers
    that already import this module. ``None`` means the account has no identity
    of its own yet -- the caller must not silently substitute the machine-level
    value, because one device serving every account is the signal being avoided.
    """
    import ds_profile                       # deferred: see capture_device_id
    return ds_profile.device_id_for_account(account_id)


def fingerprint_rng():
    """A fresh deterministic RNG over the identity seed.

    Fresh on every call on purpose. The values it produces -- the canvas hash,
    the GPU -- must come out IDENTICAL each time rather than advancing like a
    stream, because that is what a real browser does. Anything that should
    genuinely vary per challenge (timings, the signal envelope id) keeps using
    the ``random`` module instead.
    """
    return random.Random(int(_digest("fingerprint", 16), 16))
