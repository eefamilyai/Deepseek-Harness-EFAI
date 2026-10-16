#!/usr/bin/env python
"""Offline tests for the real-window input helpers in vision_tools.py.

Run:  python test_window_input.py

Pins the parts that decide where input goes and what it says: a title that
matches several windows is refused instead of guessed, key chords are parsed
or refused, characters become Unicode key events (a surrogate pair travels in
one SendInput call), and the helpers are registered in the kernel.
SendInput itself is stubbed; the live check is in .recon/dshai notes.
"""
import os
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import vision_tools as vt  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not ok and detail:
        print("      %s" % detail)


WINDOWS = [
    {"handle": 1, "title": "a - Notepad", "class": "Notepad", "minimized": False},
    {"handle": 2, "title": "b - Notepad++", "class": "Notepad++", "minimized": False},
    {"handle": 3, "title": "Probe", "class": "Tk", "minimized": False},
    {"handle": 4, "title": "Probe two", "class": "Tk", "minimized": False},
    {"handle": 5, "title": "Hidden", "class": "X", "minimized": True},
]
vt.vision_windows = lambda title=None: {"windows": [w for w in WINDOWS if title is None or title.lower() in w["title"].lower()]}

check("a handle is used as given", vt._resolve_window(9, None) == (9, None))
check("no handle and no title is refused", vt._resolve_window(None, None)[0] is None)
h, err = vt._resolve_window(None, "Notepad")
check("an ambiguous title is refused, naming the matches", h is None and "2 windows match" in err and "handle 1" in err and "handle 2" in err, err)
check("an exact title wins among several matches", vt._resolve_window(None, "Probe") == (3, None))
check("a unique substring resolves", vt._resolve_window(None, "two") == (4, None))
check("a minimized-only match still resolves", vt._resolve_window(None, "Hidden") == (5, None))
check("no match is reported", "no window matched" in vt._resolve_window(None, "zzz")[1])

# Route input through a recording stand-in.
SENT = []


class FakeUser32:
    def GetForegroundWindow(self):
        return 77


def fake_input(handle, title, act, restore):
    hwnd, err = vt._resolve_window(handle, title)
    if err:
        return {"error": err}

    def send(*items):
        SENT.append(items)
        return len(items)

    def key(vk=0, scan=0, flags=0):
        return ("key", vk, scan, flags)

    def mouse(flags):
        return ("mouse", flags)

    out = act(FakeUser32(), send, key, mouse, hwnd)
    out["handle"] = hwnd
    return out


vt._window_input = fake_input
SENT.clear()
r = vt.window_type("a😀\n\t", handle=3)
check("typing reports its length", r == {"typed": 4, "handle": 3}, r)
check("a BMP character is one down/up pair in one call", SENT[0] == (("key", 0, 0x61, 4), ("key", 0, 0x61, 6)), SENT[0])
check("a surrogate pair travels in one call", len(SENT[1]) == 4 and [e[2] for e in SENT[1]] == [0xD83D, 0xD83D, 0xDE00, 0xDE00], SENT[1])
check("newline presses Enter, tab presses Tab", SENT[2] == (("key", 0x0D, 0, 0), ("key", 0x0D, 0, 2)) and SENT[3][0][1] == 0x09)

SENT.clear()
r = vt.window_key("ctrl+shift+Tab", handle=3)
check("a chord presses modifiers, the key, then releases in reverse", SENT[0] == (
    ("key", 0x11, 0, 0), ("key", 0x10, 0, 0), ("key", 0x09, 0, 0),
    ("key", 0x09, 0, 2), ("key", 0x10, 0, 2), ("key", 0x11, 0, 2)), SENT[0])
check("a letter key maps to its virtual key", (vt.window_key("ctrl+a", handle=3), SENT[-1][1])[1] == ("key", 0x41, 0, 0))
check("an unknown modifier is refused", "unknown modifier" in vt.window_key("hyper+a", handle=3)["error"])
check("an unknown key is refused", "unknown key" in vt.window_key("qq", handle=3)["error"])
check("an empty key is refused", "needs a key" in vt.window_key("", handle=3)["error"])
check("an ambiguous title is refused for typing too", "error" in vt.window_type("x", title="Notepad"))

with open(os.path.join(HERE, "kernel_child.py"), encoding="utf-8") as fh:
    kernel = fh.read()
check("the kernel registers all three helpers", all('"%s": vision_tools.%s' % (n, n) in kernel for n in ("window_click", "window_type", "window_key")))
check("each helper has a docstring", all((getattr(vt, n).__doc__ or "").strip() for n in ("window_click", "window_type", "window_key")))

failed = [x for x in RESULTS if not x[1]]
print("\n%d passed, %d failed" % (len(RESULTS) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
