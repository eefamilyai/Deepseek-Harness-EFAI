# Classify a mute-shaped `server_error` as a mute, not as a chat message.
#
# WHY. A mute normally arrives as a bare JSON envelope with no `event:` framing,
# which `_parse` ignores entirely -- so no events are yielded, `yielded` stays
# False, and the `if not yielded:` block reaches `_mute_verdict_in`. Correct.
#
# But `_parse` ALSO emits an ("error", msg) event for a `event: hint` payload with
# `type == "error"`. That sets `server_error`, and the `if server_error:` branch
# RETURNS before the mute reader is reached:
#
#     yield {"type": "content", "text": "W DeepSeek: " + msg}   # shown as an answer
#     ...
#     if server_error:  ... return                              # <-- leaves here
#     if not yielded:
#         muted = _mute_verdict_in(raw_sink)                    # <-- never reached
#
# The turn then looks SUCCESSFUL to the harness. Nothing rotates the pool off the
# muted account, and the operator sees a chat message instead of "switch accounts".
# That is not a storm -- `_retry_kind` returns None for mute wording, so nothing
# retries -- but it does mean a muted account stays in service.
#
# The fix reads the same three tells the other four mute sites use, in the same
# order (code, then account payload, then wording), so no new vocabulary is
# introduced. A false positive is not possible from model prose: `server_error`
# only ever carries a server-issued hint message, never an answer body.
#
# Applied by script because multi-line edits kept arriving mangled.
import io
import os
import sys

TARGET = os.path.join(os.path.dirname(os.path.abspath(__file__)), "ds_direct.py")

OLD = '''        if server_error:                            # server-side refusal — surface it, no self-heal
            import sys as _sys
            print(f"[ds_direct] server error: {server_error}", file=_sys.stderr, flush=True)
            _persist_cookies(client)
            return
'''

NEW = '''        if server_error:                            # server-side refusal — surface it, no self-heal
            import sys as _sys
            # A mute can ALSO arrive as a `event: hint` payload with type=error,
            # which `_parse` turns into this `server_error`. Without this check it
            # is printed as a chat message and the turn RETURNS, so it looks
            # successful: nothing rotates the pool off an account DeepSeek has
            # already refused, and the operator sees prose instead of the verdict.
            # Read with the same three tells every other mute site uses.
            if _mute_verdict(None, server_error, None):
                _persist_cookies(client)
                ds_wirelog.verdict("mute", server_error,
                                   account=getattr(client.account, "id", None))
                raise _Muted(
                    "DeepSeek has muted this account: %s. This is an account-level "
                    "moderation verdict, not a credential or session problem, so "
                    "re-logging in will not clear it. Switch to another account, or "
                    "wait for the mute to lift." % server_error)
            print(f"[ds_direct] server error: {server_error}", file=_sys.stderr, flush=True)
            _persist_cookies(client)
            return
'''


def main():
    src = io.open(TARGET, encoding="utf-8").read()
    n = src.count(OLD)
    print("occurrences: %d" % n)
    if n == 1:
        io.open(TARGET, "w", encoding="utf-8", newline="").write(src.replace(OLD, NEW))
        print("WROTE")
    elif n == 0:
        print("already applied, or the anchor moved")
    else:
        print("AMBIGUOUS -- refusing")
    return 0


if __name__ == "__main__":
    sys.exit(main())
