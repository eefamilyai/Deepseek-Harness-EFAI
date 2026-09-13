#!/usr/bin/env python3
"""
ds_direct — talk to chat.deepseek.com DIRECTLY (no proxy).

Drop-in replacement for kiln-code's old localhost:8000 deepseek-free-api proxy.
Solves DeepSeek's Proof-of-Work via its own wasm (run through Node), holds one
session, and streams the current fragment SSE format as reasoning/content deltas.

Config: ds_config.json next to this file (or ../../../Crazy-AI/ds_config.json):
    {"token": "<bearer>", "cookie": "smidV2=...; cf_clearance=...; aws-waf-token=...; ds_session_id=..."}
Grab both from chat.deepseek.com devtools (the /completion request).
"""

import base64
import contextlib
import hashlib
import json
import os
import re
import shutil
import struct
import subprocess
import tempfile
import threading
import time

import config
import ds_identity
from token_usage import estimate_tokens

try:
    import ds_waf
except Exception:  # pragma: no cover
    ds_waf = None

try:
    # CurlMime lives on the PACKAGE, not on `requests`. Importing it separately
    # rather than reaching through `cffi.` — the attribute isn't there, and the
    # AttributeError only shows up the first time someone uploads a file.
    from curl_cffi import CurlMime
    from curl_cffi import requests as cffi
except Exception as _cffi_import_err:  # pragma: no cover
    # Capture the REAL failure: on Windows this is often a wrong-interpreter
    # problem (server started outside the project venv) or a DLL load error,
    # not a missing package — the old message sent users on a dead-end
    # "pip install" chase when the package was already installed.
    cffi = None
    CurlMime = None
    _CFFI_IMPORT_ERROR = _cffi_import_err
else:
    _CFFI_IMPORT_ERROR = None


def _cffi_unavailable():
    """Diagnose WHY curl_cffi can't be used, including the interpreter in play.
    The single most common cause is the server running outside the project
    venv (e.g. a bare `python` on PATH), so name that explicitly."""
    import sys as _sys
    detail = repr(_CFFI_IMPORT_ERROR) if _CFFI_IMPORT_ERROR else "package not found"
    return ("curl-cffi unavailable in the server's Python (%s): %s. "
            "Start the server with the project venv — `uv run python server.py` "
            "— then `uv sync` if it still can't be imported."
            % (_sys.executable, detail))

BASE = "https://chat.deepseek.com/api/v0"
# The browser this connector presents. ds_identity owns both halves so the
# TLS fingerprint curl_cffi impersonates and the headers below always
# describe the SAME build -- a macOS Chrome 120 handshake under a Windows
# Chrome 134 User-Agent is a combination no real browser emits.
IMPERSONATE = ds_identity.IMPERSONATE
UA = ds_identity.UA
# How long a freshly minted token stays good enough to hand to another client
# that was waiting on the same account. Only spans the concurrent-401 burst.
LOGIN_REUSE_WINDOW = 60
BUSY_MAX_TRIES = 40      # ~3 min of "server is busy" before giving up
RATE_MAX_TRIES = 20      # ~1 h of "rate limited" before giving up (see DS_RATE_WAIT)
# How long to wait for DeepSeek to finish parsing an upload. This blocks the
# attachment chip, so it is short on purpose: a file that isn't ready in 20s
# almost never becomes ready, and a spinner that sits for a minute reads as a
# hang rather than as patience.
FILE_READY_TIMEOUT = 20
_DIR = os.path.dirname(os.path.abspath(__file__))
WASM_CACHE = os.path.join(_DIR, "sha3_wasm_bg.wasm")
POW_JS = os.path.join(_DIR, "_pow_solver.cjs")
WASM_URL = "https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm"

# kiln model id -> (model_type, thinking_enabled, search_enabled)
#
# `search_enabled` may not be only "may it use the web". On the expert tier it
# looks like it also selects WHICH BUILD answers: the tell is the writing — one
# build opens with "I'll", the other with "Let me". The evidence is one A/B where
# a reference script sending search=true produced the first and this file
# produced the second, with every other field in the two requests byte-identical,
# headers included.
#
# This is a HYPOTHESIS, not a settled fact — it comes from one A/B where the two
# requests differed in exactly this field and nothing else. So both settings are
# in the picker, side by side, and you can flip between them mid-conversation to
# confirm or kill it without editing any source. If the no-web variant turns out
# to write "I'll" as well, then search_enabled is innocent and the real cause is
# elsewhere — start with the session, which is the other thing that differs
# (this file reuses one chat across turns; the reference script opens a fresh
# one every run).
#
# DECISION (DSML): the expert/agent tier now ships with search OFF. Sending
# `search_enabled: true` tells the web model it has a tool available, which
# primes it to emit its native DSML tool-call markup instead of a ```python
# fence — and on this endpoint that markup has nothing to dispatch it. Web
# search stays available on the explicit `*-search` ids for chat that needs it.
MODEL_MAP = {
    "deepseek-default":            ("default", False, False),
    "deepseek-reasoner":           ("default", True,  False),
    "deepseek-search":             ("default", False, True),
    "deepseek-reasoner-search":    ("default", True,  True),
}

# Retired ids that must still RESOLVE. chat.deepseek.com's picker collapsed to
# the four modes above, so the Expert and Vision tiers no longer exist as
# choices — but a conversation, an agent preset, a saved default, or a pinned
# route may still name one. Deleting the ids outright would send every such
# reference through `MODEL_MAP.get(model, ...)`'s fallback and silently change
# which model answers; resolving them onto the closest surviving mode keeps the
# old name working and only changes the LABEL the picker shows.
#
# Each maps onto a mode whose (model_type, thinking, search) matches what the
# retired id used to send, so a legacy turn behaves as it did before:
#   * Expert shipped with thinking ON and search OFF  -> deepseek-reasoner
#   * Expert Search shipped with search ON            -> deepseek-reasoner-search
#   * Vision is no longer a distinct tier at all: images and files now ride an
#     ordinary `default` chat as `ref_file_ids`, which is verified working
#     (see describe_files), so the vision ids resolve to the plain modes.
LEGACY_ALIASES = {
    "deepseek-expert":             "deepseek-reasoner",
    "deepseek-expert-reasoner":    "deepseek-reasoner",
    "deepseek-expert-offline":     "deepseek-reasoner",
    "deepseek-expert-search":      "deepseek-reasoner-search",
    "deepseek-vision":             "deepseek-default",
    "deepseek-vision-reasoner":    "deepseek-reasoner",
}


def resolve_model(model):
    """Map any accepted id — current or retired — onto a live mode id.

    The ONE place that decides which mode a requested id means. Callers that
    only need the flags go through `MODEL_MAP[resolve_model(model)]`; keeping
    the lookup here rather than repeating a `.get(..., default)` at each call
    site is what makes a legacy id behave identically everywhere (streaming,
    session keys, and the picker's current selection).
    """
    m = model or ""
    if m in MODEL_MAP:
        return m
    return LEGACY_ALIASES.get(m, "deepseek-default")


# Display names, read by providers.py so the model picker doesn't have to
# reverse-engineer these ids. Only the four live modes appear here: this map is
# the advisory catalogue the harness falls back to before a token is present
# (see provider_bridge._advertised), so a retired id listed here would put a
# mode the website no longer offers back in front of the user.
LABELS = {
    "deepseek-default":            "DeepSeek",
    "deepseek-reasoner":           "DeepSeek \u00b7 Thinking",
    "deepseek-search":             "DeepSeek \u00b7 Search",
    "deepseek-reasoner-search":    "DeepSeek \u00b7 Thinking + Search",
}


# ─── config (hot-reloaded from disk — a token refresh needs no server restart) ──
def _atomic_json(path, obj):
    """Replace a JSON file without a window where it is truncated.

    `open(path, "w")` empties the file first. ds_config.json holds the ONLY copy
    of the token, the cookies and the login password, and the old code truncated
    it and then serialised — with the whole thing wrapped in `except: pass`. Any
    failure in between logged you out silently and left you re-pasting a token
    out of devtools with no idea why.
    """
    folder = os.path.dirname(os.path.abspath(path)) or "."
    # KILN_STATE_DIR may name a directory nobody has created yet — the harness
    # points it at a state folder rather than at this source tree. `mkstemp`
    # raises on a missing directory, and `_save_sessions` swallows that, so the
    # symptom was every chat-session pin silently failing to persist and each
    # restart re-priming a brand-new DeepSeek chat from a clipped transcript.
    os.makedirs(folder, exist_ok=True)
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".ds-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(obj, f, indent=2)
            f.flush()
            os.fsync(f.fileno())
        os.replace(tmp, path)
    except BaseException:
        with contextlib.suppress(OSError):
            os.remove(tmp)
        raise


_CONTENT_TYPES = {
    ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg",
    ".gif": "image/gif", ".webp": "image/webp", ".bmp": "image/bmp",
    ".tif": "image/tiff", ".tiff": "image/tiff", ".heic": "image/heic",
    ".heif": "image/heif", ".avif": "image/avif", ".svg": "image/svg+xml",
    ".pdf": "application/pdf", ".txt": "text/plain", ".md": "text/markdown",
}


def _content_type(filename):
    """A real content type, because DeepSeek routes on it.

    application/octet-stream for a PNG gets it treated as a generic blob rather
    than an image, and the vision model then has nothing to look at.
    """
    ext = os.path.splitext(str(filename or "").lower())[1]
    return _CONTENT_TYPES.get(ext, "application/octet-stream")


def _config_paths():
    """Where to look for ds_config.json. KILN_DS_CONFIG overrides everything,
    so the credentials file can live outside the project folder."""
    override = os.environ.get("KILN_DS_CONFIG")
    paths = [override] if override else []
    paths.append(os.path.join(_DIR, "ds_config.json"))
    return [p for p in paths if p]


# ─── accounts (one or many DeepSeek logins) ─────────────────────────
# A DeepSeek "account" is one credential set: a bearer token + WAF cookies, and
# optionally email/mobile + password for automatic token refresh. Kiln can hold
# SEVERAL, so parallel agents don't contend over a single login and a
# busy/blocked account can fail over to another. Backward compatible: a plain
# top-level {"token","cookie",...} in ds_config.json is simply account #0; a new
# "accounts": [ {...}, {...} ] array (each with its own token/cookie and
# optionally email+password) adds more.
class _Account:
    """One DeepSeek login. `source` records WHERE to persist a refreshed
    token/cookie, so a re-login rewrites the right slot and touches nothing else:
    ("env",) | ("top", path) | ("array", path, index)."""
    __slots__ = ("id", "token", "cookie", "email", "mobile", "area_code",
                 "password", "headers", "source", "mtime", "lock",
                 "_last_saved_cookie", "login_lock", "last_login_token",
                 "last_login_at", "last_login_cookie")

    def __init__(self, id, token="", cookie="", email="", mobile="",
                 area_code="+86", password="", source=("env",), mtime=0.0,
                 headers=None):
        self.id = id
        self.token = token or ""
        self.cookie = cookie or ""
        self.email = email or ""
        self.mobile = mobile or ""
        self.area_code = area_code or "+86"
        self.password = password or ""
        # Extra request headers, verbatim from ds_config.json. This exists for
        # the `x-hif-*` anti-abuse pair DeepSeek's web client sends: each is an
        # AES-GCM blob (41-byte ciphertext+tag, then a 12-byte IV after the dot)
        # minted by obfuscated JS, so they cannot be computed here — only
        # captured and replayed. Deliberately NOT hardcoded in this file: the
        # plaintext is short enough to be little more than a timestamp and an
        # id, so a baked-in constant would go stale, and one value replayed on
        # every request is a sharper bot signal than sending nothing.
        self.headers = {str(k): str(v) for k, v in (headers or {}).items()}
        self.source = source
        self.mtime = mtime
        self.lock = threading.Lock()
        self._last_saved_cookie = ""
        # One login at a time per ACCOUNT. Pooled clients share an account and
        # each retries 401 independently, so N conversations hitting an
        # expired token fired N concurrent /users/login posts for one identity
        # -- which DeepSeek answers with "too many requests". This lock plus
        # the token handoff below collapses those into one login.
        self.login_lock = threading.Lock()
        self.last_login_token = ""
        self.last_login_at = 0.0
        self.last_login_cookie = ""

    def update_from(self, other):
        """Refresh creds in place from a freshly-read copy, keeping object
        identity so pooled clients holding this account see the new token."""
        self.token, self.cookie = other.token, other.cookie
        self.email, self.mobile = other.email, other.mobile
        self.area_code, self.password = other.area_code, other.password
        self.headers = other.headers
        self.source, self.mtime = other.source, other.mtime

    def save(self, token=None, cookie=None):
        """Persist a refreshed token and/or cookie back to THIS account's slot."""
        with self.lock:
            if token:
                self.token = token
            if cookie:
                self.cookie = cookie
            kind = self.source[0] if self.source else ""
            if kind == "env":
                if token:
                    os.environ["DEEPSEEK_TOKEN"] = token
                if cookie:
                    os.environ["DEEPSEEK_COOKIE"] = cookie
                return
            # A source with no file slot (e.g. a "probe" account being tested by
            # add_account) has nowhere to persist a refreshed cookie — add_account
            # does its own write afterward — so this is a no-op rather than an
            # IndexError on the missing path element.
            if kind not in ("top", "array") or len(self.source) < 2:
                return
            path = self.source[1]
            try:
                with open(path, "r", encoding="utf-8") as f:
                    doc = json.load(f)
            except Exception:
                doc = {}
            if kind == "top":
                if token:
                    doc["token"] = token
                if cookie:
                    doc["cookie"] = cookie
            else:                                   # ("array", path, index)
                idx = self.source[2]
                arr = doc.get("accounts")
                if not isinstance(arr, list):
                    arr = []
                while len(arr) <= idx:
                    arr.append({})
                if not isinstance(arr[idx], dict):
                    arr[idx] = {}
                if token:
                    arr[idx]["token"] = token
                if cookie:
                    arr[idx]["cookie"] = cookie
                doc["accounts"] = arr
            try:
                _atomic_json(path, doc)
                self.mtime = os.path.getmtime(path)
            except Exception:
                pass


