#!/usr/bin/env python
"""Offline tests for the image-measurement helpers.

Run:  python test_image_tools.py

These pin the numbers a rendering check is built on: the content box of a
silhouette, the per-band luminance profile that separates "wrong height" from
"inverted normals", the pixel count and box of a frame-to-frame change, and the
single-colour answer that proves a canvas never drew.
"""
import base64
import io
import os
import tempfile

from PIL import Image, ImageDraw

import image_tools

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not ok and detail:
        print("      %s" % detail)


def render_rect(size=(100, 100), rect=(30, 40, 50, 50), background="white", fill="black"):
    """A frame with one solid rectangle, the simplest locatable content."""
    image = Image.new("RGB", size, background)
    ImageDraw.Draw(image).rectangle(rect, fill=fill)
    return image


def write_temp(image, name="frame.png"):
    directory = tempfile.mkdtemp(prefix="dsh-image-tools-")
    path = os.path.join(directory, name)
    image.save(path)
    return path


def test_analyze_locates_content():
    path = write_temp(render_rect())
    result = image_tools.analyze_image(path)
    check("analyze: size", (result["width"], result["height"]) == (100, 100), result)
    # PIL draws inclusive bounds: (30,40)-(50,50) covers 21x11 pixels.\n    check("analyze: content box", result["content_bbox"] == [30, 40, 21, 11], result["content_bbox"])
    check("analyze: content pixels", result["content_pixels"] == 21 * 11, result["content_pixels"])
    check("analyze: background", result["background_hex"] == "#ffffff", result["background_hex"])
    check("analyze: ratio", abs(result["content_ratio"] - 231 / 10000) < 1e-6, result["content_ratio"])


def test_analyze_accepts_every_source_kind():
    image = render_rect()
    buffer = io.BytesIO()
    image.save(buffer, format="PNG")
    payload = buffer.getvalue()

    from_bytes = image_tools.analyze_image(payload)
    from_data_url = image_tools.analyze_image("data:image/png;base64," + base64.b64encode(payload).decode())
    from_base64 = image_tools.analyze_image(base64.b64encode(payload).decode())
    from_image = image_tools.analyze_image(image)
    boxes = {tuple(result["content_bbox"]) for result in (from_bytes, from_data_url, from_base64, from_image)}
    check("analyze: bytes, data URL, base64, and PIL agree", boxes == {(30, 40, 21, 11)}, boxes)


def test_analyze_reports_a_blank_frame():
    blank = image_tools.analyze_image(Image.new("RGB", (64, 64), "white"))
    check("analyze: blank frame has no content box", blank["content_bbox"] is None, blank["content_bbox"])
    check("analyze: blank frame is one colour", blank["channel_stddev"] == [0, 0, 0], blank["channel_stddev"])


def test_compare_identical_and_changed():
    path = write_temp(render_rect())
    same = image_tools.compare_images(path, path)
    check("compare: identical frames", same["identical"] is True and same["changed_pixels"] == 0, same)

    moved = write_temp(render_rect(rect=(30, 60, 50, 70)), "moved.png")
    changed = image_tools.compare_images(path, moved)
    check("compare: change detected", changed["identical"] is False, changed)
    check("compare: change box", changed["bbox"] == [30, 40, 21, 31], changed["bbox"])
    # Two disjoint 21x11 rectangles with no overlap: every pixel of both changed.
    check("compare: changed pixel count", changed["changed_pixels"] == 2 * 21 * 11, changed["changed_pixels"])


def test_compare_tolerance_suppresses_noise():
    pure = render_rect(fill="black")
    near = render_rect(fill=(0, 0, 3))
    strict = image_tools.compare_images(pure, near, tolerance=0)
    loose = image_tools.compare_images(pure, near, tolerance=8)
    check("compare: a 3-level delta counts as change at tolerance 0", strict["changed_pixels"] == 21 * 11, strict["changed_pixels"])
    check("compare: the same delta is ignored at tolerance 8", loose["changed_pixels"] == 0, loose["changed_pixels"])


def test_compare_rejects_different_sizes():
    small = write_temp(render_rect(size=(10, 10)), "small.png")
    large = write_temp(render_rect(size=(20, 20)), "large.png")
    result = image_tools.compare_images(small, large)
    check("compare: different sizes are reported, not compared", result["same_size"] is False, result)


def test_luminance_rows_sees_a_gradient():
    gradient = Image.new("L", (32, 64))
    for y in range(64):
        for x in range(32):
            gradient.putpixel((x, y), y * 4)
    rows = image_tools.luminance_rows(gradient, bands=4)["luminance"]
    check("luminance: four bands", len(rows) == 4, rows)
    check("luminance: dark to light", rows == sorted(rows) and rows[0] < rows[-1], rows)

    flat = image_tools.luminance_rows(Image.new("RGB", (32, 64), "white"), bands=4)["luminance"]
    check("luminance: a flat frame is flat", len(set(flat)) == 1, flat)


def test_region_stats():
    path = write_temp(render_rect())
    inside = image_tools.region_stats(path, (30, 40, 20, 10))
    outside = image_tools.region_stats(path, (0, 0, 10, 10))
    check("region: inside the rect is black", inside["luminance_mean"] == 0, inside)
    check("region: outside the rect is white", outside["luminance_mean"] == 255, outside)


def test_dominant_colors():
    colors = image_tools.dominant_colors(render_rect(), top=2)
    check("colors: background is dominant", colors[0]["hex"] == "#ffffff", colors)
    check("colors: background ratio", abs(colors[0]["ratio"] - (10000 - 231) / 10000) < 1e-6, colors[0])
    blank = image_tools.dominant_colors(Image.new("RGB", (8, 8), (10, 20, 30)), top=3)
    check("colors: a frame that never drew is one colour at 100%",
          len(blank) == 1 and blank[0]["ratio"] == 1.0, blank)


def test_diff_mask_writes_a_file():
    first = write_temp(render_rect())
    second = write_temp(render_rect(rect=(0, 0, 10, 10)), "other.png")
    target = os.path.join(tempfile.mkdtemp(prefix="dsh-image-mask-"), "mask.png")
    written = image_tools.image_diff_mask(first, second, path=target)
    check("mask: file written", os.path.exists(written), written)
    check("mask: mask has the frame's size", Image.open(written).size == (100, 100), Image.open(written).size)


def main():
    tests = [value for name, value in sorted(globals().items()) if name.startswith("test_") and callable(value)]
    for test in tests:
        test()
    failed = [entry for entry in RESULTS if not entry[1]]
    print("\n%d checks, %d failed" % (len(RESULTS), len(failed)))
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
