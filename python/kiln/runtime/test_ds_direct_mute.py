#!/usr/bin/env python
"""Regression tests for ds_direct's MUTE classification.

Run:  python test_ds_direct_mute.py

DeepSeek reports an account MUTE inside an HTTP 200 body, and one nesting level
BELOW every other refusal:

    {"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted",
     "biz_data":{"is_muted":1,"mute_until":1790932407.459}}}

The outer envelope says success -- `code` 0, `msg` "" -- so every reader that
looks at the HTTP status or the top-level code/msg pair sees a healthy request
that happened to stream nothing. That is why the operator saw

    DeepSeek returned an empty response (HTTP 200): no answer and no diagnostic

while DeepSeek had said in plain words why it would not answer.

Pinned here:
  * the nested verdict is FOUND, on a bare JSON body and on an SSE-framed one;
  * it is NOT confused with the token verdict (`_auth_verdict_in` returns None
    for it), because answering a mute by re-logging in is a wasted login --
    the credential is fine and the account is muted;
  * `_Muted` is its own type, NOT `_AuthExpired`, so the login-and-retry path
    does not run at it;
  * end to end, an unmuted retry is not attempted: the turn fails once, naming
    the mute, instead of burning three logins and then reporting "empty".

No network and no credentials: the tests drive a fake client.
"""
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


class FakeResponse:
    def __init__(self, status_code=200, lines=()):
        self.status_code = status_code
        self.text = ""
        self._lines = list(lines)
        self.closed = False

    def iter_lines(self):
        for line in self._lines:
            yield line

    def close(self):
        self.closed = True


class FakeClient:
    def __init__(self, login_ok=False, responses=None):
        self.opened = []
        self.new_sessions = 0
        self.account = None
        self.login_ok = login_ok
        self.logins = 0
        self._responses = list(responses or [])

    def new_session(self):
        self.new_sessions += 1
        return "fresh-sid-%d" % self.new_sessions

    def login(self):
        self.logins += 1
        return self.login_ok

    def open_completion(self, sid, prompt, thinking, search, model_type, parent,
                        preempt, ref_file_ids=None):
        self.opened.append({"sid": sid, "parent": parent})
        if self._responses:
            return self._responses.pop(0)
        return FakeResponse()


class FakeAccount:
    id = "test@example.com"


def drive(fake_lines=(), stored_sid="dead-sid", login_ok=False, responses=None):
    if fake_lines and responses is None:
        responses = [FakeResponse(lines=fake_lines)]
    client = FakeClient(login_ok=login_ok, responses=responses)
    client.account = FakeAccount()

    saved = {k: getattr(dd, k) for k in
             ("_get_state", "_prompt_for", "_persist_cookies", "_save_sessions",
              "_sessions", "_session_lock")}
    dd._sessions = {"conv#default": {"sid": stored_sid, "parent": None, "sent": 0,
                                     "account": "test@example.com"}}
    dd._session_lock = threading.Lock()
    dd._get_state = lambda c, conv_id, force_new=False, why="", model_type=None, search=None: (
        {"sid": c.new_session() if force_new else stored_sid, "parent": None,
         "sent": 0, "account": "test@example.com"})
    dd._prompt_for = lambda messages, st: "prompt"
    dd._persist_cookies = lambda c: None
    dd._save_sessions = lambda: None

    events, error = [], None
    try:
        for ev in dd._stream_with(client, "default", False, False,
                                  [{"role": "user", "content": "hi"}],
                                  lambda: False, "conv", False, True):
            events.append(ev)
    except BaseException as e:      # noqa: BLE001 -- the test asserts on the type
        error = e
    finally:
        for k, v in saved.items():
            setattr(dd, k, v)
    return events, error, client


# The exact body the operator was shown, verbatim from the failure report.
MUTE_JSON = ('{"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted",'
             '"biz_data":{"is_muted":1,"mute_until":1790932407.459}}}')
MUTE_SSE = ("data: " + MUTE_JSON).encode("utf-8")

# ── the verdict reader itself ───────────────────────────────────────
check("_mute_verdict_in finds a bare-JSON mute",
      dd._mute_verdict_in([MUTE_JSON]) is not None,
      repr(dd._mute_verdict_in([MUTE_JSON])))
check("_mute_verdict_in finds an SSE-framed mute",
      dd._mute_verdict_in([MUTE_SSE]) is not None,
      repr(dd._mute_verdict_in([MUTE_SSE])))
check("the mute report names the message",
      "muted" in (dd._mute_verdict_in([MUTE_JSON]) or ""),
      repr(dd._mute_verdict_in([MUTE_JSON])))
