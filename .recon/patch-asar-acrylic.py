"""Rewrite a packaged DSH Desktop asar so its Windows window is translucent.

The installed app creates the primary window opaque on Windows: `transparent` and
`backgroundColor` appear only in the `darwin` branch. Adding `transparent: true` there was
measured to have no effect while `titleBarStyle: 'hidden'` and `titleBarOverlay` are set -
the window stayed opaque through a full restart - so this uses the pattern the app itself
already relies on for Windows translucency, in its welcome window: `backgroundMaterial`.

The archive is rewritten with the *original* 16-byte header preserved verbatim; only the
directory's file offsets and sizes change, and the JSON is asserted to keep its exact
length so those header fields remain true.

Usage:
  python .recon/patch-asar-acrylic.py --check <asar>
  python .recon/patch-asar-acrylic.py --write <asar> <out>
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

# The primary window's Windows branch, still opaque.
OPAQUE = re.compile(r'(platform === "win32" && primary \? \{\s*titleBarStyle: "hidden",)(?P<body>.*?)(\} : \{\})', re.S)
# The window this rewrites may already carry a failed attempt at `transparent: true`.
ALREADY = re.compile(r'\s*transparent: true,\s*\n\s*backgroundColor: "#00000000",')
INSERT = '\n\t\t\tbackgroundMaterial: "acrylic",\n\t\t\tbackgroundColor: "#00000000",'
OVERLAY_FILL = re.compile(r'color: chromeFallbackFill\(\),')


def read_archive(path: Path) -> tuple[dict, int, bytes, bytes]:
    """Directory, data offset, whole file, and the original 16-byte header."""
    raw = path.read_bytes()
    pickle_size, header_size, third, json_size = struct.unpack_from("<4I", raw, 0)
    if pickle_size != 4:
        raise SystemExit(f"unexpected pickle size {pickle_size}")
    header = json.loads(raw[16:16 + json_size].decode("utf-8"))
    return header, 8 + header_size, raw, raw[:16]


def walk(node: dict, prefix: str = "") -> list[tuple[str, dict]]:
    """Every file entry, with its path inside the archive."""
    found: list[tuple[str, dict]] = []
    for name, entry in node.get("files", {}).items():
        path = f"{prefix}/{name}" if prefix else name
        if "files" in entry:
            found.extend(walk(entry, path))
        else:
            found.append((path, entry))
    return found


def main() -> None:
    """Report the change, and write the rewritten archive when asked."""
    args = sys.argv[1:]
    if not args:
        raise SystemExit(__doc__)
    source = Path(args[1])
    header, data_start, raw, prefix = read_archive(source)
    _, _, _, json_size = struct.unpack_from("<4I", raw, 0)
    entries = walk(header)

    target = None
    for path, entry in entries:
        if entry.get("unpacked") or not path.endswith(".js"):
            continue
        start = data_start + int(entry["offset"])
        body = raw[start:start + int(entry["size"])].decode("utf-8", "replace")
        if OPAQUE.search(body):
            target = (path, entry, body)
            break
    if target is None:
        raise SystemExit("no file matched the primary-window factory")
    path, entry, body = target
    match = OPAQUE.search(body)
    assert match is not None

    region = match.group("body")
    region = ALREADY.sub("", region)
    region = OVERLAY_FILL.sub('color: "#00000000",', region, count=1)
    patched = body[:match.end(1)] + INSERT + region + body[match.start(3):]

    print(f"source      : {source} ({len(raw)} bytes, {len(entries)} entries)")
    print(f"target      : {path} ({entry['size']} -> {len(patched)} bytes)")
    at = patched.find('win32" && primary ? {')
    print("patched     : " + patched[at:at + 210].replace("\n", " ").replace("\t", " "))
    if "--check" in args:
        print("(dry run)")
        return

    out_path = Path(args[2])
    # Rebuild the data section in the original order with fresh offsets.
    directory = json.loads(json.dumps(header))
    data = bytearray()
    for candidate_path, candidate in entries:
        if candidate.get("unpacked"):
            continue
        start = data_start + int(candidate["offset"])
        payload = raw[start:start + int(candidate["size"])]
        if candidate_path == path:
            payload = patched.encode("utf-8")
        node = directory
        *parents, leaf = candidate_path.split("/")
        for part in parents:
            node = node["files"][part]
        node["files"][leaf]["offset"] = str(len(data))
        node["files"][leaf]["size"] = len(payload)
        data.extend(payload)

    json_bytes = json.dumps(directory, separators=(",", ":")).encode("utf-8")
    if len(json_bytes) != json_size:
        raise SystemExit(f"header would lie: json {len(json_bytes)} != {json_size}")
    out_path.write_bytes(prefix + json_bytes + bytes(data))
    print(f"wrote       : {out_path} ({out_path.stat().st_size} bytes)")


if __name__ == "__main__":
    main()
