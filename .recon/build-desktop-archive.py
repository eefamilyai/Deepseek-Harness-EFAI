"""Build the fork's Desktop archive from a pristine app.asar: every fork patch to files the
Desktop compiles into its archive, applied in one pass.

Patches:
  table-repair   web shell bundle: repair damaged markdown tables before rendering
                 (see build-markdown-repair-archive.py for the transform).
  transparent    lib/main.js: the Windows main window is created transparent, so where the
                 page paints nothing (the Personalization "Desktop" backdrop with the shell
                 below 100%) the applications behind the window show through. Windows draws a
                 transparent window square and without its native shadow.

Each patch is skipped when already present, so the source may be a pristine or an already
patched archive; otherwise it refuses unless its anchor occurs exactly once, so an app update
that moves code fails the build instead of shipping a half-patched archive.

Usage:
  python .recon/build-desktop-archive.py <pristine.asar> <out.asar> <table-repair.iife.js> [--only a,b]
"""

from __future__ import annotations

import importlib.util
import json
import struct
import sys
from pathlib import Path

RECON = Path(__file__).resolve().parent

WINDOW_ANCHOR = (
    '...process.platform === "win32" && primary ? {\n'
    '\t\t\ttitleBarStyle: "hidden",\n'
    '\t\t\ttitleBarOverlay: {\n'
    '\t\t\t\theight: 40,\n'
    '\t\t\t\tcolor: chromeFallbackFill(),'
)
WINDOW_PATCHED = (
    '...process.platform === "win32" && primary ? {\n'
    '\t\t\t/* dsh fork: literal transparency */ transparent: true,\n'
    '\t\t\tbackgroundColor: "#00000000",\n'
    '\t\t\ttitleBarStyle: "hidden",\n'
    '\t\t\ttitleBarOverlay: {\n'
    '\t\t\t\theight: 40,\n'
    '\t\t\t\tcolor: "#00000000",'
)


def load_table_repair():
    """The table-repair transform from its own script."""
    spec = importlib.util.spec_from_file_location('table_repair', RECON / 'build-markdown-repair-archive.py')
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def patch_window(body: str) -> str:
    """Make the Windows primary window transparent."""
    if 'dsh fork: literal transparency' in body:
        return body
    if body.count(WINDOW_ANCHOR) != 1:
        raise SystemExit(f'primary-window anchor found {body.count(WINDOW_ANCHOR)} times; expected exactly 1')
    return body.replace(WINDOW_ANCHOR, WINDOW_PATCHED, 1)


def main() -> None:
    """Apply every selected patch and repack."""
    args = [a for a in sys.argv[1:] if not a.startswith('--')]
    source, destination, repair_path = Path(args[0]), Path(args[1]), Path(args[2])
    only = None
    if '--only' in sys.argv:
        only = set(sys.argv[sys.argv.index('--only') + 1].split(','))
    table = load_table_repair()
    repair = repair_path.read_text(encoding='utf-8')

    raw = source.read_bytes()
    _, header_size, _, json_size = struct.unpack_from('<4I', raw, 0)
    directory = json.loads(raw[16:16 + json_size].decode('utf-8'))
    data_start = 8 + header_size
    entries = table.walk(directory)

    def body_of(entry: dict) -> bytes:
        start = data_start + int(entry['offset'])
        return raw[start:start + int(entry['size'])]

    transforms: dict[str, callable] = {}
    if only is None or 'table-repair' in only:
        shell = [p for p, e in entries if p.startswith(table.BUNDLE_DIR) and p.endswith('.js') and not e.get('unpacked')
                 and (table.SIGNATURE.encode() in body_of(e) or table.MARKER.encode() in body_of(e))]
        if len(shell) != 1:
            raise SystemExit(f'expected one shell bundle carrying MarkdownText, found {shell}')
        transforms[shell[0]] = lambda text: text if table.MARKER in text else table.patch_bundle(text, repair)
    if only is None or 'transparent' in only:
        transforms['lib/main.js'] = patch_window

    data = bytearray()
    new_directory = json.loads(json.dumps(directory))
    for path, entry in entries:
        if entry.get('unpacked'):
            continue
        payload = body_of(entry)
        node = new_directory
        *parents, leaf = path.split('/')
        for part in parents:
            node = node['files'][part]
        record = node['files'][leaf]
        if path in transforms:
            payload = transforms.pop(path)(payload.decode('utf-8')).encode('utf-8')
            if 'integrity' in record:
                record['integrity'] = table.integrity(payload)
            print(f'patched: {path} ({entry["size"]} -> {len(payload)} bytes)')
        record['offset'] = str(len(data))
        record['size'] = len(payload)
        data.extend(payload)
    if transforms:
        raise SystemExit(f'patch targets not found: {list(transforms)}')

    json_bytes = json.dumps(new_directory, separators=(',', ':')).encode('utf-8')
    padded = len(json_bytes) + (-len(json_bytes) % 4)
    out = bytearray(struct.pack('<4I', 4, 8 + padded, 4 + padded, len(json_bytes)))
    out.extend(json_bytes)
    out.extend(b'\0' * (padded - len(json_bytes)))
    out.extend(data)
    destination.write_bytes(bytes(out))
    print(f'wrote  : {destination} ({len(out)} bytes)')


if __name__ == '__main__':
    main()
