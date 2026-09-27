#!/usr/bin/env python
"""Regression tests for ds_hif -- the refreshing ``x-hif-*`` pair.

Run:  python test_ds_hif.py

Everything here is OFFLINE: ``ds_hif.mint`` is replaced, so no request leaves the
machine. What these pin is the rule the module exists to enforce -- a captured
``x-hif-*`` value must never be replayed forever, because a real browser
re-fetches it on the lifetime the server states:

  * a minted value is used, then REUSED while it is still inside its TTL, so one
    renewal serves many requests instead of one fetch per request;
  * the TTL is the server's ``x-hif-ttl``, clamped, and the cache lapses at a
    FRACTION of it so the client never arrives holding an expired envelope;
  * a mint that fails leaves the configured value in place. Dropping the header
    or inventing a value both change the request shape, which is a louder signal
    than the stale value this is trying to avoid;
  * concurrent callers during one renewal do not each open their own fetch.

No credentials and nothing off the machine.
"""
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Point the identity at a scratch directory BEFORE importing: ds_hif imports
# ds_identity, which resolves the machine seed from there.
_SCRATCH = tempfile.mkdtemp(prefix="ds-hif-test-")
os.environ["KILN_STATE_DIR"] = _SCRATCH
os.environ["KILN_IDENTITY_DIR"] = os.path.join(_SCRATCH, "identity")

import ds_hif as h                # noqa: E402

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


# A value shaped like a real envelope: two base64 segments joined by a dot.
GOOD_A = "A" * 24 + "." + "B" * 24
GOOD_B = "C" * 24 + "." + "D" * 24


def fake_mint(value, ttl=600.0):
    """A `mint` that answers with `value` and records how often it was asked."""
    calls = []

    def _mint(host, timeout=None, session=None, dbg=None):
        calls.append(host)
        return (value, ttl) if value is not None else (None, None)

    _mint.calls = calls
    return _mint


# ── the shape check ─────────────────────────────────────────────────────────
# A SHAPE check, not a checksum: it exists to reject a truncated read, an HTML
# error page, or a stray token before one is presented as a forged envelope.
check("a well-formed envelope is accepted", h._valid(GOOD_A), repr(GOOD_A[:20]))
check("an empty value is refused", not h._valid(""))
check("a bare token with no dot is refused", not h._valid("A" * 32))
check("a too-short pair is refused", not h._valid("a.b"))
check("a value with whitespace is refused", not h._valid("AAA BBB.CCC DDD"))
check("a None value is refused", not h._valid(None))

# ── the stated TTL is taken from the header, and clamped ────────────────────
# A zero or absurd TTL would either thrash the endpoint or pin one value
# forever; both are worse than the default.
check("a missing x-hif-ttl falls back to the default",
      h._ttl_from({}) == h.DEFAULT_TTL)
check("a nonsense x-hif-ttl falls back to the default",
      h._ttl_from({"x-hif-ttl": "soon"}) == h.DEFAULT_TTL)
check("a zero x-hif-ttl falls back to the default",
      h._ttl_from({"x-hif-ttl": "0"}) == h.DEFAULT_TTL)
check("a tiny x-hif-ttl is raised to the floor",
      h._ttl_from({"x-hif-ttl": "1"}) == h.MIN_TTL,
      repr(h._ttl_from({"x-hif-ttl": "1"})))
check("an absurd x-hif-ttl is capped",
      h._ttl_from({"x-hif-ttl": "999999"}) == h.MAX_TTL,
      repr(h._ttl_from({"x-hif-ttl": "999999"})))
check("a stated TTL is honoured when it is in range",
      h._ttl_from({"x-hif-ttl": "600"}) == 600.0)
check("the TTL header is matched case-insensitively",
      h._ttl_from({"X-HIF-TTL": "300"}) == 300.0)

# ── a minted value is used, then reused ─────────────────────────────────────
h.clear()
mint = fake_mint(GOOD_A, ttl=600.0)
h.mint = mint

got = h.refresh()
check("a minted value reaches both headers",
      got.get("x-hif-leim") == GOOD_A and got.get("x-hif-dliq") == GOOD_A,
      repr({k: v[:12] for k, v in got.items()}))
check("the mint was asked for both endpoints", len(mint.calls) == 2,
      repr(mint.calls))

before = len(mint.calls)
again = h.refresh()
check("a warm cache serves the second call without a fetch",
      len(mint.calls) == before, "a renewal ran per request, not per TTL")
check("the cached call returns the same value",
      again.get("x-hif-leim") == GOOD_A)