_accounts = []                     # list[_Account] in round-robin order
_accounts_lock = threading.Lock()
_accounts_sig = None               # config (path, mtime) signature for change detection
_rr_index = 0
_rr_lock = threading.Lock()


def _acct_id_for(raw, positional):
    """A STABLE id for an account: explicit "id" > email > mobile > positional.
    Stable ids matter because ds_sessions.json pins each conversation to one."""
    for k in ("id", "email", "mobile"):
        v = str(raw.get(k) or "").strip()
        if v:
            return v
    return positional


def _doc_usable(raw):
    """Whether one raw ds_config.json slot describes an account worth building.

    The same rule as `_usable`, applied to the JSON before an `_Account` exists.
    """
    if not isinstance(raw, dict):
        return False
    if raw.get("token"):
        return True
    return bool(raw.get("password") and (raw.get("email") or raw.get("mobile")))


def _can_login(acct):
    """Whether this account can obtain a token by logging in.

    A password is useless without an identity to present it for, and an email
    or mobile is useless without a password, so both halves are required.
    """
    return bool(acct.password and (acct.email or acct.mobile))


def _usable(acct):
    """Whether this account can serve a request, now or after one login."""
    if acct.token and not acct.token.startswith("PASTE"):
        return True
    return _can_login(acct)


def _read_accounts_from_disk():
    """Build the account list from env + every ds_config.json. Order is stable:
    env first, then each config's top-level login, then its accounts[]. The same
    token appearing twice (e.g. env AND file) is de-duplicated so one real login
    isn't counted as two accounts."""
    out, seen_ids, seen_tokens = [], set(), set()

    def add(acct):
        # An account is usable with a TOKEN or with LOGIN CREDENTIALS. `login()`
        # mints a token from email/mobile + password and the 401 path calls it,
        # so credentials alone are a complete configuration — demanding a token
        # here is what made an email+password setup report "no token and cookie"
        # while holding everything needed to obtain one.
        if not acct.token and not _can_login(acct):
            return
        if acct.id in seen_ids:
            return
        # Dedup on the token only when there is one. An empty token is not
        # evidence that two credential-only accounts are the same account, and
        # collapsing them would silently drop every login after the first.
        if acct.token and acct.token in seen_tokens:
            return
        seen_ids.add(acct.id)
        if acct.token:
            seen_tokens.add(acct.token)
        out.append(acct)

    add(_Account("env", os.environ.get("DEEPSEEK_TOKEN", ""),
                 os.environ.get("DEEPSEEK_COOKIE", ""),
                 os.environ.get("DEEPSEEK_EMAIL", ""),
                 os.environ.get("DEEPSEEK_MOBILE", ""),
                 os.environ.get("DEEPSEEK_AREA_CODE", "+86"),
                 os.environ.get("DEEPSEEK_PASSWORD", ""),
                 source=("env",)))

    for p in _config_paths():
        if not os.path.exists(p):
            continue
        try:
            with open(p, "r", encoding="utf-8") as f:
                doc = json.load(f)
            mt = os.path.getmtime(p)
        except Exception:
            continue
        tag = os.path.basename(p) or "cfg"
        # A slot counts when it carries a token OR credentials to obtain one.
        # `add` makes the same judgement, but these guards run FIRST — a
        # token-only test here skipped the whole slot before `add` ever saw it,
        # which is why an email + password in ds_config.json still reported
        # "No DeepSeek token".
        if _doc_usable(doc):
            add(_Account(_acct_id_for(doc, tag + ":top"), doc.get("token"),
                         doc.get("cookie"), doc.get("email"), doc.get("mobile"),
                         doc.get("area_code") or "+86", doc.get("password"),
                         source=("top", p), mtime=mt,
                         headers=doc.get("headers")))
        arr = doc.get("accounts")
        if isinstance(arr, list):
            for i, raw in enumerate(arr):
                if not isinstance(raw, dict) or not _doc_usable(raw):
                    continue
                add(_Account(_acct_id_for(raw, f"{tag}:acct{i}"), raw.get("token"),
                             raw.get("cookie"), raw.get("email"), raw.get("mobile"),
                             raw.get("area_code") or "+86", raw.get("password"),
                             source=("array", p, i), mtime=mt,
                             headers=raw.get("headers") or doc.get("headers")))
    return out


def _config_sig():
    sig = [(
        "__env__",
        os.environ.get("DEEPSEEK_TOKEN", ""),
        os.environ.get("DEEPSEEK_COOKIE", ""),
        os.environ.get("DEEPSEEK_EMAIL", ""),
        os.environ.get("DEEPSEEK_MOBILE", ""),
        os.environ.get("DEEPSEEK_AREA_CODE", ""),
        os.environ.get("DEEPSEEK_PASSWORD", ""),
    )]
    for p in _config_paths():
        try:
            sig.append((p, os.path.getmtime(p)))
        except OSError:
            sig.append((p, None))
    return tuple(sig)


def _load_accounts(force=False):
    """(Re)build the module account list, reconciling by id so pooled clients
    keep seeing live creds. A cheap no-op when no config file has changed."""
    global _accounts, _accounts_sig
    sig = _config_sig()
    with _accounts_lock:
        if not force and sig == _accounts_sig and _accounts:
            return _accounts
        fresh = _read_accounts_from_disk()
        by_id = {a.id: a for a in _accounts}
        merged = []
        for a in fresh:
            keep = by_id.get(a.id)
            if keep is not None:
                keep.update_from(a)
                merged.append(keep)
            else:
                merged.append(a)
        _accounts = merged
        _accounts_sig = sig
        return _accounts


_load_accounts(force=True)         # build once at import


def _account_by_id(acct_id):
    for a in _accounts:
        if a.id == acct_id:
            return a
    return _accounts[0] if _accounts else None


def _default_account_id():
    return _accounts[0].id if _accounts else None


def _next_account_id():
    """Round-robin pick for a brand-new conversation (spreads load across logins)."""
    global _rr_index
    with _rr_lock:
        if not _accounts:
            return None
        acct = _accounts[_rr_index % len(_accounts)]
        _rr_index += 1
        return acct.id


def account_ids():
    """Every configured account id, in stable order.

    Public because the harness registers one route per account from this list;
    it is ids only, never a credential."""
    _load_accounts()
    return [a.id for a in _accounts]


def _persist_new_account(acct_id, email, mobile, area_code, password, token, cookie):
    """Append (or replace by id) one account in the first config file's `accounts`
    array, leaving any existing top-level or array accounts untouched. Written
    owner-only where the OS supports it. Returns (ok, error)."""
    path = _config_paths()[0]
    doc = {}
    if os.path.exists(path):
        try:
            with open(path, "r", encoding="utf-8") as f:
                doc = json.load(f)
        except Exception as e:  # noqa: BLE001 — never silently extend a corrupt file
            return False, "%s exists but is not valid JSON (%s)" % (path, e)
    if not isinstance(doc, dict):
        doc = {}
    slot = {"id": acct_id, "token": token or "", "cookie": cookie or "",
            "email": email or "", "mobile": mobile or "",
            "area_code": area_code or "+86", "password": password or ""}
    arr = doc.get("accounts")
    if not isinstance(arr, list):
        arr = []
    for i, existing in enumerate(arr):
        if isinstance(existing, dict) and existing.get("id") == acct_id:
            arr[i] = slot
            break
    else:
        arr.append(slot)
    doc["accounts"] = arr
    try:
        if not os.path.exists(path):
            os.close(os.open(path, os.O_CREAT | os.O_WRONLY, 0o600))
        try:
            os.chmod(path, 0o600)
        except OSError:
            pass  # Windows without POSIX modes — the ACL already restricts it
        with open(path, "w", encoding="utf-8") as f:
            json.dump(doc, f, indent=2, ensure_ascii=False)
    except Exception as e:  # noqa: BLE001 — report the write failure to the caller
        return False, "could not write %s (%s)" % (path, e)
    return True, None


def add_account(email="", password="", area_code="+86", mobile=""):
    """Test a DeepSeek login and, on success, persist it as a new pooled account.

    This is what the per-chat 'add account' flow calls: it logs in with the
    supplied credentials (so a stored bearer token is minted the same way the
    harness mints one), confirms the token can actually open a chat, then writes
    the account to ds_config.json so it becomes a selectable route. The password
    is never returned or logged; only the account id crosses back.

    Returns (account_id, None) on success, or (None, error_message).
    """
    if cffi is None:
        return None, _cffi_unavailable()
    email = (email or "").strip()
    mobile = (mobile or "").strip()
    if not password:
        return None, "a password is required"
    if not (email or mobile):
        return None, "an email or mobile number is required"
    acct_id = email or mobile
    acct = _Account(id=acct_id, email=email, mobile=mobile,
                    area_code=area_code or "+86", password=password, source=("probe",))
    client = _Client(acct)
    token = client.login()
    if not token:
        return None, client.last_login_error or "login failed"
    try:
        client.new_session()          # prove the token works, not just that one issued
    except Exception as e:  # noqa: BLE001 — any failure here means the login is not usable
        return None, "login succeeded but the token was rejected on first use (%s)" % e
    ok, err = _persist_new_account(acct_id, email, mobile, area_code, password,
                                   token, client.cookie_string())
    if not ok:
        return None, err
    _load_accounts(force=True)
    return acct_id, None


def _account_order(key, pinned=None):
    """Accounts to try this turn: the conversation's sticky account first (so it
    stays on ONE DeepSeek chat), then the rest as failover in ring order.

    `pinned` names an account the CALLER chose — a route bound to one login, so
    a subagent can be kept off the account the main agent is using. It outranks
    the round-robin pick for a new conversation but not an existing sticky one,
    because moving a live chat to another account would abandon its server-side
    history. The other accounts still follow as failover: an unreachable pinned
    account should degrade to a slower answer, not to no answer.
    """
    _load_accounts()
    ids = [a.id for a in _accounts]
    if not ids:
        return [None]
    sticky = None
    with _session_lock:
        st = _sessions.get(key)
        if st:
            sticky = st.get("account")
    if sticky not in ids:
        sticky = pinned if pinned in ids else _next_account_id()
    if sticky in ids:
        i = ids.index(sticky)
        return ids[i:] + ids[:i]
    return ids


def configured():
    _load_accounts()
    return any(_usable(a) for a in _accounts)


def _load_creds():
    """Legacy single-account view (first account's token, cookie, mtime). Kept
    for the standalone ds_*_test.py scripts that predate multi-account."""
    _load_accounts()
    if _accounts:
        a = _accounts[0]
        return a.token, a.cookie, a.mtime
    return (os.environ.get("DEEPSEEK_TOKEN", ""),
            os.environ.get("DEEPSEEK_COOKIE", ""), 0.0)


def _persist_cookies(client):
    """Save the client's account cookies if the WAF token changed (sliding refresh)."""
    acct = getattr(client, "account", None)
    if acct is None:
        return
    cs = client.cookie_string()
    # pooled clients finish turns concurrently — serialise the compare-and-write
    with _cookie_lock:
        if cs and cs != acct._last_saved_cookie:
            acct.save(cookie=cs)
            acct._last_saved_cookie = cs


