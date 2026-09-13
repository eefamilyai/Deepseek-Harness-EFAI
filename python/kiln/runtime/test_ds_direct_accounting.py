#!/usr/bin/env python
"""Regression tests for ds_direct's chat-prompt ACCOUNTING.

Run:  python test_ds_direct_accounting.py

DeepSeek threads every turn onto ONE server-side chat, and that chat keeps the
model's own reasoning alongside its answers. `_prompt_for` sends only the
per-turn delta, so the wire prompt deliberately omits reasoning the chat already
holds -- but `_full_conversation_prompt` reconstructs the chat itself, to diff
against the previous turn for prefix caching and to price the turn's usage. It
used `_msg_text`, which extracts only `text` blocks, so the reconstruction
priced the chat at roughly half of what DeepSeek was actually holding: over one
long session the visible text and tool traffic came to ~6.9M characters while
the reasoning blocks alone came to ~5.1M more.

The harness trusts that usage number as its context occupancy, and the
compaction threshold is a fraction of it, so the undercount made the harness
believe a chat was comfortable while DeepSeek was already refusing turns on it
with a "length limit" hint. The fix prices the blocks the chat actually holds
without changing what goes on the wire.

No network and no credentials.
"""
import json
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

import ds_direct as dd

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


REASONING = "deliberation " * 40          # 480 chars
ANSWER = "the answer"
TOOL_BLOCK = {"type": "tool-call", "name": "kernel", "arguments": '{"code":"x"}'}
TEXT_BLOCK = {"type": "text", "text": ANSWER}
REASONING_BLOCK = {"type": "reasoning", "text": REASONING}


def assistant_msg(blocks):
    return {"role": "assistant", "content": blocks}


# ── the wire prompt must keep omitting reasoning ────────────────────────────
wire = dd.messages_to_prompt([assistant_msg([REASONING_BLOCK, TEXT_BLOCK])])
check("wire prompt omits reasoning", REASONING not in wire,
      "reasoning must not be re-sent as input")
check("wire prompt still carries the answer", ANSWER in wire)

# A plain-string message is unaffected on either path.
plain = [{"role": "user", "content": "hello"}]
check("plain string unchanged on wire",
      dd.messages_to_prompt(plain) == dd.messages_to_prompt(plain, text_of=dd._msg_text_accounting))

# ── the accounting renderer must price the whole chat ───────────────────────
check("accounting renderer exists", hasattr(dd, "_msg_text_accounting"))
acct = dd.messages_to_prompt([assistant_msg([REASONING_BLOCK, TEXT_BLOCK])],
                             text_of=dd._msg_text_accounting)
check("accounting prices reasoning", REASONING in acct)
check("accounting prices the answer", ANSWER in acct)

# Reasoning must make the accounting reconstruction strictly larger.
wire_len = len(wire)
acct_len = len(acct)
check("accounting is larger than the wire prompt", acct_len > wire_len,
      "wire=%d accounting=%d" % (wire_len, acct_len))

# ── non-text blocks are priced structurally, not silently dropped ───────────
acct_tool = dd.messages_to_prompt([assistant_msg([TOOL_BLOCK])],
                                  text_of=dd._msg_text_accounting)
check("accounting keeps non-text blocks", '"kernel"' in acct_tool or "kernel" in acct_tool,
      "a dropped block undercounts the chat")

# ── the reconstruction is what the fix routes through ──────────────────────
chat = dd._full_conversation_prompt([assistant_msg([REASONING_BLOCK, TEXT_BLOCK])])
check("_full_conversation_prompt prices reasoning", REASONING in chat,
      "this is the function _turn_usage diffs for the reported usage")

# A system prompt still rides along, and env blocks still do not.
with_env = dd._full_conversation_prompt([
    {"role": "system", "content": "SYS"},
    {"role": "assistant", "kind": "env", "content": "VOLATILE"},
    assistant_msg([REASONING_BLOCK]),
])
check("chat reconstruction keeps the system prompt", "SYS" in with_env)
check("chat reconstruction drops the env tail", "VOLATILE" not in with_env)

# ── sizing: reasoning must dominate for a reasoning-heavy turn ─────────────
heavy = [assistant_msg([{"type": "reasoning", "text": "t" * 4000},
                        {"type": "text", "text": "ok"}])]
heavy_wire = len(dd.messages_to_prompt(heavy))
heavy_acct = len(dd.messages_to_prompt(heavy, text_of=dd._msg_text_accounting))
check("reasoning-heavy turn is priced far higher", heavy_acct >= heavy_wire * 5,
      "wire=%d accounting=%d" % (heavy_wire, heavy_acct))

# ── malformed blocks must not raise ────────────────────────────────────────
try:
    dd.messages_to_prompt([assistant_msg([None, "bare", {"type": "text"}])],
                          text_of=dd._msg_text_accounting)
    check("accounting tolerates malformed blocks", True)
except Exception as exc:                                   # noqa: BLE001
    check("accounting tolerates malformed blocks", False, repr(exc))

print()
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all accounting checks passed")
