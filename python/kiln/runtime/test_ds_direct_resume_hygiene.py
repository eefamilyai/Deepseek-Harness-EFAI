# The first turn after a long idle gap must forget the stale ds_session_id.
#
# Why. The server lapses a session cookie during a pause, and a browser in that
# state has been redirected to the sign-in page -- so the first request after the
# pause carries NO session cookie. This connector used to carry the stored one
# straight into the resume request, which is the state no browser occupies. The
# captured Chrome profiles confirm the divergence: they hold `aws-waf-token`
# (persistent) and `smidV2`, but no `ds_session_id` for any account.
#
# The threshold must sit ABOVE every in-turn retry wait, because a rate-limit storm
# retries for an hour INSIDE one turn and that is not idleness. A storm must never
# trip this; an overnight gap always must.
#
# Run:  .venv\Scripts\python.exe test_ds_direct_resume_hygiene.py
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    ok = bool(cond)
    CHECKS.append((name, ok))
    line = "  %-4s %s" % ("PASS" if ok else "FAIL", name)
    if detail and not ok:
        line += "  -- " + detail
    print(line)


class FakeCookies:
    def __init__(self, d=None):
        self.d = dict(d or {})

    def set(self, k, v, **kw):
        self.d[k] = v

    def get_dict(self):
        return dict(self.d)

    def clear(self):
        self.d.clear()

    def __delitem__(self, k):
        if k not in self.d:
            raise KeyError(k)
        del self.d[k]


class FakeSess:
    def __init__(self, d=None):
        self.cookies = FakeCookies(d)


class FakeClient:
    def __init__(self, d=None):
        self.sess = FakeSess(d)


def reset():
    ds._last_turn_at.clear()


def main():
    print("=== the constant sits above every in-turn retry wait ===")
    storm_s = ds.RATE_MAX_TRIES * ds.DS_RATE_WAIT
    check("IDLE_RESUME_S > a full rate-limit storm (%.0f s)" % storm_s,
          ds.IDLE_RESUME_S > storm_s,
          "IDLE_RESUME_S=%s storm=%s" % (ds.IDLE_RESUME_S, storm_s))

    print()
    print("=== first ever turn: no baseline, nothing dropped ===")
    reset()
    c = FakeClient({"ds_session_id": "S", "aws-waf-token": "W"})
    dropped = ds._resume_hygiene(c, "a@x", now=1000.0)
    check("nothing dropped on the first turn", dropped is False, repr(dropped))
    check("the cookie is still present",
          "ds_session_id" in c.sess.cookies.get_dict())

    print()
    print("=== a turn soon after: NOT a resume, nothing dropped ===")
    reset()
    c = FakeClient({"ds_session_id": "S", "aws-waf-token": "W"})
    ds._resume_hygiene(c, "a@x", now=1000.0)
    dropped = ds._resume_hygiene(c, "a@x", now=1000.0 + 60)
    check("a 1-minute gap drops nothing", dropped is False, repr(dropped))
    check("the cookie survives",
          "ds_session_id" in c.sess.cookies.get_dict())

    print()
    print("=== a storm-length gap (1 h of retries) is NOT idleness ===")
    reset()
    c = FakeClient({"ds_session_id": "S", "aws-waf-token": "W"})
    ds._resume_hygiene(c, "a@x", now=1000.0)
    dropped = ds._resume_hygiene(c, "a@x", now=1000.0 + storm_s + 1)
    check("a 60-minute gap drops nothing", dropped is False,
          "gap=%ds" % (storm_s + 1))
    check("the cookie survives a storm-length gap",
          "ds_session_id" in c.sess.cookies.get_dict())

    print()
    print("=== a genuine long pause: the stale cookie goes ===")
    reset()
    c = FakeClient({"ds_session_id": "S", "aws-waf-token": "W"})
    ds._resume_hygiene(c, "a@x", now=1000.0)
    long_gap = ds.IDLE_RESUME_S + 60
    dropped = ds._resume_hygiene(c, "a@x", now=1000.0 + long_gap)
    jar = c.sess.cookies.get_dict()
    check("a gap past the threshold drops it", dropped is True,
          "gap=%.0fs" % long_gap)
    check("ds_session_id is GONE", "ds_session_id" not in jar, repr(jar))
    check("aws-waf-token is KEPT (WAF clearance is not a session)",
          jar.get("aws-waf-token") == "W", repr(jar))

    print()
    print("=== the threshold boundary ===")
    reset()
    c = FakeClient({"ds_session_id": "S"})
    ds._resume_hygiene(c, "a@x", now=1000.0)
    just_under = ds._resume_hygiene(c, "a@x", now=1000.0 + ds.IDLE_RESUME_S - 1)
    check("one second under the threshold drops nothing",
          just_under is False, repr(just_under))
    reset()
    c = FakeClient({"ds_session_id": "S"})
    ds._resume_hygiene(c, "a@x", now=1000.0)
    at = ds._resume_hygiene(c, "a@x", now=1000.0 + ds.IDLE_RESUME_S)
    check("exactly at the threshold drops it", at is True, repr(at))

    print()
    print("=== per-account: one account's pause is not another's ===")
    reset()
    a = FakeClient({"ds_session_id": "A"})
    b = FakeClient({"ds_session_id": "B"})
    ds._resume_hygiene(a, "a@x", now=1000.0)
    ds._resume_hygiene(b, "b@x", now=1000.0 + ds.IDLE_RESUME_S + 1)   # b is new
    check("a new account is not treated as a resume",
          "ds_session_id" in b.sess.cookies.get_dict(),
          repr(b.sess.cookies.get_dict()))
    # now a really resumes while b is fresh
    resumed = ds._resume_hygiene(a, "a@x", now=1000.0 + ds.IDLE_RESUME_S + 1)
    check("only the paused account is cleaned", resumed is True, repr(resumed))
    check("the other account's cookie is untouched",
          "ds_session_id" in b.sess.cookies.get_dict())

    print()
    print("=== robustness: a jar that cannot be edited is not fatal ===")
    reset()

    class OpaqueCookies:
        def get_dict(self):
            raise RuntimeError("unreadable")

    class OpaqueSess:
        cookies = OpaqueCookies()

    class OpaqueClient:
        sess = OpaqueSess()

    ds._resume_hygiene(OpaqueClient(), "a@x", now=1000.0)
    got = ds._resume_hygiene(OpaqueClient(), "a@x",
                             now=1000.0 + ds.IDLE_RESUME_S + 1)
    check("an unreadable jar returns False instead of raising", got is False,
          repr(got))

    reset()

    class NoSess:
        sess = None

    ds._resume_hygiene(NoSess(), "a@x", now=1000.0)
    got2 = ds._resume_hygiene(NoSess(), "a@x", now=1000.0 + ds.IDLE_RESUME_S + 1)
    check("a client with no sess returns False instead of raising",
          got2 is False, repr(got2))

    print()
    failed = [n for n, ok in CHECKS if not ok]
    print("%d check(s), %d failed" % (len(CHECKS), len(failed)))
    for n in failed:
        print("  FAILED: %s" % n)
    if not failed:
        print("ALL GREEN")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
