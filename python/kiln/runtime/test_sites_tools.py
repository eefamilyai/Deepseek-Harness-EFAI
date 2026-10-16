#!/usr/bin/env python
"""Offline tests for sites_tools.py, the kernel helpers over the harness `site` tool.

Run:  python test_sites_tools.py

The module is bound to a recording stand-in for `call_tool`, so these tests pin the
arguments each helper sends and how sources become file lists, without a kernel,
a harness, or a network. They also pin that kernel_child.py imports, binds, and
registers the helpers, and that every helper carries a docstring for `tool_help`.
"""
import base64
import os
import sys
import tempfile

HERE = os.path.dirname(os.path.abspath(__file__))
sys.path.insert(0, HERE)
import sites_tools  # noqa: E402

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not ok and detail:
        print("      %s" % detail)


CALLS = []
ANSWERS = []


def fake_call(name, arguments, timeout=None):
    CALLS.append((name, arguments, timeout))
    return ANSWERS.pop(0) if ANSWERS else {"text": "ok", "url": "https://x/"}


def raises(fn, kind):
    try:
        fn()
    except kind:
        return True
    except Exception:  # noqa: BLE001
        return False
    return False


# Unbound helpers refuse clearly.
sites_tools._CALL = None
check("unbound helpers raise", raises(lambda: sites_tools.site_list(), RuntimeError))

sites_tools.bind(fake_call)

# Sources.
sites_tools.site_publish("demo", "<h1>raw</h1>", title="T", wait_seconds=30)
name, args, timeout = CALLS[-1]
check("an HTML string becomes index.html", args["files"] == [{"path": "index.html", "content": "<h1>raw</h1>"}], args)
check("publish forwards name, title, and wait", (name, args["action"], args["name"], args["title"], args["wait_seconds"]) == ("site", "publish", "demo", "T", 30))
check("publish timeout covers the wait", timeout == 150.0, timeout)

sites_tools.site_publish("demo", {"index.html": "x", "a\\b.png": b"\x01\x02", "c.txt": "y"})
files = {f["path"]: f for f in CALLS[-1][1]["files"]}
check("dict paths use forward slashes", "a/b.png" in files, files)
check("bytes are sent as base64", files["a/b.png"] == {"path": "a/b.png", "content": base64.b64encode(b"\x01\x02").decode(), "base64": True})
check("no title is omitted", "title" not in CALLS[-1][1])

folder = tempfile.mkdtemp()
os.makedirs(os.path.join(folder, "assets"))
os.makedirs(os.path.join(folder, "node_modules"))
with open(os.path.join(folder, "index.html"), "w", encoding="utf-8") as fh:
    fh.write("<p>folder</p>")
with open(os.path.join(folder, "assets", "pic.bin"), "wb") as fh:
    fh.write(b"\x00\xff")
with open(os.path.join(folder, "node_modules", "skip.js"), "w") as fh:
    fh.write("x")
sites_tools.site_publish("demo", folder)
paths = sorted(f["path"] for f in CALLS[-1][1]["files"])
check("a folder is walked, skipping node_modules", paths == ["assets/pic.bin", "index.html"], paths)

from pathlib import Path  # noqa: E402
sites_tools.site_publish("demo", {"index.html": Path(folder) / "index.html", "pic": Path(folder) / "assets" / "pic.bin"})
files = {f["path"]: f for f in CALLS[-1][1]["files"]}
check("a Path value reads text or bytes", files["index.html"]["content"] == "<p>folder</p>" and files["pic"].get("base64") is True, files)

check("a non-string value is refused", raises(lambda: sites_tools.site_publish("d", {"index.html": 3}), TypeError))
check("an unusable source is refused", raises(lambda: sites_tools.site_publish("d", "plain words"), ValueError))

# Other actions.
sites_tools.site_status("demo")
check("status sends its action", CALLS[-1][1] == {"action": "status", "name": "demo"})
sites_tools.site_list()
check("list sends its action", CALLS[-1][1] == {"action": "list"})
sites_tools.site_remove("demo")
check("remove sends its action", CALLS[-1][1] == {"action": "remove", "name": "demo"})

ANSWERS.append("plain text")
check("a non-dict answer is wrapped", sites_tools.site_list() == {"text": "plain text"})
check("a result displays as one line", repr(sites_tools.site_status("demo")) == "<site https://x/>" and repr(sites_tools.SiteResult()) == "<site result>")

# Waiting for https.
ANSWERS.extend([{"text": "- answers: http 200; https no answer"}, {"text": "- answers: http 301; https 200"}])
real_sleep = sites_tools.time.sleep
sites_tools.time.sleep = lambda s: None
check("wait_https polls until https answers", sites_tools.site_wait_https("demo", timeout=60, every=0) is True)
ANSWERS.append({"text": "- answers: https no answer"})
check("wait_https gives up at the deadline", sites_tools.site_wait_https("demo", timeout=0, every=0) is False)
sites_tools.time.sleep = real_sleep

# Starters.
for kind in ["page", "slides", "illustration", "chart"]:
    path = sites_tools.site_starter(kind, "My <Title>")
    with open(os.path.join(path, "index.html"), encoding="utf-8") as fh:
        html = fh.read()
    check(f"starter {kind} carries the title", "My <Title>" in html and "{title}" not in html)
with open(os.path.join(sites_tools.site_starter("slides", "S"), "index.html"), encoding="utf-8") as fh:
    check("slides keep their JavaScript braces", "Reveal.initialize({ hash: true" in fh.read())
target = os.path.join(tempfile.mkdtemp(), "nested", "site")
check("a starter writes into a given folder", sites_tools.site_starter("page", "P", target) == target and os.path.exists(os.path.join(target, "style.css")))
check("an unknown starter is refused", raises(lambda: sites_tools.site_starter("poster"), ValueError))

# Registration.
check("every helper has a docstring", all((fn.__doc__ or "").strip() for fn in sites_tools.HELPERS.values()))
with open(os.path.join(HERE, "kernel_child.py"), encoding="utf-8") as fh:
    kernel = fh.read()
check("kernel_child imports sites_tools", "import sites_tools" in kernel)
check("kernel_child binds call_tool and registers the helpers",
      "sites_tools.bind(call_tool)" in kernel and "prompt_dict.update(sites_tools.HELPERS)" in kernel and "globals().update(sites_tools.HELPERS)" in kernel)

failed = [r for r in RESULTS if not r[1]]
print("\n%d passed, %d failed" % (len(RESULTS) - len(failed), len(failed)))
sys.exit(1 if failed else 0)
