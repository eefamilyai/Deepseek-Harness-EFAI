# kernel_child.py

import ast

import base64

import contextlib

import fnmatch

import io

import json

import linecache

import locale

import os

import re

import subprocess

import sys

import time

import traceback

import urllib.parse

import urllib.request

import uuid

from html.parser import HTMLParser

# ── fd-1 quarantine ──────────────────────────────────────────────────────
# The wire protocol is newline-delimited base64 on stdout, so a SINGLE raw
# byte written to fd 1 by anything that is not send_frame desynchronises the
# transport for the rest of the process's life: the harness reads that line as
# the answer to the running cell, and every later cell then receives the
# previous cell's frame. Nothing detects it and nothing recovers from it.
#
# Plenty of ordinary Python reaches fd 1 without going through sys.stdout:
# os.system, any subprocess that inherits stdio, a C extension, or a print
# from a thread that is not executing a captured cell. So fd 1 stops being the
# protocol. It is duplicated to a private fd that only send_frame writes to,
# and a pipe takes its place on fd 1. A daemon drains that pipe, which both
# protects the transport and recovers output the model used to lose entirely.
#
# Installed here, immediately after the imports, so no module-level code can
# contaminate the channel before the guard is up.
_STRAY_LOCK = None
_STRAY = []
# Sentinel pushed through fd 1 to find out when the drain has caught up. A pipe
# is FIFO, so once the sentinel comes back every byte the cell wrote before it
# has already been collected — which is what lets stray output be attributed to
# the cell that produced it instead of to whichever frame the drain thread
# happened to be scheduled before.
_STRAY_SYNC = "\x00KILN_FD1_SYNC\x00"
_STRAY_SYNCED = None


def _install_fd_quarantine():
    """Move the protocol off fd 1. Returns the private protocol stream, or None
    when the platform refuses, in which case send_frame falls back to fd 1 and
    behaves exactly as it did before."""
    global _STRAY_LOCK, _STRAY_SYNCED
    import threading
    _STRAY_LOCK = threading.Lock()
    _STRAY_SYNCED = threading.Event()
    try:
        proto_fd = os.dup(1)
    except Exception:
        return None
    try:
        read_fd, write_fd = os.pipe()
        os.dup2(write_fd, 1)
        os.close(write_fd)
    except Exception:
        try:
            os.close(proto_fd)
        except Exception:
            pass
        return None

    sync = _STRAY_SYNC.encode('utf-8')

    def _drain():
        # Must never stop while fd 1 is open: an undrained pipe fills at ~64KB
        # and blocks the writer, which would hang a cell instead of the old
        # failure of corrupting the protocol.
        carry = b""
        while True:
            try:
                chunk = os.read(read_fd, 65536)
            except Exception:
                return
            if not chunk:
                return
            data = carry + chunk
            carry = b""
            seen_sync = sync in data
            if seen_sync:
                data = data.replace(sync, b"")
            else:
                # A sentinel can straddle a read boundary. Hold back a tail that
                # could still be its start, so the sync is never missed; the
                # next chunk (there is always one — every sync writes) frees it.
                edge = data[-(len(sync) - 1):]
                cut = edge.find(sync[:1])
                if cut != -1:
                    carry = edge[cut:]
                    data = data[:len(data) - len(carry)]
            if data:
                with _STRAY_LOCK:
                    _STRAY.append(data.decode('utf-8', 'replace'))
            if seen_sync:
                _STRAY_SYNCED.set()

    threading.Thread(target=_drain, daemon=True, name='kiln-fd1-drain').start()
    return os.fdopen(proto_fd, 'w', encoding='utf-8', newline='\n')


_PROTO_STREAM = _install_fd_quarantine()


def _await_stray_drain(timeout=0.25):
    """Block until the drain thread has collected everything already written to
    fd 1. Costs one pipe round-trip, not a sleep, so a cell that wrote nothing
    pays almost nothing. Bounded because a wedged drain must degrade to slightly
    misattributed output, never to a hung cell."""
    if _STRAY_SYNCED is None or _PROTO_STREAM is None:
        return
    _STRAY_SYNCED.clear()
    try:
        os.write(1, _STRAY_SYNC.encode('utf-8'))
    except Exception:
        return
    _STRAY_SYNCED.wait(timeout)


def take_stray_output():
    """Drain the bytes that reached the real fd 1 since the last frame.

    Returned labelled rather than spliced silently into the cell's own output:
    it arrived outside the per-thread capture, so it is not the cell's captured
    output and should not be dressed up as it."""
    if _STRAY_LOCK is None:
        return ""
    _await_stray_drain()
    with _STRAY_LOCK:
        if not _STRAY:
            return ""
        text = "".join(_STRAY)
        del _STRAY[:]
    text = text.strip("\r\n")
    if not text:
        return ""
    return "[output written straight to the process stdout, outside any cell's capture]\n" + text





def decode_bytes(data: bytes) -> str:

    if not data:

        return ""

    if data.startswith(b'\xff\xfe') or data.startswith(b'\xfe\xff'):

        try:

            return data.decode('utf-16')

        except UnicodeDecodeError:

            pass

    pref = locale.getpreferredencoding(False) or 'utf-8'

    # every attempt is strict except the guaranteed-last one (latin-1 never

    # fails) — with errors='replace' the first try always "succeeds" and the

    # platform/cp1252/cp850 fallbacks below are unreachable dead code

    for enc in [('utf-8-sig', 'strict'), (pref, 'strict'),

                ('cp1252', 'strict'), ('cp850', 'strict'), ('latin-1', 'strict')]:

        try:

            return data.decode(enc[0], enc[1])

        except (UnicodeDecodeError, LookupError):

            continue

    return data.decode('latin-1', 'strict')





# The kernel process outlives a single chat. Python's cwd is mutable, so a

# cell that os.chdir()'d in the previous chat must not leak into this one:

# every cell is executed from _KERNEL_CWD, which starts at launch cwd and

# only changes when the model explicitly calls set_cwd().

_STARTUP_CWD = os.path.abspath(os.getcwd())

_KERNEL_CWD = _STARTUP_CWD

# The workspace stamp carried by the most recent cell, so a chat switch can be

# told from a run of cells in the same chat. Same stamp = same chat: a set_cwd()

# the model made in between must survive. New stamp = another chat: reset to it.

_LAST_STAMPED_CWD = None



def sh(cmd, timeout=None, result=False, check=False, **kwargs):
    """Run a shell command and return its combined output.

    The default return is stdout+stderr concatenated as text, so existing
    one-shot idioms keep working. Pass ``result=True`` for a structured dict
    ``{ok, code, stdout, stderr, output}`` so the model can tell a failed
    command from one that printed nothing. ``check=True`` raises RuntimeError
    on a non-zero exit instead of returning it quietly.

    Extra keyword arguments are accepted and ignored so idioms the model picks
    up from other harnesses (``capture=``, ``check=``, ``text=``, ``shell=``)
    never crash the call -- this helper ALWAYS captures output.

    Prefers the harness shell seam (policy, sandbox, timeout); falls back to the
    local subprocess run when the seam or the foreground RPC is unavailable.
    """
    if isinstance(cmd, (list, tuple)):
        cmd = subprocess.list2cmdline(cmd)
    _seam = _seam_request("shell.run", {"command": cmd, "timeoutMs": timeout * 1000 if isinstance(timeout, (int, float)) else None})
    if _seam is not None and _seam.get("ok"):
        _v = _seam.get("value") or {}
        _code = _v.get("exitCode")
        _ok = _code == 0
        _out = (str(_v.get("stdout") or "") + str(_v.get("stderr") or ""))
        if check and not _ok:
            raise RuntimeError("Command exited with code %s: %s" % (_code, _out))
        if result:
            return {"ok": _ok, "code": _code, "stdout": _v.get("stdout") or "",
                    "stderr": _v.get("stderr") or "", "output": _out,
                    "timed_out": bool(_v.get("timedOut")), "harness": True}
        return _out
    try:
        r = subprocess.run(cmd, shell=True, capture_output=True, timeout=timeout)
    except subprocess.TimeoutExpired:
        msg = "Command timed out after %ss" % timeout
        if result:
            return {"ok": False, "code": None, "stdout": "", "stderr": "",
                    "output": msg, "timeout": True, "error": msg}
        if check:
            raise RuntimeError(msg)
        return msg
    except Exception as e:
        msg = "Error running command: %s" % e
        if result:
            return {"ok": False, "code": None, "stdout": "", "stderr": "",
                    "output": msg, "error": msg}
        if check:
            raise RuntimeError(msg)
        return msg
    stdout = decode_bytes(r.stdout)
    stderr = decode_bytes(r.stderr)
    output = stdout + stderr
    ok = r.returncode == 0
    if check and not ok:
        raise RuntimeError("Command exited with code %s: %s" % (r.returncode, output))
    if result:
        return {"ok": ok, "code": r.returncode, "stdout": stdout,
                "stderr": stderr, "output": output}
    return output

def fetch(url, timeout=30):

    """GET a URL and return its text. Transient failures (429/5xx, connection

    refused/reset/timeout) are retried with backoff instead of failing the

    model's turn on a blip."""

    import time as _t

    import urllib.error

    import urllib.request

    _UA = ('Mozilla/5.0 (Windows NT 10.0; Win64; x64) '

           'AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36')

    _seam = _seam_request("web.fetch", {"url": url})
    if _seam is not None and _seam.get("ok"):
        _v = _seam.get("value") or {}
        _body = _v.get("body") or {}
        _content = _body.get("content")
        if isinstance(_content, str) and _content:
            return _content
        _code = _v.get("statusCode")
        if _code is not None and _code >= 400:
            return "Fetch error: HTTP %s" % _code

    last = None

    for attempt in range(3):

        req = urllib.request.Request(url, headers={'User-Agent': _UA})

        try:

            with urllib.request.urlopen(req, timeout=timeout) as resp:

                return decode_bytes(resp.read())

        except urllib.error.HTTPError as e:

            if e.code in (429, 500, 502, 503, 504) and attempt < 2:

                last = "HTTP %d" % e.code

                _t.sleep(1.5 * (attempt + 1))

                continue

            return f"Fetch error: HTTP {e.code}: {e.reason}"

        except (urllib.error.URLError, ConnectionError, TimeoutError,

                OSError) as e:

            if attempt < 2:

                last = str(e)

                _t.sleep(1.5 * (attempt + 1))

                continue

            return f"Fetch error: {e}"

        except Exception as e:

            return f"Fetch error: {e}"

    return f"Fetch error: {last} (retried 3x)"





class _DuckParser(HTMLParser):

    def __init__(self):

        super().__init__()

        self.results = []

        self._in_result = False

        self._cur = {}

        self._in_title = False

        self._in_snippet = False

        self._buf = []

    def handle_starttag(self, tag, attrs):

        attrs = dict(attrs)

        cls = attrs.get('class','')

        if tag=='a' and 'result__a' in cls:

            self._in_result = True

            self._cur['url'] = attrs.get('href','')

            self._in_title = True

            self._buf=[]

        elif tag=='a' and 'result__snippet' in cls:

            self._in_snippet = True

            self._buf=[]

    def handle_data(self, data):

        if self._in_title or self._in_snippet:

            self._buf.append(data)

    def handle_endtag(self, tag):

        if tag=='a' and self._in_title:

            self._cur['title'] = ''.join(self._buf).strip()

            self._in_title=False

        elif tag=='a' and self._in_snippet:

            self._cur['snippet'] = ''.join(self._buf).strip()

            self._in_snippet=False

            if self._in_result:

                self.results.append(self._cur)

                self._cur={}

                self._in_result=False



def search(query, limit=8):

    """Web search -> [{title, url, snippet}].



    Prefers the real headless browser (browser_tools): it renders the JS results

    page, carries a browser fingerprint + cookies, and clears consent walls that

    make a raw HTTP scrape come back empty or blocked. Falls back to the raw

    DuckDuckGo HTML scrape when Playwright is unavailable or the browser search

    finds nothing.

    """

    _seam = _seam_request("web.search", {"query": query, "limit": limit})
    if _seam is not None and _seam.get("ok"):
        _srcs = (_seam.get("value") or {}).get("sources") or []
        _out = []
        for _s in _srcs:
            if isinstance(_s, dict):
                _out.append({"title": _s.get("title") or "", "url": _s.get("url") or "",
                             "snippet": _s.get("snippet") or ""})
        if _out:
            return _out

    try:

        from browser_tools import browser_search

        res = browser_search(query, limit=limit)

        if res:

            return res

    except Exception:

        pass

    url = 'https://html.duckduckgo.com/html/?q=' + urllib.parse.quote(query)

    req = urllib.request.Request(url, headers={

        'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0 Safari/537.36'})

    try:

        with urllib.request.urlopen(req, timeout=30) as resp:

            data = resp.read().decode('utf-8','replace')

        p = _DuckParser()

        p.feed(data)

        return p.results[:limit]

    except Exception as e:

        return [{"title":"Search error","url":"","snippet":str(e)}]



# ── Cline-style file helpers ────────────────────────────────────────────────

_READ_CAP = 200_000



# Change tracking (timeline + revert). Every file-modifying helper records a

# JSONL entry + a byte backup when KILN_HISTORY_DIR is set (the server sets it

# per run). The UI shows the timeline and can restore the backup. Writing this

# must never break the helper that calls it — failures are swallowed.



def _record_change(op, path, backup, had_original, diff=None):

    hdir = os.environ.get("KILN_HISTORY_DIR") or ""

    if not hdir:

        return

    try:

        os.makedirs(hdir, exist_ok=True)

        seq = uuid.uuid4().hex[:8]

        rec = {

            "id": "%s_%s" % (os.path.basename(hdir) or "run", seq),

            "ts": time.time(),

            "op": op,

            "path": os.path.abspath(path),

            "conv": os.environ.get("KILN_CONV_ID", ""),

            "had_original": bool(had_original),

            "size": len(backup) if backup else 0,

        }

        if diff:

            rec["diff"] = diff[:20000]

        if backup is not None:

            bdir = os.path.join(hdir, "backups")

            os.makedirs(bdir, exist_ok=True)

            with open(os.path.join(bdir, seq), "wb") as f:

                f.write(backup)

        with open(os.path.join(hdir, "changes.jsonl"), "a", encoding="utf-8") as f:

            f.write(json.dumps(rec) + "\n")

    except Exception:

        pass





