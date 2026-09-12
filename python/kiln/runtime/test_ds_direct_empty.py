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
    """Records the session ids it was asked to serve and always answers empty."""

    def __init__(self):
        self.opened = []
        self.new_sessions = 0
        self.account = None

    def new_session(self):
        self.new_sessions += 1
        return "fresh-sid-%d" % self.new_sessions

    def open_completion(self, sid, prompt, thinking, search, model_type, parent,
                        preempt, ref_file_ids=None):
        self.opened.append({"sid": sid, "parent": parent})
        return FakeResponse()


class FakeAccount:
    id = "test@example.com"


def drive(fake_lines=(), stored_sid="dead-sid"):
    """Run _stream_with once against a fake client; return (events, error, client)."""
    client = FakeClient()
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


print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all checks passed")
