#!/usr/bin/env python3
"""FIX 24: the completion body and the hint set match the operator's HAR capture.

Evidence: chat.deepseek.com.har -- 5 completions, every body carries NINE keys
(chat_session_id, parent_message_id, model_type, prompt, ref_file_ids,
thinking_enabled, search_enabled, action, preempt); 47 of 47 chat.deepseek.com
requests carry all nine client hints. Run from this directory with
KILN_STATE_DIR pointing at a scratch dir.
"""
import json
import os
import sys
import tempfile

os.environ.setdefault("KILN_STATE_DIR", tempfile.mkdtemp(prefix="fix24_"))
import ds_direct
import ds_hif
import ds_identity

# The real ds_hif.headers() reaches hif-*.deepseek.com; this suite is offline.
ds_hif.headers = lambda configured=None, dbg=None: {}

FAILED = []


def check(name, ok, detail=""):
    print("%s  %s%s" % ("PASS" if ok else "FAIL", name, "" if ok else "  -- " + str(detail)))
    if not ok:
        FAILED.append(name)


BROWSER_KEYS = ["chat_session_id", "parent_message_id", "model_type", "prompt",
                "ref_file_ids", "thinking_enabled", "search_enabled", "action", "preempt"]


class _Sess:
    def __init__(self):
        self.calls = []

    def post(self, url, **kw):
        self.calls.append((url, kw))
        return object()


def _client():
    c = object.__new__(ds_direct._Client)
    c.sess = _Sess()
    c.token = "tok"
    c.account = None
    c._pow = lambda: {}
    return c


def _open(**kw):
    c = _client()
    orig = ds_direct.solve_pow
    ds_direct.solve_pow = lambda ch: "powresp"
    try:
        c.open_completion("sid", "hello", True, False, "default", **kw)
    finally:
        ds_direct.solve_pow = orig
    return c.sess.calls[0][1]


kw = _open(parent_message_id=3)
body = kw["json"]
check("the body has exactly the browser's nine keys", sorted(body) == sorted(BROWSER_KEYS), sorted(body))
check("the body keys are in the browser's order", list(body) == BROWSER_KEYS, list(body))
check("action is null", body["action"] is None, repr(body["action"]))
check("preempt is present and false by default", body["preempt"] is False, repr(body.get("preempt")))
check("the body survives JSON round-trip", json.loads(json.dumps(body)) == body)
check("preempt:true is still honoured", _open(preempt=True)["json"]["preempt"] is True)
check("a first message sends parent_message_id null", _open()["json"]["parent_message_id"] is None)

h = {k.lower(): v for k, v in kw["headers"].items()}
nine = ds_identity.client_hints_full()
check("the completion carries all nine hints", all(h.get(k) == v for k, v in nine.items()),
      sorted(k for k in nine if h.get(k) != nine[k]))
check("the completion carries no navigation-only header",
      h.get("sec-fetch-user") is None and h.get("upgrade-insecure-requests") is None)

for name, hdrs in (("login", ds_direct._Client._login_headers(_client())),):
    hh = {k.lower(): v for k, v in hdrs.items()}
    check("%s carries all nine hints" % name, all(hh.get(k) == v for k, v in nine.items()))

import inspect
_hif_src = inspect.getsource(ds_hif)
check("the hif-* mint still sends the triple, not the nine",
      "client_hints()" in _hif_src and "client_hints_full" not in _hif_src)

if FAILED:
    print("%d FAILED: %s" % (len(FAILED), ", ".join(FAILED)))
    sys.exit(1)
print("all checks passed")
