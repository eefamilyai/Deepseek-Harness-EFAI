# Honour the one-shot `was_cancelled` flag only while it is FRESH.
#
# WHY. `was_cancelled` exists so that after the user stops a generation, the next
# send carries `preempt:true` and kills the server-side generation still running.
# That is a real browser behaviour -- but only in the moment it happens. The flag
# is PERSISTED and popped on the NEXT turn however far away that is, so a cancel
# followed by an overnight pause still sends `preempt:true` on the first request
# back. By then the stale generation is long finished and the browser is a freshly
# loaded page, which is not a state that sends preempt at all. That makes the
# first request after a long pause a request shape the website does not produce --
# the same class of staleness as the session cookie `_resume_hygiene` already
# guards, on the same pause, so the two now agree about what "a long pause" means.
#
# A PRECAUTION, not a measured mute cause -- recorded as such. It cannot be
# evidenced from the existing logs, because the flag's value is not logged.
#
# Applied by script because multi-line edits kept arriving mangled.
import io
import os
import sys

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ds_direct.py")

OLD_POP = '''        if st.pop("was_cancelled", False):
            need_preempt = True
            config.dbg("ds_direct: was_cancelled flag found for %s \u2192 need_preempt=True", key)
            _save_sessions()
'''

NEW_POP = '''        # One-shot, and honoured only while FRESH. After a long pause the browser
        # is a freshly loaded page, not a page mid-cancel, so `preempt:true` on the
        # first request back is a shape the website does not produce. Same
        # idle-gap threshold as `_resume_hygiene`, so both guards agree.
        cancelled_at = st.pop("was_cancelled_at", None)
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

OLD_SET = '''                    st["was_cancelled"] = True
                    _sessions[key] = st
'''

NEW_SET = '''                    st["was_cancelled"] = True
                    # Stamped so the next turn can tell "just cancelled" from
                    # "cancelled, then the machine sat idle overnight".
                    st["was_cancelled_at"] = time.time()
                    _sessions[key] = st
'''


def main():
    src = io.open(TARGET, encoding="utf-8").read()
    for label, old, new in (("pop", OLD_POP, NEW_POP), ("set", OLD_SET, NEW_SET)):
        n = src.count(old)
        print("  %-4s occurrences=%d" % (label, n))
        if n != 1:
            print("  REFUSED -- nothing written")
            return 1
        src = src.replace(old, new)
    io.open(TARGET, "w", encoding="utf-8", newline="").write(src)
    print("WROTE")
    return 0


if __name__ == "__main__":
    sys.exit(main())
