#!/usr/bin/env python
"""Regression tests for ds_direct's EMPTY-completion handling.

Run:  python test_ds_direct_empty.py

An HTTP 200 whose body streams nothing is what DeepSeek returns for a chat it
will not serve (a dead session id, a rejected thread). Two behaviours are pinned
here, because getting either wrong produced a live outage:

  * a bare EMPTY body must heal to a FRESH chat. The dead-session detector only
    matched four literal phrases, so an empty body matched none of them and the
    heal never fired: the retry reused the same unusable session.
  * an empty completion must be reported as a FAILURE, never as success. It used
    to print a diagnostic to stderr and return normally, so the harness recorded
    a COMPLETED turn carrying no content. The goal-round driver saw a successful
    round, re-armed, and queued the next one until the goal hit its round cap --
    the conversation filled with `<goal_round>` rows and no assistant output.

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
    """An HTTP 200 that streams nothing -- DeepSeek's empty completion."""

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
    """Records the session ids it was asked to serve.

    Answers empty by default. `responses` supplies one scripted reply per call
    instead, and `login_ok` decides what a mid-stream dead-token re-login does.
    """

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
    """Run _stream_with once against a fake client; return (events, error, client).

    `fake_lines` is shorthand for a single scripted response carrying those lines
    — without it the client answers an EMPTY body, so a test that meant to feed a
    specific body through would silently exercise the empty path instead.
    """
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


# ── a bare EMPTY body must heal to a fresh chat ─────────────────────
events, error, client = drive(fake_lines=())

check("an empty completion does not return quietly",
      error is not None,
      "returned normally with events=%r" % (events,))
check("an empty completion raises RuntimeError",
      isinstance(error, RuntimeError),
      "got %s: %s" % (type(error).__name__, error))
check("the empty-completion error names the empty response",
      isinstance(error, RuntimeError) and "empty response" in str(error).lower(),
      repr(str(error))[:120])
check("the empty-completion error carries HTTP 200",
      isinstance(error, RuntimeError) and "200" in str(error),
      repr(str(error))[:120])

# The heal must have fired. The FIRST attempt legitimately probes the stored sid
# -- that request is how we discover the chat is unservable -- so the assertion is
# that a fresh chat was opened and the RETRY used it rather than the dead sid.
check("a bare empty body triggers the fresh-chat heal",
      client.new_sessions >= 1,
      "new_sessions=%d opened=%r" % (client.new_sessions, client.opened))
check("the retry after the heal does not re-serve the dead session id",
      len(client.opened) >= 2 and client.opened[-1]["sid"] != "dead-sid",
      repr(client.opened))


# ── a recognised dead-session marker keeps its existing heal ────────
events2, error2, client2 = drive(
    fake_lines=[b"data: {\"code\": 1, \"msg\": \"invalid chat session id\"}"])
check("a literal dead-session marker still heals and then fails loudly",
      isinstance(error2, RuntimeError) and client2.new_sessions >= 1,
      "error=%r new_sessions=%d" % (error2, client2.new_sessions))


# ── the detector itself: an empty body must now count as unservable ──
check("_is_dead_session does not claim an empty body by itself",
      dd._is_dead_session([]) is False,
      "the empty case is handled by the caller's `or not raw_sink` guard")


# ── a dead bearer token can arrive in the COMPLETION body ───────────
# The completion POST is a separate request from the pow solve, so a token that
# dies between the two arrives here as
# {"code":40003,"msg":"Authorization Failed (invalid token)"}. Read as an empty
# response it never runs the re-login retry, which is the same hand-relogin
# failure the pow fix removed, one request later.

AUTH_BODY = (b'data: {"code":40003,"msg":"Authorization Failed (invalid token)",'
             b'"data":null}')

# The verdict reader itself.
check("_auth_verdict_in finds an SSE-framed auth verdict",
      dd._auth_verdict_in([AUTH_BODY]) is not None,
      repr(dd._auth_verdict_in([AUTH_BODY])))
check("_auth_verdict_in finds a bare JSON auth verdict",
      dd._auth_verdict_in(['{"code":40003,"msg":"Authorization Failed (invalid token)"}'])
      is not None)
check("_auth_verdict_in does not read model prose as a verdict",
      dd._auth_verdict_in(
          [b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
           b'"content":"your invalid token was rejected, here is why"}]}}}']) is None,
      "only a parsed object with a code/msg pair may classify")
check("_auth_verdict_in ignores a non-auth verdict",
      dd._auth_verdict_in(['{"code":40300,"msg":"MISSING_HEADER"}']) is None)
check("_auth_verdict_in ignores an empty body",
      dd._auth_verdict_in([]) is None)

# End to end: with no working re-login, the verdict must surface as an AUTH
# failure, never as the generic empty-response error.
events_a, error_a, client_a = drive(
    responses=[FakeResponse(lines=[AUTH_BODY])], login_ok=False)
check("a completion-body auth verdict raises _AuthExpired",
      isinstance(error_a, dd._AuthExpired),
      "got %s: %s" % (type(error_a).__name__, error_a))
check("the completion-body auth failure is not reported as empty",
      not (isinstance(error_a, RuntimeError)
           and "empty response" in str(error_a).lower()),
      repr(str(error_a))[:140])
check("the auth verdict named the bearer token",
      isinstance(error_a, dd._AuthExpired) and "bearer token" in str(error_a),
      repr(str(error_a))[:140])
check("a failed re-login is attempted but not retried forever",
      client_a.logins == 1, "logins=%d" % client_a.logins)

# End to end: with a working re-login, the SAME chat is retried and the retry
# that succeeds is what the caller sees.
GOOD_BODY = (b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
             b'"content":"hello"}]}}}')
events_b, error_b, client_b = drive(
    login_ok=True,
    responses=[FakeResponse(lines=[AUTH_BODY]), FakeResponse(lines=[GOOD_BODY])])
check("a working re-login clears a completion-body auth verdict",
      error_b is None, "error=%r" % (error_b,))
check("the retry after a mid-stream re-login produced the answer",
      any(e.get("type") == "content" and e.get("text") == "hello" for e in events_b),
      repr(events_b))
check("the mid-stream retry kept the same chat",
      len(client_b.opened) == 2 and client_b.opened[0]["sid"] == client_b.opened[1]["sid"],
      repr(client_b.opened))
check("the mid-stream re-login happened exactly once",
      client_b.logins == 1, "logins=%d" % client_b.logins)


print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all checks passed")
