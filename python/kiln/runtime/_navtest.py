#!/usr/bin/env python3
# What headers ACTUALLY reach the wire for a bare impersonated GET?
#
# WHY: `ds_wirelog` records only the headers a call site explicitly passed
# (`kwargs.get("headers")`). `ds_direct.py:1569` passes none, so the journal shows
# `header_order: []` -- which is a fact about the CALL SITE, not about the wire.
# curl_cffi's `impersonate=` mints a whole browser header set on its own. This
# script runs a loopback echo server so the real on-the-wire header set can be
# read directly, instead of inferred.
#
# Run:  .venv\Scripts\python.exe _navtest.py
import http.server
import json
import os
import sys
import threading

from curl_cffi import requests as cffi

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

CAPTURED = []


class H(http.server.BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.1"

    def _capture(self):
        CAPTURED.append({
            "path": self.path,
            "method": self.command,
            "headers": [[k, v] for k, v in self.headers.items()],
        })

    def _reply(self, body, ctype):
        self.send_response(200)
        self.send_header("content-type", ctype)
        self.send_header("content-length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_GET(self):
        self._capture()
        self._reply(b"ok", "text/html")

    def do_POST(self):
        n = int(self.headers.get("content-length") or 0)
        if n:
            self.rfile.read(n)
        self._capture()
        self._reply(b'{"ok":true}', "application/json")

    def log_message(self, *a):
        pass


srv = http.server.HTTPServer(("127.0.0.1", 0), H)
port = srv.server_address[1]
threading.Thread(target=srv.serve_forever, daemon=True).start()
base = "http://127.0.0.1:%d" % port

import ds_identity as di  # noqa: E402

try:
    import ds_direct as ds  # noqa: E402
    IMP = ds.IMPERSONATE
except Exception as e:  # noqa: BLE001
    IMP = "chrome120"
    print("(could not import ds_direct for IMPERSONATE: %s)" % e)

print("impersonate =", IMP)
print("ds_identity.UA =", di.UA)
print()


def show(n, title, note):
    cap = CAPTURED[-1]
    print("=" * 74)
    print("%d. %s" % (n, title))
    print("   %s" % note)
    print("=" * 74)
    for k, v in cap["headers"]:
        print("   %-28s %r" % (k, v))
    print("   -> %d headers" % len(cap["headers"]))
    print()


# ---- 1. exactly what ds_direct.py:1569 does ----
s1 = cffi.Session()
s1.get(base + "/", impersonate=IMP, timeout=10)
show(1, "BARE GET  (ds_direct.py:1569 - no headers= argument)",
     "this is the naked GET that opens every login attempt")

# ---- 2. what ds_waf._nav_headers() sends ----
NAV = None
try:
    import ds_waf  # noqa: E402
    NAV = ds_waf._nav_headers()
    s2 = cffi.Session()
    s2.get(base + "/", headers=NAV, impersonate=IMP, timeout=10)
    show(2, "NAV GET   (ds_waf._nav_headers)",
         "%d explicit headers" % len(NAV))
except Exception as e:  # noqa: BLE001
    print("ds_waf nav test failed: %s" % e)
    print()

# ---- 3. the navigation the SOLVER actually makes to / ----
try:
    s3 = cffi.Session()
    s3.get(base + "/", headers=ds_waf._nav_headers(), impersonate=IMP, timeout=10)
    show(3, "SOLVER NAV (same call the WAF solver makes)",
         "compared against #1 to see if they differ at all")
except Exception:
    pass

# ---- 4. a login POST as ds_direct builds it ----
try:
    s4 = cffi.Session()
    s4.post(base + "/api/v0/users/login", json={"email": "x", "password": "y"},
            headers=di.browser_headers(), impersonate=IMP, timeout=10)
    show(4, "LOGIN POST (browser_headers only)",
         "shows what curl_cffi adds beyond the explicit set")
except Exception as e:  # noqa: BLE001
    print("login post test failed: %s" % e)

print("=" * 74)
print("SUMMARY - header name sets")
print("=" * 74)
for i, cap in enumerate(CAPTURED, 1):
    names = sorted(k.lower() for k, _ in cap["headers"])
    print("  %d. %-5s %-30s (%d)" % (i, cap["method"], cap["path"], len(names)))
    print("       %s" % ", ".join(names))

print()
print("=" * 74)
print("DIFF: bare GET (#1) vs nav GET (#2)")
print("=" * 74)
if len(CAPTURED) >= 2:
    a = {k.lower(): v for k, v in CAPTURED[0]["headers"]}
    b = {k.lower(): v for k, v in CAPTURED[1]["headers"]}
    print("  only on bare :", sorted(set(a) - set(b)))
    print("  only on nav  :", sorted(set(b) - set(a)))
    print("  differing    :", sorted(k for k in set(a) & set(b) if a[k] != b[k]))
    for k in sorted(set(a) & set(b)):
        if a[k] != b[k]:
            print("     %-24s bare=%r" % (k, a[k][:64]))
            print("     %-24s nav =%r" % ("", b[k][:64]))
