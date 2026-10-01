#!/usr/bin/env python3
"""FIX 26: the opt-in settings heartbeat. Offline; run with KILN_STATE_DIR on a scratch dir."""
import contextlib, os, sys, tempfile, time
os.environ.setdefault("KILN_STATE_DIR", tempfile.mkdtemp(prefix="fix26_"))
os.environ.pop("KILN_DS_SETTINGS_POLL", None)
import ds_direct as d
F = []
def check(n, ok, det=""):
    print("%s  %s%s" % ("PASS" if ok else "FAIL", n, "" if ok else "  -- " + str(det)))
    if not ok: F.append(n)

class C:
    def __init__(self): self.calls = []
    def client_settings(self, scope="provider"): self.calls.append(scope)
@contextlib.contextmanager
def lease(acct):
    c = C(); leased.append((acct, c)); yield c
leased = []
now = time.time()
d._last_turn_at.clear()
d._last_turn_at.update({"a@x": now - 600, "old@x": now - 5 * 3600, "m@x": now - 60, "other@x": now - 30})
d._poll_accounts.update({"a@x", "old@x", "m@x"})
orig = d._muted_now
d._muted_now = lambda a, *k, **kw: a == "m@x"
sent = d._poll_once(now=now, lease=lease)
d._muted_now = orig
check("recently active account gets all four scopes in the browser's set",
      [s for a, s in sent if a == "a@x"] == list(d.SETTINGS_SCOPES) and set(d.SETTINGS_SCOPES) == {"provider", "web_upgrade", "model", "main"}, sent)
check("an account idle past the window is not polled", all(a != "old@x" for a, _ in sent), sent)
check("a muted account is not polled", all(a != "m@x" for a, _ in sent), sent)
check("an account another process drives is not polled", all(a != "other@x" for a, _ in sent), sent)
check("the cadence is the browser's 300 s", d.SETTINGS_POLL_S == 300.0)

class Boom:
    @contextlib.contextmanager
    def __call__(self, acct): raise RuntimeError("pool busy"); yield
d._last_turn_at.clear(); d._last_turn_at["a@x"] = now; d._poll_accounts.add("a@x")
try:
    r = d._poll_once(now=now, lease=Boom()); ok = r == []
except Exception as e:
    ok = False
check("a failing lease never raises out of the heartbeat", ok)

check("the heartbeat is OFF by default", d._settings_poll_enabled() is False and d._ensure_settings_poll() is False)
os.environ["KILN_DS_SETTINGS_POLL"] = "1"
d._poll_started = False
d._poll_loop_orig = d._poll_loop
d._poll_loop = lambda: None
check("KILN_DS_SETTINGS_POLL=1 starts it once", d._ensure_settings_poll("z@x") is True and d._ensure_settings_poll("z@x") is False and "z@x" in d._poll_accounts)
os.environ.pop("KILN_DS_SETTINGS_POLL")
if F: print("%d FAILED: %s" % (len(F), ", ".join(F))); sys.exit(1)
print("all checks passed")
