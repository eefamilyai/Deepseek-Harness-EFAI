# Extract the stale-preempt freshness test into a named, testable helper.
#
# The inline three-line decision could not be exercised without constructing a
# client and driving a whole turn, so the threshold went untested -- the same
# mistake the earlier IDLE_RESUME_S work already paid for once. A named helper
# puts the decision where a test can reach it, and gives the two call sites
# something to agree on.
#
# Applied by script because multi-line edits kept arriving mangled.
import io
import os
import sys

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ds_direct.py")

OLD_HELPER_ANCHOR = '''IDLE_RESUME_S = RATE_MAX_TRIES * DS_RATE_WAIT + 1800.0      # 5400 s = 90 min
'''

NEW_HELPER_ANCHOR = '''IDLE_RESUME_S = RATE_MAX_TRIES * DS_RATE_WAIT + 1800.0      # 5400 s = 90 min


def _preempt_is_fresh(cancelled_at, now=None):
    """Whether a recorded cancel is recent enough to still send `preempt:true`.

    `was_cancelled` arms a one-shot preempt on the NEXT turn, so that a user who
    stops a generation makes the following send kill the server-side generation
    still running. That is only a real browser behaviour in the moment: after a
    long pause the page is freshly loaded and no stale generation exists, so
    `preempt:true` becomes a request shape the website does not produce.

    Unknown age counts as fresh -- an entry written before this stamp existed
    must keep the behaviour it had, since losing the flag is the worse failure.
    """
    if cancelled_at is None:
        return True
    try:
        age = (time.time() if now is None else now) - float(cancelled_at)
    except (TypeError, ValueError):
        return True
    return age < IDLE_RESUME_S
'''

OLD_POP = '''        cancelled_at = st.pop("was_cancelled_at", None)
        if st.pop("was_cancelled", False):
            age = None if cancelled_at is None else (time.time() - float(cancelled_at))
            if age is None or age < IDLE_RESUME_S:
                need_preempt = True
                config.dbg("ds_direct: was_cancelled flag found for %s -> need_preempt=True", key)
            else:
                config.dbg("ds_direct: was_cancelled flag is %.0f min stale for %s -- ignored",
                           age / 60.0, key)
            _save_sessions()
'''

NEW_POP = '''        cancelled_at = st.pop("was_cancelled_at", None)
        if st.pop("was_cancelled", False):
            if _preempt_is_fresh(cancelled_at):
                need_preempt = True
                config.dbg("ds_direct: was_cancelled flag found for %s -> need_preempt=True", key)
            else:
                stale_min = (time.time() - float(cancelled_at)) / 60.0
                config.dbg("ds_direct: was_cancelled flag is %.0f min stale for %s -- ignored",
                           stale_min, key)
            _save_sessions()
'''


def main():
    src = io.open(TARGET, encoding="utf-8").read()
    for label, old, new in (("helper", OLD_HELPER_ANCHOR, NEW_HELPER_ANCHOR),
                            ("pop", OLD_POP, NEW_POP)):
        n = src.count(old)
        print("  %-7s occurrences=%d" % (label, n))
        if n != 1:
            print("  REFUSED -- nothing written")
            return 1
        src = src.replace(old, new)
    io.open(TARGET, "w", encoding="utf-8", newline="").write(src)
    print("WROTE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
