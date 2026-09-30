#!/usr/bin/env python3
# Build _syssoak.py from _fastsoak.py by injecting a real system message.
#
# WHY: `_system_due` re-sends the system prompt when a chat is unprimed, when its
# text changes, and every KILN_DS_SYSTEM_EVERY turns (default 8). Every earlier
# soak sent `msgs = [{"role": "user", "content": prompt}]` -- no system message at
# all -- so that path never fired once, and ds_direct's own docstring names the
# consequence: the chat keeps every prompt it is sent, so a re-sent system prompt
# is stored AGAIN each turn, and a tool protocol of tens of thousands of
# characters fills the server-side conversation with copies of itself.
#
# Run:  python _mk_syssoak.py
import os
import py_compile
import re

R = os.path.dirname(os.path.abspath(__file__))
SRC = os.path.join(R, "_fastsoak.py")
DST = os.path.join(R, "_syssoak.py")

src = open(SRC, encoding="utf-8", errors="replace").read()

ANCHOR = '        msgs = [{"role": "user", "content": prompt}]'
assert src.count(ANCHOR) == 1, "the request-building anchor moved"

LINES = [
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
]

parts = ",\n".join('    "%s"' % ln.replace("\\", "\\\\").replace('"', '\\"')
                   for ln in LINES)
CONST = (
    "# A stand-in for the harness's own system slot: the transport's format\n"
    "# statement plus a tool catalog, at the size the real one reaches.\n"
    "#\n"
    "# THIS IS THE ONE ACCUMULATOR STILL STANDING. `_system_due` re-sends the\n"
    "# system prompt when a chat is unprimed, when its text changes, and every\n"
    "# KILN_DS_SYSTEM_EVERY turns (default 8). No earlier soak sent one at all, so\n"
    "# the path never fired and the earlier 'no mute' results say nothing about it.\n"
    'SYSTEM_PROMPT = "\\n".join([\n' + parts + ",\n])"
)

MARK = "PROMPTS = ["
src = src.replace(MARK, CONST + "\n\n" + MARK, 1)
src = src.replace(
    ANCHOR,
    '        msgs = [\n'
    '            {"role": "system", "content": SYSTEM_PROMPT},\n'
    '            {"role": "user", "content": prompt},\n'
    '        ]',
    1,
)

OLDLOG = ("prompt=prompt,\n            prompt_chars=len(prompt), "
          "sid=sid_for(conv), dur_s=round(dur, 2),")
if src.count(OLDLOG) == 1:
    src = src.replace(
        OLDLOG,
        "prompt=prompt,\n            prompt_chars=len(prompt),\n"
        "            sys_chars=len(SYSTEM_PROMPT),\n"
        "            sid=sid_for(conv), dur_s=round(dur, 2),", 1)

# rename the run so the two soaks never share a log or a state file
src = src.replace("_fastsoak_%s.jsonl", "_syssoak_%s.jsonl")
src = src.replace("_fastsoak_%s_state.json", "_syssoak_%s_state.json")
src = src.replace('"fastsoak-%d"', '"syssoak-%d"')
src = src.replace('print("fast soak")', 'print("system-prompt soak")')
for old, new in (("FS_ACCOUNT", "SS_ACCOUNT"), ("FS_TURNS", "SS_TURNS"),
                 ("FS_DELAY_MIN", "SS_DELAY_MIN"), ("FS_DELAY_MAX", "SS_DELAY_MAX"),
                 ("FS_CONV", "SS_CONV")):
    src = src.replace(old, new)

open(DST, "w", encoding="utf-8", newline="\n").write(src)

print("wrote %s (%d bytes)" % (DST, os.path.getsize(DST)))
try:
    py_compile.compile(DST, doraise=True)
    print("py_compile: OK")
except Exception as e:  # noqa: BLE001
    print("py_compile FAILED:", e)
    raise SystemExit(1)

t = open(DST, encoding="utf-8", errors="replace").read()
print("SYSTEM_PROMPT defined :", "SYSTEM_PROMPT = " in t)
print("system msg injected   :", '"role": "system", "content": SYSTEM_PROMPT' in t)
print("sys_chars logged      :", "sys_chars=len(SYSTEM_PROMPT)" in t)
print("own log path          :", "_syssoak_%s.jsonl" in t)
m = re.search(r'SYSTEM_PROMPT = "\\n"\.join\(\[(.*?)\n\]\)', t, re.S)
print("system prompt lines   :", m.group(1).count('",') + 1 if m else "?")
