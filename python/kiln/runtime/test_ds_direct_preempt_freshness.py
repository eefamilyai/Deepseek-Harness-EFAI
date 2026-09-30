# Checks that a persisted cancel only arms `preempt:true` while it is FRESH.
#
# Run from this directory:
#     .venv\Scripts\python.exe test_ds_direct_preempt_freshness.py
#
# WHY THIS EXISTS. `was_cancelled` exists so that after the user stops a
# generation, the NEXT send carries `preempt:true` and kills the server-side
# generation still running. That is a real browser behaviour -- in the moment.
# The flag is persisted and was popped on the next turn however far away that
# was, so a cancel followed by an overnight pause still sent `preempt:true` on
# the first request back. By then no stale generation exists and the browser is
# a freshly loaded page, which does not send preempt at all.
#
# The threshold is shared with `_resume_hygiene` deliberately: both guards are
# about the same thing (the first request after a long pause should not carry
# state that only made sense before the pause), so they must not drift apart.
import os
import sys
import time

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print("  %s %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  -- " + str(detail)) if detail and not cond else ""))


def main():
    now = 1_800_000_000.0          # a fixed instant; nothing here reads the clock

    # --- the thresholds themselves -------------------------------------------
    print("threshold is the shared idle gap")
    check("IDLE_RESUME_S is the derived 5400 s",
          ds.IDLE_RESUME_S == 5400.0, ds.IDLE_RESUME_S)
    check("it is strictly above one full retry storm",
          ds.IDLE_RESUME_S > ds.RATE_MAX_TRIES * 180,
          "storm=%s idle=%s" % (ds.RATE_MAX_TRIES * 180, ds.IDLE_RESUME_S))

    # --- fresh: the real use case, a user who just hit Stop -------------------
    print("fresh cancels still arm preempt")
    check("just now", ds._preempt_is_fresh(now - 1, now=now))
    check("10 s ago", ds._preempt_is_fresh(now - 10, now=now))
    check("1 min ago", ds._preempt_is_fresh(now - 60, now=now))
    check("30 min ago", ds._preempt_is_fresh(now - 1800, now=now))
    check("just under the threshold",
          ds._preempt_is_fresh(now - (ds.IDLE_RESUME_S - 1), now=now))

    # --- stale: a cancel the machine then slept on ---------------------------
    print("stale cancels are ignored")
    check("exactly at the threshold",
          not ds._preempt_is_fresh(now - ds.IDLE_RESUME_S, now=now))
    check("2 h ago", not ds._preempt_is_fresh(now - 7200, now=now))
    check("overnight (10 h)", not ds._preempt_is_fresh(now - 36000, now=now))

    # --- the storm must NOT be treated as a pause ----------------------------
    # A turn can spend an hour resending inside its own retry loop. That is work,
    # not idleness, and dropping the preempt in the middle of it would be wrong.
    print("a retry storm is not a pause")
    check("one full storm length is still fresh",
          ds._preempt_is_fresh(now - ds.RATE_MAX_TRIES * 180, now=now))

    # --- unknown / unusable ages default to FRESH ----------------------------
    # An entry written before the stamp existed has no age. Losing the flag is
    # the worse failure (a stale server generation queues behind ours), so an
    # unknown age keeps the behaviour it had.
    print("unknown age keeps the old behaviour")
    check("None -> fresh", ds._preempt_is_fresh(None, now=now))
    check("garbage string -> fresh", ds._preempt_is_fresh("not-a-time", now=now))
    check("None value -> fresh", ds._preempt_is_fresh(None, now=now))

    # --- numeric shapes that could arrive from JSON --------------------------
    print("JSON number shapes")
    check("int epoch", ds._preempt_is_fresh(int(now - 5), now=now))
    check("float epoch", ds._preempt_is_fresh(now - 5.5, now=now))
    check("a STRING number is accepted",
          ds._preempt_is_fresh(str(now - 5), now=now))
    check("a stale string number is still stale",
          not ds._preempt_is_fresh(str(now - 7200), now=now))

    failed = [c for c in CHECKS if not c[1]]
    print("\n%d check(s), %d failed" % (len(CHECKS), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
