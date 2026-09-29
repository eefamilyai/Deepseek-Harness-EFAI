#!/usr/bin/env python
"""Regression tests for ds_direct's TOO-MANY-REFS classification and the
attachment-list bound that keeps it from recurring.

Run:  python test_ds_direct_ref_limit.py

DeepSeek refuses a completion whose `ref_file_ids` list is too long, and reports
it the way it reports a mute — inside an HTTP 200 body, one level below the
envelope, where the outer pair still says success:

    {"code":0,"msg":"","data":{"biz_code":10,"biz_msg":"too many ref file",
     "biz_data":null}}

Every reader that looks at the status or the top-level code/msg pair sees a
healthy request that streamed nothing, which is why the operator saw

    DeepSeek returned an empty response (HTTP 200): no answer and no diagnostic

while DeepSeek had said in plain words what was wrong.

Two things are pinned here, because either alone is insufficient:

  * the verdict is RECOGNISED, and reaches the same compaction path a full chat
    reaches (`_ContextFull`), so the turn heals instead of failing;
  * the list that overflows is BOUNDED, so a long conversation stops re-naming
    attachments it already handed over.

No network and no credentials: the tests drive the pure helpers and a fake
client.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ds_direct as dd

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


class NoFormatsClient:
    """A client that offers no tool-call-contract upload, so the only ids that
    can ride are the ones a caller or a spilled result supplies."""

    def upload_file(self, filename, blob):
        return None


# The exact body the operator was shown, verbatim from the failure report.
REF_JSON = ('{"code":0,"msg":"","data":{"biz_code":10,"biz_msg":"too many ref file",'
            '"biz_data":null}}')
REF_SSE = ("data: " + REF_JSON).encode("utf-8")

MUTE_JSON = ('{"code":0,"msg":"","data":{"biz_code":5,"biz_msg":"user is muted",'
             '"biz_data":{"is_muted":1,"mute_until":1790932407.459}}}')
AUTH_JSON = '{"code":40003,"msg":"Authorization Failed (invalid token)","data":null}'

# ── the verdict reader ──────────────────────────────────────────────
check("_ref_file_verdict_in finds a bare-JSON verdict",
      dd._ref_file_verdict_in([REF_JSON]) is not None,
      repr(dd._ref_file_verdict_in([REF_JSON])))
check("_ref_file_verdict_in finds an SSE-framed verdict",
      dd._ref_file_verdict_in([REF_SSE]) == "too many ref file",
      repr(dd._ref_file_verdict_in([REF_SSE])))
check("the report is the message DeepSeek sent",
      dd._ref_file_verdict_in([REF_JSON]) == "too many ref file")
check("the numeric code alone classifies, even with no message",
      dd._ref_file_verdict_in(['{"code":0,"msg":"","data":{"biz_code":10}}']) is not None,
      "biz_code 10 is the stable half of the pair")
check("an alternate phrasing classifies too",
      dd._ref_file_verdict_in(['{"code":0,"msg":"","data":'
                               '{"biz_code":10,"biz_msg":"too many files"}}']) is not None,
      "the message has drifted before; the code is the anchor")
check("a body whose data is a STRING cannot classify",
      dd._ref_file_verdict_in(['{"code":0,"msg":"","data":'
                               '"biz_code":10,"biz_msg":"too many files"}']) is None,
      "the nested pair must be an object, or the read is not the nested read")

# The nested read must reject every neighbour, or it would classify ordinary
# traffic or steal another verdict's handling.
check("it ignores a normal empty envelope",
      dd._ref_file_verdict_in(['{"code":0,"msg":"","data":null}']) is None)
check("it ignores a MUTE",
      dd._ref_file_verdict_in([MUTE_JSON]) is None,
      "a mute is biz_code 5 and must keep its own diagnosis")
check("it ignores an auth verdict",
      dd._ref_file_verdict_in([AUTH_JSON]) is None)
check("it ignores an empty body",
      dd._ref_file_verdict_in([]) is None)
check("it never classifies the model's own prose",
      dd._ref_file_verdict_in(
          [b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
           b'"content":"too many ref files were sent, here is how to avoid it"}]}}}']) is None,
      "only a parsed object with a nested data may classify")
check("_mute_verdict_in does NOT claim the ref-file body",
      dd._mute_verdict_in([REF_JSON]) is None)
check("_auth_verdict_in does NOT claim the ref-file body",
      dd._auth_verdict_in([REF_JSON]) is None)

# The parsed-envelope twin, for a route that already holds decoded JSON.
import json as _json
check("_ref_file_of reads the nested pair from a parsed envelope",
      dd._ref_file_of(_json.loads(REF_JSON)) == "too many ref file")
check("_ref_file_of ignores a parsed envelope with no verdict",
      dd._ref_file_of({"code": 0, "msg": "", "data": None}) is None)
check("_ref_file_of tolerates a non-dict",
      dd._ref_file_of(None) is None and dd._ref_file_of("nope") is None)

# ── the type it reaches ─────────────────────────────────────────────
# It must be the SAME exception a full chat raises: that is what routes it to
# the harness's compactor, which is the only thing that can shrink this.
check("_ContextFull exists and is a RuntimeError",
      issubclass(dd._ContextFull, RuntimeError))
check("_ContextFull is not _Muted",
      not issubclass(dd._ContextFull, dd._Muted),
      "a mute is answered by switching accounts; this is not")
check("_ContextFull is not _AuthExpired",
      not issubclass(dd._ContextFull, dd._AuthExpired),
      "a re-login cannot shorten an attachment list")
check("_ContextFull is not _SessionStale",
      not issubclass(dd._ContextFull, dd._SessionStale))

# The wording the harness classifies on. `isContextWindowExceededError` in
# packages/llm/llm/src/error.ts requires "context ... (length|window)
# (exceeded|overflowed|limit exceeded)" — the raise site must keep saying it.
SOURCE = open(os.path.join(os.path.dirname(os.path.abspath(__file__)),
                           "ds_direct.py"), encoding="utf-8").read()
check("the ref-file raise carries context-overflow wording",
      "context window exceeded" in SOURCE.split("_ref_file_verdict_in(raw_sink)")[1][:900],
      "without the canonical phrase the harness classifies it as a transport fault")

# ── the bound on the list ───────────────────────────────────────────
# The record is per-DeepSeek-chat, so a compaction retry starts clean.
check("a fresh sid reports nothing already sent",
      dd._ref_ids_already_sent({"sid": "s2", "ref_sent": ["a"],
                                "ref_sent_sid": "s1"}) == frozenset())
check("a matching sid reports what was sent",
      dd._ref_ids_already_sent({"sid": "s1", "ref_sent": ["a", "b"],
                                "ref_sent_sid": "s1"}) == frozenset({"a", "b"}))
check("no state at all is not an error",
      dd._ref_ids_already_sent(None) == frozenset()
      and dd._ref_ids_already_sent({}) == frozenset())

_state = {"sid": "s3"}
dd._remember_ref_ids(_state, ["x", "y", "x"])
dd._remember_ref_ids(_state, ["y", "z"])
check("_remember_ref_ids dedupes and accumulates",
      _state["ref_sent"] == ["x", "y", "z"], repr(_state.get("ref_sent")))
check("_remember_ref_ids stamps the sid it belongs to",
      _state["ref_sent_sid"] == "s3")
_empty = {"sid": "s"}
dd._remember_ref_ids(_empty, [])
check("_remember_ref_ids records nothing when there is nothing to record",
      "ref_sent" not in _empty)

_cap = {"sid": "s4"}
dd._remember_ref_ids(_cap, [str(i) for i in range(500)])
check("the record cannot grow without bound",
      len(_cap["ref_sent"]) == 200,
      "a record meant to stop unbounded growth must not become one: %d" % len(_cap["ref_sent"]))

# ── the whole point: turn 2 must not re-name turn 1's ids ───────────
_st = {"sid": "s5"}
first = dd._turn_attachment_ids(NoFormatsClient(), [], ["f1", "f2"], _st)
dd._remember_ref_ids(_st, first)
second = dd._turn_attachment_ids(NoFormatsClient(), [], ["f1", "f2"], _st)
check("turn 1 names the spilled ids",
      first == ["f1", "f2"], repr(first))
check("turn 2 names nothing already on the chat",
      second == [], "this is the accumulation the fix removes: %r" % (second,))
check("a caller's explicit ids always ride, even if seen before",
      dd._turn_attachment_ids(NoFormatsClient(), ["explicit"], ["f1"], _st) == ["explicit"],
      "the caller's instruction outranks the dedupe")
check("a new sid re-sends what a fresh chat needs",
      dd._turn_attachment_ids(NoFormatsClient(), [], ["f1", "f2"],
                              {"sid": "s6"}) == ["f1", "f2"],
      "a compacted retry opens a fresh chat, which needs the attachments again")
check("duplicates within one turn collapse",
      dd._turn_attachment_ids(NoFormatsClient(), [], ["f1", "f1", "f2"],
                              {"sid": "s7"}) == ["f1", "f2"])

# A call with no session state at all (an older caller) must keep working.
check("a call with no session state still returns the ids",
      dd._turn_attachment_ids(NoFormatsClient(), [], ["f1"]) == ["f1"],
      "the st argument is optional so an older call site cannot break")


# ── the vision chat's own attachment list ───────────────────────────
# `describe_files` drives ONE shared vision chat and calls `open_completion`
# directly, so the bound above never reaches it: every image batch adds its
# `ref_file_ids` to that chat for the life of the chat. It therefore meets the
# same biz_code 10 on its own, where the code used to fall through to
# "the vision model returned nothing" — a dead end no retry could clear.
#
# The remedy is a FRESH chat, not a compaction: unlike the main chat this one is
# a scratch pad whose history nothing depends on, so there is nothing to shrink
# and nothing to re-prime.
import threading


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
    """Serves one scripted response per completion and records every chat it
    was asked to open, so a heal can be told apart from a plain resend."""

    def __init__(self, responses=()):
        self.opened = []
        self.new_sessions = 0
        self.account = type("Acct", (), {"id": "test@example.com"})()
        self._responses = list(responses)

    def new_session(self):
        self.new_sessions += 1
        return "vision-sid-%d" % self.new_sessions

    def open_completion(self, session_id, prompt, thinking, search, model_type,
                        parent_message_id, ref_file_ids=None, **kw):
        self.opened.append({"sid": session_id, "refs": ref_file_ids})
        if self._responses:
            return self._responses.pop(0)
        return VResponse()


def run_vision(responses):
    """Run _run_vision_turn once; return (body, error, client)."""
    client = VClient(responses=responses)
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


REF_BODY = ("data: " + REF_JSON).encode("utf-8")
DESC_BODY = (b'data: {"v":{"response":{"fragments":[{"type":"RESPONSE",'
             b'"content":"described"}]}}}')

vb, ve, vc = run_vision([VResponse(lines=[REF_BODY]), VResponse(lines=[DESC_BODY])])
check("a vision chat that is full heals into a fresh one",
      ve is None and vb == "described", "body=%r error=%r" % (vb, ve))
check("the vision heal opened a SECOND chat",
      len(vc.opened) == 2 and vc.opened[0]["sid"] != vc.opened[1]["sid"],
      "a resend in the same chat would be refused identically: %r" % (vc.opened,))
check("the retried vision batch re-names its files on the fresh chat",
      vc.opened[1]["refs"] == ["fid-1"],
      "the new chat carries none of the accumulated references: %r" % (vc.opened[1],))

vb2, ve2, vc2 = run_vision([VResponse(), VResponse(lines=[DESC_BODY])])
check("an empty vision body with no verdict keeps its own diagnosis",
      isinstance(ve2, RuntimeError) and "returned nothing" in str(ve2),
      repr(str(ve2))[:140])
check("an empty vision body with no verdict does not burn a chat",
      len(vc2.opened) == 1, repr(vc2.opened))

# A refusal that is NOT about attachments must not spin a new chat per try.
vb3, ve3, vc3 = run_vision([VResponse(status_code=401)])
check("a vision 401 is still an auth failure, not a chat heal",
      isinstance(ve3, dd._AuthExpired), "got %s" % (type(ve3).__name__,))
check("a vision 401 opens no extra chat",
      len(vc3.opened) == 1, repr(vc3.opened))

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all ref-limit checks passed")
