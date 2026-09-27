#!/usr/bin/env python3
"""Prove one account == one Chrome profile == one device identity, empirically.

Mints a real identity for two different accounts in a scratch identity dir and
prints, for each: the profile directory, the account record, and the identity
values. Then re-reads both to show a re-login reuses rather than re-mints.

Run:
  D:\\deepseek-kernel-harness\\python\\kiln\\runtime\\.venv\\Scripts\\python.exe ^
      .recon\\probe_two_accounts.py
"""
import json
import os
import shutil
import sys
import tempfile

RUNTIME = r"D:\deepseek-kernel-harness\python\kiln\runtime"
sys.path.insert(0, RUNTIME)

SCRATCH = tempfile.mkdtemp(prefix="two-accounts-")
os.environ["KILN_STATE_DIR"] = SCRATCH
os.environ["KILN_IDENTITY_DIR"] = os.path.join(SCRATCH, "identity")

import ds_profile as dp  # noqa: E402
import ds_identity  # noqa: E402

ACCOUNTS = ["alpha@example.com", "beta@example.com"]

print("identity dir: %s" % ds_identity.identity_dir())
print()

minted = {}
try:
    for acct in ACCOUNTS:
        print("=" * 72)
        print("account: %s" % acct)
        print("  slug        : %s" % dp.slug(acct))
        print("  profile_dir : %s" % dp.profile_dir(acct))
        print("  record      : %s" % dp.account_record_path(acct))
        doc = dp.capture_identity(acct, headless=True,
                                  on_status=lambda m: print("    ... %s" % m))
        minted[acct] = doc
        print("  device_id   : %s  (%d chars)" % (doc.get("device_id"),
                                                  len(doc.get("device_id") or "")))
        print("  x_device_id : %s" % doc.get("x_device_id"))
        print("  did         : %s" % doc.get("did"))
        print("  origin      : %s" % doc.get("origin"))
        print("  valid device_id: %s" % ds_identity.valid_device_id(doc.get("device_id")))

    print()
    print("=" * 72)
    print("CROSS-CHECK")

    slugs = [dp.slug(a) for a in ACCOUNTS]
    dirs = [dp.profile_dir(a) for a in ACCOUNTS]
    recs = [dp.account_record_path(a) for a in ACCOUNTS]
    devs = [minted[a].get("device_id") for a in ACCOUNTS]
    xdevs = [minted[a].get("x_device_id") for a in ACCOUNTS]
    dids = [minted[a].get("did") for a in ACCOUNTS]

    checks = [
        ("distinct profile directories", len(set(dirs)) == 2, dirs),
        ("distinct account records", len(set(recs)) == 2, recs),
        ("distinct device_id", len(set(devs)) == 2, devs),
        ("distinct x-device-id", len(set(xdevs)) == 2, xdevs),
        ("distinct did", len(set(dids)) == 2, dids),
        ("both device_id well-formed",
         all(ds_identity.valid_device_id(d) for d in devs), devs),
        ("both profile dirs exist on disk",
         all(os.path.isdir(d) for d in dirs), dirs),
        ("both records exist on disk",
         all(os.path.isfile(r) for r in recs), recs),
    ]
    for name, ok, detail in checks:
        print("%-34s %s" % (name, "PASS" if ok else "FAIL  %r" % (detail,)))

    # A re-read (what a re-login does) must return the SAME value, and
    # device_id_for_account is exactly the function ds_direct._device_id_for calls.
    print()
    print("re-login path (ds_profile.device_id_for_account):")
    re_read = {a: dp.device_id_for_account(a) for a in ACCOUNTS}
    for a in ACCOUNTS:
        same = re_read[a] == minted[a].get("device_id")
        print("  %-22s %s  %s" % (a, "STABLE" if same else "CHANGED", re_read[a]))

    print()
    print("identity_status:")
    for a in ACCOUNTS:
        print("  %-22s %s" % (a, dp.identity_status(a)))

    print()
    print("profiles on disk: %r" % (dp.list_profiles(),))

    ok = (len(set(dirs)) == 2 and len(set(devs)) == 2 and len(set(xdevs)) == 2
          and all(re_read[a] == minted[a].get("device_id") for a in ACCOUNTS))
    print()
    print("RESULT: %s" % ("each account has its OWN profile and identity"
                          if ok else "SHARED IDENTITY -- defect"))
    sys.exit(0 if ok else 1)
finally:
    print()
    print("scratch kept for inspection: %s" % SCRATCH)
