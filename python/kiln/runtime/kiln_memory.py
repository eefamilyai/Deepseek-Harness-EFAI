"""kiln_memory.py — the durable memory tier behind the kernel.

Kiln's context has three places where information used to disappear for good:

  1. **Trimmed output.** A cell that printed 200k characters came back with the
     middle cut out. The bytes were gone; the model could only re-run the cell
     and hope it was deterministic.
  2. **Compaction.** Old turns are summarized and dropped. The summary is
     lossy by construction, and the originals were not kept anywhere.
  3. **A kernel restart.** A timeout, an interrupt or a crash wipes the Python
     namespace, and with it every variable the model was using as memory.

All three are the same problem: the transcript was the only copy. This module
is the second copy — an append-only, content-addressed store on disk, keyed per
conversation, that the kernel can read back at any time through recall().

Layout (under .kiln_memory/<conversation>/):

    blobs/<sha1>.txt   content-addressed text, written once, never mutated
    index.jsonl        append-only log of {name, sha, chars, lines, kind, ts}

Content addressing means the same output stored twice costs one copy. The
append-only index means a crash mid-write can lose at most the newest entry and
can never corrupt an older one — the reader takes the last record per name and
ignores anything unparseable.

Nothing here is ever deleted by the agent: forget() appends a tombstone so the
name stops resolving, but the bytes stay on disk. Retention is by whole
conversation (prune_conversations), the same way run history works.
"""

import hashlib
import json
import os
import re
import time

_DIR = os.path.dirname(os.path.abspath(__file__))
MEMORY_ROOT = os.path.join(_DIR, ".kiln_memory")

# Keep the newest N conversations' memory. Same shape as the run-history cap.
KEEP_CONVERSATIONS = 100

_NAME_RE = re.compile(r"[^A-Za-z0-9_.:-]+")
PREVIEW_CHARS = 160


def safe_slug(text, fallback="conv"):
    """A filesystem-safe folder name that can never climb out of the root."""
    slug = os.path.basename(str(text or "")).strip()
    slug = _NAME_RE.sub("_", slug)[:120]
    if slug in ("", ".", ".."):
        slug = fallback
    return slug


def conversation_dir(conv_id, root=None):
    """Where one conversation's durable memory lives (created on demand)."""
    base = root or MEMORY_ROOT
    path = os.path.join(base, safe_slug(conv_id))
    os.makedirs(os.path.join(path, "blobs"), exist_ok=True)
    return path


class MemoryStore:
    """Append-only durable store for one conversation.

    Deliberately has no in-memory cache of its own: the kernel child and the
    server-side loop are separate PROCESSES writing the same directory, so
    anything cached in one would go stale the moment the other wrote. Reading
    the index costs a few hundred microseconds and is always correct.
    """

    def __init__(self, conv_id, root=None):
        self.dir = conversation_dir(conv_id, root)
        self.index_path = os.path.join(self.dir, "index.jsonl")
        self.blob_dir = os.path.join(self.dir, "blobs")

    # ---- writing ----
    def _write_blob(self, text):
        sha = hashlib.sha1(text.encode("utf-8", "replace")).hexdigest()
        path = os.path.join(self.blob_dir, sha + ".txt")
        if not os.path.exists(path):
            # write to a temp name and rename: a reader must never see a
            # half-written blob under its final, content-addressed name
            tmp = path + ".%d.tmp" % os.getpid()
            with open(tmp, "w", encoding="utf-8", newline="\n") as f:
                f.write(text)
            os.replace(tmp, path)
        return sha

    def _append(self, record):
        """Append one index record, healing a torn tail first.

        A crash mid-write leaves a partial line with no newline. Appending
        straight onto it would glue the next record to the wreckage and lose
        BOTH — so if the file does not end in a newline, start one.
        """
        with open(self.index_path, "a+", encoding="utf-8", newline="\n") as f:
            f.seek(0, os.SEEK_END)
            if f.tell():
                f.seek(f.tell() - 1)
                if f.read(1) != "\n":
                    f.write("\n")
            f.write(json.dumps(record, ensure_ascii=False) + "\n")

    def put(self, name, text, kind="note"):
        """Store `text` under `name`. Returns the index entry."""
        text = text if isinstance(text, str) else str(text)
        sha = self._write_blob(text)
        entry = {
            "name": str(name),
            "sha": sha,
            "chars": len(text),
            "lines": len(text.splitlines()),
            "kind": kind,
            "ts": time.time(),
            "preview": _one_line(text[:PREVIEW_CHARS]),
        }
        self._append(entry)
        return entry

    def tombstone(self, name):
        """Stop `name` resolving. The bytes stay — this is not a delete."""
        self._append({"name": str(name), "deleted": True, "ts": time.time()})

    # ---- reading ----
    def entries(self):
        """name -> newest entry, tombstones removed."""
        out = {}
        try:
            with open(self.index_path, "r", encoding="utf-8") as f:
                for line in f:
                    line = line.strip()
                    if not line:
                        continue
                    try:
                        rec = json.loads(line)
                    except Exception:
                        continue  # a torn final line loses that record, nothing else
                    name = rec.get("name")
                    if not isinstance(name, str):
                        continue
                    if rec.get("deleted"):
                        out.pop(name, None)
                    else:
                        out[name] = rec
        except OSError:
            return {}
        return out

    def get(self, name):
        """(entry, text) for `name`, or (None, None)."""
        entry = self.entries().get(str(name))
        if not entry:
            return None, None
        path = os.path.join(self.blob_dir, str(entry.get("sha", "")) + ".txt")
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as f:
                return entry, f.read()
        except OSError:
            return entry, None

    def next_name(self, prefix):
        """A fresh `prefix_N` that is not taken yet."""
        taken = set(self.entries())
        n = 1
        while f"{prefix}_{n}" in taken:
            n += 1
        return f"{prefix}_{n}"


def _one_line(text):
    return " ".join(str(text).split())


def slice_text(text, start=1, lines=200):
    """A 1-indexed window of `text`, plus a note on what lies either side.

    Returned as text the model reads directly, so the note has to say how to
    get the rest — a window with no way forward is just a smaller truncation.
    """
    all_lines = text.splitlines()
    total = len(all_lines)
    try:
        start = max(1, int(start))
    except (TypeError, ValueError):
        start = 1
    try:
        lines = max(1, int(lines))
    except (TypeError, ValueError):
        lines = 200
    chunk = all_lines[start - 1:start - 1 + lines]
    end = start + len(chunk) - 1
    body = "\n".join(chunk)
    if total <= lines and start == 1:
        return body
    head = f"[lines {start}–{end} of {total}]"
    tail = ""
    if end < total:
        tail = f"\n[{total - end} more lines — continue with start={end + 1}]"
    return head + "\n" + body + tail


def prune_conversations(keep=KEEP_CONVERSATIONS, root=None):
    """Drop the oldest conversations' memory folders. Never raises."""
    base = root or MEMORY_ROOT
    try:
        dirs = [(os.path.getmtime(os.path.join(base, d)), d)
                for d in os.listdir(base)
                if os.path.isdir(os.path.join(base, d))]
    except OSError:
        return
    if len(dirs) <= keep:
        return
    import shutil
    dirs.sort()
    for _, d in dirs[:-keep]:
        shutil.rmtree(os.path.join(base, d), ignore_errors=True)
