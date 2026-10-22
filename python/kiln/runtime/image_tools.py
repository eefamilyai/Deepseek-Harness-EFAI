"""Pixel measurements for a rendered image.

A rendering bug is a question about numbers: is the silhouette there and how
tall, did the frame change between two moments, is the shadow band where the
gradient should put it, is the canvas one flat colour. Looking at a screenshot
answers none of those reliably — shading read as silhouette is how an inverted
normal survives six build-screenshot-guess rounds — while measuring it answers
each in one call.

Everything here takes a *source*: a file path, a `data:` URL, raw base64, image
bytes, or a PIL image. Everything returns plain dicts and numbers, so a result
can be printed, compared, or asserted on without further conversion.
"""

from __future__ import annotations

import base64
import io
import os
import re
from typing import Any

try:  # pragma: no cover - exercised through the kernel, not the test suite
    from PIL import Image, ImageChops, ImageStat
except Exception as _pillow_error:  # pragma: no cover
    Image = None
    ImageChops = None
    ImageStat = None
    _PILLOW_IMPORT_ERROR = _pillow_error

_DATA_URL = re.compile(r"^data:image/[a-zA-Z0-9.+-]+;base64,", re.IGNORECASE)


def _require_pillow() -> None:
    if Image is None:  # pragma: no cover - depends on the runtime image
        raise RuntimeError(
            "Pillow is not installed in this kernel runtime, so images cannot be measured: %s"
            % (_PILLOW_IMPORT_ERROR,)
        )


def _open(source: Any) -> "Image.Image":
    """Open a source as a PIL image without ever mutating the caller's object."""
    _require_pillow()
    if isinstance(source, Image.Image):
        return source.copy()
    if isinstance(source, (bytes, bytearray, memoryview)):
        return Image.open(io.BytesIO(bytes(source)))
    if isinstance(source, str):
        text = source.strip()
        if _DATA_URL.match(text):
            text = _DATA_URL.sub("", text)
            return Image.open(io.BytesIO(base64.b64decode(text)))
        if os.path.exists(text):
            return Image.open(text)
        # Not a path: accept a bare base64 payload rather than making the caller
        # detect the difference between "a file that is missing" and "bytes".
        try:
            return Image.open(io.BytesIO(base64.b64decode(text, validate=True)))
        except Exception:
            raise FileNotFoundError(
                "no image at %r: it is not an existing path, a data URL, or base64 bytes" % (source,)
            )
    raise TypeError("unsupported image source: %r" % (type(source).__name__,))


def _luminance(image: "Image.Image") -> "Image.Image":
    """The image as 8-bit luminance, composited over black when it has alpha."""
    if image.mode in ("RGBA", "LA", "PA"):
        flat = Image.new("RGBA", image.size, (0, 0, 0, 255))
        flat.alpha_composite(image.convert("RGBA"))
        return flat.convert("L")
    return image.convert("L")


def _hex(color: Any) -> str:
    if not isinstance(color, (tuple, list)):
        return str(color)
    channels = [int(channel) for channel in color[:3]]
    return "#" + "".join("%02x" % max(0, min(255, channel)) for channel in channels)


def _channel_peak(image: "Image.Image") -> "Image.Image":
    """Per-pixel maximum across an image's channels, as an 8-bit mask input.

    Deliberately not `.convert("L")`: that weights channels by luminance, so a
    change confined to one channel — a slightly wrong blue, a green outline —
    rounds to zero and disappears from the mask. A rendering check that reports
    "no change" for a colour shift is worse than no check at all.
    """
    bands = image.split()
    peak = bands[0]
    for band in bands[1:]:
        peak = ImageChops.lighter(peak, band)
    return peak


def _corner_color(image: "Image.Image") -> tuple:
    """The top-left pixel, as the background a rendered frame is usually drawn on."""
    return image.convert("RGB").getpixel((0, 0))


