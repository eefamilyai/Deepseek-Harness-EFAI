"""Stdio sidecar exposing the Kiln provider registry to the Node harness.

The registry (`runtime/providers.py`) and its adapters — including `ds_direct`,
DeepSeek's free web session with its proof-of-work auth — stay untouched Python.
This process is the only thing the harness talks to: one JSON object per line in,
one JSON object per line out.

Requests (stdin, newline-delimited JSON):

    {"id": 1, "cmd": "catalog"}
    {"id": 2, "cmd": "validate", "provider": "openai"}
    {"id": 3, "cmd": "stream", "provider": "deepseek", "model": "deepseek-default",
     "messages": [{"role": "user", "content": "hi"}], "opts": {"temperature": 0.6}}
    {"id": 4, "cmd": "cancel", "target": 3}
    {"id": 5, "cmd": "upload_files", "provider": "deepseek",
     "files": [{"name": "notes.txt", "data": "<base64>"}], "account": "you@example.com"}

Responses (stdout, newline-delimited JSON), each carrying the request `id`:

    {"id": 1, "ok": true, "providers": [...]}
    {"id": 3, "ev": {"type": "content", "text": "..."}}   # repeated
    {"id": 3, "done": true}
    {"id": 2, "ok": false, "error": "..."}
    {"id": 5, "ok": true, "account": "you@example.com",
     "files": [{"name": "notes.txt", "id": "file-...", "size": 42}],
     "errors": [{"name": "big.bin", "error": "..."}]}

A stream runs on its own thread so a `cancel` for it can be read and dispatched
while it is still producing; `providers.stream` already turns adapter failures
into `content` + `meta{finish:error}` events rather than raising, so a stream
ends exactly one way — with `done`.

Secrets never cross this wire. The registry resolves API keys from the
environment at request time and its catalog reports only `has_key` booleans, so
no key, cookie, or token value ever appears in a response.
"""

import base64
import json
import os
import sys
import threading

sys.path.insert(0, os.path.join(os.path.dirname(os.path.abspath(__file__)), "runtime"))

import providers  # noqa: E402 — resolved through the sys.path line above

# One lock around stdout: stream threads and the reader thread all write frames,
# and an interleaved write would corrupt the line framing the harness parses.
_out_lock = threading.Lock()

# id -> cancel flag for every stream currently running. `cancel` sets the flag;
# the adapters poll it through the `cancelled` callable the registry passes down.
_cancels = {}
_cancels_lock = threading.Lock()


def _send(obj):
    # `ensure_ascii=True` is a wire-protocol requirement, not a style choice.
    # A non-ASCII character (the MIDDLE DOT in a model label, an em dash, a
    # CJK model name) written raw is encoded with whatever codepage the child's
    # stdout happens to carry. Under UTF-8 that is the right bytes; under a
    # legacy codepage such as Windows cp1252 it is a single byte (the middle
    # dot becomes 0xB7) that the harness then decodes as UTF-8 and replaces
    # with U+FFFD -- which renders in the picker as a diamond with a question
    # mark. Escaping to \\uXXXX keeps every frame pure ASCII, so the text
    # survives any stdout codepage and is decoded identically on every host.
    line = json.dumps(obj, ensure_ascii=True)
    with _out_lock:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()


def _advertised(pid):
    """DeepSeek's fixed web variants, as an advisory fallback — and ONLY
    DeepSeek's.

    `ds_direct.models()` returns nothing until a token is present, so a catalog
    built from `models` alone hides the free-web route entirely, and a route
    absent from the picker is one nobody can select in order to configure it.
    Its `LABELS` map declares every variant — a fixed, known set, not a guess —
    so that map is reported alongside.

    Every OTHER provider is deliberately excluded: reporting its declared label
    list would put an unqueried, invented catalogue in front of the user, which
    is exactly the guessing this is meant to stop. Those providers show models
    only once a live `GET {base}/models` has run (see providers._catalog_models).
    """
    if pid != "deepseek":
        return []
    try:
        mod = providers._module_for(pid)
        labels = getattr(mod, "LABELS", None)
        if not isinstance(labels, dict):
            labels = providers._call(mod, "model_labels", providers.config_for(pid))
        return [{"id": k, "name": v} for k, v in (labels or {}).items()]
    except Exception:  # noqa: BLE001 — an advisory list never fails a catalog read
        return []


