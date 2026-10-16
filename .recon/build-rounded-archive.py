"""Build a rounded-window variant of the packaged DSH Desktop archive.

Windows rounds an ordinary window and leaves a transparent one square. The archive's
primary window asks for `transparent: true` on Windows, so it is square. This rebuilds the
archive with that replaced by the material pairing the app already uses on this platform for
its welcome window, keeping the original 16-byte header verbatim and every other file
byte-identical.

Usage:
  python .recon/build-rounded-archive.py <pristine.asar> <out.asar>
"""

from __future__ import annotations

import json
import re
import struct
import sys
from pathlib import Path

WINDOW = re.compile(r'(platform === "win32" && primary \? \{\s*titleBarStyle: "hidden",)')
INSERT = '\n\t\t\tbackgroundMaterial: "acrylic",\n\t\t\tbackgroundColor: "#00000000",'


def main() -> None:
    """Rewrite the archive with the primary window material, keeping every offset honest."""
    source, destination = Path(sys.argv[1]), Path(sys.argv[2])
    raw = source.read_bytes()
    pickle_size, header_size, _, json_size = struct.unpack_from("<4I", raw, 0)
    if pickle_size != 4:
        raise SystemExit(f"unexpected pickle size {pickle_size}")
    directory = json.loads(raw[16:16 + json_size].decode("utf-8"))
    data_start = 8 + header_size

    def walk(node: dict, prefix: str = "") -> list[tuple[str, dict]]:
        found: list[tuple[str, dict]] = []
        for name, entry in node.get("files", {}).items():
            path = f"{prefix}/{name}" if prefix else name
            if "files" in entry:
                found.extend(walk(entry, path))
            else:
                found.append((path, entry))
        return found

    entries = walk(directory)
    target = None
    for path, entry in entries:
        if entry.get("unpacked") or not path.endswith(".js"):
            continue
        start = data_start + int(entry["offset"])
        body = raw[start:start + int(entry["size"])].decode("utf-8", "replace")
        if WINDOW.search(body):
            target = (path, entry, body)
            break
    if target is None:
        raise SystemExit("no file carries the primary-window factory")
    path, entry, body = target
    match = WINDOW.search(body)
    assert match is not None
    region_start = match.end()
    region_end = body.index('} : {}', region_start)
    region = body[region_start:region_end]
    # A variant that already asks to be transparent drops that request; the pristine
    # original never made it.
    region = re.sub(r'\s*transparent: true,', '', region, count=1)
    patched = body[:region_start] + INSERT + region + body[region_end:]
    print(f"target : {path} ({entry['size']} -> {len(patched)} bytes)")
    at = patched.find('win32" && primary ? {')
    print("window : " + patched[at:at + 200].replace("\n", " ").replace("\t", " "))

    out = bytearray()
    data = bytearray()
    new_directory = json.loads(json.dumps(directory))
    for candidate_path, candidate in entries:
        if candidate.get("unpacked"):
            continue
        start = data_start + int(candidate["offset"])
        payload = raw[start:start + int(candidate["size"])]
        if candidate_path == path:
            payload = patched.encode("utf-8")
        node = new_directory
        *parents, leaf = candidate_path.split("/")
        for part in parents:
            node = node["files"][part]
        node["files"][leaf]["offset"] = str(len(data))
        node["files"][leaf]["size"] = len(payload)
        data.extend(payload)

    json_bytes = json.dumps(new_directory, separators=(",", ":")).encode("utf-8")
    if len(json_bytes) != json_size:
        raise SystemExit(f"header would lie: json {len(json_bytes)} != {json_size}")
    out.extend(raw[:16])            # the original header, verbatim
    out.extend(json_bytes)
    out.extend(data)
    destination.write_bytes(bytes(out))
    print(f"wrote  : {destination} ({len(out)} bytes)")


if __name__ == "__main__":
    main()
