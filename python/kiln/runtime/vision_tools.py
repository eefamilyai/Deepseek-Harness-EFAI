"""vision_tools — let the kernel actually SEE.

Every other kernel tool returns TEXT. This one returns what a screenshot
contains: the screen, a monitor, a window, the embedded browser, or an arbitrary
region, handed to a model that can read images and turned back into words.

Why it exists at all: an agent driving a GUI has no other way to find out
whether a click landed on the button or on the whitespace beside it, and a text
snapshot of a page cannot tell it that a modal is covering the thing it wants.
`browser_use('read_page')` gives the DOM; this gives the pixels, which is the
only evidence for "did that actually render".

How a picture reaches the model. The image is written to a PNG on disk, uploaded
to DeepSeek's file store, and attached to a chat as `ref_file_ids` — the same
path the harness already uses for an attached file, and the one verified working
against the live endpoint. Nothing here re-implements uploads; it calls
`ds_direct.upload_files` and `ds_direct.describe_files`, which own that.

Two independent capabilities, deliberately separable:

  * `capture_*` — produce a PNG. Pure local work, no network, no credentials.
    Useful on its own: a screenshot on disk is something a human can look at.
  * `see` / `describe_image` — put a PNG in front of the model and return what
    it says. Needs a configured DeepSeek account.

So `capture_screen()` works on a box with no token, and fails only when you ask
it to *read* the screen.
"""

import base64
import contextlib
import io
import os
import sys
import time

# ── optional dependencies ───────────────────────────────────────────
# mss does the screen grab and Pillow does the encoding/scaling. Both are
# feature-gated the way every other runtime dependency is: a missing package
# disables this one tool with a message that names the fix, and never breaks
# kernel startup. Windows GDI is the fallback for capture when mss is absent,
# because ctypes needs no package at all.
try:
    import mss as _mss
except Exception:  # noqa: BLE001
    _mss = None

try:
    from PIL import Image as _Image
except Exception:  # noqa: BLE001
    _Image = None

_DIR = os.path.dirname(os.path.abspath(__file__))


def _state_dir():
    """Where kernel-owned state lives — same rule as kernel_child."""
    return os.environ.get("KILN_STATE_DIR") or _DIR


def _shot_dir():
    """Directory holding captured PNGs. Created on demand.

    Under the state dir rather than beside the source, for the same reason
    `ds_sessions.json` is: the runtime can be shipped read-only inside a
    package, and a screenshot written next to the code would be lost (or
    unwritable) there.
    """
    d = os.path.join(_state_dir(), "screenshots")
    os.makedirs(d, exist_ok=True)
    return d


def _deps_error(what="screen capture"):
    missing = []
    if _mss is None:
        missing.append("mss")
    if _Image is None:
        missing.append("pillow")
    if not missing:
        return ""
    return ("%s needs %s — install with: uv pip install --python <runtime>/.venv/"
            "Scripts/python.exe %s" % (what, " and ".join(missing), " ".join(missing)))


def _slug(prefix):
    return "%s_%d.png" % (prefix, int(time.time() * 1000))


# ── capture ─────────────────────────────────────────────────────────

def _grab_mss(region=None, monitor=1):
    """One screen grab via mss -> PIL Image. `region` is a dict with
    left/top/width/height; otherwise the whole of `monitor`."""
    with _mss.mss() as sct:
        if region is not None:
            box = region
        else:
            mons = sct.monitors
            if monitor < 0 or monitor >= len(mons):
                raise ValueError("monitor %r out of range; %d available (0 = all "
                                 "monitors combined)" % (monitor, len(mons)))
            box = mons[monitor]
        shot = sct.grab(box)
        return _Image.frombytes("RGB", shot.size, shot.bgra, "raw", "BGRX")