def _distance_mask(image: "Image.Image", color: tuple, tolerance: int) -> "Image.Image":
    """A binary mask of pixels further than `tolerance` from `color`."""
    solid = Image.new("RGB", image.size, tuple(color[:3]))
    difference = ImageChops.difference(image.convert("RGB"), solid)
    return _channel_peak(difference).point(lambda value: 255 if value > tolerance else 0)


def analyze_image(source, background=None, tolerance=8):
    """Measure one image: size, channel statistics, luminance, and the content box.

    `content_bbox` is the bounding box of everything that differs from
    `background` (the top-left pixel unless given), which is how a silhouette,
    a spinning model, or a chart is located without looking at the picture.
    Returns width/height, per-channel means and standard deviations, luminance
    mean and median, the background colour, and the content box and its share of
    the frame.
    """
    image = _open(source)
    rgb = image.convert("RGB")
    luminance = _luminance(image)
    channels = ImageStat.Stat(rgb)
    light = ImageStat.Stat(luminance)
    corner = list(_corner_color(image)) if background is None else list(background)
    mask = _distance_mask(image, corner, tolerance)
    box = mask.getbbox()
    histogram = mask.histogram()
    marked = sum(histogram[1:]) if len(histogram) > 1 else 0
    total = max(1, image.size[0] * image.size[1])
    return {
        "width": image.size[0],
        "height": image.size[1],
        "mode": image.mode,
        "channel_means": [round(value, 3) for value in channels.mean],
        "channel_stddev": [round(value, 3) for value in channels.stddev],
        "luminance": {
            "mean": round(light.mean[0], 3),
            "median": light.median[0],
            "min": light.extrema[0][0],
            "max": light.extrema[0][1],
        },
        "background": corner,
        "background_hex": _hex(corner),
        "content_bbox": None if box is None else [box[0], box[1], box[2] - box[0], box[3] - box[1]],
        "content_pixels": marked,
        "content_ratio": round(marked / total, 5),
    }


def compare_images(first, second, tolerance=0):
    """Measure what changed between two images and where.

    The answer a two-frame check needs: how many pixels differ, by how much on
    average and at worst, and the box that contains every change. With
    `tolerance` above zero, differences at or below it are ignored, which is what
    makes "the animation advanced" separate from "the renderer re-ran with the
    same output".
    """
    before = _open(first)
    after = _open(second)
    if before.size != after.size:
        return {
            "same_size": False,
            "first_size": list(before.size),
            "second_size": list(after.size),
            "note": "sizes differ, so no per-pixel comparison was made",
        }
    difference = ImageChops.difference(before.convert("RGB"), after.convert("RGB"))
    peak = _channel_peak(difference)
    changed = peak.point(lambda value: 255 if value > tolerance else 0)
    box = changed.getbbox()
    marked = peak.histogram()
    changed_pixels = 0
    for value in range(tolerance + 1, 256):
        changed_pixels += marked[value]
    total = max(1, before.size[0] * before.size[1])
    stats = ImageStat.Stat(difference)
    return {
        "same_size": True,
        "width": before.size[0],
        "height": before.size[1],
        "changed_pixels": changed_pixels,
        "changed_ratio": round(changed_pixels / total, 5),
        "mean_channel_delta": [round(value, 3) for value in stats.mean],
        "max_channel_delta": [bounds[1] for bounds in stats.extrema],
        "bbox": None if box is None else [box[0], box[1], box[2] - box[0], box[3] - box[1]],
        "identical": changed_pixels == 0,
    }


