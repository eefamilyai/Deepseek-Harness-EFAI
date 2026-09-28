"""Operator-facing account administration for the DeepSeek web pool.

Three things live here, all keyed on the same account id the rest of the runtime
uses (an email or a mobile number):

  * a bounded, thread-safe EVENT LOG. Every operator-visible step -- an account
    added, a re-login started, a profile re-minted, a turn dispatched to one of
    two pooled logins -- is appended with the account it belongs to, so an
    interleaved run of two accounts stays attributable instead of a blur. The
    bridge drains it by sequence number and the Accounts tab renders it.
  * ``list_accounts()``, the full identity of every account the runtime can
    serve: what it is configured with, which browser profile it owns, and the
    actual ``device_id`` / ``x-device-id`` / ``did`` values that profile minted.
    This is the operator's own machine and those values already sit in
    ``ds_config.json`` and the per-account record, so they are reported rather
    than merely counted. The credential fields -- bearer token, WAF cookie, login
    password -- are reported as PRESENCE ONLY: a fingerprint identifies a device,
    a token authorizes a session, and only one of those belongs on a wire.
  * ``relogin()`` and ``reprofile()``, the two repairs. A re-login replays the
    stored credentials to mint a fresh bearer token for an account whose token
    went stale. A re-profile rebuilds that account's Chrome profile so its
    browser-minted identity is minted again instead of replayed.

Nothing here invents an identifier. A profile that never minted a ``device_id``
reports none, for the same reason ``ds_profile`` refuses to fabricate one.
"""

import contextlib
import os
import shutil
import threading
import time

import ds_identity
import ds_profile

__all__ = [
    "LOG_LIMIT",
    "clear_log",
    "drain",
    "list_accounts",
    "record",
    "relogin",
    "remove_account",
    "reprofile",
]

# How many events the ring keeps. The UI drains by sequence number, so this
# bounds the memory of a bridge nobody is watching -- it is not a retention
# policy for anything durable, because nothing here is written to disk.
LOG_LIMIT = 500

_LOG = []
_LOG_LOCK = threading.Lock()
_SEQ = [0]


def _text(value):
    """Best-effort text for one log field. Never raises.

    ``str`` is a method call on an arbitrary object and can itself fail. The
    event it describes still happened, so the field degrades to a named
    placeholder rather than dropping the entry -- a dropped entry is the one
    outcome this log exists to prevent.
    """
    if value is None:
        return ""
    try:
        return str(value)
    except Exception:  # noqa: BLE001 -- the fallback below is the point
        try:
            return "<unprintable %s>" % type(value).__name__
        except Exception:  # noqa: BLE001 -- a broken metaclass; the entry still goes in
            return "<unprintable>"


def record(account, event, detail="", level="info"):
    """Append one operator-visible event and return it. Never raises.

    A log line is diagnostics, so it must not be able to fail the operation it
    describes: a caller in the middle of a login is exactly the caller that
    cannot afford an exception from here. For the same reason it must not drop
    the event either -- an unprintable field degrades, the entry stays.
    """
    try:
        with _LOG_LOCK:
            _SEQ[0] += 1
            entry = {
                "seq": _SEQ[0],
                "at": time.time(),
                "account": _text(account),
                "event": _text(event),
                "level": _text(level) or "info",
                "detail": _text(detail),
            }
            _LOG.append(entry)
            excess = len(_LOG) - LOG_LIMIT
            if excess > 0:
                del _LOG[:excess]
        return entry
    except Exception:  # noqa: BLE001 -- see the docstring
        return {}


def drain(since=0):
    """Every entry with ``seq`` greater than `since`, oldest first."""
    try:
        floor = int(since)
    except (TypeError, ValueError):
        floor = 0
    with _LOG_LOCK:
        return [dict(entry) for entry in _LOG if entry["seq"] > floor]


def clear_log():
    """Drop every buffered entry. Returns how many were dropped."""
    with _LOG_LOCK:
        dropped = len(_LOG)
        _LOG.clear()
    return dropped


def _ds_direct():
    """The loaded ``ds_direct`` module, or ``None`` when it cannot be imported.

    Imported lazily and by name: ``ds_direct`` pulls in ``curl_cffi`` and builds
    its account list at import, and the log/identity half of this module has to
    keep working on a machine where that fails.
    """
    try:
        import ds_direct
        return ds_direct
    except Exception as e:  # noqa: BLE001 -- reported, not raised
        record("", "module-error", "ds_direct could not be imported: %s" % e, level="error")
        return None


