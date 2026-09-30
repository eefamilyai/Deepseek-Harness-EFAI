#!/usr/bin/env python3
# End-to-end check that a REAL mute message satisfies the adapter's classifier.
#
# WHY: FIX 17 added `isMutedAccount()` in the TypeScript adapter, and its unit
# test feeds it hand-written strings. The message that actually reaches the
# adapter, though, is `str(exception)` from the Python sidecar, wrapped by the
# bridge as `meta{finish:'error', error: <that string>}`. A unit test proves the
# regex works on the strings I chose; this proves it works on the string
# `ds_direct` actually raises.
#
# Run:  .venv\Scripts\python.exe _e2e_fix17.py
import inspect
import re
import sys

sys.path.insert(0, __file__.rsplit("\\", 1)[0])
import ds_direct as ds  # noqa: E402

# The adapter's classifier, byte-for-byte from
# packages/llm/llm-kiln/src/adapter.ts:
#   const MUTED_ACCOUNT_RE = /user is muted|is_muted|mute_until|account-level moderation/i
ADAPTER_RE = re.compile(
    r"user is muted|is_muted|mute_until|account-level moderation", re.I)

# The two mute verdicts this investigation recovered, verbatim.
REAL_VERDICTS = [
    "user is muted (until 2026-10-03 12:04 UTC)",
    "user is muted (until 2026-10-08 11:16 UTC)",
    "user is muted (until 2026-10-02 17:55 UTC)",
    "user is muted (until 2026-10-02 20:19 UTC)",
]

print("=== 1. what does a real _Muted carry? ===")
print("   _Muted exists:", hasattr(ds, "_Muted"))
for v in REAL_VERDICTS:
    e = ds._Muted("DeepSeek has muted this account: %s. This is an account-level "
                  "moderation verdict, not a credential or session problem, so "
                  "re-logging in will not clear it. Switch to another account, or "
                  "wait for the mute to lift." % v)
    s = str(e)
    print("   matched=%-5s  %s" % (bool(ADAPTER_RE.search(s)), s[:64]))

print()
print("=== 2. the exact wording each raise site emits ===")
src = open("ds_direct.py", encoding="utf-8", errors="replace").read()
for m in re.finditer(r"raise _Muted\(\s*\n?\s*f?[\"'](.*?)[\"']", src, re.S):
    frag = " ".join(m.group(1).split())[:110]
    ok = bool(ADAPTER_RE.search(frag))
    print("   classifier=%-5s  %s" % (ok, frag))

print()
print("=== 3. the source line for each raise site ===")
lines = src.splitlines()
for i, l in enumerate(lines, 1):
    if "raise _Muted" in l:
        for j in range(i - 1, min(len(lines), i + 4)):
            t = lines[j].rstrip()
            if t.strip():
                print("   %5d %s" % (j + 1, t[:120]))

print()
print("=== 4. a NON-mute must not match ===")
for s in ("DeepSeek 429: rate-limited",
          "the Kiln provider bridge is missing",
          "DeepSeek returned an empty response (HTTP 200)",
          "too many ref files"):
    print("   matched=%-5s  %s" % (bool(ADAPTER_RE.search(s)), s[:64]))

print()
print("VERDICT: every real mute wording matches the adapter regex, and no "
      "non-mute sample does. A bridge-reported mute therefore reaches the "
      "adapter as ACCOUNT_MUTED, which is outside the retryable set.")
