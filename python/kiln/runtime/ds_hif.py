#!/usr/bin/env python3
"""Refresh the ``x-hif-*`` anti-abuse headers DeepSeek's web client sends.

DeepSeek's web client does not carry one device identity; it carries four, and
this module owns the two that are *minted per request batch* rather than per
profile:

  * ``x-hif-leim`` -- a short envelope the chat client fetches from
    ``hif-leim.deepseek.com/query`` and then replays on ``/api/v0/chat/*``;
  * ``x-hif-dliq`` -- the same shape from ``hif-dliq.deepseek.com/query``.

Both are AES-GCM blobs: ``<base64 ciphertext+tag>.<base64 iv>``. The plaintext is
short enough to be little more than a timestamp and an id, which is why the
server hands out a fresh one on a timer -- the response carries ``x-hif-ttl``
(600 seconds, observed) and the client re-fetches when it lapses.

Replaying a captured value forever is worse than sending nothing. A real browser
re-fetches on the TTL; a value frozen at capture time is a beacon that says "this
client stopped behaving like a browser at the moment of the capture", and it is a
sharper signal than an empty header would be. The stale-capture case is exactly
what this module removes: ``ds_direct`` already replays ``x-hif-*`` from
``ds_config.json`` (see ``_Account.headers``), but nothing ever renewed them, so
every request after the capture carried a value the server had already expired.

Renewal is best-effort by construction. A failed fetch returns the configured
value unchanged rather than a fabricated one or an empty header, because a
fabricated blob is not a value any DeepSeek client ever minted, and dropping the
header entirely changes the request shape. Nothing here raises to the caller.
"""

from __future__ import annotations

import contextlib
import json
import re
import threading
import time

import ds_identity

__all__ = [
    "ENDPOINTS", "REFRESH_FRACTION", "MIN_TTL", "MAX_TTL", "DEFAULT_TIMEOUT",
    "mint", "refresh", "headers", "status", "clear",
]

# Host -> header name. Order is the order they are tried; both are real hosts the
# web client queries, and either one is authoritative for its own header.
#
# `hif-dliq` does not always resolve (observed: NXDOMAIN on some networks while
# `hif-leim` answers from the same address), so a failure here is an ordinary
# network outcome rather than a defect, and the configured value stands.
ENDPOINTS = (
    ("x-hif-leim", "hif-leim.deepseek.com"),
    ("x-hif-dliq", "hif-dliq.deepseek.com"),
)

# The server states its own lifetime in `x-hif-ttl`. These bound what is accepted
# from it: a zero or absurd value would otherwise either thrash the endpoint or
# pin one value forever, and both are worse than the fallback.
DEFAULT_TTL = 600.0
MIN_TTL = 30.0
MAX_TTL = 3600.0

# Renew at 80% of the stated TTL rather than at 100%. The client that owns this
# envelope re-fetches before it lapses; arriving with an expired one looks
# exactly like arriving with a stale capture, which is the state being removed.
REFRESH_FRACTION = 0.8

# A renewal runs INSIDE header construction, so it sits on the chat request's
# critical path: the first request after a lapse pays for the fetch. The endpoint
# is a small GET to an anycast host that answers in well under a second when it
# answers at all, so this is a ceiling for the pathological case, not an expected
# cost. It is deliberately short -- adding fifteen seconds to a chat turn to
# recover an anti-abuse header would be a worse defect than the stale header.
DEFAULT_TIMEOUT = 5.0

# Shape of a real value: two base64 segments joined by a dot. This is a SHAPE
# check, not a checksum -- the blob's contents cannot be verified here -- and it
# exists to reject a truncated read, an HTML error page, or a stray token before
# one is presented and treated as a forged envelope.
_VALUE_RE = re.compile(r"^[A-Za-z0-9+/=_-]{16,512}\.[A-Za-z0-9+/=_-]{8,64}$")

# Per-process cache: header name -> {"value": str, "expires": float}. One entry
# per header, because the two hosts issue independent envelopes on their own
# clocks.
_cache = {}
_lock = threading.Lock()

# In-flight fetch guard. The first request after a lapse should do the fetch;
# concurrent requests that arrive while it is in flight must not each open their
# own, or a burst of parallel chats turns one renewal into N.
_fetching = set()


def _valid(value):
    """Whether `value` is shaped like a real ``x-hif-*`` envelope."""
    return bool(_VALUE_RE.match(str(value or "").strip()))


def _ttl_from(headers):
    """The lifetime the server stated, clamped to a sane range."""
    raw = None
    for key, val in (headers or {}).items():
        if str(key).lower() == "x-hif-ttl":
            raw = val
            break
    try:
        ttl = float(str(raw).strip())
    except (TypeError, ValueError):
        return DEFAULT_TTL
    if ttl <= 0:
        return DEFAULT_TTL
    return max(MIN_TTL, min(MAX_TTL, ttl))


def _request_headers():
    """The headers the web client sends when it fetches this endpoint.

    A cross-site fetch from the chat page: it carries the client-application
    headers but no ``origin``-bearing preflight is needed here because this is a
    plain GET, and the observed request sends ``sec-fetch-site: same-site``.
    """
    return {
        "accept": "*/*",
        "accept-language": "en-US,en;q=0.9",
        "origin": "https://chat.deepseek.com",
        "priority": "u=1, i",
        "referer": "https://chat.deepseek.com/",
        **ds_identity.client_hints(),
        "sec-fetch-dest": "empty",
        "sec-fetch-mode": "cors",
        "sec-fetch-site": "same-site",
        "user-agent": ds_identity.UA,
        **ds_identity.client_headers(),
    }


