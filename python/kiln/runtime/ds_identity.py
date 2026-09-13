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
import secrets
import tempfile
import threading

_DIR = os.path.dirname(os.path.abspath(__file__))

# --- the browser this connector presents -------------------------------------
# curl_cffi impersonates a real build over TLS; these are the header values that
# same build sends, so the handshake, the User-Agent and the client hints all
# describe ONE browser. They used to disagree -- a macOS Chrome 120 TLS
# fingerprint under a Windows Chrome 134 User-Agent -- and no real browser
# produces that combination, which is the sort of contradiction an anti-bot
# signal is built to catch.
IMPERSONATE = "chrome120"
UA = ("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
      "(KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36")
SEC_CH_UA = '"Not_A Brand";v="8", "Chromium";v="120", "Google Chrome";v="120"'
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


def device_id():
    """The stable ``device_id`` every login from this machine sends."""
    return _digest("device", 32)


def fingerprint_rng():
    """A fresh deterministic RNG over the identity seed.

    Fresh on every call on purpose. The values it produces -- the canvas hash,
    the GPU -- must come out IDENTICAL each time rather than advancing like a
    stream, because that is what a real browser does. Anything that should
    genuinely vary per challenge (timings, the signal envelope id) keeps using
    the ``random`` module instead.
    """
    return random.Random(int(_digest("fingerprint", 16), 16))
