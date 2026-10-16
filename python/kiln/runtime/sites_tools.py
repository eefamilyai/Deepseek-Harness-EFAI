"""Kernel helpers for publishing web pages at https://<name>.dshai.reggilion.com.

They drive the harness `site` tool (package `@deepseek-ai/dsh-tool-sites`), which
owns the credentials and the GitHub Pages and deSEC work, and add what Python is
good at: building a site from a dict, from one HTML string, or from a folder the
cell just wrote; and scaffolding a starter site to edit.

`bind(call_tool)` connects the module to the kernel's tool caller; the kernel
does that at start-up and registers the public functions as cell helpers.
"""

from __future__ import annotations

import base64
import os
import re
import tempfile
import time
from pathlib import Path

_CALL = None

# Files a folder publish never sends.
_SKIP = {".git", "node_modules", "__pycache__", ".DS_Store", "Thumbs.db"}

# Extensions sent as text; anything else is sent as base64 bytes.
_TEXT = re.compile(r"\.(?:html?|css|m?js|json|svg|txt|md|xml|csv|map|webmanifest|ts|tsx|jsx)$", re.I)


def bind(call_tool):
    """Connect the helpers to the kernel's `call_tool(name, arguments, timeout=)`."""
    global _CALL
    _CALL = call_tool


class SiteResult(dict):
    """The tool's answer, `{text, url?}`. It displays as one line, because the helpers already print the text."""

    def __repr__(self):
        return f"<site {self.get('url') or 'result'}>"


def _site(arguments, timeout=300.0):
    if _CALL is None:
        raise RuntimeError("sites helpers are not bound to the harness; this kernel has no tool seam")
    value = _CALL("site", arguments, timeout=timeout)
    return SiteResult(value if isinstance(value, dict) else {"text": str(value)})


def _entry(path, content):
    if isinstance(content, (bytes, bytearray)):
        return {"path": path, "content": base64.b64encode(bytes(content)).decode("ascii"), "base64": True}
    if isinstance(content, Path):
        return _entry(path, content.read_bytes() if not _TEXT.search(content.name) else content.read_text(encoding="utf-8"))
    if not isinstance(content, str):
        raise TypeError(f"{path}: file content must be str, bytes, or a Path, not {type(content).__name__}")
    return {"path": path, "content": content}


def _files_of(source):
    """Turn a dict, an HTML string, or a folder into the tool's file list."""
    if isinstance(source, dict):
        return [_entry(str(path).replace("\\", "/"), content) for path, content in source.items()]
    if isinstance(source, (str, os.PathLike)) and os.path.isdir(str(source)):
        root = Path(source)
        out = []
        for path in sorted(root.rglob("*")):
            if not path.is_file() or any(part in _SKIP for part in path.relative_to(root).parts):
                continue
            rel = path.relative_to(root).as_posix()
            out.append(_entry(rel, path.read_text(encoding="utf-8") if _TEXT.search(path.name) else path.read_bytes()))
        return out
    if isinstance(source, str) and "<" in source:
        return [{"path": "index.html", "content": source}]
    raise ValueError("source must be a dict of {path: content}, an HTML string, or an existing folder")


def site_publish(name, source, title=None, wait_seconds=90):
    """Publish a site at https://<name>.dshai.reggilion.com and return {text, url}.

    `source` is a dict of {path: str | bytes | Path} (must include "index.html"),
    a single HTML string (published as index.html), or a local folder path.
    Republishing a name replaces the whole site. A new name needs a few minutes
    for DNS and HTTPS; the returned url is http until the certificate serves.
    Sites are PUBLIC GitHub repositories: never publish secrets or private data.
    """
    arguments = {"action": "publish", "name": name, "files": _files_of(source), "wait_seconds": int(wait_seconds)}
    if title:
        arguments["title"] = title
    result = _site(arguments, timeout=max(120.0, wait_seconds + 120.0))
    print(result.get("text", ""))
    return result


def site_status(name):
    """DNS, Pages build, HTTPS certificate, and whether http/https answer, for one site. Retries a missing certificate."""
    result = _site({"action": "status", "name": name}, timeout=120.0)
    print(result.get("text", ""))
    return result


def site_list():
    """Every published site, one line each, with its URL and title."""
    result = _site({"action": "list"}, timeout=60.0)
    print(result.get("text", ""))
    return result


def site_remove(name):
    """Take a site down: delete its DNS name, turn Pages off, archive its repository (publishing again restores it)."""
    result = _site({"action": "remove", "name": name}, timeout=120.0)
    print(result.get("text", ""))
    return result


