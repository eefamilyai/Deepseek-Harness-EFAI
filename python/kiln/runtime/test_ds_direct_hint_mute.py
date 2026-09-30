# Checks that a mute arriving on the `event: hint` path is classified as a mute.
#
# Run from this directory:
#     .venv\Scripts\python.exe test_ds_direct_hint_mute.py
#
# THE FAILURE THIS PINS. A mute normally arrives as a bare JSON envelope with no
# `event:` framing, which `_parse` ignores entirely -- so no events are yielded,
# `yielded` stays False, and the `if not yielded:` block reaches
# `_mute_verdict_in`. Correct.
#
# But `_parse` ALSO turns a `event: hint` payload with `type == "error"` into an
# ("error", msg) event. That sets `server_error`, and the `if server_error:` branch
# RETURNS before the mute reader is reached -- after yielding the text as chat
# content. The turn then looks SUCCESSFUL: nothing rotates the pool off an account
# DeepSeek has already refused, and the operator sees prose instead of the verdict.
#
# The checks below pin the predicate used at that site, and the ordering that makes
# it necessary. They are deliberately about the CLASSIFIER rather than the stream
# loop: the classifier is what both paths share, and it is where a wrong answer
# would come from.
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    CHECKS.append((name, bool(cond), detail))
    print("  %s %s%s" % ("PASS" if cond else "FAIL", name,
                         ("  -- " + str(detail)) if detail and not cond else ""))


def main():
    # --- the predicate the hint path now uses --------------------------------
    print("mute wording is recognised")
    for msg in ("user is muted",
                "user is muted (until 2026-10-02 13:41 UTC)",
                "you have been muted",
                "Mute",
                "MUTED"):
        check("mute: %r" % msg, ds._mute_verdict(None, msg, None) is True)

    print("transient wording is NOT a mute")
    for msg in ("Too Many Requests", "server is busy", "rate limit reached",
                "请求过于频繁", "", "try again later"):
        check("not mute: %r" % msg, not ds._mute_verdict(None, msg, None))

    # --- the reason the hint path needs its own check ------------------------
    # A mute must never be read as transient, or the retry loop would resend it.
    print("a mute is never classified transient")
    for msg in ("user is muted", "user is muted (until X)"):
        check("_retry_kind(%r) is None" % msg, ds._retry_kind(msg) is None)

    # --- and it must not be swallowed as a length limit ----------------------
    print("a mute is not a length limit")
    check("_is_length_limit('user is muted') is False",
          not ds._is_length_limit("user is muted"))

    # --- the code-only tell, with no wording at all --------------------------
    # `_mute_verdict` takes three independent tells; a bare code must be enough.
    print("the code tell alone is sufficient")
    check("code 5 is a mute", ds._mute_verdict(5, "", None) is True)
    check("code '5' is a mute", ds._mute_verdict("5", "", None) is True)
    check("code 14 is a mute (the second observed code)",
          ds._mute_verdict(14, "", None) is True)
    check("code 0 alone is not a mute", not ds._mute_verdict(0, "", None))

    # --- the account payload tell --------------------------------------------
    print("the account payload tell alone is sufficient")
    check("is_muted=1 is a mute",
          ds._mute_verdict(None, "", {"is_muted": 1}) is True)
    check("is_muted=0 is not a mute",
          not ds._mute_verdict(None, "", {"is_muted": 0}))
    check("a future mute_until is a mute",
          ds._mute_verdict(None, "", {"mute_until": 1790932407.459}) is True)
    check("mute_until=0 is not a mute",
          not ds._mute_verdict(None, "", {"mute_until": 0}))
    check("no tells at all is not a mute",
          not ds._mute_verdict(None, "", None))

    failed = [c for c in CHECKS if not c[1]]
    print("\n%d check(s), %d failed" % (len(CHECKS), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    sys.exit(main())
