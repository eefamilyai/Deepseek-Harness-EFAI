# Vision tools (`vision_tools.py`)

Kernel tools that let the agent **see** — screenshot the screen, a monitor, a
window, or the embedded browser, and hand the picture to a model that can read it.

Every other kernel tool returns text. `browser_use('read_page')` gives the DOM,
which is the right evidence for "does this button exist". It is the wrong
evidence for "did that click actually land", "is a modal covering the thing I
want", or "what does this app look like" — none of which the DOM records. These
tools return the pixels.

---

## Quick start

```python
see()                                  # what is on screen right now, in words
see("window", title="Notepad")         # one window, described
see("browser")                         # the embedded browser's current page
capture_screen()                       # just save a PNG, no model call
```

`see()` is the one entry point; the rest are the pieces it is built from.

---

## The tools

| Tool | What it does |
| --- | --- |
| `see(target, prompt=…)` | Capture a target and describe it. `target` is `screen` (default), `window`, `browser`, `image`, `monitors`, or `windows`. |
| `capture_screen(…)` | Screenshot the screen, one monitor, or a rectangle → PNG. No model needed. |
| `capture_window(handle=…, title=…)` | Screenshot one window, located by handle or title substring. |
| `capture_browser(full_page=…)` | Screenshot the embedded browser's current page. Reuses the existing browser and never launches one; a page must already be open. |
| `describe_image(path=…, files=[…])` | Put existing image files in front of the model. |
| `describe_screen(…)` | Capture the screen and describe it in one call. |
| `vision_monitors()` | List displays a capture can target. No model needed. |
| `vision_windows(title=…)` | List titled windows with their screen rectangles. No model needed. |
| `vision_status()` | What works on **this** machine, and why not if it does not. |

Two capabilities, deliberately separable:

- **Capture** (`capture_*`, `vision_monitors`, `vision_windows`) is pure local
  work — no network, no credentials. A screenshot on disk is useful on its own.
- **Read** (`describe_*`, `see` without `prompt=False`) needs a configured
  DeepSeek account. So `capture_screen()` works on a box with no token and fails
  only when you ask it to *read* the screen.

---

## Arguments worth knowing

**`max_width`** (default 1600). Every capture is downscaled to this before it is
saved. Not cosmetic: a 1920×1080 PNG is ~450 KB, and the image is billed against
the same context window as text, so a full-size grab of a mostly-empty desktop
is a lot of tokens spent on wallpaper. 1600 keeps UI text legible.
`max_width=0` keeps native resolution.

**`region={left,top,width,height}`** (or the same four as keywords). Crops to
that rectangle of the virtual desktop — the way to show the model one dialog
instead of the whole desktop it sits on.

**`monitor`** is an mss index: `1` is the primary display (the default), `0` is
every monitor stitched into one image, `2+` are the others. `vision_monitors()`
lists them and the indices match.

**`keep`** (default `True`). `keep=False` deletes the PNG after describing it,
for a caller that only wants the words and does not want the state directory
filling with screenshots.

**`prompt=False`** captures and returns the file path **without** calling a
model. This is how a caller asks for the picture rather than a description.

**`full_page`** on `capture_browser`. The whole scrollable page rather than the
viewport. Right for "read this article", wrong for "did the click work" — a
full-page shot of a long document shrinks to illegibility once scaled to fit a
model's image budget.

---

## Why `capture_window` raises the window

It captures by screen rectangle, not `PrintWindow`. `PrintWindow` is unreliable
for GPU-composited and layered windows — it returns black or a stale frame for
most modern browsers and Electron apps — while a BitBlt of the window's
on-screen rectangle is exactly what a person sees. The tradeoff: an **occluded**
window captures whatever is covering it, so the window is brought to the front
first unless `raise_window=False`. A minimized window has no on-screen pixels,
and the result says so rather than returning a picture of the taskbar.

The rectangle comes from DWM's extended frame bounds when available, because
`GetWindowRect` includes the invisible resize border — using it would put every
screenshot a few pixels off and show slivers of whatever is behind.

---

## How a picture reaches the model

The PNG is written to disk, uploaded to DeepSeek's file store, and attached to a
chat as `ref_file_ids`. That is the same path the harness already uses for an
attached file, and the one verified working against the live endpoint. Nothing
about the upload is re-implemented here: `describe_image` calls
`ds_direct.describe_files`, which owns the per-file failure and retry rules.

One consequence worth knowing: **an image is uploaded per call**. Describing the
same screenshot twice costs two uploads. Capture once and pass the path to
`describe_image(path=…)` when you need a second reading.

---

## Where files go

`screenshots/` under `KILN_STATE_DIR` — the same rule as `ds_sessions.json`, so
the harness can ship the runtime read-only inside a package without losing
captures. Unset, it falls back to the runtime's own directory.

---

## Dependencies

`mss` (screen capture) and `pillow` (scaling and PNG encoding), both declared in
`requirements.txt` and `pyproject.toml`, so `uv sync` provisions them.

Both are **feature-gated**: a missing package disables these tools with a message
naming the fix and never breaks kernel startup. `vision_status()` reports which
half is missing, and separates "no capture library" (local, installable) from
"no DeepSeek account" (needs a token) — different problems, different fixes.

Window enumeration is Win32 via `ctypes` rather than a package, so
`vision_windows()` still works when the capture libraries are absent.

---

## Tests

```sh
python test_vision_tools.py
```

Offline — no image is ever sent to a model and nothing is uploaded, so it passes
on a box with no DeepSeek account. That is enforced, not just intended: the
no-argument contract loop substitutes a `ds_direct` that fails on any upload, so a
future change that reaches the network from a bare `see()` breaks the run instead
of quietly spending a screenshot.

It pins what has to be right before a model is involved: a capture is a real
openable PNG of the requested size, the downscale happens, a region is honoured
exactly, every public entry point returns an error rather than raising, `see()`
routes each target correctly, and `keep=False` cleans up the file it made.

The model half is exercised against a stub, plus the guard clauses that need no
account. The real upload-and-read path needs a live session and is a smoke run,
not a unit test.