def _save(img, name, max_width=None, quality_note=None):
    """Write a PNG at native resolution. Returns (path, (w, h)).

    `max_width=None` keeps the capture pixel-exact: a 2560-wide grab stays 2560
    wide. Downscaling is lossy for exactly the content these tools exist to read
    — small UI text, thin borders, code — so it is opt-in via an explicit
    `max_width`, never a default. Pass a number to trade fidelity for a smaller
    upload when the caller knows legibility is not at stake.
    """
    if max_width and img.width > max_width:
        ratio = max_width / float(img.width)
        img = img.resize((max_width, max(1, int(img.height * ratio))),
                         _Image.LANCZOS)
    path = os.path.join(_shot_dir(), name)
    img.save(path, "PNG", optimize=True)
    return path, img.size


def _resolve_region(region=None, left=None, top=None, width=None, height=None):
    """Accept a dict or explicit kwargs; return a normalised dict or None."""
    if region is None and left is None:
        return None
    if region is not None:
        if not isinstance(region, dict):
            raise ValueError("region must be a dict with left/top/width/height")
        box = dict(region)
    else:
        box = {"left": left, "top": top, "width": width, "height": height}
    if box.get("left") is None or box.get("top") is None:
        raise ValueError("region needs left and top")
    box["width"] = int(box.get("width") or 0)
    box["height"] = int(box.get("height") or 0)
    if box["width"] <= 0 or box["height"] <= 0:
        raise ValueError("region needs a positive width and height")
    box["left"] = int(box["left"])
    box["top"] = int(box["top"])
    return box


def capture_screen(path=None, max_width=None, monitor=1, region=None,
                   left=None, top=None, width=None, height=None):
    """Screenshot the screen, one monitor, or a rectangle -> PNG on disk.

    Returns {"path", "width", "height", "bytes", "monitor"/"region"} or
    {"error"}. Never raises: a capture failure is a message, not a crash.

    region={left,top,width,height} (or the same four as kwargs) crops to that
    rectangle of the virtual desktop — the way to show the model one dialog
    instead of the whole desktop it sits on.

    monitor is an mss index: 1 is the primary display (the default), 0 is every
    monitor stitched into one image, 2+ are the others. `vision_monitors()`
    lists them.
    """
    err = _deps_error()
    if err:
        return {"error": err}
    try:
        box = _resolve_region(region, left, top, width, height)
        img = _grab_mss(region=box, monitor=monitor)
        name = os.path.basename(path) if path else _slug("screen")
        if not name.endswith(".png"):
            name += ".png"
        saved, size = _save(img, name, max_width=max_width)
        out = {"path": saved, "width": size[0], "height": size[1],
               "bytes": os.path.getsize(saved),
               "scale": round(size[0] / float(img.width), 4) if img.width else 1.0}
        if box:
            out["region"] = box
        else:
            out["monitor"] = monitor
        return out
    except Exception as e:  # noqa: BLE001
        return {"error": "%s: %s" % (type(e).__name__, e)}


def vision_monitors():
    """List the displays a capture can target, for `capture_screen(monitor=…)`.

    Index 0 is the whole virtual desktop; the physical monitors follow. The
    indices match what `capture_screen` accepts, so the number this returns can
    be passed straight back in.
    """
    if _mss is None:
        return {"error": _deps_error("monitor enumeration")}
    try:
        with _mss.mss() as sct:
            mons = list(sct.monitors)
        out = []
        for i, m in enumerate(mons):
            out.append({"index": i,
                        "name": m.get("name") or ("all monitors" if i == 0 else "display %d" % i),
                        "left": m.get("left"), "top": m.get("top"),
                        "width": m.get("width"), "height": m.get("height"),
                        "primary": bool(m.get("is_primary"))})
        return {"monitors": out, "count": len(mons) - 1}
    except Exception as e:  # noqa: BLE001
        return {"error": "%s: %s" % (type(e).__name__, e)}


# ── windows ─────────────────────────────────────────────────────────

