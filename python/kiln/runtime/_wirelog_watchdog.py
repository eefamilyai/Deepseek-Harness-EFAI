#!/usr/bin/env python3
"""Guard the wirelog against the FIX 18 runaway while an OLD bridge is still live.

WHY THIS EXISTS

`ds_wirelog.verdict()` used to push each verdict it built back into `_RING`, and
every later verdict's `preamble` is a copy of that ring. Nesting made the record
written for one verdict larger than every earlier verdict combined, so growth was
exponential in the number of VERDICTS. The live journal reached a single 11.47 GB
line holding 1,048,545 nested mutes, written by one `f.write()` that took 28
minutes to reach disk.

FIX 18 removes the nesting (`_strip_verdict`) and adds a per-record ceiling
(`_RECORD_MAX`), but a Python process caches its modules at import. A bridge that
was already running when the fix landed keeps the old module in memory until it is
restarted, so the runaway is still reachable in that process.

This watchdog is the stopgap for that window. It polls the journal and, if it sees
the runaway signature, truncates the file and records why.

WHAT IT WATCHES, AND WHY THOSE TWO NUMBERS

* **last-line length** is the direct signature. A legitimate record is under
  `_RECORD_MAX` (1 MiB) and in practice ~17 KB. 4 MiB means nesting has started.
* **total file size** is the second net: even if a line is being built in memory,
  the file only grows when a record lands, so a journal past 256 MiB while
  `_FILE_MAX` is 32 MiB means rotation is not keeping up.

Truncating is safe. Nothing reads this journal for control flow: it is
append-only diagnostics written by `_append`, and no connector code opens it. The
only consumer is a human or a tool reading it after the fact, so losing the tail
of a runaway file loses nothing of value -- and the runaway record is unreadable
anyway.

USAGE

    python _wirelog_watchdog.py            # poll every 30 s, run until killed
    python _wirelog_watchdog.py --once     # single check, for a test

It writes a line to stdout on every action and appends to `_wirelog_watchdog.log`
beside the journal. It never touches a healthy journal.
"""
import argparse
import json
import os
import sys
import time

_HERE = os.path.dirname(os.path.abspath(__file__))

# A record this large means `_strip_verdict` never ran: the record is carrying
# nested copies of earlier verdicts. 1 MiB is the post-fix ceiling; a healthy
# record measured 17,068 B, so 4 MiB is unambiguous.
_LINE_MAX = 4 * 1024 * 1024
# `_FILE_MAX` is 32 MiB. Ten times that with rotation working would need ten
# rotations, all of which would have moved the file away.
_FILE_MAX = 256 * 1024 * 1024
# Keep this much head+tail when a bad journal is replaced, for the post-mortem.
_KEEP = 120_000


def _state_dir():
    return os.environ.get("KILN_STATE_DIR") or _HERE


def _journal():
    return os.path.join(_state_dir(), "ds_wirelog.jsonl")


def _log(msg):
    line = "%s %s" % (time.strftime("%Y-%m-%d %H:%M:%S"), msg)
    print(line, flush=True)
    try:
        with open(os.path.join(_state_dir(), "_wirelog_watchdog.log"),
                  "a", encoding="utf-8") as fh:
            fh.write(line + "\n")
    except Exception:
        pass


def _last_line_size(path):
    """Length of the final line, without reading the whole file.

    Reads backwards in 1 MiB blocks looking for a newline. A runaway file is
    enormous, so a full read is not an option; this touches only the tail.
    """
    size = os.path.getsize(path)
    if size == 0:
        return 0
    block = 1 << 20
    with open(path, "rb") as fh:
        fh.seek(max(0, size - block))
        tail = fh.read()
    # A file with no newline at all is one single record.
    if b"\n" not in tail[:-1] and size > block:
        return size
    idx = tail.rstrip(b"\n").rfind(b"\n")
    return len(tail) - idx - 1


def _replace(path, reason, observed):
    """Keep a head+tail sample, then empty the journal."""
    sample = path + ".runaway"
    try:
        size = os.path.getsize(path)
        with open(path, "rb") as fh:
            head = fh.read(_KEEP)
            fh.seek(max(0, size - _KEEP))
            tail = fh.read()
        with open(sample, "wb") as fh:
            fh.write(head)
            fh.write(b"\n...WATCHDOG-TRUNCATED...\n")
            fh.write(tail)
        with open(path, "w", encoding="utf-8"):
            pass
        _log("TRUNCATED %s (%s; observed=%s, file=%d B). Sample: %s"
             % (path, reason, observed, size, os.path.basename(sample)))
        return True
    except Exception as e:  # noqa: BLE001
        _log("truncate FAILED for %s: %s" % (path, e))
        return False


def check(once=False):
    path = _journal()
    if not os.path.exists(path):
        return False
    try:
        size = os.path.getsize(path)
        last = _last_line_size(path)
    except Exception as e:  # noqa: BLE001
        _log("stat failed: %s" % e)
        return False

    if last > _LINE_MAX:
        return _replace(path, "one record exceeded %d B" % _LINE_MAX, last)
    if size > _FILE_MAX:
        return _replace(path, "journal exceeded %d B" % _FILE_MAX, size)
    return False


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--once", action="store_true")
    ap.add_argument("--interval", type=float, default=30.0)
    args = ap.parse_args()

    path = _journal()
    _log("watchdog start: journal=%s line_max=%d file_max=%d interval=%.0fs"
         % (path, _LINE_MAX, _FILE_MAX, args.interval))

    if args.once:
        hit = check(once=True)
        print("once: %s" % ("TRUNCATED" if hit else "clean"))
        return 0

    while True:
        try:
            check()
        except KeyboardInterrupt:
            _log("watchdog stopped")
            return 0
        except Exception as e:  # noqa: BLE001
            _log("check raised %s: %s" % (type(e).__name__, e))
        time.sleep(args.interval)


if __name__ == "__main__":
    sys.exit(main())
