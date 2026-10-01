#!/usr/bin/env python3
"""FIX 25: the wirelog records only headers that go on the wire (None = removed)."""
import os, sys, tempfile, json
os.environ["KILN_STATE_DIR"] = tempfile.mkdtemp(prefix="fix25_")
os.environ["KILN_DS_WIRELOG"] = "1"
import ds_wirelog as wl
F = []
def check(n, ok, d=""):
    print("%s  %s%s" % ("PASS" if ok else "FAIL", n, "" if ok else "  -- " + str(d)))
    if not ok: F.append(n)
class R:
    status_code = 200; headers = {}; text = ""
    def json(self): return {}
class S:
    def request(self, method, url, *a, **k): return R()
s = S(); wl.install(s, account="a@x")
s.request("POST", "https://chat.deepseek.com/api/v0/chat/completion",
          headers={"accept": "*/*", "sec-fetch-user": None, "upgrade-insecure-requests": None, "x-a": "1"}, json={"k": 1})
rec = [json.loads(l) for l in open(wl._journal_path() if hasattr(wl, "_journal_path") else os.path.join(os.environ["KILN_STATE_DIR"], "ds_wirelog.jsonl"), encoding="utf-8")]
req = [r for r in rec if r.get("kind") == "request"][0]
check("a None-valued header is not journaled as sent", "sec-fetch-user" not in req["header_order"] and "upgrade-insecure-requests" not in req["header_order"], req["header_order"])
check("real headers are journaled", req["header_order"] == ["accept", "x-a"], req["header_order"])
check("header fingerprints skip them too", set(req["header_fp"]) == {"accept", "x-a"}, req["header_fp"])
if F: print("%d FAILED" % len(F)); sys.exit(1)
print("all checks passed")
