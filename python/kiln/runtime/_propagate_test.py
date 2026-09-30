#!/usr/bin/env python3
# Does a token written by ANOTHER process reach this process's client?
#
# WHY: section 38 found two processes presenting different token generations for
# one account. The propagation machinery already exists on paper --
# `_refresh_client_creds` re-reads the config on every lease and
# `_Account.update_from` copies `token` -- so the defect is either that it does
# not fire, or that the account has nowhere to persist a token. This test decides
# which, without touching the real config.
#
# Uses a TEMP config via KILN_DS_CONFIG, so no real credential is read or written.
# Run:  .venv\Scripts\python.exe _propagate_test.py
import json
import os
import shutil
import sys
import tempfile
import time

RT = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, RT)

TMP = tempfile.mkdtemp(prefix="kiln-propagate-")
CFG = os.path.join(TMP, "ds_config.json")
os.environ["KILN_DS_CONFIG"] = CFG
os.environ["KILN_STATE_DIR"] = TMP

FAKE_A = "tok-generation-AAAA-" + "a" * 40
FAKE_B = "tok-generation-BBBB-" + "b" * 40


def write_cfg(token):
    doc = {
        "accounts": [
            {"id": "probe@example.invalid", "token": token,
             "cookie": "aws-waf-token=fake", "email": "probe@example.invalid",
             "password": "not-a-real-password"},
        ]
    }
    with open(CFG, "w", encoding="utf-8") as fh:
        json.dump(doc, fh, indent=1)
    # Force a distinct mtime even on a coarse filesystem clock.
    os.utime(CFG, (time.time() + 1, time.time() + 1))


print("=== setup ===")
write_cfg(FAKE_A)
print("  temp config :", CFG)
print("  state dir   :", TMP)

import ds_direct as ds  # noqa: E402

print()
print("=== 1. initial load ===")
ds._load_accounts(force=True)
acct = ds._account_by_id("probe@example.invalid")
print("  account found        :", acct is not None)
print("  token is generation A:", bool(acct and acct.token == FAKE_A))
print("  account.source       :", acct.source if acct else None)
print("  account.mtime        :", acct.mtime if acct else None)

print()
print("=== 2. build a client and record what it would send ===")
client = ds._Client(acct)
print("  client.token is A    :", client.token == FAKE_A)
print("  client.creds_mtime   :", client.creds_mtime)

print()
print("=== 3. ANOTHER PROCESS writes generation B to the config ===")
write_cfg(FAKE_B)
time.sleep(0.05)
print("  wrote generation B")

print()
print("=== 4. does this process's client adopt it on the next lease? ===")
ds._refresh_client_creds(client)
print("  after _refresh_client_creds:")
print("    client.token is B  :", client.token == FAKE_B)
print("    client.token is A  :", client.token == FAKE_A)

print()
print("=== 5. and the account OBJECT (what a fresh client would read)? ===")
ds._load_accounts(force=True)
acct2 = ds._account_by_id("probe@example.invalid")
print("  account.token is B   :", bool(acct2 and acct2.token == FAKE_B))

fresh = ds._Client(acct2)
print("  a FRESH client reads B:", fresh.token == FAKE_B)

print()
print("=== 6. the config signature: does mtime-only detection see the change? ===")
sig_now = ds._config_sig()
print("  _config_sig()        :", sig_now)
print("  _accounts_sig        :", ds._accounts_sig)
print("  sig tracks the change:", sig_now == ds._accounts_sig)

print()
print("=== 7. what does save() persist to, and does it round-trip? ===")
print("  before: source =", acct2.source)
acct2.save(token=FAKE_A)
on_disk = json.load(open(CFG, encoding="utf-8"))
got = on_disk["accounts"][0].get("token", "")
print("  after save(token=A): disk holds generation A:", got == FAKE_A)
print("  account.mtime after save:", acct2.mtime)

print()
print("=== VERDICT ===")
propagates = (client.token == FAKE_B)
print("  cross-process propagation via config+mtime:",
      "WORKS" if propagates else "BROKEN")

shutil.rmtree(TMP, ignore_errors=True)
