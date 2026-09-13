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


def state_dir():
    """Where mutable state lives. KILN_STATE_DIR keeps it out of the source
    tree; unset, the runtime directory stands."""
    return os.environ.get("KILN_STATE_DIR") or _DIR


def identity_path():
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
    folder = state_dir()
    with _seed_lock:
        cached = _seed_cache.get(folder)
        if cached:
            return cached
        path = identity_path()
        value = _read_seed(path)
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
