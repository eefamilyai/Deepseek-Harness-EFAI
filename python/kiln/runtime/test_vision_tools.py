#!/usr/bin/env python
"""Regression tests for vision_tools — capture, windows, and the model handoff.

Run:  python test_vision_tools.py

Everything here is OFFLINE: no image is ever sent to a model and nothing is
uploaded, so these pass on a box with no DeepSeek account. That claim is
enforced, not merely intended — see `_OfflineGuard` below. What they pin is the part that has
to be right before a model is involved at all:

  * a capture produces a real, openable PNG of the requested size, and the
    downscale actually happens (a full-size 1920x1080 grab is a lot of tokens
    spent on wallpaper);
  * a region is honoured exactly, so "show me this dialog" shows that dialog;
  * bad input is a returned error, never a raise — every public entry point is
    called from a kernel cell where an exception costs the model a whole turn;
  * `see()` routes each target to the right capture and can skip the model
    entirely with prompt=False, which is how a caller asks for a file;
  * window enumeration returns rectangles that can be fed straight back into a
    capture.

The model half is exercised only up to its guard clauses (missing file, no
account), because the real thing needs a live session and belongs in a smoke run,
not here.
"""
import inspect
import os
import struct
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

# Point the shot dir at a scratch folder so a test run never litters the real
# state directory, and so the "deleted when keep=False" case is provable.
_SCRATCH = tempfile.mkdtemp(prefix="vision_test_")
os.environ["KILN_STATE_DIR"] = _SCRATCH

import vision_tools as vt

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


def png_size(path):
    """(width, height) read straight out of the IHDR chunk.

    Read by hand rather than with Pillow so the test does not depend on the
    same library it is checking the output of.
    """
    with open(path, "rb") as f:
        data = f.read(24)
    if data[:8] != b"\x89PNG\r\n\x1a\n" or data[12:16] != b"IHDR":
        return None
    return struct.unpack(">II", data[16:24])


# ── status ─────────────────────────────────────────────────────────
st = vt.vision_status()
check("vision_status reports capture capability", "capture" in st)
check("vision_status reports a shot dir under the state dir",
      st.get("shot_dir", "").startswith(_SCRATCH), repr(st.get("shot_dir")))
check("vision_status names the model capability",
      "model" in st and "model_detail" in st)
check("vision_status never raises", isinstance(st, dict))


# ── capture ────────────────────────────────────────────────────────
if vt._mss is None or vt._Image is None:
    print("SKIP  capture tests (mss/pillow missing): %s" % vt._deps_error())
else:
    res = vt.capture_screen()
    check("capture_screen returns a path", bool(res.get("path")), repr(res))
    check("capture_screen wrote a real PNG",
          res.get("path") and os.path.exists(res["path"])
          and png_size(res["path"]) == (res["width"], res["height"]),
          repr(res))
    check("capture_screen downscales to max_width",
          res["width"] <= 1600, repr(res.get("width")))
    check("capture_screen kept the aspect ratio",
          abs((res["width"] / float(res["height"])) - (16 / 9.0)) < 0.05,
          repr((res.get("width"), res.get("height"))))
    check("capture_screen reports the scale it applied",
          0 < res.get("scale", 0) <= 1.0, repr(res.get("scale")))

    big = vt.capture_screen(max_width=0)          # 0 = keep native size
    check("max_width=0 disables downscaling", big.get("scale") == 1.0, repr(big))
    check("the native capture is bigger than the scaled one",
          big["width"] > res["width"], "%s vs %s" % (big["width"], res["width"]))

    small = vt.capture_screen(max_width=640)
    check("a smaller max_width produces a smaller image",
          small["width"] <= 640, repr(small.get("width")))

    # A region must be honoured exactly: this is what makes "screenshot this
    # dialog" show the dialog instead of the desktop it sits on.
    reg = vt.capture_screen(left=10, top=20, width=300, height=200, max_width=0)
    check("a region captures exactly the requested rectangle",
          png_size(reg["path"]) == (300, 200), repr(png_size(reg.get("path"))))
    check("the region is echoed back", reg.get("region", {}).get("left") == 10,
          repr(reg.get("region")))
    reg2 = vt.capture_screen(region={"left": 5, "top": 6, "width": 120, "height": 90},
                             max_width=0)
    check("a region dict works like the kwargs",
          png_size(reg2["path"]) == (120, 90), repr(png_size(reg2.get("path"))))

    # Errors are values, not exceptions.
    for label, call in [
        ("zero-size region", lambda: vt.capture_screen(left=0, top=0, width=0, height=1)),
        ("negative width", lambda: vt.capture_screen(left=0, top=0, width=-5, height=5)),
        ("region without left/top", lambda: vt.capture_screen(region={"width": 5, "height": 5})),
        ("non-dict region", lambda: vt.capture_screen(region=[1, 2, 3, 4])),
        ("bad monitor index", lambda: vt.capture_screen(monitor=99)),
    ]:
        r = call()
        check("bad input returns an error, not a raise: %s" % label,
              isinstance(r, dict) and bool(r.get("error")), repr(r)[:200])

    mons = vt.vision_monitors()
    check("vision_monitors lists at least the primary display",
          mons.get("count", 0) >= 1, repr(mons)[:200])
    check("monitor index 0 is the combined desktop",
          mons["monitors"][0]["width"] >= mons["monitors"][1]["width"], repr(mons)[:200])
    check("exactly one monitor is marked primary",
          sum(1 for m in mons["monitors"] if m.get("primary")) == 1, repr(mons)[:300])


