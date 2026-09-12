"""Offline contract tests for the kernel's image-return path.

`show()` is what lets a cell hand a REAL picture back to the calling agent's own
vision instead of a description of one. The bytes travel as base64 on the cell's
result frame, so these tests drive a live `kernel_child.py` over its actual wire
protocol and read what came back — nothing here calls a model, and nothing
uploads anything.

The contract has two halves and both are pinned here: the Python side decides
what may be queued and enforces the per-cell caps, and the frame carries only
what a consumer can use. What the harness does with the bytes afterwards is the
TypeScript side's contract and is tested there.

Run it directly:  python test_kernel_images.py
"""

import base64
import json
import os
import subprocess
import sys
import tempfile
import textwrap
import time

HERE = os.path.dirname(os.path.abspath(__file__))
CHILD = os.path.join(HERE, "kernel_child.py")
CELL_PREFIX = "\x00KILN_CELL\x00"

#: A real 2x2 PNG, so the media-type check is answering about real bytes.
PNG = base64.b64decode(
    "iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7i2mMAAAAASUVORK5CYII=")

_failures = []
_passes = []


def check(name, condition, detail=""):
    if condition:
        _passes.append(name)
    else:
        _failures.append("%s%s" % (name, (": " + detail) if detail else ""))


class Kernel:
    """One live kernel child, driven over its real stdin/stdout frame protocol."""

    def __init__(self):
        self.state = tempfile.mkdtemp(prefix="kiln_images_")
        env = dict(os.environ)
        env["KILN_STATE_DIR"] = self.state
        self.proc = subprocess.Popen(
            [sys.executable, "-u", CHILD], cwd=HERE, env=env,
            stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE)
        self.next_id = 1
        self._await_ready()

    def _line(self, timeout=120.0):
        """Read one frame line, or None if the child went quiet."""
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            line = self.proc.stdout.readline()
            if not line:
                return None
            try:
                return json.loads(base64.b64decode(line.strip()).decode("utf-8"))
            except Exception:
                continue
        return None

    def _await_ready(self):
        frame = self._line()
        if frame is None or not frame.get("ready"):
            raise RuntimeError("kernel child never reported ready")

    def run(self, code, timeout=120.0):
        """Send one cell and return the frame that answers it, skipping seam frames."""
        cell_id = self.next_id
        self.next_id += 1
        payload = CELL_PREFIX + json.dumps({"id": cell_id, "code": textwrap.dedent(code)})
        self.proc.stdin.write(base64.b64encode(payload.encode("utf-8")) + b"\n")
        self.proc.stdin.flush()
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            frame = self._line(timeout=max(1.0, deadline - time.monotonic()))
            if frame is None:
                return None
            # A seam request is a harness round trip this test does not serve.
            if "seam" in frame:
                continue
            if frame.get("id") == cell_id:
                return frame
        return None

    def close(self):
        try:
            self.proc.kill()
        except Exception:
            pass


def write_png(directory, name="shot.png", data=PNG):
    path = os.path.join(directory, name)
    with open(path, "wb") as handle:
        handle.write(data)
    return path


def test_show_a_file_returns_an_image():
    kernel = Kernel()
    try:
        path = write_png(kernel.state, "red.png")
        frame = kernel.run("""
            r = show(%r, note="a tiny red square")
            print(repr(r))
        """ % path)
        check("show() reports success", frame is not None and "queued" in (frame.get("out") or ""),
              (frame or {}).get("out", ""))
        images = (frame or {}).get("images") or []
        check("the frame carries exactly one image", len(images) == 1, str(len(images)))
        if images:
            image = images[0]
            check("the media type came from the bytes", image.get("mediaType") == "image/png",
                  str(image.get("mediaType")))
            check("the byte count is the file's", image.get("bytes") == len(PNG), str(image.get("bytes")))
            check("the name is the file's", image.get("name") == "red.png", str(image.get("name")))
            check("the caption survived", image.get("note") == "a tiny red square",
                  str(image.get("note")))
            check("the payload decodes to the same bytes",
                  base64.b64decode(image.get("data", "")) == PNG)
    finally:
        kernel.close()


def test_a_cell_without_show_sends_no_images():
    kernel = Kernel()
    try:
        frame = kernel.run("print('nothing to look at')")
        check("a plain cell still answers", frame is not None and "nothing to look at" in (frame.get("out") or ""))
        # Absent rather than empty: a consumer checks the field, and an always
        # present empty array would make that check meaningless.
        check("no images key at all", not (frame or {}).get("images"),
              str((frame or {}).get("images")))
    finally:
        kernel.close()


def test_an_unsupported_file_is_reported_not_raised():
    kernel = Kernel()
    try:
        path = os.path.join(kernel.state, "not-an-image.txt")
        with open(path, "w") as handle:
            handle.write("hello")
        frame = kernel.run("""
            r = show(%r)
            print(repr(r))
        """ % path)
        out = (frame or {}).get("out") or ""
        check("the cell kept running", frame is not None and "error" in out, out)
        check("nothing was attached", not (frame or {}).get("images"))
        check("the error names the file", "not-an-image.txt" in out, out)
    finally:
        kernel.close()


