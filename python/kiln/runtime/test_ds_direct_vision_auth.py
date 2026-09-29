#!/usr/bin/env python
"""Regression tests for the VISION/attachment auth verdict in ds_direct.

Run:  python test_ds_direct_vision_auth.py

A dead bearer token reaches every DeepSeek surface the same way: an HTTP 200
whose body carries {"code":40003,"msg":"Authorization Failed (invalid token)"}
and streams no frames at all. The proof-of-work solve and the ordinary
completion both learned to read that verdict; the attachment path did not. An
expired token there produced a plain RuntimeError("the vision model returned
nothing"), and the caller's re-login retry -- which catches only _AuthExpired --
never ran, so the operator had to relog in by hand to attach a file again.

Two defects are pinned here:

  * a 200-with-40003 attachment body must classify as _AuthExpired, which is
    what makes the existing login-and-retry path run;
  * the 400/422 retry's OWN response must be re-checked. A fresh turn in the
    same chat can come back 401 just as easily as the first attempt can, and the
    retry used to be sent without ever looking at its reply.

No network and no credentials: the tests drive a fake client.
"""
import contextlib
import os
import sys
import threading

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ds_direct as dd

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


AUTH_BODY = (b'data: {"code":40003,"msg":"Authorization Failed (invalid token)",'
             b'"data":null}')
ANSWER_BODY = (b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
               b'"content":"described"}]}}}')


class FakeResponse:
    def __init__(self, status_code=200, lines=(), text=""):
        self.status_code = status_code
        self.text = text
        self._lines = list(lines)
        self.closed = False

    def iter_lines(self):
        for line in self._lines:
            yield line

    def close(self):
        self.closed = True


class FakeClient:
    """Serves one scripted response per completion, and remembers the order."""

    def __init__(self, responses=(), login_ok=False):
        self.opened = []
        self.logins = 0
        self.new_sessions = 0
        self.account = type("Acct", (), {"id": "test@example.com"})()
        self._responses = list(responses)
        self._login_ok = login_ok

    def new_session(self):
        self.new_sessions += 1
        return "vision-sid-%d" % self.new_sessions

    def login(self):
        self.logins += 1
        return self._login_ok

    def open_completion(self, session_id, prompt, thinking, search, model_type,
                        parent_message_id, ref_file_ids=None, **kw):
        self.opened.append({"sid": session_id, "parent": parent_message_id,
                            "refs": ref_file_ids})
        if self._responses:
            return self._responses.pop(0)
        return FakeResponse()

    def upload_file(self, filename, blob):
        return "file-" + filename

    def file_status(self, file_ids):
        return {}          # not answering: "no evidence" keeps the file usable


def run_vision(responses, login_ok=False):
    """Run _run_vision_turn once; return (body, error, client)."""
    client = FakeClient(responses=responses, login_ok=login_ok)
    saved = {k: getattr(dd, k) for k in
             ("_sessions", "_session_lock", "_save_sessions", "_persist_cookies")}
    dd._sessions = {}
    dd._session_lock = threading.Lock()
    dd._save_sessions = lambda: None
    dd._persist_cookies = lambda c: None

    body, error = None, None
    try:
        body = dd._run_vision_turn(client, "describe these", ["fid-1"], lambda: False)
    except BaseException as e:      # noqa: BLE001 -- the test asserts on the type
        error = e
    finally:
        for k, v in saved.items():
            setattr(dd, k, v)
    return body, error, client


# ── a 200 carrying 40003 is an expired credential, not an empty answer ─
body_a, error_a, _client_a = run_vision([FakeResponse(lines=[AUTH_BODY])])

check("a vision 200 carrying 40003 raises _AuthExpired",
      isinstance(error_a, dd._AuthExpired),
      "got %s: %s" % (type(error_a).__name__, error_a))
check("the vision auth failure names the bearer token",
      isinstance(error_a, dd._AuthExpired) and "bearer token" in str(error_a),
      repr(str(error_a))[:140])
check("the vision auth failure is not the generic empty-body error",
      not (isinstance(error_a, RuntimeError) and "returned nothing" in str(error_a)),
      repr(str(error_a))[:140])
check("a refused vision turn returns no body",
      body_a is None, "body=%r" % (body_a,))


# ── an empty body with NO verdict keeps its own diagnosis ──────────────
body_e, error_e, _client_e = run_vision([FakeResponse()])

check("an empty vision body with no verdict is not an auth failure",
      not isinstance(error_e, dd._AuthExpired),
      "got %s: %s" % (type(error_e).__name__, error_e))