# ── see() routing ──────────────────────────────────────────────────
check("see is callable", callable(vt.see))
check("see('monitors') needs no model",
      "monitors" in vt.see("monitors"))
check("see('nonsense') falls back to the screen capture",
      "path" in vt.see("nonsense", prompt=False, max_width=200))
check("see('image') without a path errors",
      "error" in vt.see("image"))
check("see('image') on a missing file errors",
      "error" in vt.see("image", path=os.path.join(_SCRATCH, "nope.png")))

if vt._mss is not None and vt._Image is not None:
    shot = vt.see("screen", prompt=False, max_width=200)
    check("see(prompt=False) captures without calling a model",
          bool(shot.get("path")) and os.path.exists(shot["path"]), repr(shot))
    # keep=False must clean up after itself — otherwise every "just tell me what
    # is on screen" call leaves a PNG behind forever. Assert on the specific
    # file the call created, not just on the directory listing, so a leak with a
    # coincidentally-equal count still fails.
    r2 = vt.see("screen", prompt=False, max_width=200, keep=False)
    check("keep=False still returns the capture it made",
          bool(r2.get("path")), repr(r2))
    check("keep=False removes exactly the file it created",
          not os.path.exists(r2["path"]), "still present: %s" % r2.get("path"))
    before = set(os.listdir(vt._shot_dir()))
    r3 = vt.see("screen", prompt=False, max_width=200, keep=False)
    after = set(os.listdir(vt._shot_dir()))
    check("keep=False leaves the shot dir unchanged",
          before == after, "added %s" % (after - before))
    check("the default keep=True DOES leave the file (so keep=False means something)",
          os.path.exists(shot["path"]), repr(shot.get("path")))

    win = vt.see("window", prompt=False, title="zzz-no-such-window-zzz")
    check("see('window') with no match errors", "error" in win, repr(win)[:200])


# ── windows ────────────────────────────────────────────────────────
if sys.platform == "win32":
    w = vt.vision_windows()
    check("vision_windows returns a list", "windows" in w, repr(w)[:200])
    if w.get("windows"):
        first = w["windows"][0]
        check("a window row carries its rectangle",
              all(k in first for k in ("handle", "title", "left", "top",
                                       "width", "height", "minimized")),
              repr(first)[:300])
        check("a window rectangle is positive-sized",
              first["width"] > 0 and first["height"] > 0, repr(first)[:200])
        # The rectangle must be directly usable as a capture region, which is
        # the whole point of returning it.
        if vt._mss is not None and vt._Image is not None:
            cap = vt.capture_screen(left=first["left"], top=first["top"],
                                    width=min(first["width"], 300),
                                    height=min(first["height"], 200), max_width=0)
            check("a window rect can be fed straight into a capture",
                  bool(cap.get("path")), repr(cap)[:200])
        check("a title filter narrows the list",
              len(vt.vision_windows(title="zzz-nope-zzz")["windows"]) == 0)
    check("capture_window without handle or title errors",
          "error" in vt.capture_window())
    check("capture_window with an impossible title errors",
          "error" in vt.capture_window(title="zzz-no-such-window-zzz"))
    check("capture_window with a bogus handle errors",
          "error" in vt.capture_window(handle=1))
else:
    check("vision_windows is Windows-only and says so",
          "error" in vt.vision_windows())


# ── the model handoff (guard clauses only) ─────────────────────────
check("describe_image without a path errors", "error" in vt.describe_image())
check("describe_image on a missing file errors",
      "error" in vt.describe_image(path=os.path.join(_SCRATCH, "nope.png")))
check("describe_image reports the missing name",
      "nope.png" in vt.describe_image(path=os.path.join(_SCRATCH, "nope.png"))["error"])
check("describe_screen surfaces a capture error instead of calling a model",
      "error" in vt.describe_screen(region={"left": 0, "top": 0, "width": 0, "height": 0}))