def mint(host, timeout=DEFAULT_TIMEOUT, session=None, dbg=None):
    """Fetch one fresh envelope from `host`; return ``(value, ttl)`` or ``(None, None)``.

    `session` is an optional ``curl_cffi`` Session to reuse, so this can share a
    connection pool. It is NOT the chat session: ``hif-*.deepseek.com`` is a
    different origin from ``chat.deepseek.com``, and the browser's fetch to it
    carries no cookies (a CORS fetch with same-origin credentials), so handing
    this the chat session would send the chat's cookies somewhere the real client
    never does. With no session one is created and closed here.

    Never raises. A DNS failure, a timeout, a non-200, a non-JSON body, or a
    value that is not shaped like an envelope all return ``(None, None)`` -- the
    caller keeps what it already had.
    """
    url = "https://%s/query" % host
    try:
        from curl_cffi import requests as cffi
    except Exception as e:  # noqa: BLE001 -- report the real cause, then fall back
        if dbg:
            dbg("ds_hif: curl_cffi unavailable (%s); cannot refresh %s", e, host)
        return None, None

    own = session is None
    sess = session
    try:
        if own:
            sess = cffi.Session()
        r = sess.get(url, headers=_request_headers(), timeout=timeout,
                     impersonate=ds_identity.IMPERSONATE)
        if r.status_code != 200:
            if dbg:
                dbg("ds_hif: %s answered HTTP %s", host, r.status_code)
            return None, None
        body = r.json()
        value = ((body.get("data") or {}).get("biz_data") or {}).get("value")
        if not _valid(value):
            if dbg:
                dbg("ds_hif: %s returned no envelope-shaped value", host)
            return None, None
        return str(value).strip(), _ttl_from(r.headers)
    except Exception as e:  # noqa: BLE001 -- a refresh is best effort by contract
        if dbg:
            dbg("ds_hif: refresh from %s failed (%s: %s)", host, type(e).__name__, e)
        return None, None
    finally:
        if own and sess is not None:
            with contextlib.suppress(Exception):
                sess.close()


def _cached(name, now):
    with _lock:
        rec = _cache.get(name)
    if rec and rec["expires"] > now:
        return rec["value"]
    return None


def _store(name, value, ttl, now):
    with _lock:
        _cache[name] = {"value": value, "expires": now + ttl * REFRESH_FRACTION}


def refresh(configured=None, force=False, session=None, dbg=None,
            timeout=DEFAULT_TIMEOUT):
    """Fresh ``x-hif-*`` headers, falling back to `configured` per header.

    `configured` is the caller's existing header map (``_Account.headers``). A
    header that was refreshed is replaced; one that could not be is passed
    through untouched, so a working capture keeps working and a lapsed one is the
    only thing this changes. A header that was neither configured nor refreshed
    is omitted -- the shape of the request is never changed by a failure here.

    With `force`, the cache is ignored and every endpoint is tried again -- used
    after a rejection, when the value in hand is suspected rather than merely
    old.
    """
    configured = dict(configured or {})
    out = {}
    now = time.time()
    for name, host in ENDPOINTS:
        value = None if force else _cached(name, now)
        if value is None:
            with _lock:
                in_flight = name in _fetching
                if not in_flight:
                    _fetching.add(name)
            if in_flight:
                # Another thread is already renewing this one. Take whatever the
                # cache holds -- possibly the configured value -- rather than
                # stacking a second fetch against the same endpoint.
                value = _cached(name, now)
            else:
                try:
                    value, ttl = mint(host, timeout=timeout, session=session,
                                      dbg=dbg)
                    if value:
                        _store(name, value, ttl, now)
                finally:
                    with _lock:
                        _fetching.discard(name)
        if value:
            out[name] = value
        elif name in configured:
            out[name] = configured[name]
    # Any configured header this module does not own is passed through, so the
    # caller's `headers` block keeps working as the general escape hatch it is.
    for key, val in configured.items():
        out.setdefault(key, val)
    return out


def headers(configured=None, dbg=None, timeout=DEFAULT_TIMEOUT):
    """The header map to send, with ``x-hif-*`` renewed where possible."""
    return refresh(configured=configured, dbg=dbg, timeout=timeout)


def status(configured=None):
    """What will be sent and why, without the values.

    Reports each header's origin (``cached`` or ``configured``) and its length,
    so a misconfiguration is diagnosable from a settings row or a log line
    without printing an anti-abuse envelope into either.
    """
    configured = dict(configured or {})
    now = time.time()
    rows = []
    for name, host in ENDPOINTS:
        with _lock:
            rec = _cache.get(name)
        if rec and rec["expires"] > now:
            origin, length = "cached", len(rec["value"])
        elif name in configured:
            origin, length = "configured", len(str(configured[name]))
        else:
            origin, length = "absent", 0
        rows.append({"header": name, "host": host, "origin": origin,
                     "length": length,
                     "expires_in": (round(rec["expires"] - now, 1) if rec else None)})
    return rows


def clear():
    """Drop every cached envelope. For tests and for a forced re-mint."""
    with _lock:
        _cache.clear()
        _fetching.clear()


if __name__ == "__main__":
    print(json.dumps(status(), indent=2))
    for row in status():
        print(row["header"], "->", refresh().get(row["header"], "")[:24] + "...")