def vision_windows(title=None, visible_only=True, limit=60):
    """List top-level windows that have a title, with their screen rectangle.

    Enumeration is Win32 (ctypes + user32) rather than a package, so it works
    even when the capture libraries are missing. The rectangles come from
    DWM's extended frame bounds when available — GetWindowRect includes the
    invisible resize border, which would put every screenshot a few pixels off
    and show slivers of whatever is behind the window.

    `title` filters case-insensitively on a substring. Returns
    {"windows": [{handle, title, class, left, top, width, height, minimized}],
    "count"}.
    """
    if sys.platform != "win32":
        return {"error": "window enumeration is Windows-only"}
    import ctypes
    import ctypes.wintypes as wt

    user32 = ctypes.windll.user32
    try:
        dwmapi = ctypes.windll.dwmapi
    except Exception:  # noqa: BLE001
        dwmapi = None

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    out = []
    needle = (title or "").lower()

    WNDENUMPROC = ctypes.WINFUNCTYPE(wt.BOOL, wt.HWND, wt.LPARAM)

    def _cb(hwnd, _lparam):
        if len(out) >= limit:
            return True
        if visible_only and not user32.IsWindowVisible(hwnd):
            return True
        n = user32.GetWindowTextLengthW(hwnd)
        if not n:
            return True
        buf = ctypes.create_unicode_buffer(n + 1)
        user32.GetWindowTextW(hwnd, buf, n + 1)
        text = buf.value
        if needle and needle not in text.lower():
            return True
        cls = ctypes.create_unicode_buffer(256)
        user32.GetClassNameW(hwnd, cls, 256)
        r = RECT()
        got = False
        if dwmapi is not None:
            # DWMWA_EXTENDED_FRAME_BOUNDS = 9
            try:
                got = dwmapi.DwmGetWindowAttribute(
                    wt.HWND(hwnd), ctypes.c_uint(9), ctypes.byref(r),
                    ctypes.sizeof(r)) == 0
            except Exception:  # noqa: BLE001
                got = False
        if not got:
            got = bool(user32.GetWindowRect(hwnd, ctypes.byref(r)))
        if not got:
            return True
        w, h = r.right - r.left, r.bottom - r.top
        if w <= 0 or h <= 0:
            return True
        out.append({
            "handle": int(hwnd), "title": text, "class": cls.value,
            "left": r.left, "top": r.top, "width": w, "height": h,
            "minimized": bool(user32.IsIconic(hwnd)),
        })
        return True

    try:
        user32.EnumWindows(WNDENUMPROC(_cb), 0)
    except Exception as e:  # noqa: BLE001
        return {"error": "%s: %s" % (type(e).__name__, e)}
    return {"windows": out, "count": len(out)}


def _window_rect(handle):
    """The on-screen rect of one window handle, or None."""
    if sys.platform != "win32" or not handle:
        return None
    import ctypes
    import ctypes.wintypes as wt

    class RECT(ctypes.Structure):
        _fields_ = [("left", ctypes.c_long), ("top", ctypes.c_long),
                    ("right", ctypes.c_long), ("bottom", ctypes.c_long)]

    user32 = ctypes.windll.user32
    hwnd = wt.HWND(int(handle))
    r = RECT()
    got = False
    try:
        dwmapi = ctypes.windll.dwmapi
        got = dwmapi.DwmGetWindowAttribute(
            hwnd, ctypes.c_uint(9), ctypes.byref(r), ctypes.sizeof(r)) == 0
    except Exception:  # noqa: BLE001
        got = False
    if not got and not user32.GetWindowRect(hwnd, ctypes.byref(r)):
        return None
    w, h = r.right - r.left, r.bottom - r.top
    if w <= 0 or h <= 0:
        return None
    return {"left": r.left, "top": r.top, "width": w, "height": h}


