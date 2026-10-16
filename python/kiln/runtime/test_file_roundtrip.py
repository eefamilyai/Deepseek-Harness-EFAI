#!/usr/bin/env python
"""Offline tests for the kernel's file helpers: a read is never silently shortened,
a write never corrupts line endings, and text carrying an omission marker is refused.

Run:  python test_file_roundtrip.py

The regressions these pin:
  * read_file shortened any file over 200 000 characters to its head and tail around
    an "…[N chars omitted]…" marker, and write() saved that text back, deleting the
    middle of the file (it happened to kernel_child.py itself);
  * write() of text read from a CRLF file wrote "\\r\\r\\n" on every line.

The helpers are exec'd from kernel_child.py's source with the harness seam stubbed
out, so the local file path is what runs.
"""
import os
import re
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "kernel_child.py")
RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not ok and detail:
        print("      %s" % detail)


with open(SOURCE, encoding="utf-8") as fh:
    src = fh.read()
start = src.index("# The marker an explicitly shortened read inserts.")
end = src.index("# ── project memory (KILN.md)")
ns = {"os": os, "_seam_request": lambda *a, **k: None, "_record_change": lambda *a, **k: None}
exec(src[start:end], ns)  # noqa: S102 — the helpers under test, verbatim
read_file, write_file, append_file = ns["read_file"], ns["write_file"], ns["append_file"]

tmp = tempfile.mkdtemp()

# A big file reads whole by default and survives a read/write round trip.
big = os.path.join(tmp, "big.txt")
body = "".join("line %06d\n" % i for i in range(40000))  # 480 000 chars
with open(big, "w", encoding="utf-8", newline="") as fh:
    fh.write(body)
text = read_file(big)
check("a large file reads whole by default", text == body, len(text))
write_file(big, text.replace("line 000000", "LINE 000000"))
with open(big, encoding="utf-8", newline="") as fh:
    after = fh.read()
check("a round trip keeps every line", len(after) == len(body) and after.startswith("LINE 000000"))

# An explicit shortened read is marked, and writing it back is refused.
short = read_file(big, max_chars=1000)
check("an explicit max_chars shortens with a marker", "chars omitted -- read a slice]" in short and len(short) < 1200)
refused = write_file(big, short)
check("writing a shortened read back is refused", refused.startswith("write_file error: refusing"), refused)
with open(big, encoding="utf-8", newline="") as fh:
    check("the refused write left the file intact", fh.read() == after)
check("append refuses the marker too", "refusing" in append_file(big, short))

meta = read_file(big, max_chars=1000, meta=True)
check("meta reports truncation truthfully", meta["truncated"] is True and meta["total_chars"] == len(body)
      and meta["returned_chars"] == len(short))
check("meta of a whole read says not truncated", read_file(big, meta=True)["truncated"] is False)

# CRLF files keep CRLF, and CRLF text is not doubled.
crlf = os.path.join(tmp, "crlf.yml")
with open(crlf, "wb") as fh:
    fh.write(b"a: 1\r\nb: 2\r\n")
content = read_file(crlf)
check("a CRLF file reads with its \\r\\n", content == "a: 1\r\nb: 2\r\n", repr(content))
write_file(crlf, content + "c: 3\n")
with open(crlf, "rb") as fh:
    raw = fh.read()
check("writing CRLF text back never doubles \\r", b"\r\r" not in raw, raw)
check("the file stays CRLF throughout", raw == b"a: 1\r\nb: 2\r\nc: 3\r\n", raw)
append_file(crlf, "d: 4\r\n")
with open(crlf, "rb") as fh:
    raw = fh.read()
check("append keeps CRLF without doubling", raw.endswith(b"c: 3\r\nd: 4\r\n") and b"\r\r" not in raw, raw)

# LF files and new files stay LF.
lf = os.path.join(tmp, "lf.txt")
write_file(lf, "x\r\ny\n")
with open(lf, "rb") as fh:
    check("a new file is LF", fh.read() == b"x\ny\n")

# A missing file reports, both ways.
check("a missing file reports an error string", read_file(os.path.join(tmp, "nope")).startswith("read_file error:"))
check("a missing file reports ok False in meta", read_file(os.path.join(tmp, "nope"), meta=True)["ok"] is False)

# The seam path: whole text, truthful meta.
ns["_seam_request"] = lambda op, args, **k: {"ok": True, "value": "é" * 10} if op == "fs.readText" else None
check("a seam read is whole", read_file("x") == "é" * 10)
m = read_file("x", max_chars=4, meta=True)
check("a seam read reports truncation and UTF-8 size", m["truncated"] is True and m["size"] == 20, m)
sent = []
ns["_seam_request"] = lambda op, args, **k: sent.append(args) or {"ok": True, "value": {}}
write_file(crlf, "p\r\nq\n")
check("a seam write of a CRLF file sends CRLF once", sent and sent[-1]["content"] == "p\r\nq\r\n", sent)
check("a seam write refuses the marker", "refusing" in write_file(crlf, short))

failed = [r for r in RESULTS if not r[1]]
print("\n%d passed, %d failed" % (len(RESULTS) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
