# context_store.py — local disk context storage for Kiln-Kernel.
#
# A persistent, incremental, code-aware BM25 index over a directory. The agent
# can index a project once and then search it repeatedly — files are re-scanned
# only when their mtime/size change. Pure stdlib (json + os + re).
#
#   index_context(path=".", force=False) -> stats string
#   search_context(query, path=".", k=8)  -> ranked snippet list (as text)
#   context_stats(path=".")               -> index summary

import json
import os
import re
import time

STOPWORDS = set("""a an and are as at be but by for from has have he her his i if in is
it its me my of on or our so that the their them they this to was we were what when
where which who will with you your about into over under again further once only own
same than too very just can dont should now""".split())

_SKIP_DIRS = {".git", "__pycache__", "node_modules", ".venv", "venv", ".idea",
              ".vscode", "browser_runs", "projects", "skills", "chats"}
_SKIP_EXT = {".pyc", ".png", ".jpg", ".jpeg", ".gif", ".ico", ".wasm", ".exe",
             ".dll", ".so", ".dylib", ".woff", ".woff2", ".ttf", ".pdf", ".zip",
             ".gz", ".tar", ".bin", ".db", ".sqlite", ".lock", ".tmp"}
_MAX_FILES = 2000
_MAX_FILE_CHARS = 400_000
_INDEX_NAME = "kiln_context_index.json"


def _tokens(text):
    """Code-aware tokenization: snake_case/camelCase split, alnum + _ only."""
    if not text:
        return []
    # split camelCase and snake_case boundaries, drop non-alnum
    text = re.sub(r"(?<=[a-z0-9])(?=[A-Z])", " ", text)
    text = re.sub(r"[_\-/\\.]", " ", text)
    words = re.findall(r"[A-Za-z0-9]{2,}", text.lower())
    return [w for w in words if w not in STOPWORDS]


def _index_path(root):
    return os.path.join(root, ".kiln_index", _INDEX_NAME)


def _walk_files(root):
    out = []
    for dirpath, dirnames, filenames in os.walk(root):
        dirnames[:] = [d for d in dirnames if d not in _SKIP_DIRS
                       and not d.startswith(".")]
        for fn in filenames:
            if fn.startswith(".") or fn.endswith(tuple(_SKIP_EXT)):
                continue
            full = os.path.join(dirpath, fn)
            try:
                if os.path.getsize(full) > 5_000_000:
                    continue
            except OSError:
                continue
            out.append(full)
            if len(out) >= _MAX_FILES:
                return out
    return out


def _read_doc(path):
    try:
        with open(path, "r", encoding="utf-8", errors="replace") as f:
            data = f.read(_MAX_FILE_CHARS + 1)
        return data
    except Exception:
        return None


def index_context(path=".", force=False):
    """Scan `path`, update the on-disk index incrementally, return stats."""
    root = os.path.abspath(path)
    if not os.path.isdir(root):
        return f"index_context: not a directory: {root}"
    idx_path = _index_path(root)
    idx = {"version": 1, "docs": {}, "postings": {}, "meta": {}}
    if os.path.isfile(idx_path) and not force:
        try:
            with open(idx_path, encoding="utf-8") as f:
                idx = json.load(f)
        except Exception:
            idx = {"version": 1, "docs": {}, "postings": {}, "meta": {}}
    docs = idx.setdefault("docs", {})
    postings = idx.setdefault("postings", {})
    relroot = root

    added = updated = removed = 0
    seen = set()
    for full in _walk_files(root):
        rel = os.path.relpath(full, relroot).replace("\\", "/")
        seen.add(rel)
        try:
            size = os.path.getsize(full)
            mtime = os.path.getmtime(full)
        except OSError:
            continue
        old = docs.get(rel)
        if old and old.get("size") == size and old.get("mtime") == mtime:
            continue  # unchanged
        data = _read_doc(full)
        if data is None:
            continue
        terms = _tokens(data)
        counts = {}
        for t in terms:
            counts[t] = counts.get(t, 0) + 1
        if old:  # remove old postings
            for t in old.get("terms", {}):
                postings.get(t, {}).pop(rel, None)
                if not postings.get(t):
                    postings.pop(t, None)
            updated += 1
        else:
            added += 1
        docs[rel] = {"size": size, "mtime": mtime, "len": len(terms),
                     "terms": counts}
        for t, c in counts.items():
            postings.setdefault(t, {})[rel] = c
    # drop docs that no longer exist
    for rel in [r for r in docs if r not in seen]:
        for t in docs[rel].get("terms", {}):
            postings.get(t, {}).pop(rel, None)
            if not postings.get(t):
                postings.pop(t, None)
        docs.pop(rel, None)
        removed += 1

    idx["meta"] = {"updated": time.time(), "total_docs": len(docs),
                   "total_terms": len(postings)}
    try:
        os.makedirs(os.path.dirname(idx_path), exist_ok=True)
        tmp = idx_path + ".tmp"
        with open(tmp, "w", encoding="utf-8") as f:
            json.dump(idx, f)
        os.replace(tmp, idx_path)
    except Exception as e:
        return f"index_context: write failed: {e}"
    return (f"indexed {root}: {len(docs)} files "
            f"(+{added} added, {updated} updated, {removed} removed, "
            f"{len(postings)} terms)")