def capture_window(handle=None, title=None, path=None, max_width=None,
                   raise_window=True):
    """Screenshot ONE window, located by handle or by a title substring.

    Captures by screen rectangle rather than PrintWindow: PrintWindow is
    unreliable for GPU-composited and layered windows (it returns black or a
    stale frame for most modern browsers and Electron apps), while a BitBlt of
    the window's on-screen rect is exactly what a person sees. The tradeoff is
    that an OCCLUDED window captures whatever is covering it, so this brings the
    window to the front first unless raise_window=False.

    A minimized window has no on-screen pixels; the result says so rather than
    returning a picture of the taskbar.
    """
    err = _deps_error()
    if err:
        return {"error": err}
    if not handle and not title:
        return {"error": "capture_window needs a handle or a title substring"}
    try:
        info = None
        if not handle:
            listed = vision_windows(title=title)
            if listed.get("error"):
                return listed
            cands = [w for w in listed["windows"] if not w["minimized"]]
            if not cands:
                cands = listed["windows"]
            if not cands:
                return {"error": "no window matched %r" % title}
            info = cands[0]
            handle = info["handle"]
        else:
            handle = int(handle)
            if sys.platform == "win32":
                import ctypes
                import ctypes.wintypes as wt
                user32 = ctypes.windll.user32
                if user32.IsIconic(wt.HWND(handle)):
                    return {"error": "window %s is minimized — restore it first" % handle}
                if raise_window:
                    user32.SetForegroundWindow(wt.HWND(handle))
                    time.sleep(0.25)
            info = {"handle": handle}
        rect = _window_rect(handle)
        if rect is None:
            return {"error": "could not read the rectangle of window %s" % handle}
        res = capture_screen(path=path, max_width=max_width, region=rect)
        if res.get("error"):
            return res
        res["handle"] = handle
        res["title"] = (info or {}).get("title", "")
        return res
    except Exception as e:  # noqa: BLE001
        return {"error": "%s: %s" % (type(e).__name__, e)}


# ── the embedded browser ────────────────────────────────────────────

def capture_browser(path=None, max_width=None, full_page=False):
    """Screenshot the embedded browser's CURRENT page — this launches no browser.

    Reuses `browser_tools`, which already owns the page and its lifecycle, and
    runs the grab on that module's single browser worker thread: Playwright's
    sync API is thread-affine, so touching `page` from the caller's thread is
    what breaks it.

    A page must already be open. `browser_use('navigate', url=...)` opens one;
    this deliberately does not, because a browser launched just to be
    photographed has nothing on screen but about:blank.

    `full_page=True` captures the whole scrollable page instead of the viewport.
    That is the right choice for "read this article" and the wrong one for
    "did the click work", because a full-page shot of a long document shrinks
    to illegibility once it is scaled to fit a model's image budget.
    """
    try:
        import browser_tools
    except Exception as e:  # noqa: BLE001
        return {"error": "browser_tools unavailable: %s: %s" % (type(e).__name__, e)}
    if _Image is None:
        return {"error": _deps_error("browser capture")}

    name = os.path.basename(path) if path else _slug("browser")
    if not name.endswith(".png"):
        name += ".png"
    # Playwright writes the raw grab here; `_save` then writes the downscaled
    # PNG under `name`. Two files rather than one because Pillow's `open` is
    # lazy, and reading and rewriting one path in place is a trap.
    raw = os.path.join(_shot_dir(), "_raw_" + name)

    def _grab():
        b = getattr(browser_tools, "BROWSER", None)
        page = getattr(b, "page", None) if b is not None else None
        if page is None or page.is_closed():
            return None, ("no browser page is open — open one first with "
                          "browser_use('navigate', url=...)")
        page.screenshot(path=raw, full_page=bool(full_page))
        return getattr(page, "url", "") or "", None

    try:
        url, err = browser_tools._on_browser_thread(_grab)
        if err:
            return {"error": err}
        if not os.path.exists(raw):
            return {"error": "the browser wrote no file"}
        try:
            img = _Image.open(raw)
            img.load()
            saved, size = _save(img, name, max_width=max_width)
        finally:
            with contextlib.suppress(OSError):
                os.remove(raw)
        return {"path": saved, "width": size[0], "height": size[1],
                "bytes": os.path.getsize(saved), "full_page": bool(full_page),
                "url": url}
    except Exception as e:  # noqa: BLE001
        with contextlib.suppress(OSError):
            os.remove(raw)
        return {"error": "%s: %s" % (type(e).__name__, e)}


# ── reading an image with a model ───────────────────────────────────