# ─── Proof-of-Work (DeepSeek's own wasm via Node; python fallback) ──
_POW_JS_SRC = r"""
const fs = require('fs'), path = require('path');
async function main() {
  const config = JSON.parse(process.argv[2]);
  let wasmPath = process.argv[3];
  if (!wasmPath) {
    for (const f of fs.readdirSync(__dirname)) {
      if (f.endsWith('.wasm')) { wasmPath = path.join(__dirname, f); break; }
    }
  }
  const buf = fs.readFileSync(wasmPath);
  const mod = await WebAssembly.compile(buf);
  const inst = await WebAssembly.instantiate(mod, {});
  const mem = inst.exports.memory;
  const prefix = `${config.salt}_${config.expire_at}_`;
  function w(str) {
    const e = Buffer.from(str, 'utf-8');
    const ptr = inst.exports.__wbindgen_export_0(e.length, 1);
    const v = new Uint8Array(mem.buffer);
    for (let i = 0; i < e.length; i++) v[ptr + i] = e[i];
    return { ptr, length: e.length };
  }
  const retptr = inst.exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const c = w(config.challenge), p = w(prefix);
    inst.exports.wasm_solve(retptr, c.ptr, c.length, p.ptr, p.length, config.difficulty);
    const status = new Int32Array(mem.buffer)[retptr/4];
    if (status === 0) process.exit(1);
    const answer = Math.floor(new Float64Array(mem.buffer)[(retptr+8)/8]);
    const result = {
      algorithm: config.algorithm, challenge: config.challenge, salt: config.salt,
      answer, signature: config.signature, target_path: config.target_path,
    };
    process.stdout.write(Buffer.from(JSON.stringify(result)).toString('base64'));
  } finally { inst.exports.__wbindgen_add_to_stack_pointer(16); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
"""


def _find_wasm():
    for root in (_DIR, os.path.join(_DIR, "..", "..", "..", "Crazy-AI")):
        if not os.path.isdir(root):
            continue
        for dp, dirs, files in os.walk(root):
            for fn in files:
                if fn.endswith(".wasm") and "sha3" in fn.lower():
                    return os.path.join(dp, fn)
            if dp.count(os.sep) - root.count(os.sep) > 3:
                dirs[:] = []
    return None


def _ensure_pow_assets():
    if not os.path.exists(POW_JS):
        with open(POW_JS, "w", encoding="utf-8") as f:
            f.write(_POW_JS_SRC)
    if os.path.exists(WASM_CACHE):
        return WASM_CACHE
    found = _find_wasm()
    if found:
        try:
            shutil.copy(found, WASM_CACHE)
            return WASM_CACHE
        except Exception:
            return found
    data = cffi.get(WASM_URL, impersonate=IMPERSONATE, timeout=60).content
    with open(WASM_CACHE, "wb") as f:
        f.write(data)
    return WASM_CACHE


def _solve_pow_node(ch):
    wasm = _ensure_pow_assets()
    r = subprocess.run(["node", POW_JS, json.dumps(ch), wasm],
                       capture_output=True, text=True, timeout=120)
    out = (r.stdout or "").strip()
    if not out:
        raise RuntimeError(f"node wasm solver: {(r.stderr or '')[-200:]}")
    return out


def _solve_pow_python(ch):
    prefix = f"{ch['salt']}_{ch['expire_at']}_"
    difficulty = ch.get("difficulty") or 1        # 0/None would divide by zero
    threshold = (2 ** 32) // max(1, int(difficulty))
    ans = None
    for n in range(10_000_000):
        h = hashlib.sha3_256((ch["challenge"] + prefix + str(n)).encode()).digest()
        if struct.unpack("<I", h[:4])[0] < threshold:
            ans = n
            break
    if ans is None:
        raise RuntimeError("PoW: no solution")
    result = {"algorithm": ch["algorithm"], "challenge": ch["challenge"], "salt": ch["salt"],
              "answer": ans, "signature": ch["signature"], "target_path": ch["target_path"]}
    return base64.b64encode(json.dumps(result).encode()).decode()


def solve_pow(ch):
    try:
        return _solve_pow_node(ch)
    except Exception as e:
        # The pure-python fallback can grind through millions of hashes; if we
        # end up here every request, that's a silent, severe slowdown worth
        # seeing rather than swallowing.
        import sys as _sys
        print(f"[ds_direct] node PoW solver unavailable ({e}) — using slow "
              f"python fallback", file=_sys.stderr, flush=True)
        return _solve_pow_python(ch)


# ─── DeepSeek client (one shared session) ───────────────────────────
class _AuthExpired(Exception):
    """Token/cookies no longer valid (401, or a 200 with data:null)."""

    def __init__(self, detail=None):
        # Every raise site knows WHICH credential check failed, but most pass
        # nothing, and `"%s" % e` on a bare exception renders as an empty string
        # -- which surfaced to the user as "auth failed during upload:" with the
        # reason missing. A default keeps the class usable when raised bare and
        # lets a caller that knows more say so.
        super().__init__(detail or "the DeepSeek session is no longer valid")


class _SessionStale(RuntimeError):
    """THIS conversation's DeepSeek chat session is bad (unknown session id, or a
    parent_message_id it won't accept) — as opposed to a transient failure. Only
    this warrants abandoning the session and opening a new DeepSeek chat."""


class _RateLimited(Exception):
    """DeepSeek answered HTTP 429 and there is no other account to fail over to.

    Distinct from a plain transient RuntimeError because the response is
    different: a rate limit is a quota window that reopens on its own, so the
    turn waits DS_RATE_WAIT and resends rather than failing the request. Raised
    only before anything has streamed."""

    def __init__(self, reason=""):
        super().__init__(reason)
        self.reason = reason


class _RotateAccount(Exception):
    """This account can't serve the turn (busy / blocked / auth-dead) and NOTHING
    has been streamed yet — so the driver should try the next account. Never
    raised once content has been yielded: a half-answer must not switch accounts."""

    def __init__(self, reason=""):
        super().__init__(reason)
        self.reason = reason


class _ContextFull(RuntimeError):
    """The DeepSeek chat is full ("Length limit reached"). Not transient and not
    per-account — the transcript itself is too long — so it is NOT retried here
    and NOT failed over to another login. It is raised with context-overflow
    wording the harness recognises, which runs the same compaction as `/compact`
    and retries; on that retry the transcript is shorter and _stream_with opens a
    fresh chat primed with the compacted history (see the shrink check)."""


class _Client:
    def __init__(self, account):
        self.sess = cffi.Session()
        self.account = account
        self.token = ""
        self.last_login_error = None
        self.creds_mtime = 0.0         # so the pool knows when this client is stale
        # Set when the last login was refused by the anti-abuse stack rather
        # than by the credential. A device verdict is about this machine, so it
        # must not be answered by trying the next account.
        self.last_login_device_risk = False
        if account is not None:
            self.apply_account(account)

    def apply_account(self, account):
        """Bind this client to an account: swap in its token + cookies in place."""
        self.account = account
        self.token = account.token or ""
        self.creds_mtime = account.mtime
        for part in (account.cookie or "").split(";"):
            if "=" in part:
                k, v = part.strip().split("=", 1)
                try:
                    self.sess.cookies.set(k.strip(), v)
                except Exception:
                    pass

    def cookie_string(self):
        """Current cookies as 'name=value; ...' — captures WAF tokens DeepSeek refreshes."""
        try:
            return "; ".join(f"{k}={v}" for k, v in self.sess.cookies.get_dict().items())
        except Exception:
            return ""

    def _headers(self, pow_response=None):
        h = {
            "accept": "*/*", "authorization": f"Bearer {self.token}",
            "content-type": "application/json", "origin": "https://chat.deepseek.com",
            "referer": "https://chat.deepseek.com/",
            "user-agent": UA,
            "sec-ch-ua": ds_identity.SEC_CH_UA,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": ds_identity.SEC_CH_UA_PLATFORM,
            "x-client-platform": "web", "x-client-version": "2.3.0",
            "x-client-locale": "en_US", "x-client-bundle-id": "com.deepseek.chat",
        }
        if pow_response:
            h["x-ds-pow-response"] = pow_response
        h.update(self._extra_headers())
        return h

    def _extra_headers(self):
        """Captured headers from ds_config.json, applied last so they win.

        Empty unless a `headers` object is configured, which keeps the proven
        default request shape exactly as it is.
        """
        acct = self.account
        return dict(acct.headers) if acct is not None and acct.headers else {}

    def _login_headers(self):
        # A fresh login must NOT carry the old/expired Bearer token.
        h = {
            "accept": "*/*", "content-type": "application/json",
            "origin": "https://chat.deepseek.com", "referer": "https://chat.deepseek.com/",
            "user-agent": UA,
            "sec-ch-ua": ds_identity.SEC_CH_UA,
            "sec-ch-ua-mobile": "?0",
            "sec-ch-ua-platform": ds_identity.SEC_CH_UA_PLATFORM,
            "x-client-platform": "web", "x-client-version": "2.3.0",
            "x-client-locale": "en_US", "x-client-bundle-id": "com.deepseek.chat",
        }
        h.update(self._extra_headers())
        return h

    def login(self):
        """Log in with THIS account's saved email/mobile + password for a fresh
        token. Returns it or None; on failure self.last_login_error explains why.

        Serialised per ACCOUNT, not per client. Pooled clients that share one
        login each hit 401 on the same expired token, and without this they all
        posted /users/login at once -- several logins for one identity inside a
        second is what earns "too many requests". The first caller logs in and
        publishes the token; the rest adopt it instead of asking again.
        """
        acct = self.account
        email = acct.email if acct else ""
        mobile = acct.mobile if acct else ""
        area = acct.area_code if acct else "+86"
        password = acct.password if acct else ""
        if not password or not (email or mobile):
            self.last_login_error = "no email/password set for this account in ds_config.json"
            return None

        lock = acct.login_lock if acct is not None else None
        if lock is None:
            return self._login_once(email, mobile, area, password)
        with lock:
            # Another client may have logged in while we waited. Its token is
            # just as good, and reusing it is the whole point of the lock.
            if (acct.last_login_token and acct.last_login_token != self.token
                    and time.time() - acct.last_login_at < LOGIN_REUSE_WINDOW):
                self.token = acct.last_login_token
                self.last_login_error = None
                # The other client already refreshed the WAF cookies for this
                # login; carrying the OLD ones into the new token is what makes
                # the retry fail again.
                for part in (acct.last_login_cookie or "").split(";"):
                    if "=" in part:
                        k, v = part.strip().split("=", 1)
                        with contextlib.suppress(Exception):
                            self.sess.cookies.set(k.strip(), v)
                return self.token
            return self._login_once(email, mobile, area, password)

    def _login_once(self, email, mobile, area, password):
        acct = self.account
        payload = {
            # The SAME device_id every login from this machine. It used to be
            # minted fresh per attempt, so a routine token refresh presented as
            # a new device joining the account -- and several machines doing
            # that from one address is what earns "too many requests" on
            # /users/login. ds_identity persists it per machine.
            "password": password, "device_id": ds_identity.device_id(), "os": "web",
            "email": email or "", "mobile": mobile or "",
            "area_code": area if (mobile and not email) else "",
        }
        for _login_attempt in range(2):
            try:
                self.sess.get("https://chat.deepseek.com/", impersonate=IMPERSONATE, timeout=15)
            except Exception:
                pass
            try:
                r = self.sess.post(f"{BASE}/users/login", json=payload, headers=self._login_headers(),
                                   impersonate=IMPERSONATE, timeout=30)
            except Exception as e:
                self.last_login_error = f"login request failed: {e}"
                return None
            if r.status_code == 202 and r.headers.get("x-amzn-waf-action"):
                # AWS WAF answered before DeepSeek read the password. Solve the
                # challenge programmatically and retry once — the solved value is
                # exactly the `aws-waf-token` cookie, so refresh it in this
                # session and persist it back to the account for future turns.
                if _login_attempt == 0 and ds_waf is not None:
                    try:
                        # A STALE aws-waf-token makes the page load succeed while
                        # /users/login still refuses it. The stored token's cookie
                        # domain doesn't always match for a targeted delete, so
                        # clear the whole jar — the subsequent login rebuilds the
                        # cookies (waf token, session, clearance) from scratch.
                        self.sess.cookies.clear()
                        waf_token = ds_waf.solve_waf(self.sess)
                    except Exception as e:
                        self.last_login_error = (
                            "login blocked by AWS WAF — automatic challenge solver "
                            f"failed: {e}")
                        return None
                    self.sess.cookies.set("aws-waf-token", waf_token,
                                          domain="chat.deepseek.com")
                    if acct:
                        acct.save(cookie=self.cookie_string())
                    config.dbg("ds_direct solved AWS WAF challenge for login")
                    continue
                self.last_login_error = (
                    "login blocked by AWS WAF — challenge solver unavailable or "
                    "login still refused after solving.")
                return None
            break
        try:
            d = r.json()
        except Exception:
            self.last_login_error = f"non-JSON login response (HTTP {r.status_code}): {(r.text or '')[:150]}"
            return None
        data = d.get("data") or {}
        tok = (data.get("biz_data") or {}).get("user", {}).get("token")
        if not tok:
            detail = (f"login rejected — HTTP {r.status_code}, "
                      f"code={d.get('code')}/{data.get('biz_code')} "
                      f"{data.get('biz_msg') or d.get('msg') or ''}".strip())
            self.last_login_error = detail
            # The anti-abuse stack refusing the DEVICE is not a bad password, so
            # it is recorded apart from the message. The caller must not answer
            # it by rotating to the next account: the same machine earns the
            # same verdict for every credential, and each attempt posts another
            # /users/login for an identity that is already refused.
            self.last_login_device_risk = _is_device_risk(detail)
            return None
        self.last_login_device_risk = False
        print(f"[ds_direct] token expired for account {acct.id if acct else '?'} — "
              f"re-logged in with saved password")
        self.last_login_error = None
        self.token = tok
        if acct:
            acct.save(token=tok, cookie=self.cookie_string())   # login also refreshes WAF cookies
            self.creds_mtime = acct.mtime
            # Hand this token to any client already waiting on the same
            # account, so it adopts a live token instead of posting a second
            # /users/login for an identity that just logged in.
            acct.last_login_token = tok
            acct.last_login_at = time.time()
            acct.last_login_cookie = self.cookie_string()
        return tok

    def new_session(self):
        r = self.sess.post(f"{BASE}/chat_session/create", headers=self._headers(),
                           json={"character_id": None}, impersonate=IMPERSONATE, timeout=60)
        try:
            biz = r.json()["data"]["biz_data"]
            sid = (biz.get("chat_session") or {}).get("id") or biz.get("id")
        except (KeyError, TypeError, ValueError, AttributeError):
            sid = None
        if not sid:                       # 401, or 200 with data:null → token dead
            raise _AuthExpired("the completion endpoint returned no chat session id")
        return sid

    def _pow(self, target_path="/api/v0/chat/completion"):
        """A proof-of-work challenge for ONE endpoint.

        The challenge is bound to the path it was minted for, so the upload
        endpoint needs its own — a completion challenge won't satisfy it.
        """
        r = self.sess.post(f"{BASE}/chat/create_pow_challenge",
                           headers=self._headers(), json={"target_path": target_path},
                           impersonate=IMPERSONATE, timeout=60)
        try:
            return r.json()["data"]["biz_data"]["challenge"]
        except (KeyError, TypeError, ValueError, AttributeError):
            raise _AuthExpired("the proof-of-work challenge request returned no challenge")

    def upload_file(self, filename, blob):
        """Push one file into DeepSeek's store and return its id.

        Three things have to be right and each was wrong once: `multipart=`
        rather than `files=` (curl_cffi rejects the latter), a real content type
        (DeepSeek routes on it), and a proof-of-work header minted for THIS
        path (without it you get a 200 carrying MISSING_HEADER).

        Every failure returns a message rather than raising past the caller, so
        a change at DeepSeek's end shows up as "couldn't read that file:
        <reason>" on the attachment chip. `--debug` logs the raw response.
        """
        # DeepSeek requires a proof-of-work on uploads too, and without the
        # x-ds-pow-response header it answers HTTP 200 with
        # {"code":40300,"msg":"MISSING_HEADER"} — a 200 carrying a refusal,
        # which is why this looked like "no file id" rather than "no PoW".
        pow_response = solve_pow(self._pow("/api/v0/file/upload_file"))
        headers = self._headers(pow_response)
        headers.pop("content-type", None)          # multipart sets its own
        # The web client sends the byte length up front. The endpoint accepts
        # an upload without it, but this mirrors the browser exactly and costs
        # nothing, so a future build that starts requiring it does not break
        # the attachment path first.
        headers["x-file-size"] = str(len(blob))
        # curl_cffi does NOT accept requests' `files=` — it raises
        # NotImplementedError and tells you to use `multipart`. That error text
        # went straight to the attachment chip, which is how this was found.
        mime = CurlMime()
        mime.addpart(name="file", filename=filename, data=blob,
                     content_type=_content_type(filename))
        try:
            r = self.sess.post(f"{BASE}/file/upload_file", headers=headers,
                               multipart=mime, impersonate=IMPERSONATE,
                               timeout=180)
        finally:
            with contextlib.suppress(Exception):
                mime.close()
        config.dbg("ds_direct upload_file %s -> HTTP %s %s",
                   filename, r.status_code, r.text[:300])
        if r.status_code in (401, 403):
            raise _AuthExpired()
        if r.status_code != 200:
            raise RuntimeError(f"upload failed: HTTP {r.status_code} {r.text[:200]}")
        try:
            payload = r.json()
        except Exception:
            raise RuntimeError(f"upload returned no JSON: {r.text[:200]}")

        # A 200 does NOT mean it worked. DeepSeek returns its real verdict in
        # `code`, and reading only the HTTP status turned every refusal into the
        # generic "no file id" — hiding the reason DeepSeek had just given us.
        code = payload.get("code")
        if code not in (None, 0):
            msg = payload.get("msg") or "unknown error"
            if str(code) in ("40300", "40001") or "AUTH" in str(msg).upper():
                raise _AuthExpired()
            raise RuntimeError(f"DeepSeek refused the upload: {msg} (code {code})")

        biz = (payload.get("data") or {}).get("biz_data")
        if not isinstance(biz, dict):
            raise RuntimeError(f"upload returned no file id: {r.text[:200]}")
        # The id has moved around between web builds; accept the shapes seen.
        for candidate in (biz, biz.get("file") if isinstance(biz, dict) else None):
            if isinstance(candidate, dict) and candidate.get("id"):
                return str(candidate["id"])
        raise RuntimeError(f"upload returned no file id: {r.text[:200]}")

    def file_status(self, file_ids):
        """Best-effort {id: status} for uploaded files. `{}` means UNKNOWN.

        As of this writing `/file/fetch_files` no longer returns file rows —
        it answers without a `files` array, so every call lands in the except
        and returns `{}`. That is a legitimate answer here, not a failure: the
        upload response itself already carries `status` (PENDING) and a
        `file_size`, and referencing a freshly uploaded id works immediately
        (verified: an attachment uploaded and read back in the same turn). So
        the caller must treat `{}` as "no evidence either way" and go ahead,
        which is exactly what `_describe_once` does — it only holds a file back
        when this method actually reported a non-ready status.

        Kept rather than deleted because the endpoint may come back, and a
        status check that starts working again should be used again without a
        code change.
        """
        try:
            r = self.sess.post(f"{BASE}/file/fetch_files", headers=self._headers(),
                               json={"file_ids": list(file_ids)},
                               impersonate=IMPERSONATE, timeout=60)
            items = r.json()["data"]["biz_data"]["files"]
        except Exception:
            return {}
        out = {}
        for it in items or []:
            if isinstance(it, dict) and it.get("id"):
                out[str(it["id"])] = str(it.get("status") or "")
        return out

    def open_completion(self, session_id, prompt, thinking, search, model_type,
                        parent_message_id=None, preempt=False, ref_file_ids=None):
        config.dbg("ds_direct -> completion model_type=%s thinking=%s search=%s "
                   "session=%s parent=%s preempt=%s",
                   model_type, thinking, search, session_id,
                   parent_message_id, preempt)
        pow_response = solve_pow(self._pow())
        body = {"chat_session_id": session_id, "parent_message_id": parent_message_id,
                "prompt": prompt, "ref_file_ids": list(ref_file_ids or []),
                "thinking_enabled": thinking,
                "search_enabled": search, "model_type": model_type}
        if preempt:
            body["preempt"] = True
        return self.sess.post(f"{BASE}/chat/completion", headers=self._headers(pow_response),
                              json=body, impersonate=IMPERSONATE, stream=True, timeout=600)