# describe_image must pass real bytes to ds_direct and flatten its per-file
# result. Driven against a stub so no network is involved.
_real_ds = None
try:
    import ds_direct as _real_ds
except Exception:
    _real_ds = None

if _real_ds is not None:
    img = os.path.join(_SCRATCH, "probe.png")
    with open(img, "wb") as f:
        f.write(b"\x89PNG\r\n\x1a\n" + b"x" * 64)

    class _FakeDS:
        configured = staticmethod(lambda: True)

        @staticmethod
        def describe_files(pairs, prompt, cancelled=None):
            _FakeDS.seen = {"names": [n for n, _ in pairs],
                            "sizes": [len(b) for _, b in pairs],
                            "prompt": prompt}
            return {n: {"description": "a test image", "error": ""} for n, _ in pairs}

    vt_ds = vt.__dict__.get("ds_direct")
    import sys as _sys
    saved = _sys.modules.get("ds_direct")
    _sys.modules["ds_direct"] = _FakeDS
    try:
        got = vt.describe_image(path=img, prompt="what is this")
        check("describe_image returns the model's text",
              got.get("description") == "a test image", repr(got))
        check("describe_image passes the file's real bytes",
              _FakeDS.seen["sizes"] == [os.path.getsize(img)], repr(_FakeDS.seen))
        check("describe_image passes the caller's prompt through",
              _FakeDS.seen["prompt"] == "what is this", repr(_FakeDS.seen))
        check("describe_image reports the file list",
              got["files"][0]["name"] == "probe.png", repr(got.get("files")))

        multi = vt.describe_image(files=[img, img])
        check("describe_image accepts several files",
              len(multi["files"]) == 2 and "description" in multi, repr(multi)[:200])
    finally:
        if saved is not None:
            _sys.modules["ds_direct"] = saved
        else:
            _sys.modules.pop("ds_direct", None)

    # A caller with no account gets a message that separates the two problems:
    # the capture worked, only the reading needs a model.
    class _NoAccount(_FakeDS):
        configured = staticmethod(lambda: False)

    _sys.modules["ds_direct"] = _NoAccount
    try:
        r = vt.describe_image(path=img)
        check("no account is reported as a model problem, not a capture one",
              "capture succeeded" in r.get("error", ""), repr(r)[:250])
    finally:
        if saved is not None:
            _sys.modules["ds_direct"] = saved
        else:
            _sys.modules.pop("ds_direct", None)


# ── every public entry point is exception-free by contract ─────────
PUBLIC = ["capture_screen", "capture_window", "capture_browser", "describe_image",
          "describe_screen", "see", "vision_monitors", "vision_windows",
          "vision_status"]


class _OfflineGuard:
    """A `ds_direct` stand-in that turns any network use into a FAILURE.

    Calling every public entry point with no arguments is the right contract
    check — a tool that raises on a bare call costs the model a turn — but
    `describe_screen()` and `see()` capture the screen and then hand it to a
    model, so with a real account configured this loop used to upload a live
    screenshot and open a real chat. That is the one thing this suite promises
    never happens.

    Reporting "no account" keeps the loop meaningful (`configured()` returning
    False is a path the tools must survive) while any stray upload fails the
    run loudly instead of quietly reaching the network.
    """

    calls = []

    @staticmethod
    def configured():
        return False

    @staticmethod
    def describe_files(*a, **k):
        _OfflineGuard.calls.append("describe_files")
        raise AssertionError("offline suite reached describe_files")

    @staticmethod
    def upload_files(*a, **k):
        _OfflineGuard.calls.append("upload_files")
        raise AssertionError("offline suite reached upload_files")


import sys as _sys
_saved_ds = _sys.modules.get("ds_direct")
_sys.modules["ds_direct"] = _OfflineGuard
try:
    for name in PUBLIC:
        fn = getattr(vt, name, None)
        check("%s exists and is documented" % name,
              callable(fn) and bool(inspect.getdoc(fn)), repr(fn))
        if callable(fn):
            try:
                out = fn()
                check("%s() with no arguments returns a dict, not a raise" % name,
                      isinstance(out, dict), "%s -> %r" % (name, type(out).__name__))
            except Exception as e:
                check("%s() with no arguments returns a dict, not a raise" % name,
                      False, "%s: %s" % (type(e).__name__, e))
finally:
    if _saved_ds is not None:
        _sys.modules["ds_direct"] = _saved_ds
    else:
        _sys.modules.pop("ds_direct", None)

check("the no-argument contract loop never reached the network",
      _OfflineGuard.calls == [], repr(_OfflineGuard.calls))

print()
if FAILS:
    print("%d FAILURE(S): %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all checks passed")