_DEFAULT_PROMPT = (
    "Describe this screenshot for an engineer who cannot see it. Lead with what "
    "the screen is (app, page, dialog), then the state that matters: any error, "
    "warning, or unexpected text verbatim; the primary controls and their "
    "enabled/disabled state; and anything that looks broken or half-loaded. Be "
    "specific and concise — no preamble, no restating these instructions."
)


def _load_blob(path):
    with open(path, "rb") as f:
        return f.read()


def describe_image(path=None, prompt=None, files=None, cancelled=None,
                   account=None):
    """Put one or more images in front of the model and return what it says.

    `path` is a single image; `files` is a list of paths for a combined read
    ("compare these two screenshots"). Returns {"description", "files", "account",
    "bytes"} or {"error"}.

    This is the ONLY function here that needs a DeepSeek account, because it is
    the only one that talks to a model. It calls `ds_direct.describe_files`,
    which uploads and reads in one step and already handles the per-file failure
    and retry rules; nothing about the upload is re-implemented here.
    """
    try:
        import ds_direct
    except Exception as e:  # noqa: BLE001
        return {"error": "ds_direct unavailable: %s: %s" % (type(e).__name__, e)}

    paths = []
    if path:
        paths.append(path)
    for p in (files or []):
        if p:
            paths.append(p)
    if not paths:
        return {"error": "describe_image needs a path (or files=[...])"}

    pairs, missing = [], []
    for p in paths:
        if not os.path.exists(p):
            missing.append(p)
            continue
        pairs.append((os.path.basename(p), _load_blob(p)))
    if missing:
        return {"error": "no such file: %s" % ", ".join(missing)}
    if not pairs:
        return {"error": "nothing to describe"}

    try:
        if not ds_direct.configured():
            return {"error": "no DeepSeek account — add a token to ds_config.json "
                             "(the capture succeeded; only reading it needs a model)"}
        out = ds_direct.describe_files(pairs, prompt or _DEFAULT_PROMPT,
                                       cancelled=cancelled)
    except Exception as e:  # noqa: BLE001
        return {"error": "%s: %s" % (type(e).__name__, e)}

    # describe_files returns {name: {"description","error"}}; a single image is
    # the common case, so flatten it while keeping the per-file detail.
    parts, errors = [], []
    for name, _blob in pairs:
        entry = out.get(name) or {}
        text = (entry.get("description") or "").strip()
        if text:
            parts.append(text if len(pairs) == 1 else "%s:\n%s" % (name, text))
        err = entry.get("error")
        if err:
            errors.append({"name": name, "error": err})
    if not parts:
        return {"error": "the model returned nothing",
                "files": [n for n, _ in pairs], "errors": errors}
    res = {"description": "\n\n".join(parts),
           "files": [{"name": n, "bytes": len(b)} for n, b in pairs]}
    if errors:
        res["errors"] = errors
    return res


def describe_screen(prompt=None, monitor=1, region=None, max_width=None,
                    keep=True, cancelled=None):
    """Capture the screen and describe it, in one call.

    The one-liner an agent actually wants: "what is on screen right now".
    `keep=False` deletes the PNG afterwards, for a caller that only wants the
    words and does not want the state directory filling with screenshots.
    """
    shot = capture_screen(max_width=max_width, monitor=monitor, region=region)
    if shot.get("error"):
        return shot
    try:
        res = describe_image(path=shot["path"], prompt=prompt, cancelled=cancelled)
    finally:
        if not keep:
            try:
                os.remove(shot["path"])
            except OSError:
                pass
    if res.get("error"):
        res["capture"] = shot
        return res
    res["capture"] = shot
    return res