def region_stats(source, box=None):
    """Measure one rectangle of an image: `box` is (left, top, width, height).

    This is how a band is checked rather than eyeballed — the gradient at the
    bottom of a shader, the area a shadow should darken, the cell a sprite
    occupies. Without a box the whole frame is measured.
    """
    image = _open(source)
    if box is not None:
        left, top, width, height = [int(value) for value in box]
        right = min(image.size[0], left + width)
        bottom = min(image.size[1], top + height)
        if left >= right or top >= bottom:
            raise ValueError(
                "box %r lies outside the %dx%d image" % (list(box), image.size[0], image.size[1])
            )
        image = image.crop((left, top, right, bottom))
    rgb = image.convert("RGB")
    light = ImageStat.Stat(_luminance(image))
    stats = ImageStat.Stat(rgb)
    return {
        "width": image.size[0],
        "height": image.size[1],
        "channel_means": [round(value, 3) for value in stats.mean],
        "luminance_mean": round(light.mean[0], 3),
        "luminance_stddev": round(light.stddev[0], 3),
        "luminance_min": light.extrema[0][0],
        "luminance_max": light.extrema[0][1],
    }


def luminance_rows(source, bands=8):
    """Mean luminance of horizontal bands, top to bottom.

    A gradient, a vignette, or a ground shadow shows up here as a monotonic
    series of numbers; a flat frame shows up as identical ones. That is the
    measurement that distinguishes "the height profile is wrong" from "the
    normals are inverted", which look the same to the eye.
    """
    if bands < 1:
        raise ValueError("bands must be at least 1")
    image = _open(source)
    light = _luminance(image)
    height = image.size[1]
    step = max(1, height // bands)
    rows = []
    top = 0
    while top < height:
        bottom = min(height, top + step) if len(rows) < bands - 1 else height
        strip = light.crop((0, top, image.size[0], bottom))
        rows.append(round(ImageStat.Stat(strip).mean[0], 3))
        top = bottom
    return {"bands": len(rows), "band_height": step, "luminance": rows}


def dominant_colors(source, top=5):
    """The most common colours and their share of the frame.

    One call distinguishes a frame that rendered from a frame that drew nothing
    but its clear colour: a canvas that failed to draw is one colour at 100%.
    """
    image = _open(source).convert("RGB")
    colors = image.getcolors(maxcolors=image.size[0] * image.size[1] + 1) or []
    colors.sort(key=lambda item: item[0], reverse=True)
    total = max(1, image.size[0] * image.size[1])
    return [
        {"color": list(color), "hex": _hex(color), "pixels": count, "ratio": round(count / total, 5)}
        for count, color in colors[: max(1, top)]
    ]


def image_diff_mask(first, second, path=None, tolerance=0):
    """Write a black-and-white mask of the pixels that changed, and return its path.

    The mask is what makes a change locatable in the picture rather than only
    countable: white marks a changed pixel, black an unchanged one.
    """
    before = _open(first)
    after = _open(second)
    if before.size != after.size:
        raise ValueError(
            "cannot diff images of different sizes: %dx%d vs %dx%d"
            % (before.size + after.size)
        )
    difference = ImageChops.difference(before.convert("RGB"), after.convert("RGB"))
    mask = _channel_peak(difference).point(lambda value: 255 if value > tolerance else 0)
    target = path or os.path.join(os.getcwd(), "diff-mask.png")
    mask.save(target)
    return target


def preview_image(source, path=None, max_width=1200):
    """Save a scaled copy of an image and return its path, for `show()`.

    A full-size screenshot handed to the model costs tokens for detail it cannot
    use; this caps the width while keeping the frame recognisable.
    """
    image = _open(source)
    if image.size[0] > max_width:
        height = max(1, int(image.size[1] * (max_width / image.size[0])))
        image = image.resize((max_width, height), Image.LANCZOS)
    target = path or os.path.join(os.getcwd(), "preview.png")
    image.save(target)
    return target


HELPERS = {
    "analyze_image": analyze_image,
    "compare_images": compare_images,
    "region_stats": region_stats,
    "luminance_rows": luminance_rows,
    "dominant_colors": dominant_colors,
    "image_diff_mask": image_diff_mask,
    "preview_image": preview_image,
}