def test_a_missing_file_is_reported_not_raised():
    kernel = Kernel()
    try:
        frame = kernel.run("""
            r = show("definitely-not-here.png")
            print(repr(r))
        """)
        out = (frame or {}).get("out") or ""
        check("a missing file is a message", "no such file" in out, out)
        check("and attaches nothing", not (frame or {}).get("images"))
    finally:
        kernel.close()


def test_several_images_arrive_in_order():
    kernel = Kernel()
    try:
        first = write_png(kernel.state, "first.png")
        second = write_png(kernel.state, "second.png")
        frame = kernel.run("""
            show(%r, note="one")
            show(%r, note="two")
            print("done")
        """ % (first, second))
        images = (frame or {}).get("images") or []
        check("both images arrived", len(images) == 2, str(len(images)))
        if len(images) == 2:
            check("the queue order is preserved",
                  [i.get("note") for i in images] == ["one", "two"],
                  str([i.get("note") for i in images]))
    finally:
        kernel.close()


def test_the_per_cell_count_cap_is_enforced():
    kernel = Kernel()
    try:
        # Nine is one past the cap of eight.
        frame = kernel.run("""
            import base64
            data = base64.b64decode(%r)
            results = []
            for i in range(9):
                results.append(show(data))
            print(repr(results[-1]))
        """ % base64.b64encode(PNG).decode("ascii"))
        out = (frame or {}).get("out") or ""
        check("the ninth is refused", "per-result limit" in out, out)
        check("the first eight still went", len((frame or {}).get("images") or []) == 8,
              str(len((frame or {}).get("images") or [])))
    finally:
        kernel.close()


def test_raw_bytes_are_accepted_when_they_are_an_image():
    kernel = Kernel()
    try:
        frame = kernel.run("""
            import base64
            r = show(base64.b64decode(%r))
            print(repr(r))
        """ % base64.b64encode(PNG).decode("ascii"))
        images = (frame or {}).get("images") or []
        check("encoded image bytes are accepted", len(images) == 1, str(len(images)))
        if images:
            check("and typed from their signature", images[0].get("mediaType") == "image/png")
    finally:
        kernel.close()


def test_bytes_that_are_not_an_image_are_refused():
    kernel = Kernel()
    try:
        frame = kernel.run("""
            r = show(b"this is not a picture")
            print(repr(r))
        """)
        out = (frame or {}).get("out") or ""
        check("non-image bytes are a message", "not a PNG" in out, out)
        check("and attach nothing", not (frame or {}).get("images"))
    finally:
        kernel.close()


def test_shown_images_reports_without_echoing_the_payload():
    kernel = Kernel()
    try:
        path = write_png(kernel.state, "peek.png")
        frame = kernel.run("""
            show(%r, note="peek")
            print(repr(shown_images()))
        """ % path)
        out = (frame or {}).get("out") or ""
        check("shown_images reports the count", "'count': 1" in out, out)
        # The base64 payload IS the picture; a caller asking what it queued does
        # not want it echoed back into the transcript.
        check("the payload is not echoed", "'data'" not in out, out)
        check("the metadata is there", "peek.png" in out, out)
    finally:
        kernel.close()


def test_show_is_discoverable_through_tool_help():
    kernel = Kernel()
    try:
        frame = kernel.run("print(tool_help('show'))")
        out = (frame or {}).get("out") or ""
        # A helper the model cannot discover is a helper it will not use.
        check("tool_help documents show()", "show" in out and "Show YOURSELF" in out, out[:400])
    finally:
        kernel.close()


def test_a_failing_cell_still_delivers_its_image():
    kernel = Kernel()
    try:
        path = write_png(kernel.state, "before-crash.png")
        frame = kernel.run("""
            show(%r, note="before the traceback")
            raise ValueError("boom")
        """ % path)
        check("the traceback is reported", "ValueError" in ((frame or {}).get("error") or ""),
              str((frame or {}).get("error"))[:200])
        # The picture taken before the failure is exactly the evidence the
        # traceback is about, so it must survive the cell raising.
        check("the image still arrived", len((frame or {}).get("images") or []) == 1,
              str(len((frame or {}).get("images") or [])))
    finally:
        kernel.close()


def main():
    tests = [value for name, value in sorted(globals().items())
             if name.startswith("test_") and callable(value)]
    for test in tests:
        try:
            test()
        except Exception as error:  # noqa: BLE001 - a crashed test is a failure, not a stop
            _failures.append("%s raised %s: %s" % (test.__name__, type(error).__name__, error))

    for name in _passes:
        print("  ok   %s" % name)
    for failure in _failures:
        print("  FAIL %s" % failure)
    print("\n%d passed, %d failed" % (len(_passes), len(_failures)))
    return 1 if _failures else 0


if __name__ == "__main__":
    sys.exit(main())