def read_file(path, max_chars=_READ_CAP, meta=False):
    """Return a file's text (head+tail if huge).

    ``meta=True`` returns a structured dict instead of the text itself:
    ``{ok, path, size, total_chars, returned_chars, truncated, text}`` on
    success or ``{ok: False, path, error}`` on failure. The default string form
    is unchanged, so existing one-shot ``read_file(x)`` calls keep working.

    Prefers the harness filesystem seam (policy, sandbox, observation); falls
    back to the local read when the seam or the foreground RPC is unavailable.
    """
    _seam = _seam_request("fs.readText", {"path": path})
    if _seam is not None and _seam.get("ok"):
        text = _seam.get("value") or ""
        if len(text) > max_chars:
            text = text[: max_chars // 2] + f"\n…[{len(text) - max_chars} chars omitted — read a slice]…\n" + text[-max_chars // 2:]
        return {"ok": True, "path": path, "size": len(text), "total_chars": len(text),
                "returned_chars": len(text), "truncated": False, "text": text} if meta else text
    try:
        st = os.stat(path)
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read()
    except Exception as e:
        msg = "read_file error: %s" % e
        if meta:
            return {"ok": False, "path": path, "error": msg}
        return msg
    truncated = len(data) > max_chars
    shown = data
    if truncated:
        shown = (data[: max_chars // 2]
                 + "\n…[%d chars omitted -- read a slice]…\n"
                   % (len(data) - max_chars)
                 + data[-max_chars // 2:])
    if meta:
        return {"ok": True, "path": path, "size": st.st_size,
                "total_chars": len(data), "returned_chars": len(shown),
                "truncated": truncated, "text": shown}
    return shown

def _detect_newline(path, default="\n"):

    """The line ending an existing file already uses; LF for a new one.



    Text-mode writes translate "\\n" to os.linesep, so on Windows every file

    the agent wrote silently became CRLF — it could not produce an LF file at

    all, and the byte count never matched the character count it reported.

    Editing a file must not rewrite every line ending either, so existing

    files keep whatever they already use.

    """

    try:

        with open(path, "rb") as f:

            head = f.read(65536)

    except OSError:

        return default

    if b"\r\n" in head:

        return "\r\n"

    if b"\n" in head:

        return "\n"

    return default





def _written(path, verb, chars):

    """Report what is ACTUALLY on disk, read back after the write.



    The old message reported len(content) as "chars", which is neither what

    the OS reports nor what the user sees in a file listing — a model that

    quotes it is quoting its own intent, not the result. Reading the size back

    means the number cannot be wrong.

    """

    try:

        size = os.path.getsize(path)

    except OSError:

        return f"{verb} {path} (could not stat the file afterwards)"

    extra = "" if size == chars else f" ({chars} chars)"

    return f"{verb} {path} — {size} bytes on disk{extra}"





def write_file(path, content):

    """Write text to a file (creates folders). Returns a confirmation.

    Prefers the harness filesystem seam; falls back to the local write when the
    seam or the foreground RPC is unavailable.
    """

    _seam = _seam_request("fs.writeText", {"path": path, "content": content})
    if _seam is not None and _seam.get("ok"):
        _out = _seam.get("value")
        if isinstance(_out, dict) and _out.get("operation"):
            return f"wrote {path} (via harness fs; operation={_out.get('operation')})"
        return f"wrote {path} (via harness fs)"
    try:

        folder = os.path.dirname(os.path.abspath(path))

        os.makedirs(folder, exist_ok=True)

        had = os.path.isfile(path)

        backup = None

        if had:

            with open(path, "rb") as f:

                backup = f.read()

        with open(path, "w", encoding="utf-8", newline=_detect_newline(path)) as f:

            f.write(content)

        _record_change("write", path, backup, had)

        return _written(path, "wrote", len(content))

    except Exception as e:

        return f"write_file error: {e}"





def append_file(path, content):

    """Append text to a file. Returns a confirmation."""

    try:

        folder = os.path.dirname(os.path.abspath(path))

        os.makedirs(folder, exist_ok=True)

        had = os.path.isfile(path)

        backup = None

        if had:

            with open(path, "rb") as f:

                backup = f.read()

        with open(path, "a", encoding="utf-8", newline=_detect_newline(path)) as f:

            f.write(content)

        _record_change("append", path, backup, had)

        return _written(path, "appended to", len(content))

    except Exception as e:

        return f"append_file error: {e}"





# ── project memory (KILN.md) ────────────────────────────────────────────────

# The agent's persistent memory: a KILN.md in the working directory whose

# contents are loaded into the system prompt every run. The model appends

# durable conventions/decisions with memory_append() so future runs don't

# relearn them from scratch.



def memory_read():

    """Return the project memory file (KILN.md in the working directory)."""

    p = os.path.join(os.getcwd(), "KILN.md")

    if not os.path.isfile(p):

        return "(no KILN.md yet — call memory_append() to create one)"

    try:

        with open(p, "r", encoding="utf-8", errors="replace") as f:

            return f.read()

    except Exception as e:

        return f"memory_read error: {e}"





def memory_append(text):

    """Append a dated note to KILN.md (creating it if needed). Use it to

    persist durable conventions/decisions future runs should know."""

    try:

        p = os.path.join(os.getcwd(), "KILN.md")

        entry = time.strftime("%Y-%m-%d %H:%M") + " — " + str(text).strip() + "\n"

        if os.path.isfile(p):

            with open(p, "a", encoding="utf-8", newline=_detect_newline(p)) as f:

                f.write("\n" + entry)

        else:

            with open(p, "w", encoding="utf-8", newline="\n") as f:

                f.write("# Project memory (KILN.md)\n\n"

                        "Durable notes the agent keeps across runs; loaded into "

                        "every run's system prompt. Append with memory_append().\n\n"

                        + entry)

        return "appended a note to " + p

    except Exception as e:

        return f"memory_append error: {e}"





# ── durable memory (remember / recall / forget) ──────────────────────────────

# The Python namespace is the model's working memory, but it dies with the

# kernel: a timeout, an interrupt or a crash restarts the child and every

# variable goes with it. And anything the model does NOT print is invisible to

# it next turn, while anything it DOES print is re-sent forever.

#

# remember() writes through to disk (see kiln_memory.py), so a name survives a

# kernel restart, compaction, the end of the run, and being scrolled out of

# context. recall() brings it back on demand — which is what makes it safe to

# keep big things OUT of the transcript instead of printing them to be sure.

import kiln_memory  # noqa: E402

# `_active_conv` holds the conversation key for the cell CURRENTLY RUNNING ON THE
# CURRENT THREAD. It is declared right after `import threading as _threading`
# below (thread-local machinery must exist first) and is read by _memory_store().
# The per-cell envelope value is threaded through _CellRunner to keep one session's
# durable memory out of another session even when a backgrounded cell and a new
# foreground cell run concurrently in this one process.





def _memory_store():

    """This conversation's store. None when the kernel was started outside a

    conversation (bare `python kernel_child.py`), where there is nothing to

    key on — the helpers then say so rather than writing to a stray folder.

    The conversation id is read from the active cell's thread-local first: one

    kernel process serves every session, and a backgrounded cell may run while

    a different session's foreground cell also runs, so a single process-global

    `os.environ['KILN_CONV_ID']` would leak one session's memory into another.

    `KILN_CONV_ID` remains only as a legacy/standalone fallback."""

    conv = (getattr(_active_conv, "value", None) or "").strip() or (os.environ.get("KILN_CONV_ID") or "")

    if not conv:

        return None

    try:

        return kiln_memory.MemoryStore(conv, os.environ.get("KILN_MEMORY_DIR") or None)

    except Exception:

        return None





def _ctx_bind_entries():
    store = _memory_store()
    if store is None:
        return {}
    try:
        entries = store.entries()
    except Exception:
        return {}
    out = {}
    for name, entry in entries.items():
        if entry.get("kind") != "ctx":
            continue
        _, text = store.get(name)
        if text is None:
            continue
        out[str(name)] = text
    return out


def _as_text(value):

    """Text for storage. Strings go verbatim; everything else is rendered so

    that what comes back is what the model actually saw."""

    if isinstance(value, str):

        return value

    if isinstance(value, (bytes, bytearray)):

        return decode_bytes(bytes(value))

    try:

        if isinstance(value, (dict, list, tuple)):

            return json.dumps(value, ensure_ascii=False, indent=2, default=repr)

    except Exception:

        pass

    return repr(value)





def remember(name, value, kind="note"):

    """Store something durably under `name`, and keep the live object too.



        remember("api_shape", parsed)     # survives a kernel restart



    The value stays in the namespace under its own name as well, so normal

    Python keeps working. What this adds is the disk copy: recall("api_shape")

    returns it even after a timeout, a crash, a compaction, or a new run.



    Use it for anything you would otherwise print "so you don't lose it" —

    printing costs those tokens on every later turn, this costs them once.

    """

    store = _memory_store()

    if store is None:

        return "remember: no conversation to store into (KILN_CONV_ID is unset)"

    key = str(name).strip()

    if not key:

        return "remember: name must not be empty"

    try:

        text = _as_text(value)

        entry = store.put(key, text, kind=kind)

    except Exception as e:

        return f"remember error: {e}"

    # keep the live object addressable by the same name

    try:

        _ns[key] = value

    except Exception:

        pass

    n = entry["lines"]

    return (f"remembered {key!r} — {entry['chars']} chars, "

            f"{n} line{'' if n == 1 else 's'}. "

            f"Get it back any time with recall({key!r}).")





def recall(name=None, start=1, lines=200):

    """Read back something stored with remember(), or list what is stored.



        recall()                  # every name, with size and preview

        recall("api_shape")       # the first 200 lines

        recall("out_3", start=201)  # the next window



    Also resolves the automatic names Kiln creates for you: `out_N` for a cell

    whose output was too long to show in full, and `turns_N` for the turns a

    compaction summarized away. Nothing that was ever in your context is

    unreachable — it is only off-screen.

    """

    store = _memory_store()

    if store is None:

        return "recall: no conversation to read from (KILN_CONV_ID is unset)"

    if name is None:

        entries = store.entries()

        if not entries:

            return "nothing stored yet — remember(name, value) puts something here"

        rows = sorted(entries.values(), key=lambda e: e.get("ts", 0), reverse=True)

        out = ["%d stored:" % len(rows)]

        for e in rows:

            out.append("  %-24s %7d chars  %-7s  %s"

                       % (e.get("name", "?"), e.get("chars", 0),

                          e.get("kind", "note"), e.get("preview", "")[:80]))

        return "\n".join(out)

    entry, text = store.get(str(name))

    if entry is None:

        known = ", ".join(sorted(store.entries())[:20]) or "(nothing stored)"

        return f"recall: nothing stored under {str(name)!r}. Stored names: {known}"

    if text is None:

        return f"recall: the blob for {str(name)!r} is missing from disk"

    return kiln_memory.slice_text(text, start, lines)





def forget(name):

    """Stop a remembered name resolving. The bytes stay on disk — this is a

    tombstone, not a delete, so it can never destroy something you still need."""

    store = _memory_store()

    if store is None:

        return "forget: no conversation to write to (KILN_CONV_ID is unset)"

    key = str(name)

    if key not in store.entries():

        return f"forget: nothing stored under {key!r}"

    try:

        store.tombstone(key)

    except Exception as e:

        return f"forget error: {e}"

    return f"forgot {key!r} (the stored copy is kept on disk, just unnamed)"





def _make_diff(path, old_text, new_text):

    """Unified diff of an edit, capped so huge files don't flood the model."""

    import difflib

    diff = "\n".join(difflib.unified_diff(

        old_text.splitlines(), new_text.splitlines(),

        fromfile="a/" + path, tofile="b/" + path, lineterm=""))

    lines = diff.splitlines()

    if len(lines) > 120:

        diff = "\n".join(lines[:60] + ["… %d lines omitted …" % (len(lines) - 120)] + lines[-60:])

    return diff





def edit_file(path, old, new):

    """Replace `old` with `new` in a file. `old` must match EXACTLY ONE

    occurrence — an ambiguous pattern is refused so the wrong spot is never

    patched silently. Returns the unified diff of the change."""

    try:

        with open(path, "r", encoding="utf-8") as f:

            data = f.read()

    except Exception as e:

        return f"edit_file error: {e}"

    n = data.count(old)

    if n == 0:

        return f"edit_file error: pattern not found in {path}"

    if n > 1:

        return (f"edit_file error: the `old` text appears {n} times in {path} — "

                f"include more surrounding context so it matches exactly one occurrence")

    data2 = data.replace(old, new, 1)

    diff = _make_diff(path, data, data2)

    try:

        with open(path, "rb") as f:

            backup = f.read()

        # keep the file's existing line endings — an edit must not rewrite

        # every line as a side effect

        with open(path, "w", encoding="utf-8", newline=_detect_newline(path)) as f:

            f.write(data2)

        _record_change("edit", path, backup, True, diff=diff)

    except Exception as e:

        return f"edit_file error: {e}"

    return f"{_written(path, 'edited', len(data2))}\n--- diff ---\n{diff}"





def delete_file(path):

    """Delete a file. Returns a confirmation."""

    try:

        with open(path, "rb") as f:

            backup = f.read()

        os.remove(path)

        _record_change("delete", path, backup, True)

        return f"deleted {path}"

    except Exception as e:

        return f"delete_file error: {e}"





def list_dir(path=".", depth=1, max_entries=200):

    """Pretty directory tree, skipping noise folders.

    Prefers the harness filesystem seam; falls back to the local tree when the
    seam or the foreground RPC is unavailable.
    """

    _SKIP = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea", ".vscode"}

    _seam = _seam_request("fs.listDir", {"path": path})
    if _seam is not None and _seam.get("ok"):
        _entries = _seam.get("value")
        if isinstance(_entries, list):
            _lines = []
            for _e in _entries:
                if not isinstance(_e, dict):
                    continue
                _name = _e.get("name")
                _typ = _e.get("type")
                _size = _e.get("size")
                if _typ == "directory":
                    _lines.append(f"{_name}/")
                elif _size is not None:
                    _lines.append(f"{_name}  ({_size}b)")
                else:
                    _lines.append(f"{_name}")
                if len(_lines) >= max_entries:
                    break
            return "\n".join(_lines)
    try:

        root = os.path.abspath(path)

        lines, count = [], [0]



        def walk(cur, d):

            if count[0] >= max_entries:

                return

            try:

                entries = sorted(os.listdir(cur))

            except Exception:

                return

            for name in entries:

                if count[0] >= max_entries:

                    return

                if name in _SKIP:

                    continue

                full = os.path.join(cur, name)

                indent = "  " * d

                if os.path.isdir(full):

                    lines.append(f"{indent}{name}/")

                    count[0] += 1

                    if d < depth:

                        walk(full, d + 1)

                else:

                    try:

                        lines.append(f"{indent}{name}  ({os.path.getsize(full)}b)")

                    except Exception:

                        lines.append(f"{indent}{name}")

                    count[0] += 1



        walk(root, 0)

        return "\n".join(lines) or "(empty)"

    except Exception as e:

        return f"list_dir error: {e}"





def find(pattern, path=".", max_results=50):

    """Grep: regex over text files, lines like `path:lineno: line`."""

    try:

        rx = re.compile(pattern)

    except Exception as e:

        return f"find error: bad regex — {e}"

    _BIN = (".pyc", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".wasm", ".exe",

            ".dll", ".so", ".dylib", ".woff", ".woff2", ".ttf")

    _SKIP = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea"}

    out = []

    for root, dirs, files in os.walk(path):

        dirs[:] = [d for d in dirs if d not in _SKIP]

        for fn in files:

            if len(out) >= max_results:

                break

            if fn.endswith(_BIN):

                continue

            full = os.path.join(root, fn)

            try:

                with open(full, "r", encoding="utf-8", errors="replace") as f:

                    for i, line in enumerate(f, 1):

                        if rx.search(line):

                            out.append(f"{full}:{i}: {line.rstrip()[:200]}")

                            break

            except Exception:

                continue

        if len(out) >= max_results:

            break

    return "\n".join(out[:max_results]) or f"no matches for {pattern!r}"





def glob(pattern, path=".", max_results=100):

    """Glob: match file paths by pattern (**/*.py style, case-sensitive),

    relative to `path`. Returns one path per line, up to max_results."""

    import pathlib

    try:

        root = pathlib.Path(path)

        out = []

        for p in root.glob(pattern):

            if len(out) >= max_results:

                break

            if p.is_file():

                try:

                    out.append(p.relative_to(root).as_posix())

                except ValueError:

                    out.append(str(p))

        return "\n".join(sorted(out)) or f"no matches for {pattern!r}"

    except Exception as e:

        return f"glob error: {e}"





# ── Task list (the model maintains a visible to-do list per conversation) ───

def task_add(subject, status="pending"):
    """Add one item to this conversation's task list.

    ``status`` is ``"pending"``, ``"in_progress"``, or ``"completed"``. Returns
    the full resulting list (not the text the UI shows), or an error dict when
    the task history directory is unavailable.
    """
    import json as _json
    hdir = os.environ.get("KILN_HISTORY_DIR") or ""
    if not hdir:
        return {"ok": False, "error": "KILN_HISTORY_DIR not set"}
    path = os.path.join(hdir, "todos.json")
    items = []
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                payload = _json.load(f)
            items = list(payload.get("items") or [])
    except Exception:
        items = []
    items = [it for it in items if it.get("subject") != subject]
    items.append({"subject": subject, "status": status})
    try:
        os.makedirs(hdir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            _json.dump({"conv": os.environ.get("KILN_CONV_ID", ""),
                        "ts": time.time(), "items": items}, f)
        return {"ok": True, "items": items}
    except Exception as e:
        return {"ok": False, "error": "task_add failed: %s" % e}


def task_done(subject):
    """Mark one task completed by subject. Returns the full resulting list."""
    import json as _json
    hdir = os.environ.get("KILN_HISTORY_DIR") or ""
    if not hdir:
        return {"ok": False, "error": "KILN_HISTORY_DIR not set"}
    path = os.path.join(hdir, "todos.json")
    items = []
    try:
        if os.path.exists(path):
            with open(path, "r", encoding="utf-8") as f:
                items = list(_json.load(f).get("items") or [])
    except Exception:
        items = []
    found = False
    for it in items:
        if it.get("subject") == subject:
            it["status"] = "completed"
            found = True
            break
    try:
        os.makedirs(hdir, exist_ok=True)
        with open(path, "w", encoding="utf-8") as f:
            _json.dump({"conv": os.environ.get("KILN_CONV_ID", ""),
                        "ts": time.time(), "items": items}, f)
        return {"ok": True, "found": found, "items": items}
    except Exception as e:
        return {"ok": False, "error": "task_done failed: %s" % e}


def run_cell(code, timeoutMs=None):
    """Run one Python statement in the kernel namespace and return its result.

    This is the same namespace the model's own cells already share, but the
    return value is an explicit object: ``{"ok": True, "value": ...}``,
    ``{"ok": True, "value": None}``, or ``{"ok": False, "traceback": ...}``.
    Use it when a helper needs to chain: compute in the namespace and read the
    answer in one call instead of guessing from printed output.
    """
    if not isinstance(code, str) or not code.strip():
        return {"ok": False, "error": "code must be a non-empty string"}
    try:
        value = eval(compile(code, "<run_cell>", "eval"), dict(_ns))
    except SyntaxError:
        exec(compile(code, "<run_cell>", "exec"), dict(_ns))
        return {"ok": True, "value": None}
    except Exception:
        import traceback as _tb
        return {"ok": False, "traceback": _tb.format_exc()}
    return {"ok": True, "value": value}


def git_status(path="."):
    """Summarize git state in ``path`` if it is inside a git work tree.

    Returns a dict with ``in_git``, ``branch``, ``porcelain`` entries, and a
    compact per-file ``changes`` list, or an error dict when git is unavailable.
    """
    try:
        r = subprocess.run(["git", "rev-parse", "--is-inside-work-tree"],
                           cwd=path, capture_output=True, timeout=15)
    except FileNotFoundError:
        return {"ok": False, "error": "git executable not found"}
    except Exception as e:
        return {"ok": False, "error": "git_status failed: %s" % e}
    if r.returncode != 0:
        return {"ok": True, "in_git": False}
    try:
        branch = subprocess.run(["git", "branch", "--show-current"], cwd=path,
                                capture_output=True, text=True, timeout=15).stdout.strip()
        porcelain = subprocess.run(["git", "status", "--porcelain"], cwd=path,
                                   capture_output=True, text=True, timeout=15).stdout
    except Exception as e:
        return {"ok": False, "error": "git_status failed: %s" % e}
    lines = [ln for ln in porcelain.splitlines() if ln.strip()]
    return {"ok": True, "in_git": True, "branch": branch or None,
            "porcelain": lines,
            "summary": {"total": len(lines),
                        "staged": sum(1 for l in lines if l[:2].strip()),
                        "untracked": sum(1 for l in lines if l.startswith("??"))}}


def update_todos(items):

    """Set this conversation's task list. `items` is a list of

    {"subject": str, "status": "pending" | "in_progress" | "completed"}.

    Pass the FULL desired list each time — it replaces the previous one.

    The list renders live in the UI's Tasks panel. Returns a confirmation."""

    try:

        norm = []

        for it in items or []:

            if not isinstance(it, dict):

                continue

            subj = str(it.get("subject") or "").strip()

            st = str(it.get("status") or "pending").strip().lower()

            if st not in ("pending", "in_progress", "completed"):

                st = "pending"

            if subj:

                norm.append({"subject": subj, "status": st})

        hdir = os.environ.get("KILN_HISTORY_DIR") or ""

        if not hdir:

            return "update_todos error: KILN_HISTORY_DIR not set"

        os.makedirs(hdir, exist_ok=True)

        rec = {"conv": os.environ.get("KILN_CONV_ID", ""),

               "ts": time.time(),

               "items": norm}

        with open(os.path.join(hdir, "todos.json"), "w", encoding="utf-8") as f:

            json.dump(rec, f)

        if not norm:

            return "task list cleared"

        return "tasks set:\n" + "\n".join(

            f"- [{it['status']}] {it['subject']}" for it in norm)

    except Exception as e:

        return f"update_todos error: {e}"





# ── Web helpers (Cline-style) ────────────────────────────────────────────────



def web_search(query, limit=8):

    """Alias of search() — keyless web search returning [{title,url,snippet}]."""

    return search(query, limit=limit)





def web_fetch(url, timeout=30):

    """Alias of fetch() — HTTP GET returning the body as text."""

    return fetch(url, timeout=timeout)





from browser_tools import browser_use  # noqa: E402 — full sandboxed browser toolset (deferred: heavy deps)

# vision_tools: screenshots the model can actually read. Imported the same
# feature-gated way as everything above — mss/Pillow are optional, and a box
# without them keeps a working kernel and gets a clear message from the tool
# instead of a failed startup.
try:  # noqa: E402
    import vision_tools  # noqa: E402
except Exception as _vision_import_error:  # pragma: no cover
    vision_tools = None
    _vision_import_error = _vision_import_error

from context_store import context_stats, index_context, search_context  # noqa: E402 — deferred: heavy deps
try:  # noqa: E402 — RLM context-as-variable facet (local overlay)
    import rlm_context  # noqa: E402
except Exception as _rlm_import_error:
    rlm_context = None
    _rlm_import_error = _rlm_import_error






# ── Skills (Cline-style) ─────────────────────────────────────────────────────

def _skills_dir():

    return os.path.join(os.path.dirname(os.path.abspath(__file__)), "skills")





def list_skills():

    """List saved skills as [{name, description}]."""

    _seam = _seam_request("skills.list", {}, timeout=15.0)
    if _seam is not None and _seam.get("ok") and not _seam.get("unavailable"):
        skills = _seam.get("value")
        if isinstance(skills, list):
            return skills or "(no skills available in this scope)"
    d = _skills_dir()

    out = []

    if os.path.isdir(d):

        for fn in sorted(os.listdir(d)):

            if not fn.endswith(".json"):

                continue

            try:

                with open(os.path.join(d, fn), encoding="utf-8") as f:

                    s = json.load(f)

                out.append({"name": s.get("name", fn[:-5]),

                            "description": s.get("description", "")})

            except Exception:

                continue

    return out or "(no skills saved — create them in Settings → Skills)"





def use_skill(name):

    """Return a skill's instructions so the model can apply them."""

    _seam = _seam_request("skills.get", {"name": name}, timeout=15.0)
    if _seam is not None and _seam.get("ok") and not _seam.get("unavailable"):
        _skill = _seam.get("value")
        if isinstance(_skill, dict) and _skill.get("content"):
            _parts = [f"SKILL: {_skill.get('name')}"]
            if _skill.get("description"):
                _parts.append("DESCRIPTION: " + _skill["description"])
            _parts.append("INSTRUCTIONS:\n" + _skill["content"])
            return "\n\n".join(_parts)
    safe = re.sub(r"[^A-Za-z0-9 _-]", "", name or "").strip()[:64]

    path = os.path.join(_skills_dir(), safe + ".json")

    try:

        with open(path, encoding="utf-8") as f:

            s = json.load(f)

    except Exception:

        avail = list_skills()

        names = ", ".join(x["name"] for x in avail) if isinstance(avail, list) else avail

        return f"use_skill: skill {name!r} not found. Available: {names}"

    parts = [f"SKILL: {s.get('name')}"]

    if s.get("description"):

        parts.append("DESCRIPTION: " + s["description"])

    if s.get("instructions"):

        parts.append("INSTRUCTIONS:\n" + s["instructions"])

    if s.get("template"):

        parts.append("TEMPLATE:\n" + s["template"])

    return "\n\n".join(parts)





# ── ask_user (Cline-style follow-up question) ────────────────────────────────

_ASK_PREFIX = "[KILN-ASK] "





def ask_user(question):

    """Pause the run and ask the human a question. Use it INSIDE a cell like:



        print(ask_user("Which port should I use?"))



    The run pauses, the question appears in the UI, and the human's answer is

    returned in the cell output as `[User answered] ...`.

    """

    return _ASK_PREFIX + str(question)





# ── extra kernel utilities ───────────────────────────────────────────────────



def get_env(name=None):

    """Read environment variables. No argument lists all name=value pairs;

    with an argument returns that variable's value ('' when unset)."""

    if name is None:

        return "\n".join(f"{k}={v}" for k, v in sorted(os.environ.items()))

    return os.environ.get(str(name), "")





def which(cmd):

    """Return the resolved path of a command on PATH, or '' when absent."""

    import shutil

    return shutil.which(str(cmd)) or ""





def read_json(path):

    """Read a JSON file and return it decoded (dict/list)."""

    with open(path, "r", encoding="utf-8") as f:

        return json.load(f)





def write_json(path, obj):

    """Write `obj` as pretty JSON. Returns a one-line confirmation."""

    with open(path, "w", encoding="utf-8") as f:

        json.dump(obj, f, ensure_ascii=False, indent=2)

    return f"wrote {path} — {os.path.getsize(path)} bytes"





def download(url, path):

    """Download a URL to `path`. Returns bytes written or an error string."""

    try:

        with urllib.request.urlopen(url, timeout=60) as resp:

            data = resp.read()

        os.makedirs(os.path.dirname(os.path.abspath(path)) or ".", exist_ok=True)

        with open(path, "wb") as f:

            f.write(data)

        return f"downloaded {len(data)} bytes to {path}"

    except Exception as e:

        return f"download error: {e}"





def sha256(path):

    """Hex SHA-256 of a file."""

    import hashlib

    h = hashlib.sha256()

    with open(path, "rb") as f:

        for chunk in iter(lambda: f.read(65536), b""):

            h.update(chunk)

    return h.hexdigest()





def md5(path):

    """Hex MD5 of a file."""

    import hashlib

    h = hashlib.md5()

    with open(path, "rb") as f:

        for chunk in iter(lambda: f.read(65536), b""):

            h.update(chunk)

    return h.hexdigest()





def copy(src, dst):

    """Copy a file or directory tree."""

    import shutil

    if os.path.isdir(src):

        shutil.copytree(src, dst, dirs_exist_ok=True)

    else:

        os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)

        shutil.copy2(src, dst)

    return f"copied {src} -> {dst}"





def move(src, dst):

    """Move/rename a file or directory."""

    import shutil

    shutil.move(src, dst)

    return f"moved {src} -> {dst}"





def head(path, n=10):

    """First `n` lines of a text file."""

    out = []

    with open(path, "r", encoding="utf-8", errors="replace") as f:

        for i, line in enumerate(f):

            if i >= n:

                break

            out.append(line)

    return "".join(out)





def tail(path, n=10):

    """Last `n` lines of a text file."""

    with open(path, "r", encoding="utf-8", errors="replace") as f:

        return "".join(f.readlines()[-n:])





def grep(pattern, path=".", include=None, max_matches=100):

    """Regex-search text files under `path`. Optional `include` glob like

    '*.ts' narrows filenames. Returns file:line:line-text matches."""

    import fnmatch

    try:

        rx = re.compile(pattern)

    except Exception as e:

        return f"grep error: bad regex — {e}"

    matches = []

    for root, dirs, files in os.walk(path):

        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv", "venv"}]

        for fn in files:

            if include is not None and not fnmatch.fnmatch(fn, include):

                continue

            fp = os.path.join(root, fn)

            try:

                with open(fp, "r", encoding="utf-8", errors="replace") as f:

                    for lineno, line in enumerate(f, 1):

                        if rx.search(line):

                            matches.append(f"{fp}:{lineno}:{line.rstrip()}")

                            if len(matches) >= max_matches:

                                return "\n".join(matches)

            except OSError:

                continue

    return "\n".join(matches) or f"no matches for {pattern!r}"





def tree(path=".", depth=2, max_entries=100):

    """Print a directory tree up to `depth` levels."""

    root = os.path.abspath(path)

    if not os.path.exists(root):

        return f"tree: {path} does not exist"

    out = [root]

    def walk(d, dnum):

        if dnum > depth:

            return

        try:

            entries = sorted(os.listdir(d), key=lambda x: (not os.path.isdir(os.path.join(d, x)), x.lower()))

        except OSError as e:

            out.append(f"{'  ' * (dnum + 1)}ERROR: {e}")

            return

        for name in entries:

            if len(out) >= max_entries:

                return

            full = os.path.join(d, name)

            prefix = "  " * (dnum + 1)

            if os.path.isdir(full):

                out.append(f"{prefix}[D] {name}")

                walk(full, dnum + 1)

            else:

                out.append(f"{prefix}{name}")

    walk(root, 0)

    return "\n".join(out)





# ── advanced helpers ─────────────────────────────────────────────────────────



def http(url, method="GET", headers=None, data=None, json_body=None, timeout=30):

    """HTTP request returning {status, headers, body}. `json_body` is JSON-encoded

    and sent with a JSON content-type. `data` is sent as-is (bytes/str)."""

    payload = None

    if json_body is not None:

        payload = json.dumps(json_body, ensure_ascii=False).encode("utf-8")

        hdrs = dict(headers or {})

        hdrs.setdefault("Content-Type", "application/json")

    else:

        hdrs = dict(headers or {})

        payload = data.encode("utf-8") if isinstance(data, str) else data

    req = urllib.request.Request(url, data=payload, headers=hdrs, method=method.upper())

    try:

        with urllib.request.urlopen(req, timeout=timeout) as resp:

            body = resp.read()

            ctype = resp.headers.get("Content-Type", "")

            text = None

            if "application/json" in ctype:

                try:

                    text = json.loads(body.decode("utf-8"))

                except Exception:

                    text = body.decode("utf-8", errors="replace")

            else:

                text = body.decode("utf-8", errors="replace")

            return {"status": resp.status, "headers": dict(resp.headers), "body": text}

    except Exception as e:

        return {"error": str(e)}





def re_find(pattern, text, flags=0):

    """Return all regex matches. Each match is a tuple of groups (or the whole

    match when no groups)."""

    rx = re.compile(pattern, flags)

    out = []

    for m in rx.finditer(str(text)):

        out.append(m.groups() if m.groups() else m.group(0))

    return out





def re_sub(pattern, repl, text, count=0):

    """Regex substitution."""

    return re.sub(pattern, repl, str(text), count=count)





def file_info(path):

    """Structured metadata: size, mode, mtime, ctime, type, is_file, is_dir."""

    st = os.stat(path)

    out = {

        "path": path,

        "size": st.st_size,

        "mtime": st.st_mtime,

        "ctime": st.st_ctime,

        "mode": oct(st.st_mode),

        "is_file": os.path.isfile(path),

        "is_dir": os.path.isdir(path),

    }

    if os.path.isfile(path) and st.st_size <= 65536:

        try:

            out["sha256"] = sha256(path)

        except Exception:

            pass

    return out





def read_csv(path, delim=",", has_header=True):

    """Read a CSV/TSV into a list of dicts (header row required when

    has_header=True)."""

    import csv

    with open(path, "r", encoding="utf-8-sig", errors="replace", newline="") as f:

        if has_header:

            reader = csv.DictReader(f, delimiter=delim)

            return [dict(row) for row in reader]

        reader = csv.reader(f, delimiter=delim)

        return [row for row in reader]





def write_csv(path, rows, delim=",", columns=None):

    """Write a list of dicts (or lists) to CSV. Dicts use their keys as the

    header; pass `columns` to choose/order them."""

    import csv

    if not rows:

        with open(path, "w", encoding="utf-8", newline="") as f:

            f.write("")

        return f"wrote {path} — 0 bytes"

    if isinstance(rows[0], dict):

        cols = columns or list(rows[0].keys())

        with open(path, "w", encoding="utf-8", newline="") as f:

            w = csv.DictWriter(f, fieldnames=cols, delimiter=delim, extrasaction="ignore")

            w.writeheader()

            w.writerows(rows)

    else:

        with open(path, "w", encoding="utf-8", newline="") as f:

            w = csv.writer(f, delimiter=delim)

            if columns:

                w.writerow(columns)

            w.writerows(rows)

    return f"wrote {path} — {os.path.getsize(path)} bytes"





def read_yaml(path):

    """Read a YAML file into Python objects. Requires PyYAML."""

    try:

        import yaml

    except ImportError:

        return "read_yaml error: PyYAML is not installed (pip install pyyaml)"

    with open(path, "r", encoding="utf-8") as f:

        return yaml.safe_load(f)





def write_yaml(path, obj):

    """Write a Python object as YAML. Requires PyYAML."""

    try:

        import yaml

    except ImportError:

        return "write_yaml error: PyYAML is not installed (pip install pyyaml)"

    with open(path, "w", encoding="utf-8") as f:

        yaml.safe_dump(obj, f, sort_keys=False, allow_unicode=True)

    return f"wrote {path} — {os.path.getsize(path)} bytes"





def read_toml(path):
    """Read a TOML file (Python 3.11+ tomllib)."""
    try:
        import tomllib
    except ImportError:
        return {"error": "tomllib unavailable (Python < 3.11)"}
    if not os.path.exists(path):
        return {"error": "No such file: %s" % path}
    try:
        with open(path, "rb") as f:
            return tomllib.load(f)
    except Exception as e:
        return {"error": "read_toml failed: %s" % e}


def bash(cmd, timeout=None, **kwargs):
    """Run a shell command and return its combined output (alias of sh)."""
    return sh(cmd, timeout=timeout, **kwargs)


def write(path, content):
    """Write text to a file; returns a structured result dict.

    Returns ``{"ok": True, "path": ..., "bytes": ...}`` on success or
    ``{"ok": False, "path": ..., "error": ...}`` on failure, so the model can
    tell a successful write from an error string. (The older ``write_file``
    string form is unchanged.)
    """
    try:
        result = write_file(path, content)
    except Exception as e:
        return {"ok": False, "path": path, "error": "write error: %s" % e}
    if isinstance(result, str) and result.startswith("write_file error:"):
        return {"ok": False, "path": path, "error": result}
    try:
        bytes_on_disk = os.path.getsize(path)
    except OSError:
        bytes_on_disk = None
    return {"ok": True, "path": path, "bytes": bytes_on_disk,
            "reported": result}


def read(path, max_chars=_READ_CAP, meta=False):
    """Read a file as text, falling back to read_nontext for binary/non-text."""
    import mimetypes
    if path.lower().endswith((".ipynb", ".png", ".jpg", ".jpeg", ".gif",
                              ".pdf", ".webp", ".bmp", ".ico", ".zip")):
        return read_nontext(path)
    mime, _ = mimetypes.guess_type(path)
    if mime and not (mime.startswith("text/") or mime in (
            "application/json", "application/xml", "application/x-yaml",
            "application/x-toml", "application/x-ndjson")):
        return read_nontext(path)
    try:
        with open(path, "rb") as f:
            head = f.read(4096)
        if b"\x00" in head:
            return read_nontext(path)
    except Exception:
        pass
    return read_file(path, max_chars=max_chars, meta=meta)


def read_nontext(path, max_bytes=2_000_000):
    """Read a non-text file; returns text when decodable, else base64+metadata.

    Notebooks are parsed to their cell source when possible. Images, PDFs and
    other binary types are returned as base64 when no decoder is installed.
    """
    import mimetypes
    try:
        st = os.stat(path)
    except Exception as e:
        return {"error": "read_nontext error: %s" % e}
    mime, _ = mimetypes.guess_type(path)
    mime = mime or "application/octet-stream"
    try:
        with open(path, "rb") as f:
            data = f.read(max_bytes + 1)
    except Exception as e:
        return {"error": "read_nontext error: %s" % e}
    truncated = len(data) > max_bytes
    if truncated:
        data = data[:max_bytes]
    if path.lower().endswith(".ipynb"):
        try:
            nb = json.loads(data.decode("utf-8"))
            cells = []
            for c in nb.get("cells", []):
                src = c.get("source", "")
                if isinstance(src, list):
                    src = "".join(src)
                cells.append({"cell_type": c.get("cell_type", "code"),
                              "source": src})
            return {"path": path, "mime": "application/x-ipynb+json",
                    "size": st.st_size, "format": "jupyter-notebook",
                    "cells": cells}
        except Exception as e:
            return {"error": "read_nontext could not parse notebook: %s" % e}
    try:
        if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
            text = data.decode("utf-16")
        else:
            text = data.decode("utf-8")
        sample = text[:4096]
        if sample and all(ord(c) >= 32 or c in "\r\n\t" for c in sample):
            return {"path": path, "mime": mime, "size": st.st_size,
                    "truncated": truncated, "text": text[: _READ_CAP]}
    except Exception:
        pass
    return {"path": path, "mime": mime, "size": st.st_size,
            "truncated": truncated, "encoding": "base64",
            "base64": base64.b64encode(data).decode("ascii"),
            "note": "No decoder is installed for this MIME type; raw base64 returned."}


def base64e(data):

    """Base64-encode text/bytes."""

    b = data if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8")

    return base64.b64encode(bytes(b)).decode("ascii")





def base64d(data):

    """Base64-decode text/bytes."""

    b = data if isinstance(data, (bytes, bytearray)) else str(data).encode("utf-8")

    return base64.b64decode(bytes(b)).decode("utf-8")





def zip_dir(src, dst):

    """Zip a directory tree into `dst`."""

    import zipfile

    src = os.path.abspath(src)

    os.makedirs(os.path.dirname(os.path.abspath(dst)) or ".", exist_ok=True)

    with zipfile.ZipFile(dst, "w", zipfile.ZIP_DEFLATED) as z:

        for root, dirs, files in os.walk(src):

            for fn in files:

                full = os.path.join(root, fn)

                arc = os.path.relpath(full, src)

                z.write(full, arc)

    return f"zipped {src} -> {dst} ({os.path.getsize(dst)} bytes)"





def unzip(src, dst):

    """Extract a zip archive to `dst`."""

    import zipfile

    os.makedirs(dst, exist_ok=True)

    with zipfile.ZipFile(src, "r") as z:

        z.extractall(dst)

    return f"extracted {src} -> {dst}"





def jq(obj, expr):

    """Tiny JSON-path query using dot notation (a.b.0.c)."""

    cur = obj

    for part in str(expr).split("."):

        part = part.strip()

        if part == "":

            continue

        if isinstance(cur, (list, tuple)):

            try:

                cur = cur[int(part)]

            except (ValueError, IndexError):

                return None

        elif isinstance(cur, dict):

            if part not in cur:

                return None

            cur = cur[part]

        else:

            return None

    return cur





def search_files(query, path=".", max_matches=100, case_sensitive=False):

    """Unified search: filenames AND file contents. Returns structured list."""

    q = query if case_sensitive else query.lower()

    out = []

    for root, dirs, files in os.walk(path):

        dirs[:] = [d for d in dirs if d not in {".git", "node_modules", "__pycache__", ".venv", "venv"}]

        for fn in files:

            full = os.path.join(root, fn)

            hit_kind = None

            if case_sensitive:

                if q in fn:

                    hit_kind = "name"

            else:

                if q in fn.lower():

                    hit_kind = "name"

            if hit_kind is None:

                try:

                    with open(full, "r", encoding="utf-8", errors="ignore") as f:

                        for lineno, line in enumerate(f, 1):

                            target = line if case_sensitive else line.lower()

                            if q in target:

                                hit_kind = "content"

                                break

                except OSError:

                    continue

            if hit_kind:

                out.append({"path": full, "hit": hit_kind})

                if len(out) >= max_matches:

                    return out

    return out





def disk_usage(path="."):

    """shutil.disk_usage(path) as {total, used, free} bytes."""

    import shutil

    t, u, f = shutil.disk_usage(path)

    return {"total": t, "used": u, "free": f}





def parse_xml(text):

    """Parse XML text into a nested dict. Attributes are prefixed with @."""

    import xml.etree.ElementTree as ET

    root = ET.fromstring(str(text))

    def conv(el):

        d = {}

        if el.attrib:

            for k, v in el.attrib.items():

                d["@" + k] = v

        for child in el:

            cd = conv(child)

            tag = child.tag

            if tag in d:

                if not isinstance(d[tag], list):

                    d[tag] = [d[tag]]

                d[tag].append(cd)

            else:

                d[tag] = cd

        if el.text and el.text.strip():

            d["#text"] = el.text.strip()

        return d

    return {root.tag: conv(root)}





def process_list():

    """Running processes. Uses psutil if present, otherwise tasklist on Windows."""

    try:

        import psutil

        return [{"pid": p.pid, "name": p.name()} for p in psutil.process_iter()]

    except Exception:

        pass

    try:

        out = subprocess.run(["tasklist", "/FO", "CSV", "/NH"], capture_output=True, text=True, timeout=30)

        return out.stdout.strip() if out.returncode == 0 else "tasklist failed"

    except Exception:

        return "process_list unavailable"







def cell_timeout():

    """Return the per-cell timeout requested for the most recent cell (ms), or None."""

    return _LAST_CELL_TIMEOUT_MS[0]







def set_cwd(path):

    """Change the kernel cwd used for future cells. Persistent across cells."""

    global _KERNEL_CWD

    target = os.path.abspath(os.path.expanduser(str(path)))

    if not os.path.isdir(target):

        return f"set_cwd error: not a directory: {target}"

    os.chdir(target)

    _KERNEL_CWD = target

    return f"kernel cwd set to {target}"





def get_cwd():

    """Return the kernel cwd that will be restored at the start of each cell."""

    return _KERNEL_CWD





def _pin_cwd_for_cell(path):

    """Point the kernel at the owning chat's workspace for the coming cell.



    One kernel process serves every chat, so the parent stamps each cell with

    its chat's assigned cwd. That directory — not whatever the previous chat's

    cell or a stale set_cwd() left in the global — is authoritative for this

    cell, so it becomes the _KERNEL_CWD that the per-cell os.chdir() restores to.

    A path that no longer exists is ignored here and surfaces when the cell that

    needs it fails, exactly as set_cwd() leaves a bad target for the cell."""

    global _KERNEL_CWD

    target = os.path.abspath(os.path.expanduser(str(path)))

    if os.path.isdir(target):

        _KERNEL_CWD = target





def subagent(prompt, provider=None, label=None, max_depth=None, timeout=300.0):
    """Run a one-shot subagent through the harness's real `ctx.subagents` seam.

    The subagent is a separate agent spawned by THIS agent's owning Agent, so
    lineage, depth, workspace and policy all resolve through the harness rather
    than being re-implemented locally. When the seam is absent (e.g. a
    standalone kernel with no harness mounted) this returns a clear
    unavailable marker instead of pretending to run a child agent.

    Args:
        prompt: The task text delivered as the child's single user message.
        provider: Optional registered provider name; defaults to the first
            registered provider when omitted.
        label: Optional short display label persisted with a session-backed child.
        max_depth: Optional absolute delegation-depth cap forwarded to the seam.
        timeout: How long (seconds) to wait for the seam round-trip.

    Returns:
        A dict with `id`, `stopReason`, and `text` (joined assistant output).
    """
    seam = _seam_request("subagents.start", {
        "prompt": prompt,
        "provider": provider,
        "label": label,
        "maxDepth": max_depth,
    }, timeout=timeout)
    if seam is None:
        return {"error": "subagents seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "subagents seam rejected the request"}
    return seam.get("value")


def list_subagents(timeout=15.0):
    """List the registered subagent provider names through the harness seam."""
    seam = _seam_request("subagents.list", {}, timeout=timeout)
    if seam is None:
        return {"error": "subagents seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "subagents seam rejected the request"}
    return seam.get("value")


def list_subagent_children(timeout=15.0):
    """List this agent's direct session-backed subagents through the harness seam."""
    seam = _seam_request("subagents.children", {}, timeout=timeout)
    if seam is None:
        return {"error": "subagents seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "subagents seam rejected the request"}
    return seam.get("value")


def list_subagent_descendants(timeout=15.0):
    """List this agent's complete subagent tree through the harness seam."""
    seam = _seam_request("subagents.descendants", {}, timeout=timeout)
    if seam is None:
        return {"error": "subagents seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "subagents seam rejected the request"}
    return seam.get("value")


def goal_get(timeout=15.0):
    """Return this agent's current goal view from the harness `ctx.goals` seam.

    Returns None when no goal exists, or a dict with id, revision, objective,
    phase, maxGoalRounds, roundsStarted, and activation. The view is the
    harness's live projection, not a local copy.
    """
    seam = _seam_request("goals.get", {}, timeout=timeout)
    if seam is None:
        return {"error": "goals seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "goals seam rejected the request"}
    return seam.get("value")


def goal_create(objective, max_goal_rounds=None, timeout=15.0):
    """Create a goal for this agent through the harness `ctx.goals` seam.

    Args:
        objective: Non-empty completion objective text.
        max_goal_rounds: Optional positive safe-integer round cap; the seam's
            configured default applies when omitted.

    Returns the new goal view (id, revision, objective, phase, maxGoalRounds).
    """
    seam = _seam_request("goals.create", {
        "objective": objective,
        "maxGoalRounds": max_goal_rounds,
    }, timeout=timeout)
    if seam is None:
        return {"error": "goals seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "goals seam rejected the request"}
    return seam.get("value")


def _goal_mutation(op, **kwargs):
    """Shared CAS mutation helper for the goals seam. kwargs may carry the
    goal `id`/`revision` ref plus operation-specific fields."""
    timeout = kwargs.pop("timeout", 15.0)
    seam = _seam_request(op, kwargs, timeout=timeout)
    if seam is None:
        return {"error": "goals seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "goals seam rejected the request"}
    return seam.get("value")


def goal_edit(goal_id, revision, objective=None, max_goal_rounds=None, timeout=15.0):
    """Edit this agent's goal objective and/or round cap via the goals seam."""
    kwargs = {"id": goal_id, "revision": revision, "timeout": timeout}
    if objective is not None:
        kwargs["objective"] = objective
    if max_goal_rounds is not None:
        kwargs["maxGoalRounds"] = max_goal_rounds
    return _goal_mutation("goals.edit", **kwargs)


def goal_pause(goal_id, revision, timeout=15.0):
    """Pause this agent's goal via the goals seam."""
    return _goal_mutation("goals.pause", id=goal_id, revision=revision, timeout=timeout)


def goal_resume(goal_id, revision, timeout=15.0):
    """Resume this agent's goal via the goals seam."""
    return _goal_mutation("goals.resume", id=goal_id, revision=revision, timeout=timeout)


def goal_complete(goal_id, revision, timeout=15.0):
    """Mark this agent's goal complete via the goals seam."""
    return _goal_mutation("goals.complete", id=goal_id, revision=revision, timeout=timeout)


def goal_block(goal_id, revision, code, message, timeout=15.0):
    """Block this agent's goal with a stable kebab-case code and message."""
    return _goal_mutation("goals.block", id=goal_id, revision=revision,
                          code=code, message=message, timeout=timeout)


def goal_clear(goal_id, revision, timeout=15.0):
    """Clear this agent's goal via the goals seam; returns the cleared ref."""
    return _goal_mutation("goals.clear", id=goal_id, revision=revision, timeout=timeout)


def goal_disarm(timeout=15.0):
    """Disarm this agent's automatic goal continuation via the goals seam."""
    seam = _seam_request("goals.disarm", {}, timeout=timeout)
    if seam is None:
        return {"error": "goals seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "goals seam rejected the request"}
    return seam.get("value")


def list_tools(scope=None, timeout=15.0):
    """List this agent's visible tool schemas through the harness `ctx.tools` seam.

    Returns a list of dicts, each with `name`, `description`, and `parameters`.
    This is the model-facing, policy-filtered surface — not the raw registry.
    `scope` may name a scoped tool layer when one is active.
    """
    seam = _seam_request("tools.schemas", {"scope": scope}, timeout=timeout)
    if seam is None:
        return {"error": "tools seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "tools seam rejected the request"}
    return seam.get("value")


def tool_schema(name, scope=None, timeout=15.0):
    """Return one visible tool's schema through the harness `ctx.tools` seam.

    Returns a dict with `name`, `description`, and `parameters`, or None when
    the tool is not visible in this agent's scope.
    """
    seam = _seam_request("tools.get", {"name": name, "scope": scope}, timeout=timeout)
    if seam is None:
        return {"error": "tools seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "tools seam rejected the request"}
    return seam.get("value")


class ToolCallError(RuntimeError):
    """A harness tool call that settled as an error.

    Mirrors the `ToolCallError` the PTC-mode Python SDK declares, so a kernel
    caller branches the same way a `run_code` program does:

        try:
            text = tools.read({"path": "notes.txt"})
        except ToolCallError as e:
            print(e.toolName, e)

    `toolName` names the tool that failed and `code` carries the registry's
    structured code when it supplied one (e.g. `UNKNOWN_TOOL`,
    `ABORTED_BEFORE_DISPATCH`); the message is the tool's model-facing text.
    """

    def __init__(self, tool_name, message, code=None):
        super().__init__(message)
        self.toolName = tool_name
        self.code = code


def _tool_error_text(envelope):
    """The model-facing failure text from a `tools.call` error envelope.

    The registry renders a failure into content blocks exactly as it would for
    a model-facing call, so that rendering is the message — not the short
    `error.message`, which omits the tool's own diagnostics. Falls back to
    `error.message`, then to a fixed sentence, so a malformed envelope still
    produces a usable exception.
    """
    blocks = envelope.get("content")
    if isinstance(blocks, list):
        parts = [b.get("text") for b in blocks
                 if isinstance(b, dict) and b.get("type") == "text" and isinstance(b.get("text"), str)]
        text = "\n".join(parts).strip()
        if text:
            return text
    error = envelope.get("error")
    if isinstance(error, dict) and isinstance(error.get("message"), str) and error["message"]:
        return error["message"]
    return "the tool call failed"


def _tool_error_code(envelope):
    """The registry's structured error code from an error envelope, if any."""
    error = envelope.get("error")
    if isinstance(error, dict):
        info = error.get("info")
        if isinstance(info, dict) and isinstance(info.get("code"), str):
            return info["code"]
    return None


def call_tool(name, arguments=None, timeout=600.0, raw=False):
    """Execute one harness tool through the full `ctx.tools` pipeline.

    This is the kernel's general door onto every capability the harness mounts.
    The call goes through `ctx.tools.execute`, the SAME registry pipeline a
    model-facing call traverses — pre-execute policy, the approval gate, guards,
    the tool body, post-execute, and output validation — so a call made here is
    subject to exactly the enforcement a model-issued call is, and its result is
    the tool's canonical value rather than a parallel implementation of it.

    `name` is the registered tool name (`list_tools()` reports the visible set).
    `arguments` is the JSON arguments object the tool's schema declares; omit it
    or pass None for a tool that takes none.

    On success the tool's canonical lossless-JSON value is returned — the same
    value a `run_code` program receives from `await tools.name(args)`.

    On failure a `ToolCallError` is raised, carrying the tool's model-facing
    failure text. A denial by policy or guard arrives the same way, so a caller
    cannot mistake a refused call for a successful one.

    `raw=True` returns the whole `{isError, value, content, meta}` envelope
    instead of raising, for a caller that needs the model-facing rendering or
    the presentation metadata.

    `timeout` bounds the seam round trip in seconds. It defaults high because a
    tool may legitimately run long (a subagent, a browser session, a build); a
    call that exceeds it raises, rather than silently degrading to a local
    implementation the way the adapter helpers do.
    """
    if not isinstance(name, str) or not name:
        raise ValueError("call_tool requires a non-empty tool name")
    if arguments is None:
        arguments = {}
    if not isinstance(arguments, dict):
        raise TypeError("call_tool arguments must be a dict (or None)")

    seam = _seam_request("tools.call", {"name": name, "arguments": arguments}, timeout=timeout)
    if seam is None:
        raise ToolCallError(
            name,
            "the tools seam is unavailable: this cell has no harness connection, "
            "or it is running in the background where seam round trips are not served")
    if seam.get("unavailable"):
        raise ToolCallError(name, seam.get("error") or "the tools seam is not mounted for this agent")
    if not seam.get("ok"):
        raise ToolCallError(name, seam.get("error") or "the tools seam rejected the request")

    envelope = seam.get("value")
    if not isinstance(envelope, dict):
        raise ToolCallError(name, "the tools seam returned a malformed result")
    if raw:
        return envelope
    if envelope.get("isError"):
        raise ToolCallError(name, _tool_error_text(envelope), code=_tool_error_code(envelope))
    return envelope.get("value")


class _ToolCaller:
    """One bound tool, returned by the `tools` namespace's attribute/subscript access."""

    __slots__ = ("_name",)

    def __init__(self, name):
        self._name = name

    @property
    def name(self):
        """The registered tool name this caller invokes."""
        return self._name

    def __call__(self, arguments=None, timeout=600.0, raw=False):
        return call_tool(self._name, arguments, timeout=timeout, raw=raw)

    def __repr__(self):
        return "<harness tool %r>" % (self._name,)


class _ToolNamespace:
    """Every visible harness tool, as `tools.<name>(args)` or `tools["<name>"](args)`.

    The kernel's own helpers (`read_file`, `sh`, `bash`, `web_search`, ...) stay
    as they are: each is a fast local path for its common case and keeps working
    when no harness is attached. This namespace is the general door beside them —
    it reaches ANY tool the harness mounts, including ones with no local helper
    at all, through the real registry pipeline.

    A tool name that is not a legal Python attribute — `my-tool`, `class`, or one
    with a leading underscore — is reached by subscript: `tools["my-tool"]({...})`.
    """

    __slots__ = ()

    def __getattr__(self, name):
        # Underscore-leading names are reserved for Python's own protocol
        # lookups, and a tool genuinely named `_x` is reached by subscript.
        if name.startswith("_"):
            raise AttributeError(name)
        return _ToolCaller(name)

    def __getitem__(self, name):
        return _ToolCaller(str(name))

    def __dir__(self):
        """Every visible tool name, so completion and `dir()` show the surface."""
        entries = list_tools()
        if not isinstance(entries, list):
            return []
        return sorted(e["name"] for e in entries
                      if isinstance(e, dict) and isinstance(e.get("name"), str))

    def __repr__(self):
        return "<harness tools: call as tools.<name>({...}) or tools['<name>']({...})>"


#: The single `tools` namespace bound into every cell's globals.
tools = _ToolNamespace()


def list_sessions(timeout=15.0):
    """List live sessions known to the harness `ctx.sessions` registry.

    Returns a list of dicts, each `{id, header}` where header carries the
    session's createdAt, cwd, parentSession, and origin when present. This is
    the live in-process registry, not persisted session history.
    """
    seam = _seam_request("sessions.list", {}, timeout=timeout)
    if seam is None:
        return {"error": "sessions seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "sessions seam rejected the request"}
    return seam.get("value")


def get_session(session_id, timeout=15.0):
    """Return one live session's `{id, header}` from `ctx.sessions`, or None."""
    seam = _seam_request("sessions.get", {"id": session_id}, timeout=timeout)
    if seam is None:
        return {"error": "sessions seam unavailable (no harness or backgrounded cell)"}
    if seam.get("unavailable") or not seam.get("ok"):
        return {"error": seam.get("error") or "sessions seam rejected the request"}
    return seam.get("value")


def run_process(argv, cwd=None, input=None, env=None, max_bytes=1048576, grace_ms=10000, timeout_ms=None, timeout=30.0):
    """Run one executable through the harness `ctx.subprocess` seam (argv form).

    This is the raw no-shell process primitive: `argv` is the exact program and
    arguments, never shell-interpreted. stdout and stderr are collected in
    collect mode and returned as plain text, so this covers the "subprocess"
    half of the shell/subprocess pair without allocating a PTY.

    Args:
        argv: Non-empty list of strings; argv[0] is the executable.
        cwd: Working directory for the child (defaults to the kernel cwd).
        input: Optional stdin bytes/text written and closed before reading.
        env: Optional explicit environment entries merged over the scrubbed base.
        max_bytes: In-memory cap per collected stream (tail kept beyond it).
        grace_ms: SIGTERM→SIGKILL escalation window used by the seam.
        timeout_ms: Optional whole-run deadline; the seam aborts the tree on fire.
        timeout: How long (seconds) to wait for the seam RPC round-trip.

    Returns a dict with exitCode, signal, stdout, stderr, and truncation flags.
    """
    _cwd = cwd if cwd is not None else get_cwd()
    _seam = _seam_request("subprocess.run", {
        "argv": argv,
        "cwd": _cwd,
        "input": input,
        "env": env,
        "maxBytes": max_bytes,
        "graceMs": grace_ms,
        "timeoutMs": timeout_ms,
    }, timeout=timeout)
    if _seam is None:
        return {"error": "subprocess seam unavailable (no harness or backgrounded cell)"}
    if _seam.get("unavailable") or not _seam.get("ok"):
        return {"error": _seam.get("error") or "subprocess seam rejected the request"}
    return _seam.get("value")


def resolve_executable(command, env=None, timeout=15.0):
    """Resolve an executable in the harness's execution world via `ctx.subprocess`.

    Absolute paths are verified; bare names use the provider's scrubbed PATH
    plus explicit environment overrides. Returns the canonical path string.
    """
    _seam = _seam_request("subprocess.resolve", {"command": command, "env": env}, timeout=timeout)
    if _seam is None:
        return {"error": "subprocess seam unavailable (no harness or backgrounded cell)"}
    if _seam.get("unavailable") or not _seam.get("ok"):
        return {"error": _seam.get("error") or "subprocess seam rejected the request"}
    return _seam.get("value")


# engine setup

prompt_dict = dict(sh=sh, fetch=fetch, search=search, os=os, sys=sys,

                   read_file=read_file, write_file=write_file, append_file=append_file,

                   edit_file=edit_file, delete_file=delete_file, list_dir=list_dir,

                   find=find, glob=glob, update_todos=update_todos,

                   web_search=web_search, web_fetch=web_fetch,

                   browser_use=browser_use, list_skills=list_skills, use_skill=use_skill,

                   ask_user=ask_user,



                   memory_read=memory_read, memory_append=memory_append,

                   remember=remember, recall=recall, forget=forget,

                   index_context=index_context, search_context=search_context,

                   context_stats=context_stats,

                   subagent=subagent, list_subagents=list_subagents,
                   list_subagent_children=list_subagent_children,
                   list_subagent_descendants=list_subagent_descendants,

                   goal_get=goal_get, goal_create=goal_create,
                   goal_edit=goal_edit, goal_pause=goal_pause,
                   goal_resume=goal_resume, goal_complete=goal_complete,
                   goal_block=goal_block, goal_clear=goal_clear,
                   goal_disarm=goal_disarm,

                   list_tools=list_tools, tool_schema=tool_schema,
                   call_tool=call_tool, tools=tools, ToolCallError=ToolCallError,

                   list_sessions=list_sessions, get_session=get_session,

                   run_process=run_process, resolve_executable=resolve_executable)

# ── expression echo ───────────────────────────────────────────────────────────

# The model's only feedback channel is the cell's captured output. A bare

# expression statement — `browser_use("screenshot")`, `read_file("x")` — must

# therefore SHOW its value, or the model gets an empty OUTPUT and is left to

# guess what happened (it guesses badly: it fabricates plausible results).

#

# Both engines echo EVERY top-level bare expression, not just the last one,

# because the model routinely writes multi-call cells. Strings print raw

# (tool results are multi-line text; repr() would collapse them into one

# escaped line); everything else prints repr().

_ECHO_FN = "__kiln_echo__"





def __kiln_echo__(value):

    """Display a bare top-level expression's value. None is silent."""

    if value is None:

        return

    print(value if isinstance(value, str) else repr(value))





_CELL_FILE = "<cell>"





def _compile_cell(code, filename=_CELL_FILE):

    """Compile a cell, rewriting each top-level bare expression `x` into

    `__kiln_echo__(x)`. Nested expressions (inside defs, loops, ifs) are left

    alone — same scope rule as IPython's ast_node_interactivity='all'."""

    # register the source so tracebacks can show the offending LINE, not just

    # its number — the model reads the traceback to decide what to fix

    linecache.cache[filename] = (len(code), None, code.splitlines(True), filename)

    tree = ast.parse(code, filename)

    for i, node in enumerate(tree.body):

        if isinstance(node, ast.Expr):

            call = ast.Call(func=ast.Name(id=_ECHO_FN, ctx=ast.Load()),

                            args=[node.value], keywords=[])

            tree.body[i] = ast.Expr(value=call)

    ast.fix_missing_locations(tree)

    return compile(tree, filename, "exec")





prompt_dict[_ECHO_FN] = __kiln_echo__



# ONE engine, always. There used to be an optional IPython engine here with

# plain exec() as a silent fallback, and that split is exactly what produced

# the worst bug this kernel has had: IPython was not installed, exec echoes

# nothing, so every `browser_use("screenshot")` returned its result into the

# void and the model — handed an empty OUTPUT — invented plausible results

# instead. A fallback that is never exercised is a fallback that is broken.

#

# IPython was also actively wrong for this job: it prefixes "Out[N]: ",

# emits ANSI colour escapes and a duplicate traceback into the model's

# context, and its displayhook cannot be swapped for a quiet one without

# fighting the class. None of its real features (magics, rich display) are

# reachable by a model whose entire interface is a ```python fence.

engine = "exec"

_ns = dict(prompt_dict)







# ─────────────────────────────────────────────────────────────

# Multi-kernel orchestration

#

# The agent can summon additional kernel processes at runtime:

#

#     k = spawn_kernel("worker", permanent=False)   # or "permanent": True

#     out = k.execute("x = 21; x*2", tags=True)     # returns tagged {kernel, ts, out}

#     close_subkernel(k)

#

# Sub-kernels are true child processes running this same kernel_child.py.

# They share the wire protocol (base64 JSON frames). Output is tagged with the

# kernel id + a timestamp so the model can attribute results correctly.

#

#   - permanent=False (default): killed automatically when the MAIN kernel shuts

#     down (end of run). Reaped here.

#   - permanent=True: survives the run. Its PID is written to subkernels.json so

#     the server can adopt/reap it on next startup (avoids orphan zombie procs).

# ─────────────────────────────────────────────────────────────



import json as _json  # noqa: E402 — section-local aliases (module top already imports these names)

import subprocess as _subproc  # noqa: E402

import threading as _threading  # noqa: E402

import time as _time  # noqa: E402

_active_conv = _threading.local()



_SUBKERNELS = {}          # id -> dict(proc=..., permanent=..., name=..., created=...)

_SUBKERNEL_COUNTER = [0]

# KILN_STATE_DIR for the same reason as ds_direct's session pin: the harness

# ships this tree read-only, and a permanent sub-kernel's PID must outlive it so

# the next startup can still reap the process.

_SUBKERNEL_REGISTRY = os.path.join(

    os.environ.get("KILN_STATE_DIR") or os.path.dirname(os.path.abspath(__file__)),

    "subkernels.json")



class SubKernel:

    """A lightweight, scriptable kernel sub-process."""



    def __init__(self, proc, kid, name, permanent, cwd):

        self.proc = proc

        self.id = kid

        self.name = name or kid

        self.permanent = bool(permanent)

        self.cwd = cwd

        self._lock = _threading.Lock()

        self._results = []

        self._reader = _threading.Thread(target=self._read_loop, daemon=True)

        self._reader.start()

        # drain the child's startup ready-frame so it never gets mistaken for

        # the response to the first execute() call

        for _ in range(50):

            if self._results:

                self._results.clear()

                break

            _time.sleep(0.02)



    def _read_loop(self):

        try:

            while True:

                line = self.proc.stdout.readline()

                if line == "":

                    break

                line = line.strip()

                if not line:

                    continue

                try:

                    frame = _json.loads(base64.b64decode(line).decode("utf-8"))

                    self._results.append(frame)

                except Exception:

                    pass

        except Exception:

            pass



    def execute(self, code, timeout=None, tags=True):

        """Send a code cell to the sub-kernel; return its output.



        If tags is True (default), returns a dict with kernel id + timestamp +

        raw output, so the AI knows which kernel produced it and when.

        Returns {"kernel":..., "ts":..., "out":..., "error":...} on tagged mode;

        returns the plain output string when tags=False.

        """

        if self.proc.poll() is not None:

            return {

                "kernel": self.id,

                "ts": _time.time(),

                "out": "",

                "error": "Sub-kernel is not running (exit %s)" % self.proc.returncode,

            }

        frame_in = base64.b64encode(code.encode("utf-8")).decode("ascii") + "\n"

        try:

            self.proc.stdin.write(frame_in)

            self.proc.stdin.flush()

        except Exception as e:

            return {"kernel": self.id, "ts": _time.time(), "out": "",

                    "error": "Sub-kernel write failed: %s" % e}

        start = _time.time()

        while True:

            if timeout is not None and (_time.time() - start) > timeout:

                self.kill()

                return {"kernel": self.id, "ts": _time.time(), "out": "",

                        "error": "Sub-kernel timed out after %ss and was killed" % timeout}

            if self._results:

                frame = self._results.pop(0)

                if tags:

                    # errors arrive in the 'error' field (traceback text)

                    return {"kernel": self.id, "name": self.name, "ts": _time.time(),

                            "out": frame.get("out", ""), "error": frame.get("error")}

                return frame.get("out", "")

            if self.proc.poll() is not None:

                return {"kernel": self.id, "ts": _time.time(), "out": "",

                        "error": "Sub-kernel died mid-execution (exit %s)" % self.proc.returncode}

            _time.sleep(0.02)



    def is_alive(self):

        if self.proc is None:

            return False

        if self.id not in _SUBKERNELS:

            return False   # was closed/killed

        # give the OS a tick to reap a just-killed process

        for _ in range(5):

            if self.proc.poll() is not None:

                return False

            _time.sleep(0.02)

        return True



    def kill(self):

        """Terminate this sub-kernel process immediately."""

        try:

            if self.proc and self.proc.poll() is None:

                self.proc.kill()

        except Exception:

            pass

        _SUBKERNELS.pop(self.id, None)



    def close(self):

        """Graceful shutdown: send blank line to let it exit, then kill if needed."""

        try:

            if self.proc and self.proc.poll() is None:

                self.proc.stdin.write("\n")

                self.proc.stdin.flush()

                self.proc.wait(timeout=3)

        except Exception:

            pass

        try:

            if self.proc and self.proc.poll() is None:

                self.proc.kill()

        except Exception:

            pass

        _SUBKERNELS.pop(self.id, None)





def spawn_kernel(name=None, permanent=False, cwd=None):

    """Spawn a new sub-kernel child process and return a SubKernel handle.



    Use it to run multiple independent Python namespaces in parallel.



        k1 = spawn_kernel("worker1")

        k2 = spawn_kernel("worker2", permanent=True)



    Default cwd is the same as the current process. persistent namespaces are

    scoped per sub-kernel; they do NOT share variables with the main kernel or

    with each other (unless you explicitly pass data via stdout/shell/files).

    """

    _SUBKERNEL_COUNTER[0] += 1

    kid = "sk_%d_%d" % (os.getpid(), _SUBKERNEL_COUNTER[0])

    kname = name or kid

    child_script = os.path.join(os.path.dirname(os.path.abspath(__file__)),

                                "kernel_child.py")

    kcwd = os.path.abspath(cwd) if cwd else os.getcwd()

    env = os.environ.copy()

    env["KILN_SUBKERNEL_ID"] = kid

    env["KILN_SUBKERNEL_PERMANENT"] = "1" if permanent else "0"

    try:

        proc = _subproc.Popen(

            [sys.executable, child_script, "--subkernel", kid],

            stdin=subprocess.PIPE,

            stdout=subprocess.PIPE,

            stderr=subprocess.DEVNULL,

            cwd=kcwd,

            env=env,

            bufsize=1,

            text=True,

        )

    except Exception as e:

        raise RuntimeError("Failed to spawn sub-kernel: %s" % e)

    k = SubKernel(proc, kid, kname, permanent, kcwd)

    _SUBKERNELS[kid] = {"proc": proc, "permanent": bool(permanent),

                        "name": kname, "created": _time.time()}

    _write_subkernel_registry()

    return k





def list_subkernels():

    """Return a summary of live sub-kernels (id, name, permanent, alive)."""

    out = []

    for kid, rec in list(_SUBKERNELS.items()):

        out.append({

            "id": kid,

            "name": rec["name"],

            "permanent": rec["permanent"],

            "alive": rec["proc"].poll() is None,

            "created": rec["created"],

        })

    return out





def close_subkernel(k):

    """Gracefully shut down a specific sub-kernel."""

    if isinstance(k, SubKernel):

        k.close()

    elif isinstance(k, str):

        rec = _SUBKERNELS.get(k)

        if rec:

            # no SubKernel handle was retained for this id — kill the proc

            # directly (constructing a throwaway SubKernel would spin up a

            # reader thread and block draining a ready-frame for nothing)

            try:

                if rec["proc"].poll() is None:

                    rec["proc"].kill()

            except Exception:

                pass

            _SUBKERNELS.pop(k, None)

    _write_subkernel_registry()





def close_all_subkernels(include_permanent=True):

    """Kill sub-kernels. Non-permanent ones are always killed (that is their

    contract). Permanent ones are killed too when include_permanent=True

    (server shutdown); otherwise they are preserved and stay registered."""

    for kid, rec in list(_SUBKERNELS.items()):

        proc = rec["proc"]

        try:

            if proc.poll() is None:

                if include_permanent or not rec["permanent"]:

                    proc.kill()

        except Exception:

            pass

    # drop ephemeral entries; keep permanents when include_permanent is False

    if include_permanent:

        _SUBKERNELS.clear()

    else:

        for kid in [k for k, v in list(_SUBKERNELS.items()) if not v["permanent"]]:

            _SUBKERNELS.pop(kid, None)

    _write_subkernel_registry()





def _write_subkernel_registry():

    """Persist permanent sub-kernel PIDs so the server can adopt/reap orphans."""

    try:

        perm = {k: {"name": v["name"], "pid": int(v["proc"].pid),

                    "permanent": True, "created": v["created"],

                    "cwd": v.get("cwd", os.getcwd())}

                for k, v in _SUBKERNELS.items() if v["permanent"]}

        # KILN_STATE_DIR may not exist yet; without this the write raises and

        # the `except: pass` below turns it into a silent no-op.

        os.makedirs(os.path.dirname(os.path.abspath(_SUBKERNEL_REGISTRY)) or ".", exist_ok=True)

        tmp = _SUBKERNEL_REGISTRY + ".tmp"

        with open(tmp, "w", encoding="utf-8") as f:

            _json.dump(perm, f, ensure_ascii=False, indent=2)

        os.replace(tmp, _SUBKERNEL_REGISTRY)

    except Exception:

        pass



# preload the sub-kernel helpers so the model can call them without import

prompt_dict.update({

    "spawn_kernel": spawn_kernel,

    "list_subkernels": list_subkernels,

    "close_subkernel": close_subkernel,

    "close_all_subkernels": close_all_subkernels,

    "SubKernel": SubKernel,

})

# sync into the live namespace (was snapshotted earlier)

_ns.update(prompt_dict)
# sync into the live namespace (was snapshotted earlier)
try:
    if rlm_context is not None:
        rlm_context.install(_ns, _seam_request, _ctx_bind_entries)
except Exception as _rlm_install_error:
    sys.stderr.write("rlm_context install failed: %s\n" % _rlm_install_error)



# preload the extra utility helpers as well

prompt_dict.update({

    "get_env": get_env,

    "which": which,

    "read_json": read_json,

    "write_json": write_json,

    "download": download,

    "sha256": sha256,

    "md5": md5,

    "copy": copy,

    "move": move,

    "head": head,

    "tail": tail,

    "grep": grep,

    "tree": tree,

    "http": http,

    "re_find": re_find,

    "re_sub": re_sub,

    "file_info": file_info,

    "read_csv": read_csv,

    "write_csv": write_csv,

    "read_yaml": read_yaml,

    "write_yaml": write_yaml,

    "read_toml": read_toml,

    "base64e": base64e,

    "base64d": base64d,

    "zip_dir": zip_dir,

    "unzip": unzip,

    "jq": jq,

    "search_files": search_files,

    "disk_usage": disk_usage,

    "parse_xml": parse_xml,

    "process_list": process_list,

    "cell_timeout": cell_timeout,

    "set_cwd": set_cwd,

    "get_cwd": get_cwd,

})

_ns.update(prompt_dict)







def _tag_error(error):

    """Prefix an error with a stable category tag so the model can react to the

    KIND of failure instead of re-reading a raw traceback every time."""

    low = (error or "").lower()

    if "filenotfounderror" in low or "no such file" in low or "is a directory" in low:

        tag = "NOT_FOUND"

    elif "permissionerror" in low or "access denied" in low:

        tag = "PERMISSION"

    elif "timeout" in low or "timed out" in low:

        tag = "TIMEOUT"

    elif "syntaxerror" in low or "indentationerror" in low:

        tag = "SYNTAX"

    elif ("connection" in low or "network" in low or "urlopen" in low

          or "http" in low or "socket" in low):

        tag = "NETWORK"

    elif "keyerror" in low or "indexerror" in low or "attributeerror" in low:

        tag = "LOOKUP"

    elif "typeerror" in low or "valueerror" in low:

        tag = "TYPE"

    else:

        tag = "RUNTIME"

    return f"[ERROR:{tag}] " + error





def _format_exc(e):

    """Format an exception with Kiln's own frames stripped out. The model has

    to read this to decide what to fix, so it should see its cell and nothing

    of the harness that ran it."""

    here = os.path.abspath(__file__)



    def _ours(fn):

        return os.path.abspath(fn) == here or os.path.basename(fn) == "ast.py"



    entries = [(f, ln) for f, ln in traceback.walk_tb(e.__traceback__)

               if not _ours(f.f_code.co_filename)]

    lines = ["Traceback (most recent call last):\n"] if entries else []

    if entries:

        lines += traceback.StackSummary.extract(iter(entries)).format()

    lines += traceback.format_exception_only(type(e), e)

    return "".join(lines)





def _run_cell(code):

    # A cell that leaves sys.stdout rebound — an unexited redirect_stdout, a

    # library that wraps the stream on import, a force-stopped cell whose

    # context manager never ran __exit__ — used to silence EVERY later cell:

    # the proxy was gone, so nothing reached the thread-local buffer and each

    # subsequent result came back empty with no error to explain it. Restoring

    # the proxy per cell keeps that blast radius to the cell that caused it.

    if not isinstance(sys.stdout, _CaptureStream):

        sys.stdout = _CaptureStream(_REAL_STDOUT, "out")

    if not isinstance(sys.stderr, _CaptureStream):

        sys.stderr = _CaptureStream(_REAL_STDERR, "err")

    # Capture into THIS thread's buffers (routed by the _CaptureStream proxy)

    # rather than swapping the process-global sys.stdout: a backgrounded cell and

    # a new foreground cell run on different threads at the same time, and a

    # global redirect would splice one cell's prints into the other's output.

    out_buf = io.StringIO()

    err_buf = io.StringIO()

    _capture.out = out_buf

    _capture.err = err_buf

    error = None

    try:

        # compile first so a SyntaxError is reported as such rather than

        # blamed on whatever ran before it

        exec(_compile_cell(code), _ns)

    except BaseException as e:

        error = _format_exc(e)

    finally:

        _capture.out = None

        _capture.err = None

    out = out_buf.getvalue()

    err = err_buf.getvalue()

    if err:

        if out and not out.endswith('\n'):

            out += '\n'

        out += err

    if error:

        error = _tag_error(error)

    return out, error





# ─────────────────────────────────────────────────────────────

# Kernel state (context lives in Python variables)

#

# The namespace is the agent's real memory: every variable, import, and

# helper the model defines stays alive for the whole run. These helpers

# serialize that namespace (per-variable, dill, best-effort) so a NEW run in

# the same conversation can restore it — the model's context survives across

# runs instead of being rebuilt from scratch. Mirrors prime-agent's

# kernel/state-snapshot.ts.

# ─────────────────────────────────────────────────────────────



_SNAPSHOT_MARKER = "__KILN_KERNEL_STATE__"

_STATE_ALWAYS_SKIP = {"rlm", "asyncio", "exit", "quit", "open"}

_SNAPSHOT_MAX_BYTES = 256 * 1024 * 1024





def _ns_for_state():

    return _ns





def _user_state_names():

    """User-defined top-level names (skips internals and the preloaded helper

    set — the model wants its OWN state, not the built-ins that are

    re-injected on every start)."""

    ns = _ns_for_state()

    hidden = set()

    preloaded = set(prompt_dict) | _STATE_ALWAYS_SKIP

    names = []

    for name in list(ns.keys()):

        if name.startswith("_"):

            continue

        if name in hidden or name in preloaded:

            continue

        names.append(name)

    return sorted(names)





def _short_repr(v, n=60):

    try:

        r = repr(v)

    except Exception:

        r = object.__repr__(v)

    r = r.replace("\n", " ")

    return r if len(r) <= n else r[: n - 1] + "…"





def _obj_summary(v):

    """Compact 'type · size · preview' for one object — never dumps it."""

    t = type(v).__name__

    try:

        mod = (type(v).__module__ or "").split(".")[0]

        if mod == "pandas" and hasattr(v, "shape"):

            return "%s %s" % (t, tuple(v.shape))

        if mod == "numpy" and hasattr(v, "shape"):

            return "ndarray %s %s" % (tuple(v.shape), getattr(v, "dtype", ""))

        if isinstance(v, (str, bytes)):

            return "%s len=%s · %s" % (t, format(len(v), ","), _short_repr(v[:80]))

        if isinstance(v, dict):

            return "dict keys=%s" % format(len(v), ",")

        if isinstance(v, (list, tuple, set, frozenset)):

            return "%s len=%s" % (t, format(len(v), ","))

        if callable(v):

            return "%s (callable)" % t

        return "%s · %s" % (t, _short_repr(v))

    except Exception:

        return t





def kernel_vars(detail=True):

    """Your working memory — the variables living in the kernel across turns

    (NOT in the chat). detail=True (default) lists each name WITH its type and

    size, so you can see what you already have and slice it instead of

    reprinting it; detail=False returns just the list of names. Check here

    before redefining something — if it's already here, reuse it."""

    names = _user_state_names()

    if not detail:

        return names

    if not names:

        return "(no user variables yet — nothing saved in the kernel)"

    ns = _ns_for_state()

    width = min(24, max((len(n) for n in names), default=8) + 1)

    lines = ["%-*s %s" % (width, n, _obj_summary(ns.get(n))) for n in names]

    return ("live kernel variables (persist across turns; slice them, don't "

            "reprint them):\n" + "\n".join(lines))





def peek(x, rows=5):

    """Inspect a large value WITHOUT dumping it into the chat. Pass the value or

    its variable NAME. DataFrame → shape + dtypes + head; dict → key sample with

    value types; list/tuple → len + first items; str/bytes → len + head; ndarray

    → shape/dtype + sample. Everything is bounded, so it is safe on huge data."""

    name = ""

    if isinstance(x, str) and x in _ns:

        name, x = x, _ns[x]

    out = ["%s%s" % (name + ": " if name else "", type(x).__name__)]

    try:

        mod = (type(x).__module__ or "").split(".")[0]

        if mod == "pandas" and hasattr(x, "shape"):

            out.append("shape = %s" % (tuple(x.shape),))

            if hasattr(x, "dtypes"):

                items = list(x.dtypes.items())[:40]

                out.append("dtypes:\n" + "\n".join("  %s: %s" % (c, d) for c, d in items))

            if hasattr(x, "head"):

                out.append("head:\n" + str(x.head(rows)))

        elif mod == "numpy" and hasattr(x, "shape"):

            out.append("shape = %s, dtype = %s" % (tuple(x.shape), x.dtype))

            try:

                out.append("sample: " + str(x.ravel()[:12]))

            except Exception:

                pass

        elif isinstance(x, dict):

            out.append("%s keys" % format(len(x), ","))

            for k in list(x)[:25]:

                out.append("  %r: %s = %s" % (k, type(x[k]).__name__, _short_repr(x[k], 60)))

            if len(x) > 25:

                out.append("  … %s more keys" % format(len(x) - 25, ","))

        elif isinstance(x, (list, tuple, set, frozenset)):

            out.append("len = %s" % format(len(x), ","))

            for i, item in enumerate(list(x)[:rows]):

                out.append("  [%d] %s: %s" % (i, type(item).__name__, _short_repr(item, 90)))

            if len(x) > rows:

                out.append("  … %s more" % format(len(x) - rows, ","))

        elif isinstance(x, (str, bytes)):

            out.append("len = %s" % format(len(x), ","))

            seg = x[:800]

            out.append("head:\n" + (seg if isinstance(x, str) else seg.decode("latin-1", "replace")))

        else:

            out.append(_short_repr(x, 800))

            attrs = [a for a in dir(x) if not a.startswith("_")][:20]

            if attrs:

                out.append("attrs: " + ", ".join(attrs))

    except Exception as e:

        out.append("(peek error: %s)" % e)

    return "\n".join(out)





def snapshot_kernel_state(path, manifest_path, max_bytes=_SNAPSHOT_MAX_BYTES):

    """Serialize the user namespace to `path` (dill, per-variable best effort).

    Returns {"saved": [...], "skipped": [...], "bytes": n} or {"error": ...}.

    Never raises."""

    import datetime

    try:

        import dill

    except Exception as e:

        return {"error": "dill unavailable: %s" % e}

    dill.settings["recurse"] = True

    ns = _ns_for_state()

    hidden = set()

    payload = {}

    skipped = []

    total = 0

    for name in _user_state_names():

        if name in hidden:

            continue

        value = ns[name]

        try:

            blob = dill.dumps(value)

        except Exception as e:

            skipped.append({"name": name, "reason": "%s: %s" % (type(e).__name__, str(e)[:200])})

            continue

        if len(blob) > max_bytes or total + len(blob) > max_bytes:

            skipped.append({"name": name, "reason": "exceeds snapshot size cap"})

            continue

        payload[name] = blob

        total += len(blob)

    tmp = None

    try:

        os.makedirs(os.path.dirname(path) or ".", exist_ok=True)

        tmp = path + ".tmp"

        with open(tmp, "wb") as fh:

            dill.dump(payload, fh)

        os.replace(tmp, path)

    except Exception as e:

        try:

            if tmp:

                os.remove(tmp)

        except Exception:

            pass

        return {"error": "write failed: %s" % e}

    manifest = {

        "version": 1,

        "savedNames": sorted(payload),

        "skipped": skipped,

        "bytes": os.path.getsize(path),

        "pythonVersion": sys.version.split()[0],

        "timestamp": datetime.datetime.now(datetime.timezone.utc).isoformat(),

    }

    try:

        with open(manifest_path, "w", encoding="utf-8") as fh:

            json.dump(manifest, fh, ensure_ascii=False, indent=2)

    except Exception:

        pass

    return {"saved": sorted(payload.keys()), "skipped": skipped, "bytes": manifest["bytes"]}





def restore_kernel_state(path):

    """Revive a snapshot into the user namespace. Returns

    {"restored": [...], "failed": [...]} (+ optional "error"). Never raises."""

    if not path or not os.path.exists(path):

        return {"restored": [], "failed": []}

    try:

        import dill

    except Exception as e:

        return {"restored": [], "failed": [], "error": "dill unavailable: %s" % e}

    try:

        with open(path, "rb") as fh:

            payload = dill.load(fh)

    except Exception as e:

        return {"restored": [], "failed": [], "error": "load failed: %s" % e}

    if not isinstance(payload, dict):

        return {"restored": [], "failed": [], "error": "corrupt snapshot: not a dict"}

    ns = _ns_for_state()

    restored, failed = [], []

    for name, blob in payload.items():

        try:

            ns[name] = dill.loads(blob)

            restored.append(name)

        except Exception as e:

            failed.append({"name": name, "reason": "%s: %s" % (type(e).__name__, str(e)[:200])})

    return {"restored": sorted(restored), "failed": failed}





# kernel_vars is defined after the prompt_dict build above; register it now so

# the model can list its namespace without an import.

prompt_dict["kernel_vars"] = kernel_vars

_ns["kernel_vars"] = kernel_vars

prompt_dict["peek"] = peek

_ns["peek"] = peek





# ─────────────────────────────────────────────────────────────

# Two-tier cell execution (primary -> background, secondary -> stop)

#

# A cell runs in its own daemon thread so the read/dispatch loop stays free. If

# it finishes within the PRIMARY budget its result is returned as usual; if it

# overruns it is NOT killed and the namespace is NOT lost. Instead the cell is

# moved to the BACKGROUND, the loop returns a notice so the model can keep

# working, and a watchdog force-stops it only once the much-larger SECONDARY

# budget passes. Background cells run concurrently with new foreground cells, so

# a long-running job never blocks the next command.

#

# Output is captured PER THREAD (thread-local buffers routed by the proxy below)

# so a backgrounded cell and a foreground cell never cross streams. When a

# background cell finishes or is stopped, its output is surfaced on the next

# frame the loop sends.

# ─────────────────────────────────────────────────────────────

import ctypes as _ctypes

import pickle

import gzip

import tempfile



_REAL_STDOUT = sys.stdout

_REAL_STDERR = sys.stderr

_capture = _threading.local()

# ── deep-bridge seam transport (Kiln → harness) ──────────────────────────
# The harness passes a dedicated seam-response pipe on fd 3. Only the
# foreground cell thread may attempt a seam round-trip; a backgrounded cell
# falls back to its local implementation (a response can never race the
# main stdin loop, and two threads never contend for fd 3).
_SEAM_FD = None
try:
    _SEAM_FD = os.fdopen(3, 'rb')
except Exception:
    _SEAM_FD = None
_seam_fg_thread = None
_seam_lock = _threading.Lock()





class _CaptureStream:

    """Route writes to the running cell's thread-local buffer, or to the real

    stream on any thread not executing a captured cell — so the loop's own

    protocol writes (send_frame) pass straight through to the real stdout."""



    def __init__(self, real, attr):

        object.__setattr__(self, "_real", real)

        object.__setattr__(self, "_attr", attr)



    def write(self, s):

        buf = getattr(_capture, self._attr, None)

        return buf.write(s) if buf is not None else self._real.write(s)



    def flush(self):

        buf = getattr(_capture, self._attr, None)

        if buf is None:

            self._real.flush()



    def __getattr__(self, name):

        return getattr(object.__getattribute__(self, "_real"), name)





sys.stdout = _CaptureStream(_REAL_STDOUT, "out")

sys.stderr = _CaptureStream(_REAL_STDERR, "err")



_DEFAULT_PRIMARY_MS = 180_000        # background a cell still running after this

_SECONDARY_FACTOR = 5                # secondary budget = this x primary when unset

_MIN_SECONDARY_MS = 600_000          # ...but never less generous than 10 minutes



_bg_lock = _threading.Lock()

_bg_runners = {}                     # bg_id -> _CellRunner still running in background

_bg_results = []                     # finished/stopped background output awaiting a frame

_bg_counter = [0]





class _CellRunner(_threading.Thread):

    """One cell, executed off the dispatch loop so it can outlive its primary

    budget without blocking the next command."""



    def __init__(self, code, conv=None):

        super().__init__(daemon=True)

        self._code = code

        self._conv = conv if conv else None

        self.out = ""

        self.err = None

        self.done = _threading.Event()

        self.bg_id = None

        self.deadline = None

        self.stopped = False



    def run(self):

        _active_conv.value = self._conv

        # The FIRST cell to run installs the generated harness-tool functions.
        # It has to happen here rather than at import: `list_tools` needs a seam
        # round trip, and only a cell running on the foreground thread can make
        # one. A failure is recorded, not raised — a cell must still run when
        # the harness is absent or its schemas are malformed.
        if not _TOOLS_INSTALLED[0]:
            try:
                _install_harness_tools()
            except BaseException as e:
                prompt_dict["_harness_tools_error"] = _format_exc(e)

        try:

            self.out, self.err = _run_cell(self._code)

        except BaseException as e:          # never let a runner thread die silently

            self.err = _tag_error(_format_exc(e))

        finally:

            _active_conv.value = None

            self.done.set()





def _stop_runner(runner):

    """Best-effort hard stop: raise KeyboardInterrupt inside the runner thread.

    It fires at a Python bytecode boundary; a thread deep in an uninterruptible

    C call may not stop, but it never blocks the loop or a foreground cell."""

    tid = runner.ident

    if tid is None:

        return

    _ctypes.pythonapi.PyThreadState_SetAsyncExc(

        _ctypes.c_long(tid), _ctypes.py_object(KeyboardInterrupt))





def _bg_body(runner):

    body = runner.out or ""

    if runner.err:

        if body and not body.endswith("\n"):

            body += "\n"

        body += runner.err

    return body.rstrip("\n")





def _flush_bg():

    """Collect background cells that finished since the last frame, drop them

    from the registry, and return their output to prepend to the next result."""

    with _bg_lock:

        for bid, runner in [(b, r) for b, r in _bg_runners.items() if r.done.is_set()]:

            status = "stopped after its background timeout" if runner.stopped else "finished"

            _bg_results.append("[bg#%d %s]\n%s" % (bid, status, _bg_body(runner)))

            del _bg_runners[bid]

        if not _bg_results:

            return ""

        chunk = "\n".join(_bg_results) + "\n"

        _bg_results.clear()

        return chunk





def _join_stray(body):

    """Append anything that reached the real fd 1 to a frame's output.

    Before the fd-1 quarantine this text went onto the protocol channel and

    broke it; now it is recovered and shown to the model instead."""

    stray = take_stray_output()

    if not stray:

        return body

    if body and not body.endswith("\n"):

        body += "\n"

    return body + stray + "\n"


def _bg_watchdog():

    """Force-stop any background cell that passes its (generous) secondary

    deadline. Runs forever on its own daemon thread."""

    while True:

        time.sleep(0.5)

        now = time.monotonic()

        with _bg_lock:

            due = [r for r in _bg_runners.values()

                   if not r.done.is_set() and r.deadline is not None and now >= r.deadline]

        for runner in due:

            runner.stopped = True

            _stop_runner(runner)





_threading.Thread(target=_bg_watchdog, daemon=True).start()





def _secondary_ms(primary_ms, requested):

    """The generous stop deadline for a backgrounded cell: the caller's value

    when given (never below the primary), otherwise a multiple of the primary."""

    if requested is not None:

        return max(int(requested), int(primary_ms))

    return max(int(primary_ms) * _SECONDARY_FACTOR, _MIN_SECONDARY_MS)





_CELL_PREFIX = "\x00KILN_CELL\x00"

_CTRL_PREFIX = "\x00KILN_CTRL\x00"

_LAST_CELL_TIMEOUT_MS = [None]





def _handle_ctrl(req):

    """Dispatch a control request from the parent; returns the result dict."""

    cmd = req.get("cmd") if isinstance(req, dict) else None

    if cmd == "snapshot":

        return snapshot_kernel_state(

            req.get("path", ""), req.get("manifest", ""),

            int(req.get("max_bytes") or 0) or _SNAPSHOT_MAX_BYTES)

    if cmd == "restore":

        return restore_kernel_state(req.get("path", ""))

    if cmd == "list_names":

        return {"names": _user_state_names()}

    return {"error": "unknown kernel control command: %r" % cmd}



def _seam_request(op, args, timeout=30.0):
    """Ask the harness for one seam operation; return its response dict, or
    None when the transport is absent, the caller is a backgrounded cell, or
    the round-trip timed out — every None means the caller must use its own
    local implementation instead."""
    if _threading.current_thread() is not _seam_fg_thread:
        return None
    if _SEAM_FD is None:
        return None
    with _seam_lock:
        req_id = uuid.uuid4().hex
        try:
            send_frame({"seam": {"id": req_id, "op": op, "args": args}})
        except Exception:
            return None
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            try:
                line = _SEAM_FD.readline()
                if not line:
                    return None
                obj = json.loads(base64.b64decode(line.strip()).decode('utf-8'))
            except Exception:
                continue
            if obj.get('id') == req_id:
                return obj
    return None


def send_frame(obj):

    # Straight to the private protocol stream, never the capture proxy and

    # never fd 1: a frame is the protocol, not cell output, and fd 1 is shared

    # with every subprocess and C extension the cell can reach.

    stream = _PROTO_STREAM if _PROTO_STREAM is not None else _REAL_STDOUT

    stream.write(base64.b64encode(json.dumps(obj, ensure_ascii=False).encode('utf-8')).decode('ascii') + '\n')

    stream.flush()




def _get_state_dir():
    """Base directory for kernel-owned persistent state."""
    return os.environ.get("KILN_STATE_DIR") or os.path.dirname(os.path.abspath(__file__))

def _get_memory_file():
    """JSON file backing memory_store/memory_recall/memory_list."""
    return os.path.join(_get_state_dir(), "kernel_memory.json")

def _get_checkpoint_dir():
    """Directory holding kernel checkpoints."""
    return os.path.join(_get_state_dir(), "checkpoints")

def notebook_edit(filepath, cell_index=None, new_source=None, cell_type=None,

                  insert_after=None, delete=False, dry_run=False,

                  add_output=False, output_text=None, metadata=None):

    """Edit a Jupyter notebook (ipynb) file.



    Args:

        filepath: Path to .ipynb file.

        cell_index: Index of cell to modify (0-based); if None, uses insert_after.

        new_source: New source code for the cell (if modifying).

        cell_type: 'code', 'markdown', or 'raw' (for new cells).

        insert_after: Insert a new cell after this index; if None and cell_index None, appends.

        delete: If True, delete the specified cell.

        dry_run: If True, return the modified notebook structure without writing.

        add_output: If True, add output to the cell (requires output_text).

        output_text: Text to add as output (for code cells).

        metadata: Dict of metadata to set on the cell.



    Returns:

        Dict with success status and modified notebook structure.

    """

    import json

    import copy

    if not os.path.exists(filepath):

        return {'error': f'Notebook file not found: {filepath}'}

    try:

        with open(filepath, 'r', encoding='utf-8') as f:

            nb = json.load(f)

    except json.JSONDecodeError as e:

        return {'error': f'Invalid JSON: {e}'}

    if 'cells' not in nb:

        return {'error': 'Notebook has no "cells" key'}

    cells = nb['cells']

    modified = False



    if delete:

        if cell_index is None:

            return {'error': 'cell_index required for delete'}

        if 0 <= cell_index < len(cells):

            del cells[cell_index]

            modified = True

        else:

            return {'error': f'cell_index {cell_index} out of range (0-{len(cells)-1})'}

    elif new_source is not None and cell_index is not None:

        # Modify existing cell

        if 0 <= cell_index < len(cells):

            cells[cell_index]['source'] = new_source

            if cell_type:

                cells[cell_index]['cell_type'] = cell_type

            if metadata:

                cells[cell_index]['metadata'] = metadata

            if add_output and output_text is not None:

                cells[cell_index]['outputs'] = [{'output_type': 'stream', 'name': 'stdout', 'text': output_text}]

            modified = True

        else:

            return {'error': f'cell_index {cell_index} out of range (0-{len(cells)-1})'}

    elif insert_after is not None or cell_index is None:

        # Insert a new cell

        if not new_source:

            return {'error': 'new_source required for insertion'}

        new_cell = {

            'cell_type': cell_type or 'code',

            'metadata': metadata or {},

            'source': new_source,

            'outputs': [] if (cell_type or 'code') == 'code' else None

        }

        pos = insert_after + 1 if insert_after is not None else len(cells)

        cells.insert(pos, new_cell)

        modified = True

    else:

        return {'error': 'No valid operation specified'}



    if dry_run:

        return {'success': True, 'dry_run': True, 'notebook': nb}

    if modified:

        with open(filepath, 'w', encoding='utf-8') as f:

            json.dump(nb, f, indent=2, ensure_ascii=False)

        return {'success': True, 'file': filepath}

    else:

        return {'success': False, 'message': 'No changes made'}





def monitor(description, interval=1.0, timeout=None, callback=None):

    """Monitor a process or operation with progress.



    Args:

        description: Description of what's being monitored.

        interval: Update interval in seconds.

        timeout: Timeout in seconds; if None, run until stopped.

        callback: Function called with progress (0-1) and message.



    Returns:

        A monitor object with .stop() method.

    """

    import threading

    import time

    class Monitor:

        def __init__(self, desc, interval, timeout, callback):

            self.desc = desc

            self.interval = interval

            self.timeout = timeout

            self.callback = callback

            self.running = True

            self.start_time = time.time()

            self.thread = threading.Thread(target=self._run)

            self.thread.daemon = True

            self.thread.start()

        def _run(self):

            elapsed = 0

            while self.running:

                elapsed = time.time() - self.start_time

                if self.timeout and elapsed > self.timeout:

                    break

                if self.callback:

                    progress = min(elapsed / self.timeout if self.timeout else 0.0, 1.0)

                    self.callback(progress, f"{self.desc} elapsed {elapsed:.1f}s")

                time.sleep(self.interval)

        def stop(self):

            self.running = False

            if self.thread.is_alive():

                self.thread.join(timeout=0.5)

    return Monitor(description, interval, timeout, callback)





# Simple scheduler

_schedules = {}



def schedule(action, delay=None, interval=None, args=None):

    """Schedule an action to run after delay or periodically.



    Args:

        action: Callable or command string (if string, executed via sh).

        delay: Initial delay in seconds; if None, runs immediately (but async).

        interval: If provided, repeat every interval seconds.

        args: Tuple of arguments to pass to action (if callable).



    Returns:

        A schedule object with .cancel() method.

    """

    import threading

    import time

    import uuid

    from functools import partial



    class Schedule:

        def __init__(self):

            self._cancelled = False

            self._timer = None

            self._lock = threading.Lock()

        def cancel(self):

            with self._lock:

                self._cancelled = True

                if self._timer:

                    self._timer.cancel()

        def _run(self):

            try:

                if callable(action):

                    if args:

                        action(*args)

                    else:

                        action()

                elif isinstance(action, str):

                    sh(action)

                else:

                    raise ValueError('action must be callable or string')

            except Exception as e:

                # Log the error without crashing the scheduler thread.

                import traceback as _tb

                print(f"[schedule] action failed: {e}", file=__import__('sys').stderr)

            finally:

                if interval and not self._cancelled:

                    self._schedule_next()

        def _schedule_next(self):

            with self._lock:

                if not self._cancelled:

                    self._timer = threading.Timer(interval, self._run)

                    self._timer.daemon = True

                    self._timer.start()

    sched = Schedule()

    if delay:

        timer = threading.Timer(delay, sched._run)

        timer.daemon = True

        timer.start()

        sched._timer = timer

    else:

        t = threading.Thread(target=sched._run)

        t.daemon = True

        t.start()

    return sched

def routine(name, steps):

    """Define a named routine with retries and conditional steps.



    Args:

        name: Name of the routine.

        steps: List of step dicts:

            {'action': callable, 'retries': int, 'condition': callable, 'continue_on_error': bool}



    Returns:

        Dict with results: {'name': name, 'steps': [{'step': i, 'success': bool, 'error': str, ...}], 'success': bool}

    """

    import time

    results = []

    overall_success = True

    for i, step in enumerate(steps):

        step_result = {'step': i}

        action = step.get('action')

        retries = step.get('retries', 0)

        condition = step.get('condition')

        continue_on_error = step.get('continue_on_error', False)



        if condition and callable(condition):

            try:

                if not condition():

                    step_result['skipped'] = True

                    step_result['reason'] = 'Condition failed'

                    results.append(step_result)

                    continue

            except Exception as e:

                step_result['error'] = str(e)

                step_result['success'] = False

                overall_success = False

                results.append(step_result)

                if not continue_on_error:

                    return {'name': name, 'steps': results, 'success': False}

                continue



        last_error = None

        for attempt in range(retries + 1):

            try:

                if callable(action):

                    result = action()

                    step_result['success'] = True

                    step_result['result'] = result

                    break

                else:

                    raise ValueError('action must be callable')

            except Exception as e:

                last_error = str(e)

                if attempt < retries:

                    time.sleep(1)

                else:

                    step_result['success'] = False

                    step_result['error'] = last_error

                    overall_success = False

        results.append(step_result)

        if not step_result.get('success', True) and not continue_on_error:

            return {'name': name, 'steps': results, 'success': False}

    return {'name': name, 'steps': results, 'success': overall_success}

def memory_store(key, value, ttl=None, append=False):

    """Store a value persistently with TTL and append support.



    Args:

        key: Key for the value.

        value: Value to store (JSON-serializable).

        ttl: Time-to-live in seconds.

        append: If True, append value to existing list (value must be list).



    Returns:

        Dict with stored info.

    """

    import json

    import time

    mem_file = _get_memory_file()

    memory = {}

    if os.path.exists(mem_file):

        try:

            with open(mem_file, 'r', encoding='utf-8') as f:

                memory = json.load(f)

        except:

            pass

    # Clean expired

    now = time.time()

    for k in list(memory.keys()):

        if 'expires' in memory[k] and memory[k]['expires'] < now:

            del memory[k]

    if key in memory and append:

        if isinstance(memory[key].get('value'), list) and isinstance(value, list):

            memory[key]['value'].extend(value)

        else:

            return {'error': 'Cannot append: existing value not a list or value not a list'}

    else:

        memory[key] = {'value': value, 'timestamp': now}

        if ttl:

            memory[key]['expires'] = now + ttl

    with open(mem_file, 'w', encoding='utf-8') as f:

        json.dump(memory, f, indent=2)

    return {'key': key, 'stored': True, 'ttl': ttl}





def memory_recall(key, default=None):

    """Recall a value from persistent memory.



    Args:

        key: Key to retrieve.

        default: Default value if key not found or expired.



    Returns:

        Stored value or default.

    """

    import json

    import time

    mem_file = _get_memory_file()

    if not os.path.exists(mem_file):

        return default

    try:

        with open(mem_file, 'r', encoding='utf-8') as f:

            memory = json.load(f)

    except:

        return default

    now = time.time()

    if key in memory:

        entry = memory[key]

        if 'expires' in entry and entry['expires'] < now:

            del memory[key]  # clean on access

            with open(mem_file, 'w', encoding='utf-8') as f:

                json.dump(memory, f, indent=2)

            return default

        return entry['value']

    return default





def memory_list(pattern=None, include_expired=False):

    """List keys in persistent memory.



    Args:

        pattern: Regex pattern to filter keys.

        include_expired: If True, include expired entries.



    Returns:

        List of dicts with key, timestamp, expires (if any).

    """

    import json

    import time

    import re

    mem_file = _get_memory_file()

    if not os.path.exists(mem_file):

        return []

    try:

        with open(mem_file, 'r', encoding='utf-8') as f:

            memory = json.load(f)

    except:

        return []

    now = time.time()

    result = []

    for k, v in memory.items():

        if pattern and not re.search(pattern, k):

            continue

        if not include_expired and 'expires' in v and v['expires'] < now:

            continue

        entry = {'key': k, 'timestamp': v['timestamp']}

        if 'expires' in v:

            entry['expires'] = v['expires']

        result.append(entry)

    return result





def enter_worktree(path, create=False):

    """Enter a worktree directory, optionally creating it.



    Args:

        path: Directory path.

        create: If True, create directory if it doesn't exist.



    Returns:

        Dict with status and absolute path.

    """

    if create and not os.path.exists(path):

        os.makedirs(path, exist_ok=True)

    if not os.path.isdir(path):

        return {'error': f'Not a directory: {path}'}

    os.chdir(path)

    return {'success': True, 'cwd': os.getcwd()}





def stop_agent(agent_id):

    """Stop a running background agent by ID (alias for interrupt_agent).



    Args:

        agent_id: The agent ID.

    """

    # We'll call interrupt_agent if available

    if 'interrupt_agent' in globals():

        return interrupt_agent(agent_id)

    else:

        return {'error': 'interrupt_agent not available'}







def _harness_tool_names(scope=None):
    """Names of the harness tools visible to this cell, or None with no harness.

    `list_tools` answers with an `{"error": ...}` dict rather than raising when
    the tools seam is not mounted (no harness attached, or a backgrounded cell),
    so the probe can tell "no harness" apart from "a harness exposing no tools".
    """
    listing = list_tools(scope=scope)
    if not isinstance(listing, list):
        return None
    return sorted(entry["name"] for entry in listing
                  if isinstance(entry, dict) and isinstance(entry.get("name"), str))


def tool_help(tool_name=None, pattern=None):
    """Display help for all tools, one tool, or a glob/substring pattern.

    Covers BOTH kinds of callable a cell has: the preloaded local helpers, and
    every harness tool reachable through the `tools` namespace. `tool_help()`
    lists both; `tool_help("read_file")` returns a helper's docstring, and
    `tool_help("read")` — bare or as `tool_help("tools.read")` — returns the
    harness tool's schema as the model itself would see it.

    The harness half is what makes the general door discoverable: a helper that
    exists only in the harness (no local equivalent) is otherwise reachable but
    invisible to anyone asking the kernel what it can do.
    """
    import inspect
    catalog = {}
    for name, obj in globals().items():
        if name.startswith("_"):
            continue
        if not (inspect.isfunction(obj) or inspect.isbuiltin(obj)):
            continue
        doc = inspect.getdoc(obj)
        if doc:
            catalog[name] = doc

    harness = _harness_tool_names()

    if tool_name:
        # A harness tool is named either bare or with its `tools.` prefix; the
        # prefixed form is what a caller copies straight out of a listing.
        bare = tool_name[6:] if tool_name.startswith("tools.") else tool_name
        if bare in catalog:
            return "%s:\n%s" % (bare, catalog[bare])
        if harness is not None and bare in harness:
            schema = tool_schema(bare)
            if isinstance(schema, dict) and schema.get("name"):
                return "tools.%s (harness tool):\n%s\n\nparameters:\n%s" % (
                    bare,
                    schema.get("description") or "",
                    json.dumps(schema.get("parameters"), indent=2, ensure_ascii=False),
                )
        return "No help found for %s" % tool_name

    names = sorted(catalog)
    if pattern:
        names = [n for n in names
                 if fnmatch.fnmatch(n, pattern) or pattern in n]
    lines = ["Available tools:", ""]
    if not names:
        lines.append("  (no tools matched %r)" % pattern)
    for name in names:
        first = catalog[name].splitlines()[0] if catalog[name] else ""
        lines.append("  %s -- %s" % (name, first))

    lines += ["", "Harness tools (any tool the harness mounts):", ""]
    if harness is None:
        lines.append("  (unavailable: no harness is attached, or this cell is backgrounded)")
        return "\n".join(lines)
    matched = harness
    if pattern:
        matched = [n for n in harness
                   if fnmatch.fnmatch(n, pattern) or pattern in n]
    if not matched:
        lines.append("  (none matched %r)" % pattern)
    for name in matched:
        lines.append("  tools.%s" % name)
    if not pattern:
        lines += [
            "",
            "  tools.<name>({...}) calls any of them through the same registry",
            "  pipeline a model-issued call uses — policy, approval, guards, and",
            "  output validation all apply — and returns the tool's canonical",
            "  value. A refusal or failure raises ToolCallError. Use",
            "  tool_help('tools.<name>') for one tool's schema.",
        ]
    return "\n".join(lines)

# ─────────────────────────────────────────────────────────────
# Every harness tool as a real Python function
#
# `tools.<name>({...})` reaches any tool, but a cell author wants
# `read(...)`, `web_search(...)`, `subagent(...)` — real functions whose
# signatures, defaults, and docstrings are visible to `help()`, to
# `inspect.signature`, and to anyone reading the cell.
#
# These are GENERATED from the registry's own schemas. Nothing below is a
# hand-written per-tool wrapper, so a tool the harness adds appears here
# without editing this file, a schema change lands in the signature, and a
# removed tool stops being offered. A hand-written list is exactly the thing
# that goes stale and silently omits a capability.
# ─────────────────────────────────────────────────────────────

import keyword as _keyword

#: tool name -> the generated function, for introspection and tests.
_HARNESS_FUNCS = {}

#: harness tool name -> the local helper kept as `local_<name>` because both
#: wanted the same name. Recorded so the shadowing is visible, never silent.
_HARNESS_SHADOWED = {}

#: Names a generated signature claims for its own controls, so a schema
#: property with one of these names is renamed instead of colliding.
_HARNESS_CONTROL_PARAMS = ("timeout", "raw")

#: One-shot latch: the first foreground cell installs the functions, because
#: only a cell runs on the thread the seam serves.
_TOOLS_INSTALLED = [False]


class _Unset:
    """Marks "the caller passed nothing" apart from "the caller passed None".

    A property whose schema admits null must be able to receive an explicit
    `None`; every other property treats `None` as "argument omitted". A plain
    `None` default cannot express that difference, so an omitted nullable
    property would be sent as `{"prop": null}` — an argument the tool never
    asked for. This sentinel is the default instead, and only a value that is
    not the sentinel is placed in the call.
    """

    __slots__ = ()

    def __repr__(self):
        return "<not provided>"


_UNSET = _Unset()


def _schema_allows_null(sub):
    """Whether a property schema admits an explicit null.

    The distinction matters: a property that admits null needs `None` passed
    THROUGH to the tool, while for every other property `None` means "argument
    omitted". Conflating them would send `{"path": null}` to a tool that only
    wanted no `path` at all.
    """
    if not isinstance(sub, dict):
        return False
    declared = sub.get("type")
    if declared == "null" or (isinstance(declared, list) and "null" in declared):
        return True
    for key in ("anyOf", "oneOf"):
        options = sub.get(key)
        if isinstance(options, list):
            for option in options:
                if isinstance(option, dict) and option.get("type") == "null":
                    return True
    return False


def _tool_param_name(raw, used):
    """A legal, non-colliding Python parameter name for a schema property."""
    candidate = re.sub(r"\W", "_", str(raw))
    if not candidate or candidate[0].isdigit():
        candidate = "_" + candidate
    if _keyword.iskeyword(candidate):
        candidate += "_"
    base, n = candidate, 2
    while candidate in used or candidate in _HARNESS_CONTROL_PARAMS:
        candidate = "%s_%d" % (base, n)
        n += 1
    used.add(candidate)
    return candidate


def _schema_type_label(sub):
    """A short human type label for one property schema."""
    if not isinstance(sub, dict):
        return "any"
    declared = sub.get("type")
    if isinstance(declared, list):
        return "|".join(str(t) for t in declared if t != "null") or "any"
    if isinstance(declared, str) and declared != "null":
        return declared
    for key in ("anyOf", "oneOf"):
        options = sub.get(key)
        if isinstance(options, list):
            parts = [o.get("type") for o in options
                     if isinstance(o, dict) and isinstance(o.get("type"), str)]
            parts = [p for p in parts if p != "null"]
            if parts:
                return "|".join(parts)
    return "any"


def _make_tool_function(tool_name, schema):
    """Generate one real Python function that dispatches `tool_name`.

    The function is built by `exec` so its signature is genuine — the
    parameters, their defaults, and their order all come from the tool's own
    schema, which is what makes `help(read)` and tab-completion useful instead
    of showing an opaque `**kwargs`.
    """
    params = schema.get("parameters") if isinstance(schema, dict) else None
    if not isinstance(params, dict):
        params = {}
    properties = params.get("properties")
    if not isinstance(properties, dict):
        properties = {}
    declared_required = params.get("required")
    required_names = ([r for r in declared_required if isinstance(r, str)]
                      if isinstance(declared_required, list) else [])

    used = set()
    fields = []  # (py_name, raw_name, allows_null, is_required, label)
    for raw in properties:
        sub = properties.get(raw)
        fields.append((
            _tool_param_name(raw, used),
            str(raw),
            _schema_allows_null(sub),
            str(raw) in required_names,
            _schema_type_label(sub),
        ))
    # Required first so they are positional; schema order is preserved within
    # each group, which keeps the signature stable for a given schema.
    fields.sort(key=lambda f: 0 if f[3] else 1)

    # A nullable property defaults to the sentinel, not to None: `None` is a
    # value it must be able to receive, so it needs a distinct "not passed".
    positional = []
    for py_name, _raw, allows_null, is_required, _label in fields:
        if is_required:
            positional.append(py_name)
        else:
            positional.append("%s=%s" % (py_name, "_UNSET" if allows_null else "None"))

    if fields:
        signature = ", ".join(positional + ["timeout=600.0", "raw=False", "**extra"])
        body = ["    _args = {}"]
        for py_name, raw_name, allows_null, is_required, _label in fields:
            if is_required:
                body.append("    _args[%r] = %s" % (raw_name, py_name))
            elif allows_null:
                body.append("    if %s is not _UNSET:" % py_name)
                body.append("        _args[%r] = %s" % (raw_name, py_name))
            else:
                body.append("    if %s is not None:" % py_name)
                body.append("        _args[%r] = %s" % (raw_name, py_name))
        body.append("    _args.update(extra)")
    else:
        # A schema declaring no properties leaves nothing to name, so the one
        # positional parameter is the whole argument object. Without this the
        # first positional would land on `timeout`, and `tool({...})` — the
        # natural spelling, and the one `tools.<name>` already accepts — would
        # fail deep inside the call instead of at the signature.
        signature = ", ".join(["arguments=None", "timeout=600.0", "raw=False", "**extra"])
        body = [
            "    _args = {} if arguments is None else arguments",
            "    if isinstance(_args, dict):",
            "        _args = dict(_args)",
            "        _args.update(extra)",
        ]
    body.append("    return call_tool(%r, _args, timeout=timeout, raw=raw)" % tool_name)

    description = (schema.get("description") if isinstance(schema, dict) else None) or ""
    doc = ["Run the `%s` harness tool." % tool_name, ""]
    if description:
        doc += [description.strip(), ""]
    if fields:
        doc.append("Arguments (as the harness declares them):")
        for py_name, raw_name, allows_null, is_required, label in fields:
            note = "required" if is_required else "optional"
            if allows_null:
                note += ", may be None"
            if py_name != raw_name:
                note += ", passed as %s" % raw_name
            doc.append("  %-18s %s  [%s]" % (raw_name, label, note))
        doc.append("")
    else:
        # The schema names no properties, so there is nothing to list — but the
        # function still takes the argument object, and saying "no arguments"
        # would send a caller looking for a different spelling.
        doc += [
            "Takes no declared arguments; pass the whole argument object",
            "positionally, e.g. `%s({...})`." % tool_name,
            "",
        ]
    doc += [
        "Dispatches through `ctx.tools.execute`, so policy, guards, approval,",
        "and output validation apply exactly as for a model-issued call, and the",
        "returned value is the tool's canonical lossless-JSON value. A refusal or",
        "failure raises ToolCallError. `timeout` bounds the round trip; `raw=True`",
        "returns the whole {isError, value, content, meta} envelope. Extra keyword",
        "arguments are passed through verbatim, which reaches any property the",
        "signature had to rename.",
    ]

    source = "def _harness_tool_fn(%s):\n% s" % (signature, "\n".join(body))
    # `_UNSET` must be in scope: it is the default of every nullable optional
    # parameter, and a missing name here would fail at CALL time, not at
    # definition time — the worst place for it to surface.
    namespace = {"call_tool": call_tool, "_UNSET": _UNSET}
    exec(compile(source, "<harness-tool %s>" % tool_name, "exec"), namespace)
    func = namespace["_harness_tool_fn"]
    func.__name__ = tool_name
    func.__qualname__ = tool_name
    func.__doc__ = "\n".join(doc)
    func.__harness_tool__ = tool_name
    func.__signature_params__ = [f[1] for f in fields]
    return func


def _install_harness_tools(scope=None):
    """Bind every visible harness tool as a real function in the cell namespace.

    Idempotent and re-runnable: `refresh_tools()` calls it after a tool set
    changes. A name that already belongs to a preloaded local helper is NOT
    silently clobbered — the helper is preserved as `local_<name>` first, so
    the harness tool takes the plain name (which is what a cell author asking
    for `read(...)` means) while the old behaviour stays reachable and the
    shadowing is recorded in `_HARNESS_SHADOWED`.
    """
    listing = list_tools(scope=scope)
    if not isinstance(listing, list):
        return {"installed": 0, "reason": "no harness attached"}

    installed, failed = [], {}
    for entry in listing:
        if not isinstance(entry, dict):
            continue
        name = entry.get("name")
        if not isinstance(name, str) or not name:
            continue
        try:
            func = _make_tool_function(name, entry)
        except Exception as exc:  # one bad schema must not cost every tool
            failed[name] = "%s: %s" % (type(exc).__name__, exc)
            continue
        # Preserve a same-named local helper before it is shadowed.
        for target in (_ns, prompt_dict):
            existing = target.get(name)
            if existing is not None and existing is not func:
                if getattr(existing, "__harness_tool__", None) is None:
                    alias = "local_" + name
                    target.setdefault(alias, existing)
                    _HARNESS_SHADOWED[name] = alias
        _HARNESS_FUNCS[name] = func
        prompt_dict[name] = func
        _ns[name] = func
        installed.append(name)

    _TOOLS_INSTALLED[0] = True
    return {
        "installed": len(installed),
        "names": sorted(installed),
        "shadowed": dict(_HARNESS_SHADOWED),
        "failed": failed,
    }


def refresh_tools(scope=None):
    """Re-read the harness tool set and rebind the generated functions.

    Call after the harness mounts or unmounts tools. Returns a dict with the
    count installed, the shadowed-name mapping, and any schema that could not
    be turned into a function.
    """
    return _install_harness_tools(scope=scope)


def harness_tools():
    """The generated tool functions, keyed by tool name."""
    return dict(_HARNESS_FUNCS)


def _ckpt_paths(name):
    """Return (data_path, manifest_path) for a sanitized checkpoint name."""
    safe = str(name).replace("\\", "_").replace("/", "_").replace("..", "_")
    data = os.path.join(_get_checkpoint_dir(), safe + ".pkl")
    manifest = os.path.join(_get_checkpoint_dir(), safe + ".json")
    return data, manifest


def _ckpt_index_path():
    return os.path.join(_get_checkpoint_dir(), "index.json")


def _ckpt_read_index():
    ip = _ckpt_index_path()
    if not os.path.exists(ip):
        return []
    try:
        with open(ip, "r", encoding="utf-8") as f:
            data = json.load(f)
        return data if isinstance(data, list) else []
    except Exception:
        return []


def _ckpt_write_index(entries):
    ip = _ckpt_index_path()
    os.makedirs(os.path.dirname(ip), exist_ok=True)
    with open(ip, "w", encoding="utf-8") as f:
        json.dump(entries, f, ensure_ascii=False, indent=2)


def list_checkpoints():
    """List saved checkpoints with metadata."""
    return _ckpt_read_index()


def delete_checkpoint(name):
    """Delete a checkpoint by name."""
    data_path, manifest_path = _ckpt_paths(name)
    removed = []
    for path in (data_path, manifest_path):
        if os.path.exists(path):
            try:
                os.remove(path)
                removed.append(os.path.basename(path))
            except Exception as e:
                return {"error": "delete failed: %s" % e}
    if not removed:
        return {"error": 'Checkpoint "%s" not found' % name}
    entries = [e for e in _ckpt_read_index() if e.get("name") != name]
    _ckpt_write_index(entries)
    return {"success": True, "name": name, "deleted": removed}


def checkpoint(name):
    """Snapshot the user namespace into a named checkpoint."""
    data_path, manifest_path = _ckpt_paths(name)
    os.makedirs(os.path.dirname(data_path), exist_ok=True)
    result = snapshot_kernel_state(data_path, manifest_path)
    if result.get("error"):
        return result
    entries = [e for e in _ckpt_read_index() if e.get("name") != name]
    entries.append({
        "name": name,
        "timestamp": time.time(),
        "bytes": result.get("bytes", 0),
        "saved": result.get("saved", []),
    })
    _ckpt_write_index(entries)
    return {"success": True, "name": name, "saved": result.get("saved", []), "bytes": result.get("bytes", 0)}


def rewind(name):
    """Restore a named checkpoint into the user namespace."""
    data_path, _ = _ckpt_paths(name)
    if not os.path.exists(data_path):
        return {"error": 'Checkpoint "%s" not found' % name}
    result = restore_kernel_state(data_path)
    result["name"] = name
    return result


# Register the post-loop tool functions into the model namespace.
prompt_dict.update({
    "notebook_edit": notebook_edit,
    "list_checkpoints": list_checkpoints,
    "delete_checkpoint": delete_checkpoint,
    "monitor": monitor,
    "schedule": schedule,
    "routine": routine,
    "checkpoint": checkpoint,
    "rewind": rewind,
    "memory_store": memory_store,
    "memory_recall": memory_recall,
    "memory_list": memory_list,
    "enter_worktree": enter_worktree,
    "stop_agent": stop_agent,
    "bash": bash,
    "read": read,
    "write": write,
    "read_nontext": read_nontext,
    "snapshot_kernel_state": snapshot_kernel_state,
    "restore_kernel_state": restore_kernel_state,
    "git_status": git_status,
    "task_add": task_add,
    "task_done": task_done,
    "run_cell": run_cell,
    "tool_help": tool_help,
})

# vision: capture the screen/window/browser and read it with a model. Registered
# only when the module imported — with mss and Pillow absent the names would be
# None, and a tool that exists but always fails is worse than one that is not
# offered. `vision_status()` reports the real reason either way, and `tool_help`
# lists whatever ended up bound here.
if vision_tools is not None:
    # Bound into module GLOBALS as well as the namespace dict, because
    # `tool_help` discovers tools by scanning globals() for functions with a
    # docstring. Registering only in prompt_dict made all nine callable but
    # invisible to `tool_help('vision')`, which is how the model finds out a
    # tool exists — a tool the model cannot discover is a tool it will not use.
    _VISION_TOOLS = {
        "see": vision_tools.see,
        "capture_screen": vision_tools.capture_screen,
        "capture_window": vision_tools.capture_window,
        "capture_browser": vision_tools.capture_browser,
        "describe_image": vision_tools.describe_image,
        "describe_screen": vision_tools.describe_screen,
        "vision_monitors": vision_tools.vision_monitors,
        "vision_windows": vision_tools.vision_windows,
        "vision_status": vision_tools.vision_status,
    }
    prompt_dict.update(_VISION_TOOLS)
    globals().update(_VISION_TOOLS)
_ns.update(prompt_dict)

send_frame({"ready": True, "engine": engine})



while True:

    line = sys.stdin.readline()

    if line == "":

        break

    line = line.strip()

    if line == "":

        # main kernel shutting down: reap non-permanent sub-kernels now

        close_all_subkernels(include_permanent=False)

        break

    try:

        code = base64.b64decode(line).decode('utf-8')

    except Exception as e:

        send_frame({"out":"", "error":f"Protocol error: {e}"})

        continue

    cell_timeout_ms = None

    cell_secondary_ms = None

    cell_cwd = None

    cell_conv = None

    # The request's correlation id, echoed on the frame that answers it. The

    # harness matches frames to cells by this id instead of by arrival order,

    # so a stray line on the channel can no longer be read as a cell's result.

    cell_id = None

    if code.startswith(_CELL_PREFIX):

        try:

            envelope = json.loads(code[len(_CELL_PREFIX):])

            code = envelope.get("code", "")

            cell_id = envelope.get("id")

            raw_timeout = envelope.get("timeoutMs")

            if raw_timeout is not None:

                cell_timeout_ms = int(raw_timeout)

            raw_secondary = envelope.get("backgroundTimeoutMs")

            if raw_secondary is not None:

                cell_secondary_ms = int(raw_secondary)

            raw_cwd = envelope.get("cwd")

            if raw_cwd is not None and str(raw_cwd).strip() != "":

                cell_cwd = str(raw_cwd)

            raw_conv = envelope.get("conv")

            if raw_conv is not None and str(raw_conv).strip() != "":

                cell_conv = str(raw_conv)

        except Exception as e:

            send_frame({"out": "", "error": f"Cell envelope error: {e}", "id": cell_id})

            continue

    if code.startswith(_CTRL_PREFIX):

        # control channel (snapshot / restore / list_names) — never run as code

        try:

            req = json.loads(code[len(_CTRL_PREFIX):])

            cell_id = req.get("id")

            res = _handle_ctrl(req)

        except Exception as e:

            res = {"error": "control command failed: %s" % e}

        send_frame({"out": _SNAPSHOT_MARKER + json.dumps(res, ensure_ascii=False), "error": None, "id": cell_id})

        continue

    _LAST_CELL_TIMEOUT_MS[0] = cell_timeout_ms

    # Re-pin to the owning chat's cwd only when the stamp changes: a run of cells

    # in one chat keeps any set_cwd() the model made, while a different chat's

    # stamp resets to its own workspace instead of inheriting the last chat's.

    if cell_cwd is not None and cell_cwd != _LAST_STAMPED_CWD:

        _pin_cwd_for_cell(cell_cwd)

        _LAST_STAMPED_CWD = cell_cwd

    try:

        # chdir is process-global. A cell that backgrounds keeps the cwd it

        # started in only until the next foreground cell re-chdirs; concurrent

        # cells in different directories is a known limitation of one shared

        # interpreter, and in practice background + foreground share a chat's cwd.

        os.chdir(_KERNEL_CWD)

    except Exception:

        pass

    primary_ms = cell_timeout_ms if cell_timeout_ms is not None else _DEFAULT_PRIMARY_MS

    secondary_ms = _secondary_ms(primary_ms, cell_secondary_ms)

    runner = _CellRunner(code, conv=cell_conv)

    # The foreground window (while this loop is blocked in done.wait) is the
    # only time a cell may attempt a harness seam round-trip; a backgrounded
    # cell falls back to its local implementation.
    _seam_fg_thread = runner

    runner.start()

    if runner.done.wait(primary_ms / 1000.0):

        # Finished within the primary budget: normal result, plus any background

        # cell that completed since the last frame.

        _seam_fg_thread = None
        send_frame({"out": _join_stray(_flush_bg() + runner.out), "error": runner.err, "id": cell_id})

    else:

        _seam_fg_thread = None
        # Overran the primary budget: DO NOT kill. Detach it to the background so

        # the loop is free for the next command; the watchdog stops it at the

        # secondary deadline. Its output arrives on a later frame via _flush_bg().

        with _bg_lock:

            _bg_counter[0] += 1

            runner.bg_id = _bg_counter[0]

            runner.deadline = time.monotonic() + secondary_ms / 1000.0

            _bg_runners[runner.bg_id] = runner

        notice = ("[cell still running after %ds - moved to the background as bg#%d. It keeps "

                  "running while you work; its output arrives with a later result, and it is "

                  "force-stopped if it passes %ds.]"

                  % (round(primary_ms / 1000.0), runner.bg_id, round(secondary_ms / 1000.0)))

        send_frame({"out": _join_stray(_flush_bg() + notice), "error": None, "backgrounded": True, "id": cell_id})





# ============================================================

# New tools: notebook_edit, checkpoints, schedule, memory, etc.

# ============================================================