def _record_by_slug(slug):
    """The stored identity document for a profile directory name."""
    try:
        import json
        path = os.path.join(ds_identity.identity_dir(), "accounts", "%s.json" % slug)
        with open(path, "r", encoding="utf-8") as f:
            doc = json.load(f)
        return doc if isinstance(doc, dict) else {}
    except Exception:  # noqa: BLE001 -- an absent record is a normal state
        return {}


def _account_view(account_id, acct=None):
    """One account's full identity, for an expandable row in the UI."""
    rec = ds_profile.read_account_identity(account_id)
    folder = ds_profile.profile_dir(account_id)
    device_id = ds_profile.device_id_for_account(account_id) or ""
    machine = ""
    with contextlib.suppress(Exception):
        machine = ds_identity.configured_device_id() or ""
    if device_id:
        device_source = "account"
    elif machine:
        device_source = "machine"
    else:
        device_source = ""
    return {
        "id": str(account_id),
        "slug": ds_profile.slug(account_id),
        "configured": acct is not None,
        "email": str(getattr(acct, "email", "") or ""),
        "mobile": str(getattr(acct, "mobile", "") or ""),
        "area_code": str(getattr(acct, "area_code", "") or ""),
        # Presence only. A token or a password is a credential; a device id is
        # not, and the operator asked to read the second one.
        "has_token": bool(str(getattr(acct, "token", "") or "")),
        "has_cookie": bool(str(getattr(acct, "cookie", "") or "")),
        "has_password": bool(str(getattr(acct, "password", "") or "")),
        "profile": folder,
        "profile_exists": os.path.isdir(folder),
        "record_path": ds_profile.account_record_path(account_id),
        "device_id": device_id,
        "device_id_len": len(device_id),
        "device_id_valid": ds_identity.valid_device_id(device_id),
        "device_id_source": device_source,
        "device_id_rejected": str(rec.get("device_id_rejected") or ""),
        "x_device_id": str(rec.get("x_device_id") or ""),
        "did": str(rec.get("did") or ""),
        "origin": str(rec.get("origin") or ""),
        "captured_at": rec.get("updated_at"),
    }


def _orphan_view(slug):
    """A profile on disk that ``ds_config.json`` no longer names.

    Still shown: a browser identity is worth keeping even after its login was
    removed, and silently hiding the directory would make the very thing this
    page exists to explain -- where the profile went -- invisible.
    """
    rec = _record_by_slug(slug)
    folder = os.path.join(ds_identity.identity_dir(), "profiles", slug)
    # Shape-checked the same way a configured row is. Reading the record raw here
    # made the two halves of one page disagree: a configured row refused a value
    # its rule rejects while the orphan row beside it presented that value as the
    # device. One page, one rule.
    raw_device_id = str(rec.get("device_id") or "")
    device_id = raw_device_id if ds_identity.valid_device_id(raw_device_id) else ""
    return {
        "id": "",
        "slug": slug,
        "configured": False,
        "email": "",
        "mobile": "",
        "area_code": "",
        "has_token": False,
        "has_cookie": False,
        "has_password": False,
        "profile": folder,
        "profile_exists": os.path.isdir(folder),
        "record_path": os.path.join(ds_identity.identity_dir(), "accounts", "%s.json" % slug),
        "device_id": device_id,
        "device_id_len": len(device_id),
        "device_id_valid": ds_identity.valid_device_id(device_id),
        "device_id_source": "account" if device_id else "",
        "device_id_rejected": str(rec.get("device_id_rejected") or ""),
        "x_device_id": str(rec.get("x_device_id") or ""),
        "did": str(rec.get("did") or ""),
        "origin": str(rec.get("origin") or ""),
        "captured_at": rec.get("updated_at"),
    }


def list_accounts():
    """Every account the runtime can serve, configured first, then orphaned.

    The union matters: an account can be configured with no profile yet (a fresh
    ``add_account`` before its first capture), and a profile can outlive the
    config entry that named it. Both are things an operator needs to see, and
    neither is visible from only one of the two sources.
    """
    dd = _ds_direct()
    configured = {}
    if dd is not None:
        try:
            for account_id in dd.account_ids():
                configured[account_id] = dd._account_by_id(account_id)
        except Exception as e:  # noqa: BLE001 -- report, still list what is on disk
            record("", "list-error", "could not read the configured accounts: %s" % e,
                   level="error")

    known = {ds_profile.slug(account_id) for account_id in configured}
    orphaned = [slug for slug in ds_profile.list_profiles() if slug not in known]

    rows = [_account_view(account_id, acct)
            for account_id, acct in sorted(configured.items())]
    rows.extend(_orphan_view(slug) for slug in orphaned)
    return rows