def _catalog(req):
    entries = providers.get_providers()
    for entry in entries:
        entry["advertised"] = _advertised(entry["id"])
    _send({"id": req["id"], "ok": True, "providers": entries})


def _validate(req):
    ok, message = providers.validate(req.get("provider") or "")
    _send({"id": req["id"], "ok": True, "valid": bool(ok), "message": message})


def _configure(req):
    """Apply runtime credentials for a provider and force that provider to
    re-read its config.

    Only `deepseek` (ds_direct) uses this. The settings page can edit the full
    credential set: bearer token, WAF cookie, and optional login fields used by
    ds_direct for automatic token refresh. Values are passed through process
    env vars so the sidecar never needs a restart; no secret value is echoed
    back anywhere in the response.
    """
    provider = req.get("provider") or ""
    data = req.get("config") or {}
    if provider != "deepseek":
        _send({"id": req["id"], "ok": False,
               "error": "runtime config is only supported for provider 'deepseek'"})
        return
    if not isinstance(data, dict):
        data = {}
    env_map = (
        ("token", "DEEPSEEK_TOKEN"),
        ("cookie", "DEEPSEEK_COOKIE"),
        ("email", "DEEPSEEK_EMAIL"),
        ("mobile", "DEEPSEEK_MOBILE"),
        ("area_code", "DEEPSEEK_AREA_CODE"),
        ("password", "DEEPSEEK_PASSWORD"),
    )
    for key, env_name in env_map:
        if key in data:
            os.environ[env_name] = str(data[key] or "")
    try:
        mod = providers._load_module("ds_direct")
        mod._load_accounts(force=True)
    except Exception as e:  # noqa: BLE001 — report, never kill the sidecar
        _send({"id": req["id"], "ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        return
    _send({"id": req["id"], "ok": True})


def _add_account(req):
    """Test a DeepSeek login and, on success, add it as a pooled account.

    Drives ds_direct's real login so a pass here means the harness can serve
    this account. The password arrives in the request and is used only to log
    in; it is never echoed back — the response carries the account id (for the
    caller to select its route) or a plain error string, and nothing else.
    """
    provider = req.get("provider") or ""
    if provider != "deepseek":
        _send({"id": req["id"], "ok": False,
               "error": "accounts are only supported for provider 'deepseek'"})
        return
    data = req.get("account") or {}
    if not isinstance(data, dict):
        data = {}
    try:
        mod = providers._load_module("ds_direct")
        acct_id, err = mod.add_account(
            email=str(data.get("email") or ""),
            password=str(data.get("password") or ""),
            area_code=str(data.get("area_code") or "+86"),
            mobile=str(data.get("mobile") or ""))
    except Exception as e:  # noqa: BLE001 — report, never kill the sidecar
        _send({"id": req["id"], "ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        return
    if err:
        _send({"id": req["id"], "ok": False, "error": err})
        return
    _send({"id": req["id"], "ok": True, "account": acct_id})


def _upload_files(req):
    """Push caller-supplied bytes into DeepSeek's file store and return ids.

    Files cross this wire base64-encoded, because the framing is newline-
    delimited JSON and raw bytes would break it. The ids that come back can be
    passed to a later `stream` as `opts.ref_file_ids`, together with the
    returned `account` as `opts.account` — ids are scoped to the login that
    uploaded them, so the two must travel together or the chat cannot see the
    file.

    A per-file failure comes back in `errors` rather than failing the request:
    the caller decides whether losing one of five attachments is fatal, and it
    is the only party that knows. Only a whole-call failure (no credentials,
    no curl_cffi, a broken base64 payload) sets ok=false.
    """
    provider = req.get("provider") or ""
    if provider != "deepseek":
        _send({"id": req["id"], "ok": False,
               "error": "file upload is only supported for provider 'deepseek'"})
        return
    try:
        mod = providers._load_module("ds_direct")
    except Exception as e:  # noqa: BLE001 — report, never kill the sidecar
        _send({"id": req["id"], "ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        return

    pairs = []
    for raw in req.get("files") or []:
        if not isinstance(raw, dict):
            continue
        name = str(raw.get("name") or "file")
        try:
            blob = base64.b64decode(raw.get("data") or "", validate=True)
        except Exception as e:  # noqa: BLE001 — one bad payload, named
            _send({"id": req["id"], "ok": False,
                   "error": "file %r has an invalid base64 payload: %s" % (name, e)})
            return
        pairs.append((name, blob))

    try:
        result = mod.upload_files(pairs, account=req.get("account") or None)
    except Exception as e:  # noqa: BLE001 — same reason as _stream
        _send({"id": req["id"], "ok": False, "error": "%s: %s" % (type(e).__name__, e)})
        return
    _send({"id": req["id"], "ok": True,
           "account": result.get("account"),
           "files": result.get("files") or [],
           "errors": result.get("errors") or []})


def _stream(req):
    rid = req["id"]
    flag = threading.Event()
    with _cancels_lock:
        _cancels[rid] = flag
    try:
        gen = providers.stream(
            req.get("provider") or "",
            req.get("model") or "",
            req.get("messages") or [],
            req.get("opts") or {},
            flag.is_set,
        )
        for ev in gen:
            _send({"id": rid, "ev": ev})
            # Stop pumping as soon as cancellation lands. The adapters honour the
            # flag themselves, but a generator already holding a decoded chunk
            # would still hand it over, and the harness has stopped listening.
            if flag.is_set():
                break
    except Exception as e:  # noqa: BLE001 — a sidecar must report, never die
        _send({"id": rid, "ev": {"type": "content",
                                 "text": "\n[provider bridge error] %s" % e}})
        # The reason rides the meta frame as well as the content one: the text
        # is for the user to read, and `error` is what the harness classifies
        # (rate limit vs. transport) without parsing prose.
        _send({"id": rid, "ev": {"type": "meta", "finish": "error",
                                 "error": str(e)}})
    finally:
        with _cancels_lock:
            _cancels.pop(rid, None)
        _send({"id": rid, "done": True})


def _cancel(req):
    with _cancels_lock:
        flag = _cancels.get(req.get("target"))
    if flag is not None:
        flag.set()
    _send({"id": req["id"], "ok": True})


def _dispatch(req):
    cmd = req.get("cmd")
    if cmd == "stream":
        # Threaded so `cancel` (and further requests) stay readable mid-stream.
        threading.Thread(target=_stream, args=(req,), daemon=True).start()
        return
    try:
        if cmd == "catalog":
            _catalog(req)
        elif cmd == "validate":
            _validate(req)
        elif cmd == "configure":
            _configure(req)
        elif cmd == "add_account":
            _add_account(req)
        elif cmd == "cancel":
            _cancel(req)
        elif cmd == "upload_files":
            _upload_files(req)
        else:
            _send({"id": req.get("id"), "ok": False,
                   "error": "unknown command: %r" % cmd})
    except Exception as e:  # noqa: BLE001 — same reason as _stream
        _send({"id": req.get("id"), "ok": False, "error": "%s: %s" % (type(e).__name__, e)})


def main():
    for line in sys.stdin:
        line = line.strip()
        if not line:
            continue
        try:
            req = json.loads(line)
        except Exception as e:  # noqa: BLE001
            _send({"id": None, "ok": False, "error": "protocol error: %s" % e})
            continue
        _dispatch(req)


if __name__ == "__main__":
    main()
