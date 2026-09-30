#!/usr/bin/env python3
# A HIGH-THROUGHPUT soak: hundreds of consecutive turns in minutes, not days.
#
# WHY THIS EXISTS
#
# The objective is to drive a test account to a mute by running HUNDREDS of
# consecutive turns. The two soaks already running cannot reach that number in any
# useful time: the t1 human-pace soak waits 180-600 s between turns (9 turns in
# 100 minutes; 400 turns would take days), and the t2 soak, though fast per turn,
# takes a 96-minute walk-away 4% of the time -- an expected ~12 such pauses over
# 300 turns, i.e. ~19 hours of doing nothing.
#
# This script is the fast lane: a short delay, NO walk-aways, and a turn count
# high enough to matter. It deliberately does NOT replace the human-pace soak --
# that one tests a different hypothesis (does realistic idle/active pacing draw a
# verdict?), and it keeps running.
#
# WHAT IT SHARES WITH THE VERIFIED SOAKS
#
#   * a mute is caught by TYPE (`isinstance(e, ds._Muted)`), because `_Muted`'s
#     message is prose and the four `*_verdict_in` readers require a parsed
#     envelope -- a soak that only read verdicts would run its whole turn count
#     through a mute and record nothing;
#   * all four verdict readers still run, so a verdict that arrives in a body the
#     caller swallowed is caught too;
#   * `KILN_DS_WIRELOG=1` makes `ds_wirelog.verdict()` write the verdict WITH its
#     own 80-entry preamble automatically;
#   * on a mute it STOPS (`return 3`) rather than hammering, so the last turn in
#     the log is the turn that drew the verdict.
#
# Run:
#   $env:SS_ACCOUNT='deepseek.ee.1+t1@gmail.com'; .venv\Scripts\python.exe _fastsoak.py
import json
import os
import random
import sys
import time

_DIR = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, _DIR)
import ds_direct as ds  # noqa: E402

# Short and neutral. The content hypothesis was falsified (findings 17.3), so
# there is nothing to gain from loaded text -- and varying the prompt keeps the
# request body from being byte-identical turn after turn.
# A stand-in for the harness's own system slot: the transport's format
# statement plus a tool catalog, at the size the real one reaches.
#
# THIS IS THE ONE ACCUMULATOR STILL STANDING. `_system_due` re-sends the
# system prompt when a chat is unprimed, when its text changes, and every
# KILN_DS_SYSTEM_EVERY turns (default 8). No earlier soak sent one at all, so
# the path never fired and the earlier 'no mute' results say nothing about it.
SYSTEM_PROMPT = "\n".join([
    "You are a coding agent in a sandboxed Windows development environment.",
    "",
    "# Calling tools",
    "",
    "You have no native tool-call channel here, so a tool call is written into your reply",
    "as a tool_calls block, in exactly this shape:",
    "",
    "<tool_calls>",
    "<invoke name=\"TOOL_NAME\">",
    "<parameter name=\"PARAMETER_NAME\">value</parameter>",
    "</invoke>",
    "</tool_calls>",
    "",
    "- One parameter per argument; its value is the raw text between the tags.",
    "- Arguments go in parameter elements, never as attributes on the invoke tag.",
    "- Every parameter listed as required must be present in every call.",
    "- A parameter typed object, array, number, integer or boolean takes JSON.",
    "- Several invoke blocks may sit inside one tool_calls block.",
    "- A tool_calls block is the ONLY thing that executes.",
    "- After emitting a block, stop and wait.",
    "",
    "# Tools available to you",
    "",
    "## read - Read a UTF-8 text file and return line-numbered content.",
    "Required parameters: file_path. Parameters: file_path, offset, limit.",
    "",
    "## write - Create or fully replace a UTF-8 text file.",
    "Required parameters: file_path, content.",
    "",
    "## edit - Edit an existing UTF-8 text file by replacing literal text.",
    "Required parameters: file_path, old_string, new_string.",
    "Parameters: file_path, old_string, new_string, replace_all.",
    "",
    "## glob - Find files whose paths match a glob pattern.",
    "Required parameters: pattern. Parameters: pattern, path.",
    "",
    "## grep - Search file contents with a ripgrep regular expression.",
    "Required parameters: pattern. Parameters: pattern, path, include.",
    "",
    "## kernel - Run Python in a persistent kernel namespace.",
    "Required parameters: code. Parameters: code, timeoutMs.",
    "",
    "## pwsh - Execute a PowerShell command and return its stdout/stderr.",
    "Required parameters: command, description.",
    "Parameters: command, description, timeoutMs, workdir, run_in_background.",
    "",
    "## todo_write - Record and update a structured task list.",
    "Required parameters: todos. Parameters: todos.",
])

PROMPTS = [
    "Reply with the single word: ok",
    "What is 2+2? Answer with just the number.",
    "Name a colour. One word only.",
    "Say 'ready'. Nothing else.",
    "What day comes after Monday? One word.",
    "Count from 1 to 3, comma separated.",
    "What is the capital of France? One word.",
    "Reply with the word: yes",
    "Give me one word: hello",
    "What is 10-3? Answer with just the number.",
]


def sid_for(conv, model_type="default", search=None):
    """The DeepSeek chat id this conversation is pinned to, or None.

    `model_type` MUST default to "default", not None. `_state_key` returns the
    bare conversation id when `model_type is None`, but `stream()` opens the chat
    under a model and keys it as `<conv>#default` -- so passing None looked up a
    key that never exists and every row logged `sid: null`. That is an
    objective-required field (the session id per turn), so the bug made the log
    silently useless for exactly the column it was there to record.

    Still defensive: the first turn may run before state exists, and a row with
    sid=None is a usable row.
    """
    try:
        key = ds._state_key(conv, model_type, search)
        with ds._session_lock:
            st = ds._sessions.get(key) or {}
            return st.get("sid")
    except Exception:  # noqa: BLE001 -- logging must never break a turn
        return None


