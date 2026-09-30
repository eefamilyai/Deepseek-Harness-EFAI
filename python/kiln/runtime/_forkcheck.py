# Re-run the session-overlap check with FORK detection.
#
# WHY. `_concurrent.py` reported that account `+5@gmail.com` was driven from two
# sessions at overlapping times -- the exact shape the operator's device-reuse
# suspicion predicts. But the two spans had identical boundaries to the minute,
# which is not what two independent drivers look like.
#
# The check that settles it: compare the actual event TIMESTAMPS. A session whose
# (time, account) set is a SUBSET of another's is the SAME run logged twice -- a
# fork or a copied log -- not two drivers. Only an overlap where each session has
# events the other does NOT is a genuine collision.
#
# Read-only.
import collections
import glob
import json
import os
import re
import subprocess

SESS_ROOT = r"C:\Users\eejar\.dsh\sessions"
TIME = re.compile(r'"time"\s*:\s*(\d{10,})')


def ts(v):
    f = float(v)
    return f / 1000.0 if f > 1e11 else f


def main():
    by_acct = collections.defaultdict(lambda: collections.defaultdict(set))
    logs = sorted(glob.glob(os.path.join(SESS_ROOT, "**", "session.v4.jsonl.zstd"),
                            recursive=True))
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
            by_acct[str(prov).split("@", 1)[1]][sess].add(round(ts(m.group(1)), 3))

    print("=== %d account(s) with attributable turns ===" % len(by_acct))
    print()
    real, dupes = [], []
    for acct in sorted(by_acct):
        sessmap = by_acct[acct]
        names = list(sessmap)
        if len(names) < 2:
            continue
        for i in range(len(names)):
            for j in range(i + 1, len(names)):
                A, B = sessmap[names[i]], sessmap[names[j]]
                inter = A & B
                if not inter:
                    continue
                onlyA, onlyB = A - B, B - A
                tag = "DUPLICATE (fork)" if (not onlyA or not onlyB) else "REAL OVERLAP"
                print("  %-34s %s vs %s" % (acct, names[i][:20], names[j][:20]))
                print("      %d shared, %d unique to first, %d unique to second -> %s"
                      % (len(inter), len(onlyA), len(onlyB), tag))
                if tag.startswith("REAL"):
                    real.append((acct, names[i], names[j]))
                else:
                    dupes.append((acct, names[i], names[j]))
    print()
    print("=== VERDICT ===")
    print("  duplicated (fork) pairs: %d" % len(dupes))
    print("  genuine overlap pairs : %d" % len(real))
    if real:
        print("  -> At least one account WAS driven from two sessions at overlapping")
        print("     times with distinct events. Worth investigating further.")
    else:
        print("  -> Every multi-session account is a FORKED/duplicated log, not two")
        print("     drivers. The device-reuse / double-login theory is NOT supported.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
