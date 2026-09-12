# Vision tools (`vision_tools.py`)

Kernel tools that let the agent **see** — screenshot the screen, a monitor, a
window, or the embedded browser, and hand the picture to a model that can read it.

Every other kernel tool returns text. `browser_use('read_page')` gives the DOM,
which is the right evidence for "does this button exist". It is the wrong
evidence for "did that click actually land", "is a modal covering the thing I
want", or "what does this app look like" — none of which the DOM records. These
tools return the pixels.


There are two ways to get those pixels read, and they are opposites:

- **`see()` sends the picture to another model and returns its words.** You read
  a description of the image, and the pixels never reach you. Use it when a
  summary is what you want.
- **`show()` puts the picture in *your own* context.** You see the image itself
  on your next turn — there is nothing between you and the pixels, and no
  second model in the loop.

`show()` is the one to reach for when the question is what something looks like;
`see()` is for when you want a sentence about it.

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
| `show(image, note=…, name=…)` | Put a picture in **your own** context — you see the pixels on your next turn. Accepts `"screen"`, `"window"`, `"browser"`, a path, encoded bytes, a PIL image, a matplotlib figure, or a numpy array. |
| `shown_images()` | What this cell has already queued, as metadata and without the payload. |

Two capabilities, deliberately separable:

- **Capture** (`capture_*`, `vision_monitors`, `vision_windows`) is pure local
  work — no network, no credentials. A screenshot on disk is useful on its own.
- **Read** (`describe_*`, `see` without `prompt=False`) needs a configured
  DeepSeek account. So `capture_screen()` works on a box with no token and fails
  only when you ask it to *read* the screen.

---

## Arguments worth knowing

**`max_width`** (default `None`). Captures are saved at **native resolution** —
a 1920×1080 grab stays 1920×1080. Downscaling is opt-in: pass a number to trade
fidelity for a smaller upload when the caller knows legibility is not at stake
(thumbnail-style context, "is anything on screen"). It was a 1600 default for a
while, which silently threw away a third of the pixels of the small UI text,
thin borders, and code these tools exist to read; `scale` in the result reports
the ratio actually applied, so a caller can tell whether it got full fidelity.
`max_width=None` and `max_width=0` both keep native.

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

## `show()`: the picture reaches *you*

Everything above describes the picture and hands you the words. `show()` does the
opposite: it attaches the image to the result of the cell that called it, and the
harness turns that into an image block in **your own** context. On your next turn
you are looking at the pixels. No upload, no second model, no account, no
description standing between you and the thing you asked about.

```python
show("browser", note="after clicking Save")   # the page, right now
show("screenshot.png")                        # any file on disk
show("screen", region={"left": 0, "top": 0, "width": 400, "height": 200})
show(matplotlib_figure)                       # a chart you just plotted
shown_images()                                # what this cell has queued so far
```

`image` may be:

| You pass | It shows |
| --- | --- |
| `"screen"`, `"desktop"`, `"monitor"` | A live capture of the screen (with `monitor=` and `region=`). |
| `"window"` | One window, by `title=` or `handle=`. |
| `"browser"` | The embedded browser's current page (with `full_page=`). |
| a path | Any PNG/JPEG/WebP/GIF file, including one `capture_screen()` just wrote. |
| `bytes` | Encoded image bytes already in memory. |
| a PIL image | Anything with `.save`/`.mode`/`.size`. |
| a matplotlib Figure | Rendered through its canvas. |
| a numpy array | Converted through pillow. |

`note` is a caption you will see beside the picture; `name` overrides the display
name. Both are optional. The return value describes what was attached —
`{"queued": 2, "mediaType": "image/png", "bytes": …, …}` — and `shown_images()`
reports the queue as metadata **without** echoing the base64 payload, which is why
it is safe to call and print.

The media type is taken from the image's own signature bytes, not from the file
extension, so a `.dat` file that is really a PNG shows up as a PNG.

### Limits, and what happens when one is hit

- **8 images per cell, 4 MB each.** The 9th `show()` returns an error instead of
  raising; the first 8 still travel with the result.
- **A failure never kills the cell.** A missing file, an unsupported format, or
  bytes that are not an image come back as `{"error": …, "input": …}` and the cell
  keeps running, so a script can show a picture, hit a bad path, and still finish
  its work.
- **Images queued before an exception still arrive.** They travel with the
  traceback frame, so a cell that shows a screenshot and then raises still hands
  you the screenshot alongside the error.
- **Only a foreground cell can show.** A cell that overran its budget and moved to
  the background has no result frame of its own yet; the image arrives with the
  result that reports it finished.

### Choosing between `see()` and `show()`

| | `see()` | `show()` |
| --- | --- | --- |
| What comes back | A written description | The image itself, in your context |
| Who looks | A separate model | You |
| Needs an account | Yes | No |
| Costs | An upload per call | Tokens for the image block |
| Best for | A summary, a one-line answer | "What does this actually look like?" |

Reach for `show()` whenever the next thing you would do with a description is
doubt it. Counting pixels, judging alignment, reading small text in a UI, or
deciding whether a render is correct are all cases where the picture beats prose.

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