_client = None
_client_lock = threading.Lock()
_session_lock = threading.Lock()
# kiln conv_id -> {"sid": deepseek session, "parent": last msg id, "sent": # msgs sent}
# Persisted to disk so ONE kiln chat maps to ONE DeepSeek chat — across restarts,
# a new day, or a token change (as long as it's the same DeepSeek account).
# KILN_STATE_DIR keeps mutable state out of the vendored runtime directory: the
# harness ships this tree read-only inside a package, so a session pin written
# beside the source would be lost on reinstall (and unwritable when installed
# under a system prefix). Unset, the original beside-the-source path stands.
_SESS_FILE = os.path.join(os.environ.get("KILN_STATE_DIR") or _DIR, "ds_sessions.json")


def _load_sessions():
    try:
        with open(_SESS_FILE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


_sessions = _load_sessions()


def _save_sessions():
    # Same reasoning as _atomic_json above: corrupting this file loses every
    # kiln-conversation -> DeepSeek-chat mapping, and _load_sessions returns {}
    # for a bad file, so every existing chat would silently start from scratch.
    try:
        _atomic_json(_SESS_FILE, _sessions)
    except Exception:
        pass


# ─── client pool (per account) ──────────────────────────────────────
# A curl_cffi Session is NOT thread-safe. Two conversations streaming from
# DeepSeek at the same time shared one Session, interleaving its cookie jar and
# connection state — which showed up as one chat's answer dying or bleeding into
# the other. A single global lock would fix that but would also make the second
# chat sit there frozen until the first finished, and streams run for minutes.
# So: a small pool of independent clients, one leased per turn. With multiple
# accounts the pool is PARTITIONED by account — a client is bound to one login
# for its life, so leasing never mixes two accounts' cookies. Concurrent chats
# stay concurrent; nobody shares a Session.
POOL_MAX = 8                       # per account
_pools = {}                        # account_id -> {"idle": [clients], "total": int}
_pool_cv = threading.Condition(threading.Lock())
_cookie_lock = threading.Lock()


def _pool_for(acct_id):
    """The idle/total record for one account. Caller must hold _pool_cv."""
    p = _pools.get(acct_id)
    if p is None:
        p = {"idle": [], "total": 0}
        _pools[acct_id] = p
    return p


def _refresh_client_creds(c):
    """Hot-reload this client's ACCOUNT creds if ds_config.json changed."""
    _load_accounts()
    acct = _account_by_id(getattr(c.account, "id", None)) if c.account else None
    if acct is None:
        return
    c.account = acct
    if acct.mtime != getattr(c, "creds_mtime", None):
        if getattr(c, "creds_mtime", 0.0):
            print(f"[ds_direct] ds_config.json changed — reloaded creds for account {acct.id}")
        c.apply_account(acct)
        c.creds_mtime = acct.mtime


@contextlib.contextmanager
def _lease_client(account_id=None):
    """Borrow a client for one turn on ONE account, then hand it back to that
    account's pool. Different accounts never contend for the same Session."""
    if account_id is None:
        account_id = _default_account_id()
    with _pool_cv:
        pool = _pool_for(account_id)
        while True:
            if pool["idle"]:
                c = pool["idle"].pop()
                break
            if pool["total"] < POOL_MAX:
                pool["total"] += 1
                c = None
                break
            if not _pool_cv.wait(60):
                raise RuntimeError(
                    f"all {POOL_MAX} DeepSeek connections for account {account_id} "
                    "are busy — wait for another chat to finish, or stop one")
    if c is None:                       # slot reserved above; build outside the lock
        try:
            c = _Client(_account_by_id(account_id))
        except Exception:
            with _pool_cv:
                _pool_for(account_id)["total"] -= 1
                _pool_cv.notify()
            raise
    try:
        _refresh_client_creds(c)
        yield c
    finally:
        with _pool_cv:
            _pool_for(account_id)["idle"].append(c)
            _pool_cv.notify()


def _get_client():
    """Compat shim for the ds_*_test.py scripts — a leased client, returned at once.
    Fine for single-threaded scripts; server code must use _lease_client()."""
    with _lease_client() as c:
        return c


def _state_key(conv_id, model_type=None, search=None):
    """Which DeepSeek chat tab a kiln conversation maps to.

    The key includes the MODEL, which it did not used to. A DeepSeek session is
    opened under one set of model flags and keeps answering under them, so a
    conversation that had ever run on one model went on being served by it after
    you picked another — the picker changed, nothing else did. Keying by
    conversation alone made that invisible and unfixable from the UI.
    """
    base = conv_id or "__default__"
    if model_type is None:
        return base
    return f"{base}#{model_type}{'+s' if search else ''}"


def _get_state(client, conv_id, force_new=False, why="", model_type=None, search=None):
    """One persistent DeepSeek session per (kiln conversation, model, account),
    with parent-message threading. Leasing a DIFFERENT account than the one this
    conversation last ran on triggers a MIGRATION: that account has never seen
    this chat, so we open a fresh session on it and re-prime (parent/sent reset)."""
    key = _state_key(conv_id, model_type, search)
    acct_id = getattr(getattr(client, "account", None), "id", None)
    with _session_lock:
        st = _sessions.get(key)
        if st and acct_id and st.get("account") not in (None, acct_id):
            force_new = True                # migrating to another account
        if not force_new and st and st.get("sid"):
            if acct_id and not st.get("account"):
                st["account"] = acct_id     # adopt: legacy record with no account
                _save_sessions()
            return st
    # Create OUTSIDE the lock: new_session() is a network round-trip, and holding
    # the global session lock across it stalled every other conversation.
    sid = client.new_session()
    with _session_lock:
        cur = _sessions.get(key)
        if (not force_new and cur and cur.get("sid")
                and cur.get("account") in (None, acct_id)):
            if acct_id and not cur.get("account"):
                cur["account"] = acct_id
                _save_sessions()
            return cur                      # someone else won the race; keep theirs
        print(f"[ds_direct] new DeepSeek chat for conv={key} on account={acct_id} "
              f"({why or 'no existing session'})", file=_sys_err(), flush=True)
        st = {"sid": sid, "parent": None, "sent": 0, "account": acct_id}
        _sessions[key] = st
        _save_sessions()
        return st


def _sys_err():
    import sys
    return sys.stderr


# ─── SSE fragment parser -> (kind, text) deltas ─────────────────────
def _kind(t):
    return "reasoning" if str(t).upper() in ("THINK", "THINKING") else "content"


def _parse(resp, cancelled, raw_sink=None):
    frags, order, cur = {}, [], [None]

    def ensure(idx, ftype=None):
        if idx not in frags:
            frags[idx] = {"type": ftype or "RESPONSE", "content": ""}
            order.append(idx)
        elif ftype:
            frags[idx]["type"] = ftype
        cur[0] = idx

    def push(idx, text):
        if not isinstance(text, str) or not text:
            return None
        frags[idx]["content"] += text
        cur[0] = idx
        return (_kind(frags[idx]["type"]), text)

    def resolve(p):
        mt = re.search(r"fragments/(-?\d+)/content", p)
        if not mt:
            return None
        n = int(mt.group(1))
        return (order[-1] if order else 0) if n < 0 else n

    def apply(p, o, v):
        if not isinstance(p, str) or "fragments/" not in p:
            return None
        if p.endswith("content"):
            idx = resolve(p)
            if idx is not None:
                ensure(idx)
                return push(idx, v)
            return None
        # A fragment's TYPE being declared/flipped (e.g. THINK -> RESPONSE on the
        # same fragment). We must honour it, otherwise the answer keeps being
        # tagged as reasoning and only the 💭 Thinking panel fills — the reply then
        # looks like it "just stopped" with no answer.
        if p.endswith("type") and isinstance(v, str):
            m = re.search(r"fragments/(-?\d+)/type", p)
            if m:
                n = int(m.group(1))
                idx = (order[-1] if order else 0) if n < 0 else n
                ensure(idx, v)
        return None

    pending_event = None
    for raw in resp.iter_lines():
        if cancelled():
            return
        line = raw.decode("utf-8", "ignore") if isinstance(raw, bytes) else raw
        if not line:
            continue
        if raw_sink is not None and len(raw_sink) < 40:
            raw_sink.append(line[:220])
        if line.startswith("event:"):
            pending_event = line[6:].strip()
            continue
        if not line.startswith("data:"):
            continue
        payload = line[5:].strip()
        ev, pending_event = pending_event, None
        if ev == "title":                       # DeepSeek's own auto-title for the chat
            try:
                t = json.loads(payload).get("content")
            except Exception:
                t = None
            if t:
                yield ("title", t)
            continue
        if ev == "ready":                       # gives us this turn's message id (for threading)
            try:
                rid = json.loads(payload).get("response_message_id")
            except Exception:
                rid = None
            if rid is not None:
                yield ("__msgid__", rid)
            continue
        if ev == "hint":                        # DeepSeek server-side notice (e.g. rate limit)
            try:
                h = json.loads(payload)
            except Exception:
                h = {}
            if h.get("type") == "error":
                yield ("error", (h.get("content") or "DeepSeek error",
                                 h.get("finish_reason") or ""))
            continue
        if payload == "[DONE]":
            break
        try:
            obj = json.loads(payload)
        except Exception:
            continue
        v, p, o = obj.get("v"), obj.get("p"), obj.get("o")
        out = []

        def _refs_from(items):
            refs = []
            for it in items or []:
                if isinstance(it, dict) and it.get("url"):
                    refs.append({"i": it.get("cite_index"), "url": it.get("url"),
                                 "title": it.get("title") or "", "site": it.get("site_name") or ""})
            return refs

        def handle(pp, oo, vv):
            res = []
            if isinstance(pp, str) and pp.endswith("results") and isinstance(vv, list):
                r = _refs_from(vv)                       # web search sources
                if r:
                    res.append(("refs", r))
                return res
            if pp in ("response/fragments", "fragments") and oo == "APPEND":
                # A new fragment (e.g. the RESPONSE that follows SEARCH/THINK).
                # DeepSeek sends this as a list, but sometimes as a single dict —
                # the dict case used to be dropped, so the RESPONSE fragment was
                # never created and its content got appended to the THINK fragment
                # instead (answer shown as 'thinking', visible answer empty).
                frs = vv if isinstance(vv, list) else [vv] if isinstance(vv, dict) else []
                for fr in frs:
                    if not isinstance(fr, dict):
                        continue
                    ensure(len(order), fr.get("type"))
                    ref = _refs_from(fr.get("results"))
                    if ref:
                        res.append(("refs", ref))
                    d = push(cur[0], fr.get("content", "") or "")
                    if d:
                        res.append(d)
                return res
            d = apply(pp, oo, vv)
            if d:
                res.append(d)
            return res

        if isinstance(v, dict) and "response" in v:
            for i, fr in enumerate((v["response"] or {}).get("fragments") or []):
                ensure(i, fr.get("type"))
                ref = _refs_from(fr.get("results"))
                if ref:
                    out.append(("refs", ref))
                d = push(i, fr.get("content", "") or "")
                if d:
                    out.append(d)
        elif o == "BATCH" and isinstance(v, list):
            for it in v:
                out.extend(handle(it.get("p"), it.get("o"), it.get("v")))
        else:
            out.extend(handle(p, o, v))
            if not out and isinstance(v, str) and p is None and cur[0] is not None:
                d = push(cur[0], v)
                if d:
                    out.append(d)
        for d in out:
            yield d


# ─── public API (used by server.py) ─────────────────────────────────
def is_dsfree(model):
    """True for an id this connector owns.

    Legacy ids answer True as well: they still RESOLVE here (see LEGACY_ALIASES),
    so a router that classified them as someone else's would send a retired
    DeepSeek id to a provider that has never heard of it.
    """
    m = model or ""
    return "/" not in m and (m in MODEL_MAP or m in LEGACY_ALIASES
                             or m.startswith("deepseek-"))


def models():
    """Static list — direct connection is always available when a token is set."""
    return list(MODEL_MAP.keys()) if configured() else []


def model_labels(cfg=None):
    """id -> display name. The registry calls this with a cfg argument."""
    return dict(LABELS)


def default_model(cfg=None):
    """The mode a fresh conversation starts on. Plain `deepseek-default`.

    Not a thinking mode: the four modes are all equally available, and picking
    the plainest one as the default means a new chat behaves like the website's
    default rather than quietly spending thinking tokens on every turn.
    """
    return "deepseek-default"


# ─── file upload (the harness-facing bridge) ────────────────────────
# `describe_files` below is the specialised path: upload, then ask the model to
# DESCRIBE what it sees, returning prose. That is what an image attachment
# needs. It is the wrong shape for a caller that already knows what it wants to
# ask and just needs the file IN the chat — a document, a data file, a
# screenshot the harness itself will reason about. `upload_files` is that
# bridge: push bytes, get ids back, hand the ids to `stream(ref_file_ids=...)`.
#
# Why not just let callers reach `_Client.upload_file` directly: that needs a
# leased client, and a caller that leases one and then streams would hold two
# leases and could land on a DIFFERENT account than the chat it is about to
# write into. File ids are account-scoped, so that mismatch produces a file the
# chat cannot see. Doing the upload and releasing the lease here keeps the id
# and the chat on whatever account the pool hands out next — and the caller is
# told which account that was, so it can pin the stream to it.


def upload_files(files, account=None, cancelled=None):
    """Push [(name, blob)] into DeepSeek. -> {"account": id, "files": [...], "errors": [...]}.

    Never raises for a per-file failure: one unreadable file must not lose the
    others, which is the same rule `_describe_once` follows. A failure that
    invalidates the WHOLE call (no credentials, no curl_cffi) still raises,
    because there is nothing partial to report.

    The returned `account` is the login the ids belong to. Pass it back as
    `stream(..., account=<that id>)` so the turn that references these files
    runs on the same login; ids are not portable across accounts.
    """
    if cffi is None:
        raise RuntimeError(_cffi_unavailable())
    if not configured():
        raise RuntimeError("No DeepSeek session — put a token in ds_config.json.")
    files = [(str(n), b) for n, b in (files or [])]
    if not files:
        return {"account": None, "files": [], "errors": []}

    out, errors = [], []
    with _lease_client(account) as client:
        acct_id = getattr(getattr(client, "account", None), "id", None)
        for name, blob in files:
            if cancelled and cancelled():
                break
            try:
                out.append({"name": name, "id": client.upload_file(name, blob),
                            "size": len(blob)})
            except (_AuthExpired, _SessionStale) as e:
                # These invalidate the credential, not the file — the caller
                # re-logs-in and retries the whole call, exactly as
                # `describe_files` does, rather than reporting N file errors.
                raise RuntimeError("DeepSeek auth failed during upload (%s): %s"
                                 % (type(e).__name__, e))
            except Exception as e:  # noqa: BLE001 — one bad file, not the batch
                errors.append({"name": name, "error": "%s: %s" % (type(e).__name__, e)})
        _persist_cookies(client)          # uploads can slide the WAF cookies
    return {"account": acct_id, "files": out, "errors": errors}


def _msg_text(msg):
    c = msg.get("content", "")
    if isinstance(c, list):
        c = " ".join(x.get("text", "") for x in c
                     if isinstance(x, dict) and x.get("type") == "text")
    return str(c)


def _msg_text_accounting(msg):
    """Render one message the way the DeepSeek CHAT holds it, not the wire.

    `_msg_text` extracts only `text` blocks, which is what the wire prompt needs:
    the reasoning a turn already emitted must never be re-sent as input. The
    server-side chat is a different question. DeepSeek threads every turn onto
    ONE chat and that chat keeps the model's own thinking alongside its answers,
    so the conversation occupying the context window contains every reasoning
    block the model produced. Counting only `text` therefore priced the chat at
    roughly HALF of what the server was actually holding: over one long session,
    visible text and tool traffic came to ~6.9M characters while the reasoning
    blocks alone came to ~5.1M more.

    That gap is what made compaction look arbitrary. `_turn_usage` diffs this
    reconstruction to report usage, the harness trusts that number as its
    occupancy, and the compaction threshold is a fraction of it -- so the
    harness believed a 1M-token chat sat below 400k while DeepSeek was already
    refusing further turns on it. The refusal arrived as a server "length limit"
    hint at an unpredictable point, and every occurrence cost a forced
    compaction. Pricing the reasoning here makes the reported occupancy track
    the real chat, so the harness compacts on its own schedule instead.
    """
    c = msg.get("content", "")
    if not isinstance(c, list):
        return str(c)
    parts = []
    for block in c:
        if not isinstance(block, dict):
            continue
        if block.get("type") in ("text", "reasoning"):
            parts.append(block.get("text") or "")
        else:
            parts.append(json.dumps(block, ensure_ascii=False))
    return " ".join(parts)


def _common_prefix_len(a, b):
    """Length of the common character prefix of two strings.

    Binary search over slice equality rather than a per-character Python loop:
    this runs once per turn over the whole reconstructed chat prompt, which is
    multi-megabyte on a long conversation, and slice comparison happens in C.
    """
    n = min(len(a), len(b))
    if n == 0:
        return 0
    if a[:n] == b[:n]:
        return n
    lo, hi = 0, n            # invariant: a[:lo] == b[:lo], a[:hi] != b[:hi]
    while hi - lo > 1:
        mid = (lo + hi) // 2
        if a[:mid] == b[:mid]:
            lo = mid
        else:
            hi = mid
    return lo


# DeepSeek prompt-cache engineering parameters: the cache stores prefixes in
# 64-token blocks, and a prefix shorter than one full block (64 tokens) never
# hits the cache. The remainder of a partial final block is billed as a miss.
_CACHE_MIN_TOKENS = 64   # prefixes shorter than one block never read from cache
_CACHE_BLOCK_TOKENS = 64  # cached prefix floored to 64-token blocks


def _turn_usage(prev_prompt, prompt, output_text, reasoning_text):
    """Manual ds_direct token accounting with a real-cache-engine model.

    The common character prefix is converted to an estimated token count, then:
      * below `_CACHE_MIN_TOKENS`, nothing is read from cache (all fresh input);
      * at or above it, the cached read is floored to a `_CACHE_BLOCK_TOKENS`
        boundary, and the un-floored remainder of the common prefix is billed as
        fresh input together with the true suffix.
    Output counts TOTAL generation (visible + thinking); `reasoning` keeps
    the thinking-only subset for the harness's reasoningTokens field.
    """
    common = 0
    if prev_prompt is not None:
        common = _common_prefix_len(prev_prompt, prompt)
    common_tokens = estimate_tokens(prompt[:common])
    if common_tokens < _CACHE_MIN_TOKENS:
        cache_read = 0
    else:
        cache_read = (common_tokens // _CACHE_BLOCK_TOKENS) * _CACHE_BLOCK_TOKENS
    fresh_input = estimate_tokens(prompt[common:]) + max(0, common_tokens - cache_read)
    # `output` is TOTAL generation (visible + thinking), matching the API
    # convention where `completion_tokens` includes thinking and `reasoning` is a
    # subset. Splitting them made reasoner turns look like "1.3k output" when the
    # model had actually emitted tens of thousands of thinking tokens first.
    return {
        "input": fresh_input,
        "cache_read": cache_read,
        "output": estimate_tokens(output_text) + estimate_tokens(reasoning_text),
        "reasoning": estimate_tokens(reasoning_text),
    }


def messages_to_prompt(messages, text_of=None):
    """Render the caller's turns as the single prompt string DeepSeek web takes.

    This function ADDS NO INSTRUCTIONS. DeepSeek's web endpoint accepts one
    prompt rather than a role-tagged message list, so the roles have to be
    flattened into labels — but the only text that reaches the model is text the
    caller supplied. Provider-authored guidance (a tool-protocol note, a
    persona, a reminder) belongs to whoever owns the system prompt; a provider
    that smuggles its own in gives the model two authorities to reconcile, and
    the model reconciles them badly. The trailing "Assistant:" is a completion
    cue for the flattened transcript, not an instruction.
    """
    sys_parts, body_parts = [], []
    for msg in messages or []:
        role = msg.get("role", "")
        content = (text_of or _msg_text)(msg)
        if role == "system":
            sys_parts.append(content)
        elif role == "tool":
            body_parts.append(f"[Tool result]: {content}")
        elif role == "assistant":
            body_parts.append(f"Assistant: {content}")
        elif role == "user":
            body_parts.append(f"User: {content}")
    parts = list(sys_parts) + body_parts
    parts.append("Assistant:")
    return "\n\n".join(p for p in parts if p)


def _full_conversation_prompt(messages):
    """Reconstruct the full transcript this DeepSeek chat notionally holds.

    `_prompt_for` sends only the per-turn DELTA because DeepSeek threads every
    turn onto one server-side chat, so the server holds the whole flattened
    conversation, not the delta. Prefix caching is decided against THAT full
    prompt, so the cache counter diffs this reconstruction against the previous
    turn's — never the wire delta. `kind == "env"` is excluded because the
    volatile env tail is regenerated each turn and never enters the server-side
    history; system and every other body message do.
    """
    if not messages:
        return ""
    sys_msgs = [m for m in messages if m.get("role") == "system"]
    body = [m for m in messages
            if m.get("role") != "system" and m.get("kind") != "env"]
    return messages_to_prompt(sys_msgs + body, text_of=_msg_text_accounting)


# Hard ceiling on what we hand DeepSeek in one prompt. DeepSeek rejects oversized
# prompts with "Content is too long", and its own session already holds the
# history, so there is never a reason to approach this.
DS_PROMPT_MAX = 48000


def _clip_body(body_msgs, budget, primed=True):
    """Keep what fits in `budget` chars, dropping OLDEST first — but never a
    pinned message, and never reordering.

    A pinned message is a genuine user turn (the harness marks source-'user'
    messages `pin`). The current request arrives that way, and it can be OLDER
    than the large injected context the harness appends after it — workspace
    instructions, the runtime snapshot, the skill catalogue. A plain
    oldest-first clip then dropped the REQUEST itself and left the model with
    pages of context and no ask ("the user hasn't asked anything yet"), which is
    exactly the first-turn failure this fixes. Pinned turns are therefore always
    kept; only unpinned history and injected context yield space. Order is
    preserved untouched, because DeepSeek caches on a stable prefix.

    `primed` says whether the DeepSeek chat ALREADY HOLDS the dropped turns. On a
    threaded turn it does; on a brand-new chat it does not, and only the omission
    note differs, because only one of the two is true.
    """
    note_text = ("[earlier turns omitted — they are already in this DeepSeek conversation]"
                 if primed else
                 "[earlier turns omitted to fit the prompt limit — they are NOT available"
                 " to you; work from what follows and say so if you need something older]")
    note = {"role": "user", "content": note_text}
    n = len(body_msgs)
    keep = [False] * n
    used = 0
    # Pinned turns are unconditional — the user's request is never dropped.
    # A compaction summary (kind == "compact") is equally unconditional: it is
    # the ONLY surviving memory of the turns it replaced, so clipping it on the
    # very re-prime that hands the model its condensed history drops the whole
    # point of compacting and leaves the model with a fresh request and no
    # prior context ("immediately clueless after /compact").
    for i, m in enumerate(body_msgs):
        if m.get("pin") or m.get("kind") == "compact":
            keep[i] = True
            used += len(_msg_text(m)) + 12
    # Fill the rest newest-first with whatever still fits.
    for i in range(n - 1, -1, -1):
        if keep[i]:
            continue
        need = len(_msg_text(body_msgs[i])) + 12
        if used + need > budget:
            continue
        used += need
        keep[i] = True
    # Always send at least the newest message, even if nothing fit.
    if n > 0 and not any(keep):
        keep[n - 1] = True
    # Rebuild in ORIGINAL order, collapsing each dropped span into one note.
    out, gap = [], False
    for i, m in enumerate(body_msgs):
        if keep[i]:
            if gap:
                out.append(note)
                gap = False
            out.append(m)
        else:
            gap = True
    if gap:
        out.append(note)
    return out


def _prompt_for(messages, st):
    """What to actually send DeepSeek this turn.

    DeepSeek keeps the conversation itself (we thread every turn onto the same
    chat session), so re-sending the transcript is pure waste. We send the
    system/tool instructions — those must ride along every turn — plus ONLY the
    messages this DeepSeek session hasn't seen yet.

    This used to key off `st["parent"]`, which is only set once DeepSeek reports a
    response_message_id. Any turn where that wasn't captured — and every time the
    self-heal path opened a fresh session — fell back to dumping the ENTIRE
    transcript. On a long chat that meant a two-word message was sent as hundreds
    of KB and came back "Content is too long", which then triggered another retry
    with another full dump.
    """
    if not messages:
        return ""
    sys_msgs = [m for m in messages if m.get("role") == "system"]
    # kind="env" is the loop's volatile tail (see agent_loop.Run._env_block):
    # it is regenerated per turn and never enters the transcript, so it must
    # stay OUT of the running count — counting it would shift the offset and
    # silently skip a real message. It always rides along as fresh instead.
    env_msgs = [m for m in messages if m.get("kind") == "env"]
    body = [m for m in messages
            if m.get("role") != "system" and m.get("kind") != "env"]
    if not body:
        return messages_to_prompt(sys_msgs + env_msgs)

    sent = st.get("sent")
    sent = int(sent) if isinstance(sent, (int, float)) else 0
    primed = True
    if st.get("parent") is None and sent <= 0:
        fresh = body                       # brand-new DeepSeek chat: it has no history
        primed = False                     # ...so nothing clipped here exists over there
    elif 0 < sent <= len(body):
        fresh = body[sent:] or body[-1:]   # only what it hasn't been told yet
    else:
        fresh = body[-1:]                  # counts drifted (history trimmed) — newest only

    budget = max(2000, DS_PROMPT_MAX - sum(len(_msg_text(m)) for m in sys_msgs))
    # The env tail — cwd, date, and any injected context — is ambient and
    # regenerated every turn, so it yields room to the conversation, and above
    # all to the current user message, never the reverse. Clipping the two as one
    # list with env LAST made _clip_body treat env as the newest turn and drop
    # the real prompt to keep it: a first turn whose injected context overran the
    # budget reached the model as context with NO request at all. So the body is
    # clipped first — its newest message, the current prompt, is never dropped —
    # and the env tail takes only the room left over, dropped whole if none is.
    clipped = _clip_body(fresh, budget, primed)
    room = budget - sum(len(_msg_text(m)) + 12 for m in clipped)
    env_tail = []
    for m in env_msgs:
        need = len(_msg_text(m)) + 12
        if need > room:
            break
        env_tail.append(m)
        room -= need
    return messages_to_prompt(sys_msgs + clipped + env_tail)


# ─── transient-failure retry ────────────────────────────────────────
# Two different failures used to share one regex and one 5s wait, which made
# the rate-limited case behave badly: being told to slow down and answering by
# resending every 5 seconds is what keeps the limit closed, and it burned all
# 40 attempts inside three minutes before reporting a failure the user could do
# nothing about.
#
# They are not the same event. "Server is busy" is DeepSeek's own load shedding
# — it clears on its own, usually within seconds, and resending promptly is the
# right response. A rate limit is a QUOTA WINDOW attached to this account; it
# clears when the window rolls over, on the order of minutes, and nothing the
# client does makes it clear sooner.
DS_BUSY_WAIT = 5                                   # overload — resend promptly
DS_RATE_WAIT = 180                                 # quota window — resend every 3 min

_BUSY_RE = re.compile(r"server is busy|服务器繁忙|系统繁忙|"
                      r"try again later|please try again", re.I)

_RATE_RE = re.compile(r"rate.?limit|too many requests|请求过于频繁|访问过于频繁|"
                      r"too frequent|slow down|quota", re.I)

# The CHAT is full: DeepSeek refuses further turns on this session and tells you
# to open a new one. This is neither transient nor a refusal of the request —
# it is a property of the session, and its own instruction ("start a new chat")
# is the fix. Kept apart from the busy/rate patterns above so it never resends
# into the same full chat, and apart from "content is too long" (a single
# oversized prompt, which clipping already handles) so it doesn't heal what a
# fresh chat cannot help.
_LENGTH_RE = re.compile(r"length limit|start a new (chat|conversation)|"
                        r"对话.{0,6}(过长|上限)|请.{0,6}(开始|新建).{0,6}(对话|会话)", re.I)


def _is_length_limit(msg):
    """True when DeepSeek says this chat is full and a new one must be started."""
    return bool(msg) and bool(_LENGTH_RE.search(str(msg)))


# DeepSeek's anti-abuse stack refuses the LOGIN itself (HTTP 200, code 0/11)
# when it does not believe the device. Unlike a bad password or a WAF
# challenge, this is a verdict about THIS MACHINE, so it is not per-account:
# the next account on the same machine is refused for the same reason.
# Rotating accounts at it burns every credential in ds_config.json and still
# fails, which is what made this look like "too many requests".
_DEVICE_RISK_RE = re.compile(r"RISK_DEVICE|DEVICE_DETECTED|device.{0,12}risk", re.I)


def _is_device_risk(msg):
    """True when DeepSeek refused the login because it distrusts this device."""
    return bool(msg) and bool(_DEVICE_RISK_RE.search(str(msg)))


def _retry_kind(msg):
    """Classify a DeepSeek error as a transient one worth resending, or not.

    Rate limiting is tested FIRST because the two vocabularies overlap: a real
    rate-limit notice usually also says "try again later", and reading that as
    mere busyness is what produced the 5-second resend loop.

    Returns "rate", "busy", or None (a real refusal — surface it, never resend).
    """
    if not msg:
        return None
    text = str(msg)
    if _RATE_RE.search(text):
        return "rate"
    if _BUSY_RE.search(text):
        return "busy"
    return None


def _is_busy(msg):
    """True for any transient 'try again' message (overload OR rate limit)."""
    return _retry_kind(msg) is not None


def _retry_wait(kind):
    """(seconds to wait, attempt cap) for one transient-failure kind."""
    if kind == "rate":
        return DS_RATE_WAIT, RATE_MAX_TRIES
    return DS_BUSY_WAIT, BUSY_MAX_TRIES


def _retry_exhausted(kind):
    """The error to raise once a transient failure has outlasted its cap."""
    wait, cap = _retry_wait(kind)
    if kind == "rate":
        return RuntimeError(
            f"DeepSeek has been rate-limiting this account for {cap} attempts "
            f"({cap * wait // 60} minutes). The quota window has not reopened — "
            f"wait longer, add another account, or switch model.")
    return RuntimeError(
        f"DeepSeek has been answering \"server is busy\" for {cap} attempts. "
        f"Try again shortly, or switch model.")


def _transient_pause(kind, tries, cancelled):
    """Announce a transient failure, then wait out the interval that fits it.

    Shared by the two ways a rate limit arrives — an HTTP 429 on the POST, and a
    mid-stream `hint` frame — so both wait the same three minutes rather than
    one of them inheriting the five-second overload retry.

    Yields one notice frame. Returns True when the caller should resend, False
    when the user cancelled during the wait.
    """
    wait, cap = _retry_wait(kind)
    rate = kind == "rate"
    # Rendered from the interval rather than hardcoded, so tuning DS_RATE_WAIT
    # cannot leave the notice claiming "0 min".
    span = f"{wait // 60} min" if wait >= 60 else f"{wait}s"
    import sys as _sys
    print(f"[ds_direct] {'rate-limited' if rate else 'server busy'} — "
          f"retry #{tries} in {wait}s", file=_sys.stderr, flush=True)
    yield {"type": "notice",
           "text": (f"DeepSeek rate limit reached — retrying in {span} "
                    f"(attempt {tries}/{cap})…" if rate else
                    f"DeepSeek is busy — retrying in {span} (attempt {tries})…")}
    return _sleep_cancellable(wait, cancelled)


def _is_dead_session(raw_lines):
    """DeepSeek rejected the chat_session_id itself — an HTTP 200 whose body says
    `invalid chat session id` (or similar) instead of streaming an answer. Happens
    most right after a token/account swap, when a session minted under the old
    login is meaningless to the new one. Unlike a stale parent_message_id this
    needs a BRAND-NEW chat: a thread reset can't revive a session the server no
    longer knows about."""
    blob = " ".join(raw_lines or ()).lower()
    return ("invalid chat session id" in blob
            or "chat session does not exist" in blob
            or "session not found" in blob
            or "invalid session id" in blob)


def _sleep_cancellable(secs, cancelled, step=0.5):
    """Sleep up to `secs`, bailing out early if the request is cancelled.
    Returns True if it slept the full time, False if cancelled."""
    end = time.time() + secs
    while time.time() < end:
        if cancelled():
            return False
        time.sleep(min(step, max(0.0, end - time.time())))
    return not cancelled()


def stream(model, messages, temperature=0.6, max_tokens=4096, cancelled=lambda: False,
           conv_id=None, preempt=False, account=None, oneshot=False, ref_file_ids=None):
    """Yield {'type': 'reasoning'|'content'|'title', 'text': ...}. ONE persistent, threaded
    DeepSeek session per (kiln conversation, account) — a chat is always the same tab, and
    after the first turn we send only the new message.

    With several accounts configured, a conversation sticks to one (so its
    server-side DeepSeek chat is stable), and if that account is busy/blocked
    with NOTHING streamed yet, the turn fails over to the next account — which
    opens a fresh session there and re-primes it from the transcript.

    `account` pins a NEW conversation to one login instead of taking the next in
    the ring. The harness exposes one route per account and passes the route's
    account here, which is how a subagent is kept off the account its parent is
    on: without it, both take round-robin picks and can collide.

    `ref_file_ids` attaches already-uploaded DeepSeek file ids (see
    `upload_files`) to this turn, so a harness caller can put a file in front of
    the model without going through `describe_files`. Ids are bound to the
    account that uploaded them, so only pass ids obtained from the same login
    this conversation is pinned to."""
    if cffi is None:
        raise RuntimeError(_cffi_unavailable())
    if not configured():
        raise RuntimeError("No DeepSeek token — put one in ds_config.json (token + cookie).")
    config.dbg("ds_direct.stream() conv=%s model=%s preempt=%s", conv_id, model, preempt)
    # `resolve_model` is what keeps a retired id (deepseek-expert-offline, say)
    # on the mode it used to mean rather than on MODEL_MAP's fallback.
    model_type, thinking, search = MODEL_MAP[resolve_model(model)]
    key = _state_key(conv_id, model_type, search)
    # No automatic account failover. A conversation stays on the account it is
    # pinned to (or its sticky one); "server is busy" and rate limits WAIT and
    # retry on THAT account instead of hopping to another login. Switching is a
    # manual choice — pick another account route in the model picker — because a
    # mid-conversation hop also abandons the DeepSeek chat history the current
    # account is holding, and a transient busy is not a reason to lose it.
    # `is_last=True` tells _stream_with there is nowhere to fail over to, so it
    # handles every condition in place rather than raising _RotateAccount.
    acct_id = _account_order(key, pinned=account)[0]
    try:
        with _lease_client(acct_id) as client:
            for ev in _stream_with(client, model_type, thinking, search, messages,
                                   cancelled, conv_id, preempt, is_last=True,
                                   ref_file_ids=ref_file_ids):
                yield ev
    finally:
        # A one-shot auxiliary call (compaction / session-title summary) opened a
        # throwaway chat under a unique conv_id so it would not thread onto — or
        # re-prime — the conversation's persistent chat (often the very chat that
        # just hit its length limit). Drop that ephemeral session now so it does
        # not accumulate in ds_sessions.json.
        if oneshot:
            with _session_lock:
                if _sessions.pop(key, None) is not None:
                    _save_sessions()


def _stream_with(client, model_type, thinking, search, messages, cancelled, conv_id,
                  user_preempt=False, is_last=True, ref_file_ids=None):
    # Track whether the previous turn was cancelled mid-stream. If DeepSeek is still
    # generating on the server, preempt:true kills that stale generation so our new
    # prompt isn't queued behind it. The Interrupt button (user_preempt) arms a
    # one-shot preempt:true for the next send.
    key = _state_key(conv_id, model_type, search)
    need_preempt = user_preempt
    with _session_lock:
        st = _sessions.get(key) or {}
        prev_sent = int(st.get("sent") or 0)
        prev_prompt = st.get("last_prompt")
        prev_sid = st.get("sid")
        if st.pop("was_cancelled", False):
            need_preempt = True
            config.dbg("ds_direct: was_cancelled flag found for %s → need_preempt=True", key)
            _save_sessions()
    full_prompt = _full_conversation_prompt(messages)
    # A transcript that SHRANK since we last threaded it was rewritten by the
    # harness — almost always a /compact (manual or the context-overflow retry
    # that follows a _ContextFull). The old DeepSeek chat's threaded history no
    # longer matches, and it is the full one that raised the limit, so start a
    # fresh chat and re-prime it from the compacted transcript. Threading only
    # ever grows `sent`, so a body shorter than it is an unambiguous rewrite.
    body_len = len([m for m in messages
                    if m.get("role") != "system" and m.get("kind") != "env"])
    compacted = prev_sent > 0 and (body_len + 1) < prev_sent
    if compacted:
        config.dbg("ds_direct: transcript shrank (%d < sent %d) — fresh chat for %s",
                   body_len, prev_sent, key)
    config.dbg("ds_direct._stream_with conv=%s user_preempt=%s need_preempt=%s", key, user_preempt, need_preempt)
    def _reset_thread(st):
        """Keep the SAME DeepSeek chat but forget the message threading — used when a
        parent_message_id is rejected. Re-primes the chat with the transcript on the
        next call, WITHOUT opening a new chat tab."""
        with _session_lock:
            st["parent"] = None
            st["sent"] = 0
            _save_sessions()

    def _open(force, why=""):
        parent_reset = False
        for attempt in range(4):
            try:
                st = _get_state(client, conv_id, force_new=(force and attempt == 0),
                                why=why, model_type=model_type, search=search)
                prompt = _prompt_for(messages, st)
                r = client.open_completion(st["sid"], prompt, thinking, search,
                                           model_type, st.get("parent"), need_preempt,
                                           ref_file_ids=ref_file_ids)
                if r.status_code in (401, 403):
                    raise _AuthExpired()
                if r.status_code == 404:
                    # the chat_session_id itself is unknown — the session is really
                    # gone; only THIS justifies opening a new DeepSeek chat.
                    raise _SessionStale(f"DeepSeek 404: {r.text[:150]}")
                if r.status_code in (400, 422):
                    # Far more often this is a rejected parent_message_id, not a dead
                    # chat. Try once more on the SAME session with the threading reset
                    # (a fresh turn in the same tab) before ever abandoning the chat.
                    if st.get("parent") and not parent_reset:
                        parent_reset = True
                        _reset_thread(st)
                        continue
                    raise _SessionStale(f"DeepSeek {r.status_code}: {r.text[:150]}")
                if r.status_code == 429:
                    # A per-account rate limit. Another account may be free, so
                    # fail over first (nothing streamed yet); with none left, this
                    # is a quota window rather than a failure — the caller waits
                    # DS_RATE_WAIT and resends instead of surfacing an error the
                    # user can do nothing about.
                    if not is_last:
                        raise _RotateAccount(f"429 rate-limited: {r.text[:80]}")
                    raise _RateLimited(f"429 rate-limited: {r.text[:80]}")
                if r.status_code != 200:
                    # 429 / 5xx / anything transient: surface it, but do NOT burn the
                    # conversation's session over a rate limit or a blip
                    raise RuntimeError(f"DeepSeek {r.status_code}: {r.text[:150]}")
                return r, st
            except _AuthExpired:
                # Retry only while a fresh login actually SUCCEEDS. A failed login
                # (WAF challenge, or no saved password) won't clear by trying
                # again — the WAF wants a browser-solved token, which no number of
                # retries produces — so bail immediately rather than hammering
                # /users/login three times.
                if attempt < 3 and client.login():
                    continue                # fresh token — retry the SAME chat session
                if getattr(client, "last_login_device_risk", False):
                    # The login did not merely fail, it was refused for the
                    # device. Retrying the same machine cannot change that.
                    raise RuntimeError(
                        "DeepSeek refused this device — "
                        f"{getattr(client, 'last_login_error', None)}.")
                why_login = getattr(client, "last_login_error", None)
                # A device verdict is about this MACHINE, not this credential.
                # Rotating would post a fresh /users/login for every remaining
                # account and earn the same refusal from each, so surface it
                # once instead of burning the pool.
                if getattr(client, "last_login_device_risk", False):
                    raise RuntimeError(
                        f"DeepSeek refused this device — {why_login}. This is a "
                        "device/anti-abuse verdict, not a credential problem, so "
                        "another account will be refused the same way. See the "
                        "device-identity notes in README.ds-direct.md.")
                if not is_last:             # a dead/blocked account — try the next one
                    raise _RotateAccount(why_login or "auth failed / account blocked")
                raise RuntimeError(
                    f"DeepSeek auth failed — {why_login}." if why_login else
                    "DeepSeek auth failed — token/cookies expired. Set email + password in "
                    "ds_config.json for auto-refresh, or paste a fresh token "
                    "and cookie into it — see the README.")
        raise RuntimeError("DeepSeek auth failed.")

    # A stored session that's stale — a bad parent_message_id, or one that belongs to a
    # DIFFERENT account after you switch logins — makes DeepSeek error or return an INSTANT
    # empty stream. Either way: drop this conversation's session and retry once, fresh.
    def _drop_session():
        with _session_lock:
            _sessions.pop(key, None)
            _save_sessions()

    # A compacted transcript re-primes a fresh chat from the first attempt.
    force_new = compacted
    heal = 0                                       # counts empty/stale self-heals (capped)
    busy_tries = 0                                 # "server is busy" retries
    rate_tries = 0                                 # "rate limited" retries (counted apart:
                                                   # they wait 36x longer, so one shared cap
                                                   # can't be right for both)
    while True:
        try:
            r, st = _open(force=force_new,
                          why="transcript was compacted — re-priming a fresh chat" if compacted else
                              "DeepSeek said the old session no longer exists" if force_new else "")
            force_new = False
            fresh_chat = prev_sid is not None and st.get("sid") != prev_sid
        except _SessionStale:
            if heal < 1:                          # session truly gone (404) → new chat, once
                _drop_session()
                force_new = True
                heal += 1
                continue
            raise
        except _RateLimited:
            # HTTP 429 with no other account to try. The quota window reopens on
            # its own, so this is a wait, not a failure: hold the same chat and
            # the same prompt, and resend every DS_RATE_WAIT until it clears.
            rate_tries += 1
            if rate_tries > RATE_MAX_TRIES:
                raise _retry_exhausted("rate") from None
            if cancelled():
                return
            if not (yield from _transient_pause("rate", rate_tries, cancelled)):
                return                            # user hit Stop during the wait
            continue                              # resend, same session/prompt
        except RuntimeError:
            raise                                 # transient — keep this chat's session
        new_parent = None
        yielded = False
        server_error = None
        busy_error = None
        busy_kind = None                          # "rate" or "busy" — they retry differently
        length_full = None                        # chat is full → open a fresh one, once
        raw_sink = []
        output_text = ""
        reasoning_text = ""
        try:
            for kind, text in _parse(r, cancelled, raw_sink):
                if kind == "__msgid__":
                    new_parent = text
                    continue
                if kind == "error":                   # DeepSeek said no
                    msg, reason = text
                    transient = _retry_kind(msg)
                    if transient is not None:
                        # Overload or a rate limit — transient, NOT a refusal. Don't
                        # show it as the answer; we'll wait and resend. How long we
                        # wait depends on which of the two it is.
                        busy_error = msg
                        busy_kind = transient
                        continue
                    if _is_length_limit(msg):
                        # The chat is full. Not a refusal to surface — heal after
                        # the loop by opening a fresh chat and re-priming. Held
                        # back (no yield, yielded stays False) so it never reaches
                        # the user as an answer and never counts as real output.
                        length_full = msg
                        continue
                    server_error = msg
                    yield {"type": "content", "text": "⚠ DeepSeek: " + msg}
                    yielded = True
                    continue
                yielded = True
                if kind == "refs":                    # web search sources (list of {i,url,title,site})
                    yield {"type": "refs", "refs": text}
                else:
                    if kind == "reasoning":
                        reasoning_text += text
                    elif kind == "content":
                        output_text += text
                    yield {"type": kind, "text": text}
        finally:
            # Always release the streaming connection — cancelling mid-answer or
            # a generator that's never fully drained used to leak an open socket
            # per turn until the process exited.
            try:
                r.close()
            except Exception:
                pass
            # If the user cancelled mid-response, DeepSeek's server may still be
            # generating. Flag this session so the next turn sends preempt:true
            # to kill that stale generation and avoid queuing behind it.
            if cancelled():
                config.dbg("ds_direct: stream cancelled — setting was_cancelled for %s", key)
                with _session_lock:
                    st = _sessions.get(key) or {}
                    st["was_cancelled"] = True
                    _sessions[key] = st
                    _save_sessions()

        # Overload or rate limit with nothing real streamed → wait and resend the
        # SAME request, keeping the same chat, until it gets through (or the user
        # stops). Capped. Uncapped, a DeepSeek outage meant one chat spinning
        # forever while holding one of only 8 pooled clients; four such chats
        # starved every other conversation with "all connections are busy".
        if busy_error and not yielded and not is_last:
            # Another account has its own quota and its own luck with the load
            # balancer, so handing off beats waiting here — for BOTH kinds.
            raise _RotateAccount(f"{busy_kind or 'busy'}: {busy_error[:80]}")
        if busy_error and not yielded:
            rate = busy_kind == "rate"
            tries = (rate_tries if rate else busy_tries) + 1
            if tries > _retry_wait(busy_kind)[1]:
                raise _retry_exhausted(busy_kind)
            if cancelled():
                return
            if rate:
                rate_tries = tries
            else:
                busy_tries = tries
            if not (yield from _transient_pause(busy_kind, tries, cancelled)):
                return                            # user hit Stop during the wait
            continue                              # resend, same session/prompt

        # The chat filled up. Hand it to the harness's compactor rather than
        # papering over it here: raise a context-overflow the harness recognises,
        # which runs the SAME compaction as /compact and retries the turn. On that
        # retry the transcript is shorter, and the shrink check at the top of
        # _stream_with opens a fresh DeepSeek chat primed with the compacted
        # history — the conversation continues with the important context kept,
        # instead of the old behaviour of re-priming the whole raw transcript.
        # Not failed over to another account: a fresh chat there would re-prime
        # the same over-long transcript and fill up again.
        if length_full and not yielded:
            import sys as _sys
            print(f"[ds_direct] chat length limit reached — asking the harness to compact: {length_full}",
                  file=_sys.stderr, flush=True)
            _persist_cookies(client)
            raise _ContextFull(
                "context window exceeded — the DeepSeek chat reached its length limit; "
                "compact the conversation and continue in a new chat")

        if server_error:                            # server-side refusal — surface it, no self-heal
            import sys as _sys
            print(f"[ds_direct] server error: {server_error}", file=_sys.stderr, flush=True)
            _persist_cookies(client)
            return
        # A dead SESSION (not just a stale parent): HTTP 200 whose body says the
        # chat_session_id is unknown — typical right after a token/account swap,
        # when the old session ids no longer resolve. Drop it and open a fresh
        # chat, exactly like a 404. Bounded to one heal so a genuinely broken
        # account can't spin here.
        if not yielded and heal < 1 and (_is_dead_session(raw_sink) or not raw_sink):
            import sys as _sys
            print("[ds_direct] chat cannot be served (dead session or empty stream) — "
                  "opening a fresh chat and retrying", file=_sys.stderr, flush=True)
            _drop_session()
            force_new = True
            heal += 1
            continue
        if yielded or heal >= 1:
            if not yielded:                       # empty even after a fresh chat — this is a FAILURE
                import sys as _sys
                print(f"[ds_direct] EMPTY response (HTTP {r.status_code}). raw lines:\n  " +
                      "\n  ".join(raw_sink[:25] or ["(no lines at all)"]),
                      file=_sys.stderr, flush=True)
                _persist_cookies(client)
                # Report it. Returning normally here is what let a goal round re-arm
                # forever: the harness saw a COMPLETED turn carrying no content, so
                # nothing told it the round had accomplished nothing, and it queued
                # the next one until the goal hit its round cap. Raising makes the
                # empty turn a failed one, which is what it actually is.
                raise RuntimeError(
                    "DeepSeek returned an empty response (HTTP %s): no answer and no "
                    "diagnostic. Raw body: %s"
                    % (r.status_code, " | ".join(raw_sink[:5]) or "(no lines at all)"))
            _persist_cookies(client)              # capture any WAF token DeepSeek just refreshed
            if yielded:
                usage = _turn_usage(None if fresh_chat else prev_prompt, full_prompt, output_text, reasoning_text)
            with _session_lock:
                if new_parent is not None:        # thread the next turn onto this one
                    st["parent"] = new_parent
                # Remember how much of the conversation this DeepSeek session has
                # now been told, so the next turn sends only what's new. Tracked
                # independently of parent_message_id — relying on that alone made
                # us re-send the whole transcript whenever it wasn't reported.
                if yielded:
                    # +1: DeepSeek appends its own reply to the session, and that
                    # reply shows up in our message list next turn — so it has
                    # effectively "seen" one more message than we sent it.
                    # env blocks are excluded here for the same reason
                    # _prompt_for excludes them: they are transient and
                    # counting them would desync the offset.
                    body_n = len([m for m in messages
                                  if m.get("role") != "system"
                                  and m.get("kind") != "env"])
                    st["sent"] = body_n + 1
                    st["last_prompt"] = full_prompt
                _save_sessions()
            if yielded:
                yield {"type": "meta", "usage": usage}
            return
        # An empty response is usually a rejected parent_message_id or a blip — NOT a
        # dead chat. Reset the threading and retry in the SAME DeepSeek chat instead of
        # spawning a new one (which is what the 'new DeepSeek chat' churn came from).
        _reset_thread(st)
        heal += 1                                 # bounded: one thread-reset retry, then give up


# ═══════════════════════════════════════════════ file attachments ════
# Uploading a file and letting a chat read it. Named "vision" throughout this
# section because that is what it was built for and what the harness still
# calls it (`describe_files`), but it is no longer vision-tier specific: a file
# rides any ordinary chat as `ref_file_ids` now, and the modes it uses here are
# the plain ones.

VISION_KEY = "__vision__"        # its own slot in the session store
_vision_lock = threading.Lock()


def _vision_session(client):
    """The ONE chat every image description goes through.

    Deliberately not per-conversation. Creating a DeepSeek chat costs a session
    call and a proof-of-work solve, and doing that per image makes attaching
    four screenshots noticeably slow for no benefit — the descriptions are
    independent of each other and of whatever chat you happen to be in.

    The flip side is that the model accumulates history it might read meaning
    into, which is exactly why the prompt the caller passes states outright that
    the files are unrelated.
    """
    with _session_lock:
        st = _sessions.get(VISION_KEY)
        if st and st.get("sid"):
            return st
    sid = client.new_session()
    with _session_lock:
        existing = _sessions.get(VISION_KEY)
        if existing and existing.get("sid"):
            return existing
        st = {"sid": sid, "parent": None, "sent": 0,
              "account": getattr(getattr(client, "account", None), "id", None)}
        _sessions[VISION_KEY] = st
        _save_sessions()
        print(f"[ds_direct] opened the vision chat ({sid})", file=_sys_err(), flush=True)
        return st


def _drop_vision_session():
    with _session_lock:
        _sessions.pop(VISION_KEY, None)
        _save_sessions()


def describe_files(files, prompt, cancelled=None, timeout=300):
    """[(name, blob)] + a prompt -> {name: description}.

    Serialised on `_vision_lock`: one shared chat can't have two completions in
    flight, and letting them interleave would splice two descriptions together.
    """
    if cffi is None:
        raise RuntimeError(_cffi_unavailable())
    if not configured():
        raise RuntimeError("No DeepSeek session — put a token in ds_config.json.")
    if not files:
        return {}

    with _vision_lock, _lease_client() as client:
        for attempt in range(2):
            try:
                return _describe_once(client, files, prompt, cancelled, timeout)
            except _AuthExpired:
                if attempt == 0 and client.login():
                    continue
                raise RuntimeError("DeepSeek auth failed — the token or cookies expired.")
            except _SessionStale:
                # The vision chat was deleted server-side (or belongs to an
                # account you've since logged out of). Open a fresh one once.
                if attempt == 0:
                    _drop_vision_session()
                    continue
                raise
    return {}


def _describe_once(client, files, prompt, cancelled, timeout):
    """Returns {name: {"description": str, "error": str}}.

    Every file is uploaded on its own and a failure is confined to that file.
    Attaching three screenshots and losing all three because the second one was
    a few bytes over a size limit is the kind of failure that makes a feature
    feel unreliable even when it usually works.
    """
    out = {name: {"description": "", "error": ""} for name, _ in files}
    ids = {}                                   # name -> file id, successes only

    for name, blob in files:
        if cancelled and cancelled():
            return out
        try:
            ids[name] = client.upload_file(name, blob)
        except (_AuthExpired, _SessionStale):
            raise                              # these are worth a whole retry
        except Exception as e:
            out[name]["error"] = f"{e.__class__.__name__}: {e}"

    if not ids:
        # Every one failed, and each already carries its OWN reason — returning
        # them beats raising a joined-up message that repeats all three reasons
        # on all three chips.
        return out

    # DeepSeek parses an upload asynchronously; referencing one too early gets a
    # description of nothing. Wait for the statuses to settle, but bound it — a
    # stuck file should cost that file, not the whole batch.
    deadline = time.time() + FILE_READY_TIMEOUT
    ready, saw_status, refused = set(), False, False
    while time.time() < deadline and len(ready) < len(ids):
        if cancelled and cancelled():
            return out
        statuses = client.file_status(list(ids.values()))
        if not statuses:
            break            # the status endpoint isn't answering — try anyway
        saw_status = True
        for name, fid in ids.items():
            state = str(statuses.get(fid, "")).lower()
            if state in ("success", "ready", "parsed", "done", ""):
                ready.add(name)
            elif state in ("failed", "error"):
                out[name]["error"] = "DeepSeek couldn't parse this file"
                refused = True
        if refused:
            break
        if len(ready) < len(ids):
            time.sleep(0.5)

    usable = {}
    for name, fid in ids.items():
        if out[name]["error"]:
            continue
        # Only hold a file back when the status endpoint ACTUALLY told us it
        # wasn't ready. If it never answered we have no evidence either way, and
        # sending the reference is better than refusing on a guess.
        if saw_status and name not in ready:
            out[name]["error"] = ("DeepSeek was still processing this file — "
                                  "attach it again in a moment")
            continue
        usable[name] = fid
    if not usable:
        return out

    names = list(usable)
    body = _run_vision_turn(client, prompt, list(usable.values()), cancelled)
    described = _split_by_file(body, names)
    for name in names:
        text = (described.get(name) or "").strip()
        out[name]["description"] = text
        if not text:
            out[name]["error"] = "the vision model returned nothing for this file"
    return out


def _run_vision_turn(client, prompt, ref_ids, cancelled):
    """One completion in the shared attachment chat. Returns its text.

    `model_type="default"`, not `"vision"`. The website retired the Vision tier
    as a separate mode: an attached file (image or document) now rides an
    ORDINARY chat as `ref_file_ids`, and the plain mode reads it. Verified
    live — a file uploaded with a passphrase in it, referenced from a
    `model_type="default"` chat, came back with the passphrase. Asking for
    `model_type="vision"` also still works today, but that tier is gone from the
    picker, so depending on it is depending on something already retired.
    """
    st = _vision_session(client)
    r = client.open_completion(st["sid"], prompt, thinking=False, search=False,
                               model_type="default",
                               parent_message_id=st.get("parent"),
                               ref_file_ids=ref_ids)
    if r.status_code in (401, 403):
        raise _AuthExpired()
    if r.status_code == 404:
        raise _SessionStale("the vision chat no longer exists")
    if r.status_code in (400, 422):
        # Nearly always a rejected parent_message_id. Start a fresh turn in the
        # SAME chat before giving up on it.
        with _session_lock:
            st["parent"] = None
            _save_sessions()
        r = client.open_completion(st["sid"], prompt, thinking=False, search=False,
                                   model_type="default", ref_file_ids=ref_ids)
    if r.status_code != 200:
        raise RuntimeError(f"DeepSeek vision {r.status_code}: {r.text[:180]}")

    parts = []
    for kind, text in _parse(r, cancelled or (lambda: False)):
        if kind == "content":
            parts.append(text)
    _persist_cookies(client)
    body = "".join(parts).strip()
    if not body:
        raise RuntimeError("the vision model returned nothing")
    return body


def _split_by_file(body, names):
    """Cut one multi-file reply into a description per file.

    Best effort by design. When a heading can't be found for a file the WHOLE
    reply is used for it, which is redundant but complete — the failure mode of
    a bad split should be too much context, never a description silently
    attached to the wrong image.
    """
    if len(names) == 1:
        return {names[0]: body}

    marks = []
    lowered = body.lower()
    for name in names:
        at = lowered.find(name.lower())
        marks.append((at, name))
    found = sorted((a, n) for a, n in marks if a >= 0)
    if len(found) < len(names):
        return {name: body for name in names}

    out = {}
    for i, (at, name) in enumerate(found):
        # start at the beginning of the line the name appears on
        start = body.rfind("\n", 0, at) + 1
        end = found[i + 1][0] if i + 1 < len(found) else len(body)
        end = body.rfind("\n", 0, end) if i + 1 < len(found) else end
        out[name] = body[start:max(start, end)].strip()
    return out