def _load_index(root):
    idx_path = _index_path(root)
    if not os.path.isfile(idx_path):
        return None
    try:
        with open(idx_path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def _bm25(idx, query_tokens, k=8, k1=1.5, b=0.75):
    docs = idx.get("docs", {})
    postings = idx.get("postings", {})
    n_docs = max(1, len(docs))
    avgdl = sum(d.get("len", 0) for d in docs.values()) / n_docs
    scores = {}
    for t in set(query_tokens):
        df = len(postings.get(t, {}))
        if df == 0:
            continue
        idf = max(0.0, ((n_docs - df + 0.5) / (df + 0.5) + 1.0) ** 0.5)
        for rel, tf in postings[t].items():
            d = docs[rel]
            dl = max(1, d.get("len", 0))
            tf_norm = tf * (k1 + 1) / (tf + k1 * (1 - b + b * dl / avgdl))
            scores[rel] = scores.get(rel, 0.0) + idf * tf_norm
    ranked = sorted(scores.items(), key=lambda x: -x[1])[:k]
    return ranked


def _snippet(path, query_tokens, span=260):
    try:
        with open(path, encoding="utf-8", errors="replace") as f:
            lines = f.readlines()
    except Exception:
        return ""
    q = set(query_tokens)
    best = 0
    best_hits = -1
    for i, line in enumerate(lines):
        hits = sum(1 for t in q if t in line.lower())
        if hits > best_hits:
            best_hits = hits
            best = i
    if best_hits <= 0:
        return lines[0][:span] if lines else ""
    start = max(0, best - 2)
    snippet = "".join(lines[start:best + 3]).strip()
    if len(snippet) > span:
        snippet = snippet[:span] + "…"
    return snippet


def search_context(query, path=".", k=8):
    """Rank files by BM25 and return a readable, source-cited result list."""
    root = os.path.abspath(path)
    if not os.path.isdir(root):
        return f"search_context: not a directory: {root}"
    qtokens = _tokens(query)
    if not qtokens:
        return "search_context: empty query"
    idx = _load_index(root)
    if idx is None:
        # auto-index on first search
        idx_res = index_context(root)
        idx = _load_index(root)
        if idx is None:
            return f"search_context: could not index {root} ({idx_res})"
    ranked = _bm25(idx, qtokens, k=k)
    if not ranked:
        return f"no matches for {query!r} in {root} (run index_context to refresh)"
    out = []
    for rel, score in ranked:
        full = os.path.join(root, *rel.split("/"))
        snip = _snippet(full, qtokens)
        out.append(f"[{score:.2f}] {rel}\n  {snip}")
    return "\n\n".join(out)


def context_stats(path="."):
    root = os.path.abspath(path)
    idx = _load_index(root)
    if idx is None:
        return f"no index for {root} yet — run index_context(path)"
    m = idx.get("meta", {})
    return (f"index for {root}: {m.get('total_docs', 0)} files, "
            f"{m.get('total_terms', 0)} terms, "
            f"updated {time.strftime('%Y-%m-%d %H:%M', time.localtime(m.get('updated', 0)))}")
