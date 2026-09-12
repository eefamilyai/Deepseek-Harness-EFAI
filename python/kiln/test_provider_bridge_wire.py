#!/usr/bin/env python
"""Regression tests for provider_bridge's stdout wire encoding.

Run:  python test_provider_bridge_wire.py

Everything here is OFFLINE and needs no credentials. It pins one property that
a Windows install can silently break:

  A frame written to stdout must be pure ASCII.

The harness reads the bridge's stdout as UTF-8 (packages/llm/llm-kiln/src/
bridge.ts calls `setEncoding('utf8')`). Python, left alone, encodes stdout with
whatever the host console declares -- on Windows that is the ANSI codepage,
often cp1252. Under cp1252 a MIDDLE DOT in a model label is written as the
single byte 0xB7, which is not valid UTF-8; the harness replaces it with U+FFFD,
and the model picker shows a diamond with a question mark where the separator
should be. Escaping non-ASCII to \\uXXXX keeps every frame ASCII, so the bytes
are identical under every codepage and decode back to the same text.

The tests run the real writer under several forced stdout codepages. That is the
only way to exercise the failure: this machine's own default is UTF-8, which is
exactly why the defect appeared on a second machine and not here.
"""
import io
import json
import os
import subprocess
import sys

HERE = os.path.dirname(os.path.abspath(__file__))

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


# A label carrying the separator the picker actually renders, plus a CJK name
# and an em dash, so the property is pinned for more than the one character that
# was reported.
SAMPLE = {
    "id": 7,
    "ok": True,
    "name": "DeepSeek \u00b7 Thinking + Search",
    "cjk": "\u6df1\u5ea6\u6c42\u7d22",
    "dash": "a \u2014 b",
}

# The frame body the bridge writes, extracted from the module so the test reads
# the real call and not a copy of it.
BRIDGE = os.path.join(HERE, "provider_bridge.py")
with io.open(BRIDGE, encoding="utf-8") as handle:
    BRIDGE_SRC = handle.read()

check("the bridge serialises with ensure_ascii=True",
      "json.dumps(obj, ensure_ascii=True)" in BRIDGE_SRC,
      "provider_bridge._send no longer pins the ASCII wire")

check("the bridge does not serialise with ensure_ascii=False",
      "ensure_ascii=False" not in BRIDGE_SRC,
      "a raw non-ASCII character would be encoded in the host codepage")

# Drive the real `_send` under each codepage. A subprocess is required: the
# encoding is fixed when the interpreter opens stdout, so it cannot be varied
# in-process.
PROBE = (
    "import io, json, sys\n"
    "sys.path.insert(0, %r)\n"
    "import provider_bridge\n"
    "provider_bridge._send(%r)\n"
) % (HERE, SAMPLE)

for codepage in ("cp1252", "cp437", "utf-8", "ascii"):
    env = dict(os.environ)
    env["PYTHONIOENCODING"] = codepage
    env.pop("PYTHONUTF8", None)
    try:
        proc = subprocess.run(
            [sys.executable, "-c", PROBE],
            capture_output=True, env=env, cwd=HERE, timeout=120,
        )
    except Exception as exc:  # pragma: no cover - environment failure
        check("stdout=%s runs" % codepage, False, repr(exc))
        continue

    if proc.returncode != 0:
        check("stdout=%s runs" % codepage, False,
              proc.stderr.decode("utf-8", "replace").strip()[-300:])
        continue

    raw = proc.stdout
    # The wire must survive an ASCII-only read: every byte < 0x80.
    ascii_only = all(byte < 0x80 for byte in raw)
    check("stdout=%s writes pure ASCII" % codepage, ascii_only,
          "non-ASCII byte(s): %r" % raw[:120])

    # And it must round-trip to the original text through a UTF-8 reader, which
    # is what the harness is.
    decoded = raw.decode("utf-8", "replace")
    check("stdout=%s decodes without U+FFFD" % codepage, "\ufffd" not in decoded,
          repr(decoded[:120]))

    line = decoded.strip().splitlines()[-1]
    try:
        frame = json.loads(line)
    except ValueError as exc:
        check("stdout=%s is one JSON frame" % codepage, False, repr(exc))
        continue

    check("stdout=%s round-trips the label" % codepage,
          frame.get("name") == SAMPLE["name"], repr(frame.get("name")))
    check("stdout=%s round-trips CJK" % codepage,
          frame.get("cjk") == SAMPLE["cjk"], repr(frame.get("cjk")))
    check("stdout=%s round-trips the em dash" % codepage,
          frame.get("dash") == SAMPLE["dash"], repr(frame.get("dash")))


print("")
if FAILS:
    print("%d FAILED: %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all checks passed")