# The cache must actually EXPIRE, or a captured value is replayed forever --
# which is the defect this module exists to remove.
with h._lock:
    for rec in h._cache.values():
        rec["expires"] = 0.0
refreshed = h.refresh()
check("a lapsed cache re-fetches",
      len(mint.calls) == before + 2,
      "an expired envelope was replayed instead of renewed")
check("the renewed value is what is returned",
      refreshed.get("x-hif-leim") == GOOD_A)

# ── force ignores the cache ─────────────────────────────────────────────────
h.clear()
mint = fake_mint(GOOD_A, ttl=600.0)
h.mint = mint
h.refresh()
before = len(mint.calls)
h.refresh(force=True)
check("force re-mints despite a warm cache",
      len(mint.calls) == before + 2,
      "a suspected value was reused instead of re-minted")

# ── a failed mint leaves what the caller had ────────────────────────────────
# NOT dropped and NOT fabricated: both change the request shape, and a changed
# shape is a louder signal than the stale value being avoided.
h.clear()
h.mint = fake_mint(None, ttl=600.0)
configured = {"x-hif-leim": GOOD_B, "x-hif-dliq": GOOD_B, "x-other": "kept"}
got = h.refresh(configured=configured)
check("a failed mint falls back to the configured value per header",
      got.get("x-hif-leim") == GOOD_B and got.get("x-hif-dliq") == GOOD_B,
      repr(got))
check("a header this module does not own is passed through",
      got.get("x-other") == "kept")
check("no fabricated value appears on a failed mint",
      set(got.values()) <= {GOOD_B, "kept"}, repr(got))

h.clear()
h.mint = fake_mint(None, ttl=600.0)
bare = h.refresh()
check("with nothing configured a failed mint omits the header rather than "
      "sending a blank one",
      "x-hif-leim" not in bare and "x-hif-dliq" not in bare, repr(bare))

# ── a renewal already in flight is not duplicated ───────────────────────────
# A burst of parallel chats must turn one lapse into ONE fetch, not N.
h.clear()
mint = fake_mint(GOOD_A, ttl=600.0)
h.mint = mint
with h._lock:
    h._fetching.add("x-hif-leim")
got = h.refresh(configured={"x-hif-leim": GOOD_B})
check("a renewal already in flight is not stacked",
      "x-hif-leim" not in mint.calls,
      "a second fetch was opened against an endpoint already being renewed")
check("the caller keeps its configured value while a renewal is in flight",
      got.get("x-hif-leim") == GOOD_B, repr(got))
h.clear()

# ── status reports origin and length, never the value ───────────────────────
h.clear()
h.mint = fake_mint(GOOD_A, ttl=600.0)
rows = h.status(configured={"x-hif-leim": GOOD_B})
by_name = {r["header"]: r for r in rows}
check("status reports both headers",
      set(by_name) == {"x-hif-leim", "x-hif-dliq"}, repr(sorted(by_name)))
check("status reports the configured origin before any mint",
      by_name["x-hif-leim"]["origin"] == "configured",
      repr(by_name["x-hif-leim"]))
check("status reports the configured length",
      by_name["x-hif-leim"]["length"] == len(GOOD_B))
check("status does not print the value",
      GOOD_B not in repr(rows) and GOOD_A not in repr(rows))
check("status reports absent when there is neither a mint nor a configuration",
      h.status()[0]["origin"] == "absent", repr(h.status()[0]))

h.refresh()
rows = h.status()
check("status reports the cached origin once a value was minted",
      rows[0]["origin"] == "cached", repr(rows[0]))
check("status reports how long the cached value lasts",
      isinstance(rows[0]["expires_in"], float) and rows[0]["expires_in"] > 0,
      repr(rows[0]))

# ── clear drops everything ──────────────────────────────────────────────────
h.clear()
check("clear empties the cache", h._cache == {})
check("clear empties the in-flight guard", h._fetching == set())
check("after clear the header is absent again",
      h.status()[0]["origin"] == "absent")

# ── the endpoints are the two real hosts ────────────────────────────────────
check("both endpoints are the real hif hosts",
      {name: host for name, host in h.ENDPOINTS} == {
          "x-hif-leim": "hif-leim.deepseek.com",
          "x-hif-dliq": "hif-dliq.deepseek.com"},
      repr(h.ENDPOINTS))
check("the refresh fraction leaves headroom before the TTL lapses",
      0.0 < h.REFRESH_FRACTION < 1.0, repr(h.REFRESH_FRACTION))

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all ds_hif checks passed")
