# Per-request wire journal for ds_direct: every authenticated request, in order.
#
# WHY THIS EXISTS
#
# The mute verdict is ASYNCHRONOUS: it always lands minutes to hours after the
# last request, never during one. So the request that draws it is never the one
# that reports it, and a log that only records verdicts cannot answer "what did
# we send right before this account was muted?". This journal records every
# request as it goes out and keeps a ring of the most recent ones in memory, so
# the moment a verdict is raised it can be written out TOGETHER WITH its own
# preamble -- the exact request shapes that preceded it.
#
# WHAT IT RECORDS, AND WHAT IT DELIBERATELY DOES NOT
#
# Header VALUES are never written. A value here can be the bearer token, a WAF
# token, or a session cookie, and this file is read by tooling and pasted into
# reports. Instead each header value is written as a short SHA-256 fingerprint:
# two requests whose `authorization` differs have different fingerprints, two
# whose `accept-language` is identical have the same one. That is exactly the
# comparison this investigation needs (did a header change shape, appear, or go
# missing?) and it leaks nothing. The same treatment applies to cookie values.
#
# The prompt body is also not written -- only its top-level KEY NAMES and its
# serialized size, which is enough to see the request's shape without copying
# conversation text into a log.
#
# OFF BY DEFAULT. Enable per-process with KILN_DS_WIRELOG=1, or globally by
# creating a file named `ds_wirelog.on` beside this module. A running
# provider_bridge caches its modules, so the env var only takes effect in a
# process started with it set (the soak) -- which is deliberate: this must never
# silently change the behaviour of the live bridge.
import hashlib
import json
import os
import threading
import time

_DIR = os.path.dirname(os.path.abspath(__file__))
_LOCK = threading.Lock()
_RING = []
_RING_MAX = 80
_SEQ = 0
_ON = None


def _state_dir():
    """Beside ds_sessions.json, so KILN_STATE_DIR keeps test runs isolated."""
    return os.environ.get("KILN_STATE_DIR") or _DIR


def path():
    """The journal file this process appends to."""
    return os.path.join(_state_dir(), "ds_wirelog.jsonl")


def enabled():
    """Whether this process journals. Resolved once, then cached."""
    global _ON
    if _ON is None:
        flag = os.environ.get("KILN_DS_WIRELOG", "")
        marker = os.path.join(_DIR, "ds_wirelog.on")
        _ON = bool(flag and flag.strip().lower() not in ("0", "false", "no")) \
            or os.path.exists(marker)
    return _ON


def _fp(value):
    """A short, stable fingerprint of a header or cookie value -- never the value."""
    if value is None:
        return None
    if isinstance(value, bytes):
        value = value.decode("utf-8", "ignore")
    return hashlib.sha256(str(value).encode("utf-8", "ignore")).hexdigest()[:10]


def _append(obj):
    """Append one line. Best-effort: a journal must never break a turn.

    Creates the parent directory first: `KILN_STATE_DIR` may name a directory
    nobody has created yet, and the first write is exactly when that shows up.
    Swallowing the error without this made the journal silently write NOTHING,
    which is the worst possible failure for a file whose whole purpose is to
    exist after the fact.
    """
    try:
        p = path()
        parent = os.path.dirname(p)
        if parent and not os.path.isdir(parent):
            os.makedirs(parent, exist_ok=True)
        with open(p, "a", encoding="utf-8") as f:
            f.write(json.dumps(obj, ensure_ascii=False) + "\n")
    except Exception:  # noqa: BLE001
        pass


def record(kind, account=None, **fields):
    """Append one event and keep it in the ring for a later verdict preamble."""
    if not enabled():
        return
    obj = {"ts": time.time(), "kind": kind, "account": account}
    obj.update(fields)
    with _LOCK:
        _RING.append(obj)
        del _RING[:-_RING_MAX]
    _append(obj)


def verdict(kind, detail, account=None):
    """Record a refusal TOGETHER with the request shapes that preceded it.

    This is the whole point of the module: the mute arrives long after the
    request that caused it, so the useful artifact is the verdict AND the
    preamble in one line, not the verdict alone.
    """
    if not enabled():
        return
    with _LOCK:
        preamble = list(_RING)
        obj = {"ts": time.time(), "kind": "verdict", "verdict": str(kind),
               "detail": str(detail)[:800], "account": account,
               "preamble": preamble}
        _RING.append(obj)
        del _RING[:-_RING_MAX]
    _append(obj)


