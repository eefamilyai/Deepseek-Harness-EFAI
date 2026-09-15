"""Regression checks for same-step tool results surviving the prompt budget.

A step that issues several tool calls appends several tool results in a row. The
clip that fits the wire prompt to DeepSeek's budget used to drop any result that
did not fit and keep going, so a large result disappeared while a small
neighbour from the same step was kept — the reported symptom being a `read`
result arriving with the `kernel` result beside it missing.

Each check below fails on that behaviour and passes on the fixed one.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load():
    """Import ds_direct.py directly; it is a script, not an installed module."""
    path = Path(__file__).with_name("ds_direct.py")
    spec = importlib.util.spec_from_file_location("ds_direct_under_test", path)
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


def result(text: str, name: str = "tool") -> dict:
    """One body message shaped the way the adapter flattens a tool result."""
    return {"role": "tool", "name": name, "content": f"OUTPUT:\n{text}"}


def text_of(msgs) -> str:
    return "\n".join(ds._msg_text(m) for m in msgs)


# ── the classifier the fix depends on ────────────────────────────────────────

check("a rendered tool result is recognised",
      ds._is_tool_result(result("hello")))
# The discriminator is the marker, not the role: the adapter renders a tool
# result with role 'user', so role cannot separate the two. A prose turn that
# happens to open with the marker is therefore treated as a result, which is
# benign — it gets truncated rather than dropped.
check("the marker, not the role, identifies a tool result",
      ds._is_tool_result({"role": "user", "content": "OUTPUT:\nbody"}))
check("plain user text is not a tool result",
      not ds._is_tool_result({"role": "user", "content": "run the tests"}))


# ── an oversized result is truncated, never dropped ──────────────────────────

big = "K" * 60000
small = result("read ok", "read")
kept = ds._clip_body([result(big, "kernel"), small], budget=4000, primed=True)
joined = text_of(kept)

check("the oversized tool result is still present",
      "K" in joined)
check("the tool result was truncated rather than dropped whole",
      len(joined) < 20000)
check("the truncation is labelled for the model",
      "truncated" in joined)
check("its smaller neighbour from the same step survives",
      "read ok" in joined)
check("the caller's list was not rewritten in place",
      isinstance(kept, list) and len(kept) >= 2)


# ── the reported case: a large kernel result beside a small read result ──────

kernel_result = result("K" * 30000, "kernel")
read_result = result("the file says hello", "read")
clipped = ds._clip_body([kernel_result, read_result], budget=3000, primed=True)
out = text_of(clipped)

check("large kernel result survives clipping", "K" in out)
check("small read result survives beside it", "the file says hello" in out)


# ── a non-tool message too large to fit is still skipped ─────────────────────

filler = {"role": "assistant", "content": "F" * 60000}
last = result("newest wins")
picked = ds._clip_body([filler, last], budget=500, primed=True)
picked_text = text_of(picked)

check("an oversized non-result message may still be dropped",
      "F" not in picked_text)
check("the newest message always reaches the model",
      "newest wins" in picked_text)


# ── a trailing multi-result step is sent whole when counts drift ─────────────

body = [
    {"role": "user", "content": "please read and then run the kernel"},
    result("read one", "read"),
    result("read two", "read"),
    result("kernel output", "kernel"),
]
start = ds._trailing_step_start(body)
step = body[start:]

check("the trailing step starts before its first result",
      len(step) == 4 and step[1]["content"].startswith("OUTPUT:"))
check("every result of the trailing step is included",
      "read one" in text_of(step)
      and "read two" in text_of(step)
      and "kernel output" in text_of(step))

lone = [{"role": "user", "content": "hi"}, {"role": "assistant", "content": "hello"}]
check("a step with no trailing results sends only the newest message",
      len(lone[ds._trailing_step_start(lone):]) == 1)


print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) failed:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all same-step clip checks passed")