check("the mute report names WHEN it lifts",
      "2026-10-02" in (dd._mute_verdict_in([MUTE_JSON]) or ""),
      repr(dd._mute_verdict_in([MUTE_JSON])))

# The nested read has to reject everything that is not a mute, or it would
# classify ordinary traffic. Each of these is a real shape seen in the wild.
check("_mute_verdict_in ignores a normal empty envelope",
      dd._mute_verdict_in(['{"code":0,"msg":"","data":null}']) is None)
check("_mute_verdict_in ignores an auth verdict",
      dd._mute_verdict_in(['{"code":40003,"msg":"Authorization Failed '
                           '(invalid token)","data":null}']) is None)
check("_mute_verdict_in ignores MISSING_HEADER",
      dd._mute_verdict_in(['{"code":40300,"msg":"MISSING_HEADER"}']) is None)
check("_mute_verdict_in ignores an empty body",
      dd._mute_verdict_in([]) is None)
check("_mute_verdict_in ignores model prose that merely says 'muted'",
      dd._mute_verdict_in(
          [b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
           b'"content":"your account was muted last week, here is why"}]}}}']) is None,
      "only a nested data.biz_msg may classify")

# The two verdicts must not be confused in EITHER direction: a mute is not a
# dead token (so no re-login), and a dead token is not a mute (so the retry
# still runs).
check("_auth_verdict_in does NOT claim the mute body",
      dd._auth_verdict_in([MUTE_JSON]) is None,
      repr(dd._auth_verdict_in([MUTE_JSON])))
check("_mute_verdict_in does NOT claim an auth body",
      dd._mute_verdict_in(['{"code":40003,"msg":"Authorization Failed '
                           '(invalid token)","data":null}']) is None)

# `_mute_of`, the parsed-envelope twin used by the pow/upload paths.
import json as _json
check("_mute_of reads the nested pair from a parsed envelope",
      dd._mute_of(_json.loads(MUTE_JSON)) == "user is muted",
      repr(dd._mute_of(_json.loads(MUTE_JSON))))
check("_mute_of ignores a parsed envelope with no mute",
      dd._mute_of({"code": 0, "msg": "", "data": None}) is None)
check("_mute_of tolerates a non-dict",
      dd._mute_of(None) is None and dd._mute_of("nope") is None)

# ── the type ────────────────────────────────────────────────────────
check("_Muted exists and is a RuntimeError",
      issubclass(dd._Muted, RuntimeError))
check("_Muted is NOT _AuthExpired",
      not issubclass(dd._Muted, dd._AuthExpired),
      "a mute answered by re-login burns a login and changes nothing")
check("_Muted is NOT _SessionStale",
      not issubclass(dd._Muted, dd._SessionStale),
      "a fresh chat is muted too, so a new chat cannot clear it")

# ── end to end: the mute must surface, and must NOT burn a re-login ──
events_m, error_m, client_m = drive(
    responses=[FakeResponse(lines=[MUTE_SSE])], login_ok=True)

check("a mute raises _Muted",
      isinstance(error_m, dd._Muted),
      "got %s: %s" % (type(error_m).__name__, error_m))
check("a mute is NOT reported as an empty response",
      not (isinstance(error_m, RuntimeError)
           and "empty response" in str(error_m).lower()),
      repr(str(error_m))[:160])
check("a mute is NOT reported as a dead credential",
      not isinstance(error_m, dd._AuthExpired),
      repr(str(error_m))[:160])
check("the mute error says the account is muted",
      "muted" in str(error_m).lower(), repr(str(error_m))[:160])
check("the mute error tells the operator re-login will not help",
      "re-log" in str(error_m).lower() or "relog" in str(error_m).lower(),
      repr(str(error_m))[:200])
check("a mute does NOT run the re-login path (even with a working login)",
      client_m.logins == 0,
      "logins=%d -- a mute is an account verdict, not a credential one" % client_m.logins)
check("a mute does NOT open a fresh chat",
      client_m.new_sessions == 0,
      "new_sessions=%d -- a fresh chat is muted too" % client_m.new_sessions)

# A mute arriving on the RETRY (after the dead-session heal) must also be
# classified, not read as an empty response.
events_r, error_r, client_r = drive(
    responses=[FakeResponse(lines=[b'data: {"code":1,"msg":"invalid chat session id"}']),
               FakeResponse(lines=[MUTE_SSE])],
    login_ok=True)
check("a mute arriving after the dead-session heal is still classified",
      isinstance(error_r, dd._Muted),
      "got %s: %s" % (type(error_r).__name__, error_r))
check("the retry's mute did not burn a re-login",
      client_r.logins == 0, "logins=%d" % client_r.logins)


print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all mute checks passed")