def site_wait_https(name, timeout=1800, every=60):
    """Poll `site_status` until the site answers over https (a new name: usually 5-30 minutes). Returns True when it does."""
    deadline = time.time() + timeout
    while True:
        text = _site({"action": "status", "name": name}, timeout=120.0).get("text", "")
        if re.search(r"https 2\d\d", text):
            print(f"https://{name}.dshai.reggilion.com/ answers over https")
            return True
        if time.time() >= deadline:
            print(text)
            return False
        time.sleep(every)


_STARTERS = {
    "page": {
        "index.html": """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="style.css">
</head>
<body>
<main>
  <h1>{title}</h1>
  <p>Replace this with the content.</p>
</main>
<script src="app.js"></script>
</body>
</html>
""",
        "style.css": """:root { color-scheme: light dark; font-family: system-ui, sans-serif; }
body { margin: 0; min-height: 100vh; display: grid; place-items: center; background: #0f1115; color: #e8e8ea; }
main { max-width: 760px; padding: 48px 24px; }
h1 { font-size: clamp(28px, 5vw, 48px); margin: 0 0 16px; }
""",
        "app.js": "// Interactive behaviour goes here.\n",
    },
    "slides": {
        "index.html": """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.css">
<link rel="stylesheet" href="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/theme/black.css">
</head>
<body>
<div class="reveal"><div class="slides">
  <section><h1>{title}</h1><p>Press → to start, S for speaker notes, Esc for the overview</p></section>
  <section><h2>Point one</h2><ul><li class="fragment">First</li><li class="fragment">Second</li></ul>
    <aside class="notes">Speaker notes for this slide.</aside></section>
  <section><h2>Thank you</h2></section>
</div></div>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/dist/reveal.js"></script>
<script src="https://cdn.jsdelivr.net/npm/reveal.js@5/plugin/notes/notes.js"></script>
<script>Reveal.initialize({ hash: true, plugins: [RevealNotes] })</script>
</body>
</html>
""",
    },
    "illustration": {
        "index.html": """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<style>
  html, body { margin: 0; height: 100%; background: #07080c; overflow: hidden; }
  canvas { display: block; width: 100vw; height: 100vh; }
</style>
</head>
<body>
<canvas id="c"></canvas>
<script>
const c = document.getElementById('c'), g = c.getContext('2d')
const fit = () => { c.width = innerWidth * devicePixelRatio; c.height = innerHeight * devicePixelRatio }
addEventListener('resize', fit); fit()
function frame(t) {
  g.fillStyle = 'rgba(7,8,12,0.2)'; g.fillRect(0, 0, c.width, c.height)
  // Draw the illustration here; t is milliseconds since load.
  requestAnimationFrame(frame)
}
requestAnimationFrame(frame)
</script>
</body>
</html>
""",
    },
    "chart": {
        "index.html": """<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>{title}</title>
<script src="https://cdn.jsdelivr.net/npm/chart.js@4"></script>
<style>body { font-family: system-ui, sans-serif; max-width: 960px; margin: 40px auto; padding: 0 20px; }</style>
</head>
<body>
<h1>{title}</h1>
<canvas id="chart"></canvas>
<script>
const data = { labels: ['A', 'B', 'C'], datasets: [{ label: 'Series', data: [3, 7, 5] }] }
new Chart(document.getElementById('chart'), { type: 'bar', data })
</script>
</body>
</html>
""",
    },
}


def site_starter(kind="page", title="Untitled", folder=None):
    """Write a starter site to edit, and return its folder. kind: page, slides (reveal.js), illustration (canvas animation), chart (Chart.js).

    Edit the files, then `site_publish(name, folder)`.
    """
    if kind not in _STARTERS:
        raise ValueError(f"kind must be one of {sorted(_STARTERS)}")
    target = Path(folder) if folder else Path(tempfile.mkdtemp(prefix=f"site-{kind}-"))
    target.mkdir(parents=True, exist_ok=True)
    for path, text in _STARTERS[kind].items():
        content = text.replace("{title}", title)
        (target / path).write_text(content, encoding="utf-8")
    print(f"wrote the {kind} starter to {target}")
    return str(target)


HELPERS = {
    "site_publish": site_publish,
    "site_status": site_status,
    "site_list": site_list,
    "site_remove": site_remove,
    "site_wait_https": site_wait_https,
    "site_starter": site_starter,
}