def _capture(account_id, timeout_ms, note):
    """Mint-or-read this account's browser identity. Returns (ok, detail).

    Never fatal to the caller: a re-login that succeeded is a re-login that
    succeeded, and a browser that will not start is a separate, reported fact.
    """
    try:
        doc = ds_profile.capture_identity(
            account_id, headless=True, timeout_ms=timeout_ms,
            on_status=lambda msg: record(account_id, "identity", msg))
    except Exception as e:  # noqa: BLE001 -- the concrete reason is the point
        record(account_id, "%s-capture-failed" % note, str(e), level="error")
        return False, str(e)
    device_id = str(doc.get("device_id") or "")
    record(account_id, "%s-captured" % note,
           "device_id=%d chars, x-device-id=%s, did=%s" % (
               len(device_id),
               "yes" if doc.get("x_device_id") else "no",
               "yes" if doc.get("did") else "no"))
    return True, ""


def relogin(account_id, capture=True, timeout_ms=45000):
    """Mint a fresh bearer token for `account_id` from its stored credentials.

    This is the repair for a token that went stale: it replays the login the
    account was added with, persists the new token/cookie into that account's own
    slot, and -- best effort -- refreshes the browser identity from the profile
    the account already owns. The password is used and never returned.

    Returns a plain result dict; a refusal is a value, not an exception.
    """
    account_id = str(account_id or "").strip()
    if not account_id:
        return {"ok": False, "error": "an account id is required"}
    dd = _ds_direct()
    if dd is None:
        return {"ok": False, "error": "the ds_direct module is unavailable"}

    acct = None
    with contextlib.suppress(Exception):
        candidate = dd._account_by_id(account_id)
        if candidate is not None and candidate.id == account_id:
            acct = candidate
    if acct is None:
        message = "no configured account matches %r" % account_id
        record(account_id, "relogin-missing", message, level="error")
        return {"ok": False, "error": message}
    if not acct.password:
        message = "this account has no stored password to log in with"
        record(account_id, "relogin-refused", message, level="error")
        return {"ok": False, "error": message}

    record(account_id, "relogin-start", "email=%s mobile=%s" % (
        "yes" if acct.email else "no", "yes" if acct.mobile else "no"))
    try:
        client = dd._Client(acct)
        token = client.login()
    except Exception as e:  # noqa: BLE001 -- report, never raise into the bridge
        record(account_id, "relogin-failed", "%s: %s" % (type(e).__name__, e), level="error")
        return {"ok": False, "error": "%s: %s" % (type(e).__name__, e)}
    if not token:
        message = getattr(client, "last_login_error", "") or "login failed"
        record(account_id, "relogin-failed", message, level="error")
        return {"ok": False, "error": message}

    try:
        acct.save(token, client.cookie_string())
    except Exception as e:  # noqa: BLE001 -- a persistence failure is reported, not fatal
        record(account_id, "relogin-unsaved", str(e), level="error")
    with contextlib.suppress(Exception):
        dd._load_accounts(force=True)
    record(account_id, "relogin-ok", "new bearer token stored")

    captured = False
    if capture:
        captured, _ = _capture(account_id, timeout_ms, "relogin")
    return {"ok": True, "account": account_id, "captured": captured}


def reprofile(account_id, fresh=True, capture=True, timeout_ms=45000):
    """Rebuild `account_id`'s Chrome profile and mint a fresh browser identity.

    ``fresh`` removes the existing user-data directory first, which is the point:
    a profile that reuses its old state replays its old ``device_id``, and the
    repair for a flagged identity is a new one rather than the same one again.
    With ``fresh=False`` the existing profile is opened and merely re-read.

    Returns a plain result dict; a refusal is a value, not an exception.
    """
    account_id = str(account_id or "").strip()
    if not account_id:
        return {"ok": False, "error": "an account id is required"}

    folder = ds_profile.profile_dir(account_id)
    removed = False
    if fresh and os.path.isdir(folder):
        try:
            shutil.rmtree(folder)
            removed = True
        except Exception as e:  # noqa: BLE001 -- a locked profile is a real, named failure
            message = "could not remove %s (%s)" % (folder, e)
            record(account_id, "reprofile-failed", message, level="error")
            return {"ok": False, "error": message}
    record(account_id, "reprofile-start",
           "profile %s" % ("removed" if removed else "kept"))

    if not capture:
        return {"ok": True, "account": account_id, "removed": removed, "captured": False}

    ok, error = _capture(account_id, timeout_ms, "reprofile")
    if not ok:
        return {"ok": False, "error": error}
    return {"ok": True, "account": account_id, "removed": removed, "captured": True}