check("an empty vision body still reports that nothing came back",
      isinstance(error_e, RuntimeError) and "returned nothing" in str(error_e),
      repr(str(error_e))[:140])


# ── a status-only refusal is still classified from the status ──────────
_body_401, error_401, _c401 = run_vision([FakeResponse(status_code=401)])
check("a 401 vision response raises _AuthExpired",
      isinstance(error_401, dd._AuthExpired),
      "got %s: %s" % (type(error_401).__name__, error_401))

_body_404, error_404, _c404 = run_vision([FakeResponse(status_code=404)])
check("a 404 vision response raises _SessionStale",
      isinstance(error_404, dd._SessionStale),
      "got %s: %s" % (type(error_404).__name__, error_404))


# ── the 400/422 retry's own response must be re-checked ────────────────
body_r, error_r, client_r = run_vision([
    FakeResponse(status_code=400, text="bad parent"),
    FakeResponse(status_code=401),
])
check("a 400 first attempt still retries in the same chat",
      len(client_r.opened) == 2, repr(client_r.opened))
check("the retry's own 401 is classified, not reported as a vision status error",
      isinstance(error_r, dd._AuthExpired),
      "got %s: %s" % (type(error_r).__name__, error_r))

body_r2, error_r2, client_r2 = run_vision([
    FakeResponse(status_code=422, text="bad parent"),
    FakeResponse(lines=[AUTH_BODY]),
])
check("a 422 retry whose body carries 40003 is an auth failure",
      isinstance(error_r2, dd._AuthExpired),
      "got %s: %s" % (type(error_r2).__name__, error_r2))
check("the retry kept the same vision chat",
      len(client_r2.opened) == 2
      and client_r2.opened[0]["sid"] == client_r2.opened[1]["sid"],
      repr(client_r2.opened))


# ── an ordinary answer still comes back ───────────────────────────────
body_ok, error_ok, _c_ok = run_vision([FakeResponse(lines=[ANSWER_BODY])])
check("a normal vision turn returns the model's text",
      error_ok is None and body_ok == "described",
      "body=%r error=%r" % (body_ok, error_ok))


# ── the whole describe_files retry: a working login clears the verdict ──
def describe(responses, login_ok):
    """Run describe_files once with the module's guards faked out."""
    client = FakeClient(responses=responses, login_ok=login_ok)
    saved = {k: getattr(dd, k) for k in
             ("_sessions", "_session_lock", "_save_sessions", "_persist_cookies",
              "cffi", "configured", "_lease_client")}
    dd._sessions = {}
    dd._session_lock = threading.Lock()
    dd._save_sessions = lambda: None
    dd._persist_cookies = lambda c: None
    dd.cffi = object()
    dd.configured = lambda: True

    @contextlib.contextmanager
    def lease(account_id=None):
        yield client

    dd._lease_client = lease

    out, error = None, None
    try:
        out = dd.describe_files([("a.png", b"blob")], "describe", lambda: False)
    except BaseException as e:      # noqa: BLE001 -- the test asserts on the type
        error = e
    finally:
        for k, v in saved.items():
            setattr(dd, k, v)
    return out, error, client


out_d, error_d, client_d = describe(
    [FakeResponse(lines=[AUTH_BODY]), FakeResponse(lines=[ANSWER_BODY])], login_ok=True)
check("a working re-login clears a vision auth verdict",
      error_d is None, "error=%r" % (error_d,))
check("the vision retry produced a description",
      isinstance(out_d, dict)
      and out_d.get("a.png", {}).get("description") == "described",
      repr(out_d))
check("the vision re-login happened exactly once",
      client_d.logins == 1, "logins=%d" % client_d.logins)
check("the vision retry stayed in the same chat",
      len(client_d.opened) == 2
      and client_d.opened[0]["sid"] == client_d.opened[1]["sid"],
      repr(client_d.opened))

out_f, error_f, client_f = describe(
    [FakeResponse(lines=[AUTH_BODY]), FakeResponse(lines=[AUTH_BODY])], login_ok=False)
check("a failed vision re-login surfaces as an auth failure",
      isinstance(error_f, RuntimeError) and "auth failed" in str(error_f).lower(),
      "got %s: %s" % (type(error_f).__name__, error_f))
check("a failed vision re-login is attempted once, not forever",
      client_f.logins == 1, "logins=%d" % client_f.logins)


print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all checks passed")
