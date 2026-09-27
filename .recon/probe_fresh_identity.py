#!/usr/bin/env python3
"""Does a BRAND-NEW Chrome profile mint a device_id headlessly?

The one open question in the per-account identity audit. ds_direct's login
path calls ds_profile.capture_identity(headless=True) for an account that has
never been captured, and capture_identity's own docstring says headless is
the reliable path only once the SDK has had a reason to persist. If a fresh
profile yields nothing headlessly, the first login for every account silently
falls back to the machine-level device_id -- the "all my accounts look like
one device" symptom.

Redirects KILN_IDENTITY_DIR so nothing lands in the real identity dir.
"""
import json, os, sys, tempfile

RUNTIME = r"D:\deepseek-kernel-harness\python\kiln\runtime"
sys.path.insert(0, RUNTIME)

tmp = tempfile.mkdtemp(prefix="ds-idprobe-")
os.environ["KILN_IDENTITY_DIR"] = tmp
os.environ["KILN_STATE_DIR"] = tmp

import ds_identity
import ds_profile

ACCT = "probe-fresh@example.com"
folder = ds_profile.profile_dir(ACCT)

print("identity_dir :", ds_identity.identity_dir())
print("profile_dir  :", folder)
print("profile_new  :", not os.path.isdir(folder))
print(flush=True)

try:
    doc = ds_profile.capture_identity(
        ACCT, headless=True, timeout_ms=30000,
        on_status=lambda m: print("  [status]", m, flush=True))
except Exception as e:
    print()
    print("RESULT: headless capture of a FRESH profile FAILED")
    print("        %s: %s" % (type(e).__name__, e))
    print("        -> ds_direct would fall back to the machine-level device_id")
    sys.exit(0)

print()
print("RESULT: headless capture of a FRESH profile SUCCEEDED")
print(json.dumps({k: (v if k != "device_id" else "<%d chars>" % len(v))
                  for k, v in doc.items()}, indent=2, ensure_ascii=False))