def see(target="screen", prompt=None, max_width=None, keep=True, **kw):
    """One entry point for every "look at this" request. Never raises.

    target:
      "screen"    the primary monitor            (monitor=, region=)
      "monitors"  list what capture_screen can target — no model call
      "windows"   list windows — no model call
      "window"    one window by handle= or title=
      "browser"   the embedded browser's page    (full_page=)
      "image"     an existing file               (path=)

    Any target then gets described unless prompt is False, in which case only
    the capture happens and the PNG path comes back. That is the shape an agent
    needs when it wants the file rather than the words.
    """
    t = (target or "screen").lower().strip()

    if t in ("monitors", "displays"):
        return vision_monitors()
    if t in ("windows", "window_list"):
        return vision_windows(title=kw.get("title"), limit=int(kw.get("limit") or 60))

    if t == "image":
        path = kw.get("path") or kw.get("file")
        if not path:
            return {"error": "see('image') needs path="}
        if not os.path.exists(path):
            return {"error": "no such file: %s" % path}
        if prompt is False:
            return {"path": path, "bytes": os.path.getsize(path)}
        return describe_image(path=path, prompt=prompt,
                              cancelled=kw.get("cancelled"))

    # One capture per target, then optionally one model call. `keep` is applied
    # HERE rather than inside each branch: it was handled only on the
    # describe path once, so `see(..., prompt=False, keep=False)` captured and
    # returned without deleting — a caller asking for no file on disk silently
    # got one every call.
    if t == "browser":
        shot = capture_browser(max_width=max_width,
                               full_page=bool(kw.get("full_page")))
    elif t == "window":
        shot = capture_window(handle=kw.get("handle"), title=kw.get("title"),
                              max_width=max_width,
                              raise_window=kw.get("raise_window", True))
    else:
        shot = capture_screen(max_width=max_width,
                              monitor=int(kw.get("monitor") or 1),
                              region=kw.get("region"))
    if shot.get("error"):
        return shot

    if prompt is False:
        # The caller wants the file, not the words.
        if not keep:
            with contextlib.suppress(OSError):
                os.remove(shot["path"])
        return shot

    try:
        res = describe_image(path=shot["path"], prompt=prompt,
                             cancelled=kw.get("cancelled"))
    finally:
        if not keep:
            with contextlib.suppress(OSError):
                os.remove(shot["path"])
    if res.get("error"):
        res["capture"] = shot
        return res
    res["capture"] = shot
    return res


def vision_status():
    """What this module can do on THIS machine, and why not if it cannot.

    Worth calling before promising a user a screenshot: it separates "no
    capture library" (local, installable) from "no DeepSeek account" (needs a
    token), which are different fixes.
    """
    info = {
        "capture": _mss is not None and _Image is not None,
        "mss": getattr(_mss, "__version__", None) if _mss else None,
        "pillow": getattr(_Image, "__version__", None) if _Image else None,
        "platform": sys.platform,
        "shot_dir": _shot_dir(),
    }
    try:
        import ds_direct
        info["model"] = bool(ds_direct.configured())
        info["model_detail"] = ("deepseek web session configured" if info["model"]
                                else "no token in ds_config.json")
    except Exception as e:  # noqa: BLE001
        info["model"] = False
        info["model_detail"] = "%s: %s" % (type(e).__name__, e)
    try:
        from browser_tools import browser_use  # noqa: F401
        info["browser"] = True
    except Exception:  # noqa: BLE001
        info["browser"] = False
    if not info["capture"]:
        info["fix"] = _deps_error()
    return info


# ── Real-window input ─────────────────────────────────────────────────────────
# Click and type into a real top-level window, by handle or title, with
# coordinates relative to the window's own top-left corner (the same rect
# capture_window shoots, so a point read off its screenshot clicks the same
# pixel). Input goes through SendInput, the path a person's mouse and keyboard
# take, so a page cannot tell it from the operator. It drives the operator's
# own windows: use it to reproduce what they report, and say so first.

_VK = {"enter": 0x0D, "return": 0x0D, "tab": 0x09, "escape": 0x1B, "esc": 0x1B, "backspace": 0x08,
       "delete": 0x2E, "space": 0x20, "left": 0x25, "up": 0x26, "right": 0x27, "down": 0x28,
       "home": 0x24, "end": 0x23, "pageup": 0x21, "pagedown": 0x22, "f5": 0x74}
