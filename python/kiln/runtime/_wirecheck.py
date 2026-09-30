# Read the wire journal and look for any header-shape divergence.
#
# The operator's original theory was "maybe some header is not supposed to be
# added". The journal has been recording every request's header NAMES and
# per-value FINGERPRINTS (never values) since it was built, but nobody has read
# them back. This does that:
#
#   1. Is the header NAME SET identical on every request? A divergence -- a header
#      present on one route and missing on another -- is exactly the shape the
#      theory predicts, and it would show up here as differing sets.
#   2. Does any header's FINGERPRINT change between requests? `authorization` must
#      be stable for one account; a mid-run change means a re-login happened.
#   3. Is any cookie ever EXPIRED at the moment a request is sent? This is the
#      cookie-expiry theory's direct test, and the journal records `expired` and
#      `age_s` per cookie precisely so this can be answered without inference.
#
# Read-only. Prints findings; touches no account and sends nothing.
import collections
import json
import os

HERE = os.path.dirname(os.path.abspath(__file__))
JOURNAL = os.path.join(HERE, "ds_wirelog.jsonl")


def main():
    if not os.path.exists(JOURNAL):
        print("journal absent: %s" % JOURNAL)
        return 0
    reqs = []
    with open(JOURNAL, encoding="utf-8") as f:
        for line in f:
            line = line.strip()
            if not line:
                continue
            try:
                o = json.loads(line)
            except Exception:
                continue
            if o.get("kind") == "request":
                reqs.append(o)

    print("=== %d request(s) in the journal ===" % len(reqs))
    if not reqs:
        return 0

    # --- 1. header NAME SETS ------------------------------------------------
    print()
    print("=== header name sets (a divergence would show as >1 distinct set) ===")
    sets = collections.Counter(tuple(sorted(r.get("header_order") or [])) for r in reqs)
    for names, n in sets.most_common():
        print("  x%-4d %d header(s): %s" % (n, len(names), ", ".join(names)))
    if len(sets) == 1:
        print("  -> IDENTICAL on every request: no header is added on some routes")
        print("     and missing on others.")
    else:
        print("  -> %d DISTINCT SET(S) -- inspect below" % len(sets))

    # --- 2. per-header fingerprint stability --------------------------------
    print()
    print("=== per-header fingerprint stability ===")
    by_header = collections.defaultdict(collections.Counter)
    for r in reqs:
        for k, fp in (r.get("header_fp") or {}).items():
            by_header[k][fp] += 1
    for k in sorted(by_header):
        vals = by_header[k]
        if len(vals) == 1:
            print("  %-22s STABLE   (%d request(s), 1 value)" % (k, sum(vals.values())))
        else:
            # These are supposed to vary per request; list them separately.
            tag = "VARIES"
            print("  %-22s %-8s (%d distinct value(s) over %d request(s))"
                  % (k, tag, len(vals), sum(vals.values())))

    # --- 3. cookies at send time -------------------------------------------
    print()
    print("=== cookie state at the moment each request was sent ===")
    seen = collections.Counter()
    expired_hits = []
    for r in reqs:
        for name, meta in (r.get("jar") or {}).items():
            key = (name, bool(meta.get("expired")))
            seen[key] += 1
            if meta.get("expired"):
                expired_hits.append((r.get("seq"), r.get("path"), name, meta))
    for (name, exp), n in sorted(seen.items()):
        print("  %-22s expired=%-5s  %d request(s)" % (name, exp, n))
    print()
    if expired_hits:
        print("  *** %d request(s) SENT WITH AN EXPIRED COOKIE ***" % len(expired_hits))
        for seq, path, name, meta in expired_hits[:10]:
            print("      seq=%s %s cookie=%s age_s=%s" % (seq, path, name, meta.get("age_s")))
    else:
        print("  -> NO request was ever sent with an expired cookie.")
        print("     The cookie-expiry theory predicts expired=True here; it is absent.")

    # --- 4. paths actually exercised ---------------------------------------
    print()
    print("=== paths exercised ===")
    for p, n in collections.Counter(r.get("path") for r in reqs).most_common():
        print("  x%-4d %s" % (n, p))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
