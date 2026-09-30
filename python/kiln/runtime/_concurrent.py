# Was one account ever driven from TWO sessions at the same time?
#
# The operator's second suspicion: "logging into an account with a device id and
# then without properly signing out, logging back in again... a device_id is tied
# to 1 browser, so if i login then again login without signing out, theres
# definitely something suspicious."
#
# The `request/header` session event carries `config.provider`, which names the
# ACCOUNT every turn was served by. Nobody had used it to attribute turns. With
# it, every turn in every session can be placed on a timeline, and two sessions
# using ONE account at overlapping times is the exact shape that suspicion
# predicts -- one account, one device_id, two live sessions.
#
# A SECOND SESSION ON THE SAME ACCOUNT IS NORMAL if it is SEQUENTIAL (the operator
# switching chats, or the harness re-priming). It is only a signal if the ranges
# OVERLAP.
#
# Read-only. Decompresses logs and counts; touches no account.
import collections
import datetime
import glob
import json
import os
import re
import subprocess

SESS_ROOT = r"C:\Users\eejar\.dsh\sessions"
UTC = datetime.timezone.utc
TZ = datetime.timezone(datetime.timedelta(hours=8))
TIME = re.compile(r'"time"\s*:\s*(\d{10,})')

# A gap larger than this ends a session's "active span"; turns within it are one run.
SPAN_GAP_S = 1800.0


def ts(v):
    f = float(v)
    return f / 1000.0 if f > 1e11 else f


def fmt(t):
    return datetime.datetime.fromtimestamp(t, TZ).strftime("%m-%d %H:%M")


def main():
    logs = sorted(glob.glob(os.path.join(SESS_ROOT, "**", "session.v4.jsonl.zstd"),
                            recursive=True))
    # account -> list of (time, session_dir)
    hits = collections.defaultdict(list)
    for p in logs:
        r = subprocess.run(["zstd", "-d", "-c", p], capture_output=True)
        if r.returncode:
            continue
        sess = os.path.basename(os.path.dirname(p))
        for raw in r.stdout.decode("utf-8", "replace").splitlines():
            if '"type":"request/header"' not in raw:
                continue
            m = TIME.search(raw)
            if not m:
                continue
            try:
                o = json.loads(raw)
            except Exception:
                continue
            prov = (((o.get("data") or {}).get("header") or {}).get("config") or {}).get("provider")
            if not prov or not str(prov).startswith("kiln-deepseek@"):
                continue
            acct = str(prov).split("@", 1)[1]
            hits[acct].append((ts(m.group(1)), sess))

    print("=== %d account(s) seen across %d session log(s) ===" % (len(hits), len(logs)))
    print()

    overlap_any = False
    for acct in sorted(hits):
        rows = sorted(hits[acct])
        sesss = sorted({s for _, s in rows})
        print("=== %s ===" % acct)
        print("    %d request(s) across %d session(s)" % (len(rows), len(sesss)))
        # Build a span per session, splitting on large gaps.
        per = collections.defaultdict(list)
        for t, s in rows:
            per[s].append(t)
        spans = []
        for s, ts_ in per.items():
            ts_.sort()
            start = prev = ts_[0]
            for t in ts_[1:]:
                if t - prev > SPAN_GAP_S:
                    spans.append((start, prev, s))
                    start = t
                prev = t
            spans.append((start, prev, s))
        spans.sort()
        for a, b, s in spans:
            print("      %s .. %s  (%4.0f min)  %s"
                  % (fmt(a), fmt(b), (b - a) / 60.0, s[:30]))
        # Overlap check across DIFFERENT sessions.
        for i in range(len(spans)):
            for j in range(i + 1, len(spans)):
                a1, b1, s1 = spans[i]
                a2, b2, s2 = spans[j]
                if s1 == s2:
                    continue
                # Overlap if one starts before the other ends, with a tolerance of
                # one turn's duration (~2 s here) so a handoff is not a collision.
                if a2 < b1 - 60 and a1 < b2 - 60:
                    overlap_any = True
                    print("      *** OVERLAP: %s and %s both active %s..%s ***"
                          % (s1[:24], s2[:24], fmt(max(a1, a2)), fmt(min(b1, b2))))
        print()

    print("=== VERDICT ===")
    if overlap_any:
        print("  At least one account was driven from TWO sessions at overlapping")
        print("  times -- the shape the operator's device-reuse suspicion predicts.")
    else:
        print("  NO account was ever driven from two sessions at overlapping times.")
        print("  Every account's sessions are strictly SEQUENTIAL. The device-reuse")
        print("  / double-login theory is not supported by the session timeline.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
