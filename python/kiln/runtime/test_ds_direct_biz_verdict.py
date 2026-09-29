#!/usr/bin/env python
"""Regression tests for ds_direct's CATCH-ALL nested biz_code verdict.

Run:  python test_ds_direct_biz_verdict.py

Three refusals now ride one HTTP 200 body, one level below the envelope, where
the outer `code`/`msg` pair still says success:

    {"code":0,"msg":"","data":{"biz_code":5, ...}}    -> a mute       (_Muted)
    {"code":0,"msg":"","data":{"biz_code":10, ...}}   -> too many refs (_ContextFull)
    {"code":0,"msg":"","data":{"biz_code":N, ...}}    -> this file

The first two have tailored remedies. This file pins the THIRD: every other
non-success code is received, reported, and NOT retried.

Why "not retried" is the whole point. The old code answered every unrecognised
body with "DeepSeek returned an empty response (HTTP 200): no answer and no
diagnostic" and left the operator to guess. Resending is not a remedy: a code we
do not recognise is by definition one we do not know how to fix, so the resend
comes back identical. Neither is re-logging-in: an eager /users/login on a
verdict we do not understand is a login burst against an account DeepSeek is
already declining, which its anti-abuse stack escalates into a mute. So the turn
receives the verdict and fails with the code and message DeepSeek actually sent.

Pinned here, in order:
  * `_biz_verdict_of` / `_biz_verdict_in` find a code nobody has taught them;
  * they DELEGATE codes 5 and 10 to their own readers, so those keep their
    tailored handling and are not flattened into this one;
  * they reject every non-refusal (success codes, a null or string `data`, a
    non-dict, model prose);
  * end to end on the main chat and on the vision chat: NO login, no second
    request, and an error naming the code -- never the empty-response message.

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


# A code no branch has a remedy for. Deliberately one nobody has seen: the whole
# point of a catch-all is that it does not need to have seen the code before.
BIZ_JSON = ('{"code":0,"msg":"","data":{"biz_code":42,'
            '"biz_msg":"something new went wrong","biz_data":null}}')
BIZ_SSE = ("data: " + BIZ_JSON).encode("utf-8")

MUTE_JSON = ('{"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted",'
             '"biz_data":{"is_muted":1,"mute_until":1790932407.459}}}')
REF_JSON = ('{"code":0,"msg":"","data":{"biz_code":10,"biz_msg":"too many ref file",'
            '"biz_data":null}}')
AUTH_JSON = '{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}'

# ── the reader finds a code it was never taught ─────────────────────
check("_biz_verdict_in finds a bare-JSON verdict",
      dd._biz_verdict_in([BIZ_JSON]) == ("42", "something new went wrong"),
      repr(dd._biz_verdict_in([BIZ_JSON])))
check("_biz_verdict_in finds an SSE-framed verdict",
      dd._biz_verdict_in([BIZ_SSE]) == ("42", "something new went wrong"),
      repr(dd._biz_verdict_in([BIZ_SSE])))
check("the numeric code survives even with no message",
      dd._biz_verdict_in(['{"code":0,"msg":"","data":{"biz_code":42}}'])
      == ("42", "no detail"),
      "an unknown code with no message must still be reportable")
check("a code given as a NUMBER is read the same as one given as a string",
      dd._biz_verdict_in(['{"code":0,"msg":"","data":{"biz_code":"42"}}'])
      == ("42", "no detail"),
      "the wire type of biz_code has drifted before")

# ── it must DELEGATE the two codes that have their own remedy ───────
# Otherwise a mute or a full attachment list would be reported as an opaque
# "refused the request (biz_code 5)" and lose the handling built for it.
check("it does NOT claim a MUTE",
      dd._biz_verdict_in([MUTE_JSON]) is None,
      "biz_code 5 must keep its own diagnosis, not flatten into the catch-all")
check("it does NOT claim a ref-file refusal",
      dd._biz_verdict_in([REF_JSON]) is None,
      "biz_code 10 must reach _ContextFull, or the turn stops healing")
check("_mute_verdict_in still claims the mute body",
      dd._mute_verdict_in([MUTE_JSON]) is not None)
check("_ref_file_verdict_in still claims the ref-file body",
      dd._ref_file_verdict_in([REF_JSON]) is not None)

# ── and it must reject everything that is not a refusal ─────────────
check("it ignores biz_code 0",
      dd._biz_verdict_in(['{"code":0,"msg":"","data":{"biz_code":0}}']) is None,
      "0 is success, not a refusal to report")
check("it ignores a missing biz_code",
      dd._biz_verdict_in(['{"code":0,"msg":"","data":{}}']) is None)
check("it ignores a null data",
      dd._biz_verdict_in(['{"code":0,"msg":"","data":null}']) is None)
check("it ignores a body with no data key at all",
      dd._biz_verdict_in(['{"code":40300,"msg":"MISSING_HEADER"}']) is None)
check("it ignores a data that is a STRING",
      dd._biz_verdict_in(['{"code":0,"msg":"","data":'
                          '"biz_code":42,"biz_msg":"x"}']) is None,
      "the nested pair must be an object, or the read is not the nested read")
check("it ignores an auth verdict",
      dd._biz_verdict_in([AUTH_JSON]) is None,
      "a dead token has its own retry path and must not be swallowed here")
check("it ignores an empty body",
      dd._biz_verdict_in([]) is None)
check("it never classifies the model's own prose",
      dd._biz_verdict_in(
          [b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
           b'"content":"biz_code 42 means something, here is the reference"}]}}}']) is None,
      "only a parsed object with a nested data may classify")

# The parsed-envelope twin, for a route that already holds decoded JSON.
import json as _json
check("_biz_verdict_of reads the nested pair from a parsed envelope",
      dd._biz_verdict_of(_json.loads(BIZ_JSON)) == ("42", "something new went wrong"))
check("_biz_verdict_of ignores a parsed success envelope",
      dd._biz_verdict_of({"code": 0, "msg": "", "data": {"biz_code": 0}}) is None)
check("_biz_verdict_of tolerates a non-dict",
      dd._biz_verdict_of(None) is None and dd._biz_verdict_of("nope") is None)

# ── no retry, in the source itself ──────────────────────────────────
# The end-to-end checks below prove one turn does not resend. This proves WHY:
# there is no `continue` between the read and the raise, so no loop can take a
# second pass at the same verdict.
SOURCE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "ds_direct.py"), encoding="utf-8").read()
# The biz block runs from its read to the auth read that follows it. Bounded by
# those two anchors rather than a character count, so the auth retry's own
# `continue` can never leak in and read as a retry of THIS verdict.
_biz_at = SOURCE.index("_biz_verdict_in(raw_sink)")
_auth_at = SOURCE.index("_auth_verdict_in(raw_sink)", _biz_at)
_region = SOURCE[_biz_at:_auth_at]
check("the main-chat raise region contains no retry",
      "raise" in _region and "continue" not in _region,
      "a continue here is the retry the operator forbade: %r" % _region[:200])
check("the main-chat raise names the code and the message",
      "biz_code %s" in _region and "%s" in _region)
check("the account is NOT re-logged-in for the refusal",
      "client.login()" not in _region,
      "an eager login on an unrecognised verdict is the mute-rate regression")

# ── the type it reaches ─────────────────────────────────────────────
# It is a PLAIN RuntimeError on purpose, not one of the three tailored types.
# Each of those is a remedy: `_AuthExpired` enters the re-login retry, `_Muted`
# the account switch, `_ContextFull` the compactor. An unrecognised code must
# reach none of them, so the raise site must not name any of them.
check("the refusal is raised as a plain RuntimeError",
      "RuntimeError(" in _region,
      "a tailored type here would route an unknown code into a remedy for another")
check("the refusal is not raised as _AuthExpired",
      "_AuthExpired" not in _region,
      "that would enter the re-login retry the operator forbade")
check("the refusal is not raised as _Muted",
      "_Muted" not in _region,
      "that would switch accounts over an unknown code")
check("the refusal is not raised as _ContextFull",
      "_ContextFull" not in _region,
      "that would compact a chat that is not full")
check("the comment records that this is NOT retried",
      "not retried" in SOURCE.lower())

# The vision region is the text between its own read and the `break` that ends
# the loop, so the ref-heal `continue` above it cannot leak in and mask a real
# retry. Anchored on the occurrence INSIDE `_run_vision_turn`, not the first one
# in the file (which belongs to the main chat).
_vbiz_at = SOURCE.index("_biz_verdict_in(raw_sink)",
                        SOURCE.index("def _run_vision_turn"))
_vregion_end = SOURCE.index("\n        break", _vbiz_at)
_region_v = SOURCE[_vbiz_at:_vregion_end]
check("the vision raise region contains no retry",
      "raise" in _region_v and "continue" not in _region_v,
      "the vision surface must not resend either: %r" % _region_v[-200:])
check("the vision raise region names the code",
      "biz_code %s" in _region_v)
check("the vision account is NOT re-logged-in for the refusal",
      "client.login()" not in _region_v,
      "the vision surface must not earn a mute either")


# ── end to end, main chat ───────────────────────────────────────────
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


def drive(responses, login_ok=True, stored_sid="dead-sid"):
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


events_b, error_b, client_b = drive(responses=[FakeResponse(lines=[BIZ_SSE])])

check("an unknown biz_code raises",
      isinstance(error_b, RuntimeError), "got %s" % (type(error_b).__name__,))
check("it is NOT reported as an empty response",
      not (isinstance(error_b, RuntimeError)
           and "empty response" in str(error_b).lower()),
      "this is the message the fix removed: %r" % str(error_b)[:160])
check("the error names the code DeepSeek sent",
      "42" in str(error_b), repr(str(error_b))[:200])
check("the error names the message DeepSeek sent",
      "something new went wrong" in str(error_b), repr(str(error_b))[:200])
check("it is NOT an auth failure",
      not isinstance(error_b, dd._AuthExpired), repr(str(error_b))[:160])
check("it is NOT a mute",
      not isinstance(error_b, dd._Muted), repr(str(error_b))[:160])
check("it is NOT a context overflow",
      not isinstance(error_b, dd._ContextFull), repr(str(error_b))[:160])
check("the account was NOT re-logged-in",
      client_b.logins == 0,
      "logins=%d -- an eager login here is the mute-rate regression"
      % client_b.logins)
check("the turn was NOT resent",
      len(client_b.opened) == 1,
      "opened=%d -- an unrecognised verdict is not retried: %r"
      % (len(client_b.opened), client_b.opened))
check("no fresh chat was opened",
      client_b.new_sessions == 0,
      "new_sessions=%d -- a fresh chat answers the same way" % client_b.new_sessions)

# The verdict is reported on its own terms: nothing about the credential is
# touched, so no login error can replace it.
events_l, error_l, client_l = drive(responses=[FakeResponse(lines=[BIZ_SSE])],
                                    login_ok=False)
check("the verdict is reported, not a login error",
      "42" in str(error_l) and "something new went wrong" in str(error_l),
      repr(str(error_l))[:200])
check("no login was attempted even with login_ok=False",
      client_l.logins == 0, "logins=%d" % client_l.logins)


# ── end to end, the vision/attachment chat ──────────────────────────
class VResponse:
    def __init__(self, status_code=200, lines=(), text=""):
        self.status_code = status_code
        self.text = text
        self._lines = list(lines)

    def iter_lines(self):
        for line in self._lines:
            yield line

    def close(self):
        pass


class VClient:
    """Records every chat it was asked to open, so a retry (a second open) can
    be told apart from a refusal that stopped at the first."""

    def __init__(self, responses=(), login_ok=True):
        self.opened = []
        self.new_sessions = 0
        self.logins = 0
        self.login_ok = login_ok
        self.account = type("Acct", (), {"id": "test@example.com"})()
        self._responses = list(responses)

    def new_session(self):
        self.new_sessions += 1
        return "vision-sid-%d" % self.new_sessions

    def login(self):
        self.logins += 1
        return self.login_ok

    def open_completion(self, session_id, prompt, thinking, search, model_type,
                        parent_message_id, ref_file_ids=None, **kw):
        self.opened.append({"sid": session_id, "refs": ref_file_ids})
        if self._responses:
            return self._responses.pop(0)
        return VResponse()


def run_vision(responses, login_ok=True):
    """Run _run_vision_turn once; return (body, error, client)."""
    client = VClient(responses=responses, login_ok=login_ok)
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


BIZ_BODY = ("data: " + BIZ_JSON).encode("utf-8")

vb, ve, vc = run_vision([VResponse(lines=[BIZ_BODY])])
check("a vision turn with an unknown biz_code raises",
      isinstance(ve, RuntimeError), "got %s" % (type(ve).__name__,))
check("the vision error names the code",
      "42" in str(ve), repr(str(ve))[:200])
check("the vision error is NOT 'returned nothing'",
      "returned nothing" not in str(ve),
      "the verdict must replace the dead-end message: %r" % str(ve)[:160])
check("the vision error is NOT an auth failure",
      not isinstance(ve, dd._AuthExpired), repr(str(ve))[:160])
check("the vision error is NOT a context overflow",
      not isinstance(ve, dd._ContextFull),
      "an unknown code must not burn a vision chat: %r" % str(ve)[:160])
check("the vision account was NOT re-logged-in",
      vc.logins == 0, "logins=%d" % vc.logins)
check("the vision turn was NOT resent",
      len(vc.opened) == 1,
      "opened=%d -- no fresh chat, no resend: %r" % (len(vc.opened), vc.opened))
check("the vision refusal opened no extra chat",
      vc.new_sessions == 1,
      "new_sessions=%d -- 1 is the initial chat; more would be a heal"
      % vc.new_sessions)

# A refusal on the RETRY of a rejected parent must still not loop.
vb2, ve2, vc2 = run_vision([VResponse(status_code=422, text="bad parent"),
                            VResponse(lines=[BIZ_BODY])])
check("a vision refusal after the parent reset is still classified",
      "42" in str(ve2), repr(str(ve2))[:200])
check("the retry's refusal did not open a third chat",
      len(vc2.opened) == 2, repr(vc2.opened))


# ── the ACCUMULATION property: many refusals, still zero logins ──────
# The mute this fix removes was not a per-turn event -- it was a burst. One
# eager /users/login per refused turn, repeated across a session, is what the
# anti-abuse stack reads as an account being hammered. A single-turn check
# cannot see that: it passes even if the tenth turn starts logging in. So drive
# a run of refusals and assert the TOTAL stays zero. If any future change makes
# the refusal path re-authenticate, this count is what catches it.
REFUSAL_RUN = 25
_run_logins = 0
_run_opened = 0
for _i in range(REFUSAL_RUN):
    _ev, _err, _cl = drive(responses=[FakeResponse(lines=[BIZ_SSE])])
    _run_logins += _cl.logins
    _run_opened += len(_cl.opened)
check("%d consecutive refusals attempt ZERO logins in total" % REFUSAL_RUN,
      _run_logins == 0,
      "logins=%d over %d refusals -- an eager login here is the login storm "
      "that escalates a throttle into a mute" % (_run_logins, REFUSAL_RUN))
check("%d consecutive refusals each send exactly ONE request" % REFUSAL_RUN,
      _run_opened == REFUSAL_RUN,
      "opened=%d for %d refusals -- more than one means a resend"
      % (_run_opened, REFUSAL_RUN))


print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all biz-verdict checks passed")