def sys_state_for(conv, model_type="default"):
    """The chat's system-prompt bookkeeping, so the resend cadence is observable.

    `_system_due` leaves `sys_age`/`sys_hash` on the session state and
    `_note_system_sent` advances `sys_age` after each successful turn. Reading
    them back is what turns "the system prompt is re-sent every 8 turns" from a
    docstring claim into a per-turn measurement.
    """
    try:
        key = ds._state_key(conv, model_type)
        with ds._session_lock:
            st = ds._sessions.get(key) or {}
            return {"sys_hash": st.get("sys_hash"), "sys_age": st.get("sys_age"),
                    "sent": st.get("sent"), "parent": st.get("parent")}
    except Exception:  # noqa: BLE001 -- logging must never break a turn
        return {}


def verdicts_of(lines):
    """Every verdict reader's answer, so a swallowed verdict is still seen."""
    out = {}
    for name, fn in (("mute", ds._mute_verdict_in),
                     ("auth", ds._auth_verdict_in),
                     ("refs", ds._ref_file_verdict_in),
                     ("biz", ds._biz_verdict_in)):
        try:
            v = fn(lines)
            if v:
                out[name] = str(v)[:300]
        except Exception:  # noqa: BLE001
            pass
    return out


def main():
    account = os.environ.get("SS_ACCOUNT") or ds._default_account_id()
    turns = int(os.environ.get("SS_TURNS", "300"))
    delay_min = float(os.environ.get("SS_DELAY_MIN", "3"))
    delay_max = float(os.environ.get("SS_DELAY_MAX", "8"))
    conv = os.environ.get("SS_CONV") or ("syssoak-%d" % int(time.time()))
    tag = account.split("+")[-1].split("@")[0] if account else "unknown"

    log_path = os.path.join(_DIR, "_syssoak_%s.jsonl" % tag)
    state_path = os.path.join(_DIR, "_syssoak_%s_state.json" % tag)

    def save_state(st):
        try:
            tmp = state_path + ".tmp"
            with open(tmp, "w", encoding="utf-8") as f:
                json.dump(st, f, indent=2)
            os.replace(tmp, state_path)
        except Exception:  # noqa: BLE001
            pass

    def log(**kw):
        kw.setdefault("ts", time.time())
        try:
            with open(log_path, "a", encoding="utf-8") as f:
                f.write(json.dumps(kw, default=str) + "\n")
        except Exception:  # noqa: BLE001
            pass

    # Resume rather than restart when a state file exists, so a killed run can be
    # continued instead of throwing away the turns it already paid for.
    st = {"account": account, "conv": conv, "done": 0, "muted": None}
    if os.path.exists(state_path):
        try:
            with open(state_path, "r", encoding="utf-8") as f:
                prev = json.load(f)
            if prev.get("account") == account and prev.get("conv"):
                st = prev
                st.setdefault("muted", None)
        except Exception:  # noqa: BLE001
            pass
    conv = st["conv"]

    print("system-prompt soak")
    print("  account : %s" % account)
    print("  conv    : %s" % conv)
    print("  turns   : %d (from %d)" % (turns, st["done"]))
    print("  delay   : %.0f-%.0f s, NO walk-aways" % (delay_min, delay_max))
    print("  log     : %s" % log_path)
    print()

    for i in range(int(st["done"]), turns):
        prompt = random.choice(PROMPTS)
        msgs = [
            {"role": "system", "content": SYSTEM_PROMPT},
            {"role": "user", "content": prompt},
        ]
        got = 0
        raw = []
        err = None
        muted = None
        t0 = time.time()
        try:
            for ev in ds.stream("deepseek-chat", msgs, conv_id=conv, account=account):
                if ev.get("type") == "content":
                    got += len(ev.get("text") or "")
                    raw.append(ev.get("text") or "")
        except Exception as e:  # noqa: BLE001
            err = "%s: %s" % (type(e).__name__, e)
            raw = [err]
            # A mute reaches the caller as a RAISED `_Muted`; its message is prose,
            # so the readers below cannot see it. Without this check the run would
            # continue through a mute and record nothing -- exactly the result the
            # whole exercise exists to produce.
            if isinstance(e, ds._Muted):
                muted = str(e)

        dur = time.time() - t0
        v = verdicts_of([str(x) for x in raw])
        log(turn=i, chars=got, err=err, verdicts=v, muted=muted, prompt=prompt,
            prompt_chars=len(prompt),
            sys_chars=len(SYSTEM_PROMPT),
            sys_age=sys_state_for(conv).get("sys_age"),
            sys_hash=sys_state_for(conv).get("sys_hash"),
            sid=sid_for(conv), dur_s=round(dur, 2),
            account=account)
        print("  turn %-4d chars=%-5d %6.1fs %s"
              % (i, got, dur, ("ERR " + err[:70]) if err else "ok"), flush=True)

        if muted or v.get("mute"):
            verdict = muted or v["mute"]
            st["muted"] = {"turn": i, "verdict": verdict, "ts": time.time()}
            st["done"] = i + 1
            save_state(st)
            print()
            print("MUTED at turn %d: %s" % (i, verdict))
            return 3

        st["done"] = i + 1
        save_state(st)

        if st["done"] < turns:
            time.sleep(random.uniform(delay_min, delay_max))

    print()
    print("completed %d turns with no mute" % turns)
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        sys.exit(130)