def _next_seq():
    global _SEQ
    with _LOCK:
        _SEQ += 1
        return _SEQ


def _path_of(url):
    """`https://chat.deepseek.com/a/b?c=d` -> `chat.deepseek.com/a/b`."""
    text = str(url or "")
    for scheme in ("https://", "http://"):
        if text.startswith(scheme):
            text = text[len(scheme):]
            break
    return text.split("?", 1)[0]


def _cookie_names(headers):
    """Cookie NAMES plus a per-value fingerprint -- never the values."""
    raw = ""
    for k, v in (headers or {}).items():
        if str(k).lower() == "cookie":
            raw = v if isinstance(v, str) else str(v)
            break
    names = {}
    for part in raw.split(";"):
        part = part.strip()
        if not part or "=" not in part:
            continue
        name, _, val = part.partition("=")
        names[name.strip()] = _fp(val)
    return names


def _jar_cookies(sess):
    """The session cookie jar as name -> metadata, values fingerprinted.

    Reads the jar, NOT the `headers` dict: curl_cffi applies cookies at the
    libcurl level, so a `cookie` header is usually absent from `kwargs` even when
    the request carries a full jar. Reading only the headers made this journal
    report "no cookies" on every request -- exactly the wrong answer for an
    investigation into stale-cookie behaviour, and silently so.

    `expires` is recorded because a cookie replayed AFTER its expiry is the
    hypothesis under test. Epoch float, or None for a session cookie.
    """
    out = {}
    try:
        jar = getattr(getattr(sess, "cookies", None), "jar", None)
        if jar is None:
            return out
        now = time.time()
        for c in list(jar):
            exp = getattr(c, "expires", None)
            try:
                exp = float(exp) if exp is not None else None
            except (TypeError, ValueError):
                exp = None
            out[c.name] = {
                "fp": _fp(getattr(c, "value", None)),
                "domain": getattr(c, "domain", "") or "",
                "expires": exp,
                "expired": bool(exp is not None and exp <= now),
                "age_s": int(now - exp) if exp is not None else None,
            }
    except Exception:  # noqa: BLE001 -- a journal must never break a request
        pass
    return out


def _size(body):
    if body is None:
        return 0
    try:
        return len(json.dumps(body, ensure_ascii=False))
    except Exception:  # noqa: BLE001
        try:
            return len(body)
        except Exception:  # noqa: BLE001
            return -1


def _response_header(r, name):
    try:
        for k, v in (r.headers or {}).items():
            if str(k).lower() == name:
                return v
    except Exception:  # noqa: BLE001
        pass
    return None


def install(sess, account=None):
    """Wrap `sess.request` so every request and response is journaled.

    `Session.get`/`Session.post` both delegate to `Session.request`, so one wrap
    here covers every HTTP call this account makes -- login, PoW, upload,
    completion -- without touching a single call site.
    """
    if not enabled():
        return sess
    if getattr(sess, "_ds_wirelog_installed", False):
        return sess
    orig = sess.request

    def wrapped(method, url, *args, **kwargs):
        seq = _next_seq()
        headers = kwargs.get("headers") or {}
        body = kwargs.get("json")
        if body is None:
            body = kwargs.get("data")
        record(
            "request", account=account, seq=seq,
            method=str(method).upper(), path=_path_of(url),
            header_order=sorted(str(k) for k in headers.keys()),
            header_fp={str(k): _fp(v) for k, v in headers.items()},
            cookie_names=_cookie_names(headers),
            jar=_jar_cookies(sess),
            body_keys=sorted(body.keys()) if isinstance(body, dict) else None,
            body_bytes=_size(body),
            stream=bool(kwargs.get("stream")),
        )
        try:
            r = orig(method, url, *args, **kwargs)
        except Exception as e:  # noqa: BLE001
            record("error", account=account, seq=seq,
                   error=type(e).__name__, detail=str(e)[:300])
            raise
        record("response", account=account, seq=seq,
               status=getattr(r, "status_code", None),
               waf=_response_header(r, "x-amzn-waf-action"),
               ctype=_response_header(r, "content-type"))
        return r

    sess.request = wrapped
    try:
        sess._ds_wirelog_installed = True
    except Exception:  # noqa: BLE001
        pass
    return sess
