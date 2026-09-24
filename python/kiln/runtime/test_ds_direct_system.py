"""Checks that a threaded DeepSeek chat holds one copy of the system prompt.

The chat keeps every prompt it is sent. Re-sending the system prompt on every
turn stored a fresh copy of the whole tool protocol each turn, which filled the
server-side conversation with copies long before the work did and took the
per-prompt budget away from the conversation. It is now sent when a chat opens,
when it changes, and every `KILN_DS_SYSTEM_EVERY` turns — and a re-primed chat
after a compaction is told the checkpoint covers what was dropped.

Run: python test_ds_direct_system.py
"""

from __future__ import annotations

import importlib.util
import os
import sys
from pathlib import Path


def _load():
    """Import ds_direct.py directly; it is a script, not an installed module."""
    path = Path(__file__).with_name("ds_direct.py")
    spec = importlib.util.spec_from_file_location("ds_direct_system_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ds = _load()

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    if condition:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}")
        FAILURES.append(label)


SYSTEM = {"role": "system", "content": "TOOL PROTOCOL " + "x" * 20000}


def conversation(turns: int) -> list[dict]:
    """The message list at turn `turns`: earlier requests and answers, then the new request."""
    out = [SYSTEM]
    for i in range(turns):
        if i > 0:
            out.append({"role": "assistant", "content": f"answer {i - 1}"})
        out.append({"role": "user", "content": f"request {i}", "pin": True})
    return out


def turn(messages: list[dict], st: dict) -> str:
    """Send one turn the way _stream_with does: build, then record success."""
    prompt = ds._prompt_for(messages, st)
    st["parent"] = "p"
    st["sent"] = len([m for m in messages if m.get("role") != "system"]) + 1
    ds._note_system_sent(st)
    return prompt


os.environ.pop("KILN_DS_SYSTEM_EVERY", None)

# ── a new chat receives the system prompt; threaded turns do not ─────────────
st: dict = {}
first = turn(conversation(1), st)
check("a new chat receives the system prompt", "TOOL PROTOCOL" in first)
second = turn(conversation(2), st)
check("the next threaded turn does not repeat it", "TOOL PROTOCOL" not in second)
check("a note says the chat already holds it", ds.SYSTEM_HELD_NOTE in second)
check("the threaded turn still carries the new request", "request 1" in second)
check("the threaded turn is small once the system prompt is not re-sent", len(second) < 1000)

# ── it is refreshed every KILN_DS_SYSTEM_EVERY turns ─────────────────────────
os.environ["KILN_DS_SYSTEM_EVERY"] = "3"
st = {}
carried = [("TOOL PROTOCOL" in turn(conversation(n), st)) for n in range(1, 8)]
check("sent on the first turn and every third turn after", carried == [True, False, False, True, False, False, True])

os.environ["KILN_DS_SYSTEM_EVERY"] = "0"
st = {}
carried = [("TOOL PROTOCOL" in turn(conversation(n), st)) for n in range(1, 4)]
check("KILN_DS_SYSTEM_EVERY=0 sends it on every turn", carried == [True, True, True])

os.environ["KILN_DS_SYSTEM_EVERY"] = "not-a-number"
check("an unreadable setting falls back to the default", ds._system_every() == 8)
os.environ.pop("KILN_DS_SYSTEM_EVERY", None)

# ── a changed system prompt is re-sent at once ───────────────────────────────
st = {}
turn(conversation(1), st)
changed = conversation(2)
changed[0] = {"role": "system", "content": "TOOL PROTOCOL v2 " + "y" * 100}
check("a changed system prompt is re-sent on the next turn", "TOOL PROTOCOL v2" in turn(changed, st))

# ── a failed send does not count as delivered ────────────────────────────────
st = {}
ds._prompt_for(conversation(1), st)          # built, but the send failed: no _note_system_sent
check("a prompt built but never sent leaves the chat without a recorded copy", "sys_hash" not in st)
check("the retry still carries the system prompt", "TOOL PROTOCOL" in ds._prompt_for(conversation(1), st))

# ── a thread reset re-primes with the system prompt ──────────────────────────
st = {}
turn(conversation(1), st)
turn(conversation(2), st)
st["parent"], st["sent"] = None, 0           # _reset_thread
check("a reset thread is re-primed with the system prompt", "TOOL PROTOCOL" in ds._prompt_for(conversation(3), st))

# ── the budget only pays for the system prompt when it is sent ───────────────
st = {}
turn(conversation(1), st)
big = conversation(2)
big.append({"role": "user", "content": "OUTPUT:\n" + "r" * 40000})
threaded = ds._prompt_for(big, st)
check("a threaded turn gives the system prompt's room to the conversation",
      "[... output truncated" not in threaded)

# ── a re-primed chat after a compaction names the checkpoint ─────────────────
checkpoint = {"role": "user", "pin": True,
              "content": "<compacted-summary>\n## Current Work\nediting a.ts\n</compacted-summary>"}
reprime = [SYSTEM, {"role": "user", "content": "old " + "o" * 60000}, checkpoint,
           {"role": "user", "content": "continue", "pin": True}]
note = ds._prompt_for(reprime, {})
check("a re-primed chat keeps the checkpoint", "<compacted-summary>" in note)
check("the omission note points at the checkpoint", "the compacted summary in this conversation covers them" in note)
plain = ds._prompt_for([SYSTEM, {"role": "user", "content": "old " + "o" * 60000},
                        {"role": "user", "content": "continue", "pin": True}], {})
check("without a checkpoint the note says the turns are unavailable", "NOT available" in plain)

if FAILURES:
    print(f"\n{len(FAILURES)} failure(s)")
    sys.exit(1)
print("\nall checks passed")
