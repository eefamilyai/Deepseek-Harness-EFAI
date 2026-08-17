"""provider_errors.py — human-readable provider API errors.

HTTPError.__str__() dumps the whole JSON body into the chat, which is exactly
what users are complaining about. Pull the provider's own `message` field when
present; fall back to a short `HTTP <code>` line.
"""
import json
import urllib.error


def friendly_error(e):
    if isinstance(e, urllib.error.HTTPError):
        try:
            body = e.read().decode("utf-8", "replace")
        except Exception:
            body = ""
        try:
            data = json.loads(body) if body else None
        except Exception:
            data = None
        if isinstance(data, dict):
            err = data.get("error") if isinstance(data.get("error"), dict) else None
            msg = (data.get("message")
                   or (err or {}).get("message")
                   or (err or {}).get("type"))
            if msg:
                return str(msg)
        code = getattr(e, "code", "")
        reason = getattr(e, "reason", "")
        if code:
            return f"HTTP {code}" + (f": {reason}" if reason else "")
    return str(e)