_MODS = {"ctrl": 0x11, "control": 0x11, "shift": 0x10, "alt": 0x12, "win": 0x5B}


def _input_api():
    import ctypes
    import ctypes.wintypes as wt

    class KEYBDINPUT(ctypes.Structure):
        _fields_ = [("wVk", wt.WORD), ("wScan", wt.WORD), ("dwFlags", wt.DWORD),
                    ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class MOUSEINPUT(ctypes.Structure):
        _fields_ = [("dx", ctypes.c_long), ("dy", ctypes.c_long), ("mouseData", wt.DWORD),
                    ("dwFlags", wt.DWORD), ("time", wt.DWORD), ("dwExtraInfo", ctypes.c_size_t)]

    class _U(ctypes.Union):
        _fields_ = [("ki", KEYBDINPUT), ("mi", MOUSEINPUT), ("pad", ctypes.c_byte * 32)]

    class INPUT(ctypes.Structure):
        _fields_ = [("type", wt.DWORD), ("u", _U)]

    user32 = ctypes.windll.user32

    def send(*items):
        arr = (INPUT * len(items))(*items)
        return user32.SendInput(len(items), arr, ctypes.sizeof(INPUT))

    def key(vk=0, scan=0, flags=0):
        i = INPUT(type=1)
        i.u.ki = KEYBDINPUT(vk, scan, flags, 0, 0)
        return i

    def mouse(flags):
        i = INPUT(type=0)
        i.u.mi = MOUSEINPUT(0, 0, 0, flags, 0, 0)
        return i

    return user32, send, key, mouse


def _resolve_window(handle, title):
    """One window by handle, or by a title substring that matches exactly one visible window.

    Several matches are refused rather than guessed: a substring like "Notepad"
    also matches "Notepad++", and input sent to the wrong window types into the
    operator's work.
    """
    if handle:
        return int(handle), None
    if not title:
        return None, "needs a handle or a title substring"
    listed = vision_windows(title=title)
    if listed.get("error"):
        return None, listed["error"]
    cands = [w for w in listed["windows"] if not w["minimized"]] or listed["windows"]
    exact = [w for w in cands if w["title"] == title]
    if len(exact) == 1:
        cands = exact
    if not cands:
        return None, "no window matched %r" % title
    if len(cands) > 1:
        names = "; ".join("%s (handle %s)" % (w["title"], w["handle"]) for w in cands[:6])
        return None, "%d windows match %r, so none was chosen: %s. Pass handle=" % (len(cands), title, names)
    return int(cands[0]["handle"]), None


def _focus(user32, send, key, hwnd):
    """Bring hwnd to the front without sending any keystroke.

    Windows lets a process take the foreground only when it shares input with
    the current foreground thread, so this thread attaches to it for the switch.
    (A tapped Alt key also unlocks the switch, but the target then treats the
    next key as a menu accelerator.)
    """
    import ctypes
    import ctypes.wintypes as wt
    target = wt.HWND(hwnd)
    if int(user32.GetForegroundWindow() or 0) == hwnd:
        return True
    if user32.IsIconic(target):
        user32.ShowWindow(target, 9)
    kernel32 = ctypes.windll.kernel32
    mine = kernel32.GetCurrentThreadId()
    fg = user32.GetWindowThreadProcessId(user32.GetForegroundWindow(), None)
    theirs = user32.GetWindowThreadProcessId(target, None)
    attached = [t for t in {fg, theirs} if t and t != mine and user32.AttachThreadInput(mine, t, True)]
    try:
        user32.BringWindowToTop(target)
        user32.SetForegroundWindow(target)
        user32.SetFocus(target)
    finally:
        for t in attached:
            user32.AttachThreadInput(mine, t, False)
    for _ in range(20):
        if int(user32.GetForegroundWindow() or 0) == hwnd:
            time.sleep(0.15)  # let the window settle focus before input arrives
            return True
        time.sleep(0.05)
    return False


def _window_input(handle, title, act, restore):
    if sys.platform != "win32":
        return {"error": "real-window input is Windows-only"}
    hwnd, err = _resolve_window(handle, title)
    if err:
        return {"error": err}
    user32, send, key, mouse = _input_api()
    previous = int(user32.GetForegroundWindow() or 0)
    if not _focus(user32, send, key, hwnd):
        return {"error": "could not bring window %d to the front" % hwnd, "handle": hwnd}
    try:
        out = act(user32, send, key, mouse, hwnd)
    finally:
        if restore and previous and previous != hwnd:
            time.sleep(0.15)
            _focus(user32, send, key, previous)
    out.update({"handle": hwnd})
    return out


def window_click(x, y, handle=None, title=None, button="left", double=False, restore_focus=False):
    """Click at (x, y) inside a real window, relative to its top-left corner.

    The window is found by handle or title substring (see vision_windows) and
    brought to the front. Coordinates match capture_window's screenshot of the
    same window, so a point read off that image clicks the same spot. Use it to
    reproduce what the operator sees in their own windows, and tell them first:
    it moves their real mouse. restore_focus=True gives the foreground back to
    whatever window had it afterwards.
    """
    def act(user32, send, key, mouse, hwnd):
        rect = _window_rect(hwnd)
        if rect is None:
            return {"error": "window %d has no on-screen rect (minimized?)" % hwnd}
        sx, sy = rect["left"] + int(x), rect["top"] + int(y)
        user32.SetCursorPos(sx, sy)
        down, up = {"left": (0x02, 0x04), "right": (0x08, 0x10), "middle": (0x20, 0x40)}[button]
        for _ in range(2 if double else 1):
            send(mouse(down), mouse(up))
        time.sleep(0.15)
        return {"clicked": [sx, sy]}
    return _window_input(handle, title, act, restore_focus)


def window_type(text, handle=None, title=None, restore_focus=False):
    """Type text into whatever has keyboard focus in a real window, as real keystrokes.

    Characters are sent as Unicode key events (any language, no layout issues);
    "\\n" presses Enter and "\\t" presses Tab. Click the field first with
    window_click. Brings the window to the front; restore_focus=True gives the
    foreground back afterwards.
    """
    def act(user32, send, key, mouse, hwnd):
        for ch in text:
            if ch == "\n":
                send(key(0x0D), key(0x0D, flags=2))
            elif ch == "\t":
                send(key(0x09), key(0x09, flags=2))
            else:
                raw = ch.encode("utf-16-le")
                units = [raw[i] | (raw[i + 1] << 8) for i in range(0, len(raw), 2)]
                # One call per character: a surrogate pair must arrive as one unit.
                send(*[e for u in units for e in (key(0, u, 0x0004), key(0, u, 0x0004 | 0x0002))])
            # Per-character pacing: a burst of injected events can outrun a slow
            # target's message loop, which then drops characters.
            time.sleep(0.02)
        return {"typed": len(text)}
    return _window_input(handle, title, act, restore_focus)


def window_key(combo, handle=None, title=None, restore_focus=False):
    """Press one key or chord in a real window: "Enter", "Escape", "ctrl+a", "ctrl+shift+tab", "f5".

    Brings the window to the front first; restore_focus=True gives the
    foreground back afterwards.
    """
    parts = [p.strip().lower() for p in str(combo).split("+") if p.strip()]
    if not parts:
        return {"error": "window_key needs a key"}
    mods, last = parts[:-1], parts[-1]
    if any(m not in _MODS for m in mods):
        return {"error": "unknown modifier in %r; use ctrl, shift, alt, win" % combo}
    if last in _VK:
        vk = _VK[last]
    elif len(last) == 1 and last.isalnum():
        vk = ord(last.upper())
    else:
        return {"error": "unknown key %r" % last}

    def act(user32, send, key, mouse, hwnd):
        downs = [key(_MODS[m]) for m in mods] + [key(vk)]
        ups = [key(vk, flags=2)] + [key(_MODS[m], flags=2) for m in reversed(mods)]
        send(*downs, *ups)
        time.sleep(0.1)
        return {"pressed": combo}
    return _window_input(handle, title, act, restore_focus)
