# Human-pace soak: sustained low-rate turns on one account, resumable across restarts.
#
# Why pace is the variable. Every previous soak ran at ~960 turns/hour and none of
# them reproduced a mute, which rules out volume-in-an-hour as sufficient. What no
# soak has ever tested is the DISTRIBUTION a person actually produces: a handful of
# turns per hour, spread across days, with long idle gaps. If account moderation
# reads sustained volume, this is the load shape that should NOT trigger it -- and
# that is exactly the hypothesis worth a multi-day run.
#
# Resumable by design, because a multi-day soak will outlive any one process: the
# turn index and conversation id are checkpointed, and a restart continues the same
# DeepSeek chat rather than opening a new one (a new chat every restart would be
# its own anomaly).
#
# A mute is a RESULT, not a failure. The run records the verdict and stops.
import json
import os
import random
import sys
import time
import traceback

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds

HERE = os.path.dirname(os.path.abspath(__file__))
LOG = os.path.join(HERE, "_humansoak.jsonl")
STATE = os.path.join(HERE, "_humansoak_state.json")

TURNS = int(os.environ.get("HS_TURNS", "200"))
DELAY_MIN = float(os.environ.get("HS_DELAY_MIN", "180"))   # 3 min
DELAY_MAX = float(os.environ.get("HS_DELAY_MAX", "600"))   # 10 min
ACCOUNT = os.environ.get("HS_ACCOUNT", "").strip()

# 3-10 min between turns is ~6-20 turns/hour: inside the range a person typing at
# a chat window produces, and an order of magnitude below what the machine soaks did.
PROMPTS = [
    "Reply with the single word: ok",
    "What is 2+2? Answer with just the number.",
    "Name one colour. One word.",
    "Say 'ready'. Nothing else.",
    "Reply with today's day name only.",
]


def load_state():
    try:
        with open(STATE, "r", encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return {}


def save_state(st):
    tmp = STATE + ".tmp"
    with open(tmp, "w", encoding="utf-8") as f:
        json.dump(st, f, indent=2)
    os.replace(tmp, STATE)


def log(**kw):
    kw["ts"] = time.time()
    with open(LOG, "a", encoding="utf-8") as f:
        f.write(json.dumps(kw, default=str) + "\n")


def verdicts_of(lines):
    out = {}
    for name, fn in (("mute", ds._mute_verdict_in),
                     ("auth", ds._auth_verdict_in),
                     ("refs", ds._ref_file_verdict_in),
                     ("biz", ds._biz_verdict_in)):
        try:
            v = fn(lines)
            if v:
                out[name] = v
        except Exception as e:  # noqa: BLE001
            out[name + "_err"] = repr(e)
    return out


def pick_account():
    """The first configured account that is NOT currently muted.

    A real probe, not a token check: `c.token` is truthy for a muted account too,
    so the earlier version would have started a "does pace cause a mute" soak on
    an account already serving a penalty and measured nothing but that penalty.
    One light turn per account settles it -- a mute answers every authenticated
    call with the verdict, on any route.
    """
    if ACCOUNT:
        return ACCOUNT
    for a in ds._accounts:
        conv = "humansoak-probe-%s" % a.id.split("@")[0].replace("+", "_")
        try:
            for _ev in ds.stream(
                    "deepseek-chat",
                    [{"role": "user", "content": "Reply with the single word: ok"}],
                    conv_id=conv, account=a.id):
                pass
            print("  probe %-34s OK - selected" % a.id)
            return a.id
        except Exception as e:  # noqa: BLE001
            first = str(e).split(".")[0]
            print("  probe %-34s %s" % (a.id, first[:70]))
    return ds._default_account_id()


def _sid_for(conv):
    """The DeepSeek session id serving this conversation, or None.

    The goal asks for the session id per turn: it is what ties a turn to the
    server-side chat that answered it, so a mute can be attributed to a specific
    chat. Read defensively -- telemetry must never break the soak.
    """
    try:
        for k, v in list(ds._sessions.items()):
            # Keys are "<conv>#<model_type>"; the separator keeps a longer conv
            # name from prefix-matching a shorter one.
            if (isinstance(k, str) and k.startswith(conv + "#")
                    and isinstance(v, dict)):
                return v.get("sid")
    except Exception:  # noqa: BLE001
        pass
    return None


def main():
    if not ds.configured():
        print("no account configured")
        return 2
    acct = pick_account()
    st = load_state()
    st.setdefault("account", acct)
    st.setdefault("conv", "humansoak-%d" % int(time.time()))
    st.setdefault("done", 0)
    st.setdefault("muted", None)
    save_state(st)

    print("human-pace soak")
    print("  account   : %s" % st["account"])
    print("  conv      : %s" % st["conv"])
    print("  resuming at turn %d of %d" % (st["done"], TURNS))
    print("  delay     : %.0f-%.0f s (~%.1f-%.1f turns/hour)"
          % (DELAY_MIN, DELAY_MAX, 3600.0 / DELAY_MAX, 3600.0 / DELAY_MIN))
    print()

    while st["done"] < TURNS:
        i = st["done"]
        prompt = random.choice(PROMPTS)
        msgs = [{"role": "user", "content": prompt}]
        raw, got, err = [], 0, None
        t0 = time.time()
        try:
            for ev in ds.stream("deepseek-chat", msgs, conv_id=st["conv"],
                                account=st["account"]):
                if ev.get("type") == "content":
                    got += len(ev.get("text") or "")
                    raw.append(ev.get("text") or "")
        except Exception as e:  # noqa: BLE001
            err = "%s: %s" % (type(e).__name__, e)
            raw = [err]
        dur = time.time() - t0

        # The goal's per-turn telemetry. `sid` ties the turn to the server-side
        # chat; `prompt_chars` records the request size; `dur_s` separates a
        # normal turn from a retry storm, which is one turn that lasts ~an hour.
        v = verdicts_of([str(x) for x in raw])
        log(turn=i, chars=got, err=err, verdicts=v, prompt=prompt,
            sid=_sid_for(st["conv"]), prompt_chars=len(prompt),
            dur_s=round(dur, 1), account=st["account"],
            reply=" ".join(str(x) for x in raw)[:400])
        print("  turn %-4d chars=%-4d %5.1fs %s"
              % (i, got, dur, ("ERR " + err[:80]) if err else "ok"))

        if v.get("mute"):
            st["muted"] = {"turn": i, "verdict": v["mute"], "ts": time.time()}
            save_state(st)
            print()
            print("MUTED at turn %d: %s" % (i, v["mute"]))
            return 3

        st["done"] = i + 1
        save_state(st)

        if st["done"] < TURNS:
            time.sleep(random.uniform(DELAY_MIN, DELAY_MAX))

    print()
    print("completed %d turns with no mute" % st["done"])
    return 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except KeyboardInterrupt:
        print("interrupted; state checkpointed, rerun to resume")
        sys.exit(130)
    except Exception:  # noqa: BLE001
        traceback.print_exc()
        sys.exit(9)