def remove_account(account_id="", slug="", purge=False):
    """Forget an account: its config slot, its identity record, its profile.

    Three things can name one login, and they are removed together so the page
    cannot be left showing a row that half-exists:

      * the ds_config.json slot -- removed by ``ds_direct.remove_account``, and
        what actually makes the account stop being a route;
      * the recorded identity document under ``accounts/<slug>.json``;
      * the Chrome profile under ``profiles/<slug>`` -- ONLY with ``purge``.

    ``purge`` defaults to False on purpose. A browser profile is an identity, not
    a credential: it is the thing that cost a real login to mint, and a re-login
    or a replacement account can still use it. Deleting it is a separate,
    explicit decision, so the ordinary removal keeps it and the row simply moves
    to the orphan half of the list.

    Both keys are accepted because the two halves of the list are addressed
    differently: a configured row has an id, while an orphan has ONLY a slug --
    the account id it was configured under is exactly what is gone. A caller that
    passes both (the UI does) gets a single consistent operation.

    Returns a plain result dict; a refusal is a value, not an exception.
    """
    account_id = str(account_id or "").strip()
    slug = str(slug or "").strip() or (ds_profile.slug(account_id) if account_id else "")
    if not account_id and not slug:
        return {"ok": False, "error": "an account id or a slug is required"}

    result = {"ok": True, "account": account_id, "slug": slug,
              "removed_config": False, "removed_record": False,
              "removed_profile": False}

    if account_id:
        dd = _ds_direct()
        if dd is None:
            return {"ok": False, "error": "the ds_direct module is unavailable"}
        try:
            removed, error = dd.remove_account(account_id)
        except Exception as e:  # noqa: BLE001 -- report, never raise into the bridge
            message = "%s: %s" % (type(e).__name__, e)
            record(account_id, "remove-failed", message, level="error")
            return {"ok": False, "error": message}
        if error:
            record(account_id, "remove-failed", error, level="error")
            return {"ok": False, "error": error}
        result["removed_config"] = bool(removed)

    if not result["removed_config"] and not slug:
        message = "no configured account matches %r" % account_id
        record(account_id, "remove-missing", message, level="error")
        return {"ok": False, "error": message}

    record(account_id or slug, "remove-start",
           "config=%s purge=%s" % ("yes" if result["removed_config"] else "no",
                                   "yes" if purge else "no"))

    # The record goes with the login: an identity document that no login and no
    # profile points at is not a useful thing to keep, and leaving it behind is
    # what puts a deleted account straight back on this page as an orphan.
    #
    # `account_record_path` hashes its ARGUMENT into a slug, so it takes the
    # account id and only the account id. An orphan has no id left to give it --
    # the slug we were handed IS already that hash -- so its path is assembled
    # directly. Passing a slug to the helper would hash it a second time and
    # quietly delete nothing.
    if account_id:
        record_path = ds_profile.account_record_path(account_id)
    elif slug:
        record_path = os.path.join(ds_identity.identity_dir(), "accounts",
                                   "%s.json" % slug)
    else:
        record_path = ""
    if record_path and os.path.exists(record_path):
        try:
            os.remove(record_path)
            result["removed_record"] = True
        except Exception as e:  # noqa: BLE001 -- a locked file is a real, named failure
            message = "could not remove %s (%s)" % (record_path, e)
            record(account_id or slug, "remove-record-failed", message, level="error")
            return {"ok": False, "error": message, **result}

    if purge and slug:
        folder = os.path.join(ds_identity.identity_dir(), "profiles", slug)
        if os.path.isdir(folder):
            try:
                shutil.rmtree(folder)
                result["removed_profile"] = True
            except Exception as e:  # noqa: BLE001 -- a locked profile is a real, named failure
                message = "could not remove %s (%s)" % (folder, e)
                record(account_id or slug, "remove-profile-failed", message, level="error")
                return {"ok": False, "error": message, **result}

    record(account_id or slug, "remove-ok",
           "config=%s record=%s profile=%s" % (
               "yes" if result["removed_config"] else "no",
               "yes" if result["removed_record"] else "no",
               "yes" if result["removed_profile"] else "no"))
    return result
