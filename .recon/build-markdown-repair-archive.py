"""Build a Desktop archive whose web shell repairs damaged markdown tables before rendering.

The Desktop's web shell bundles `dsh-client-ui-primitives` into
`dsh-web-frontend/dist/assets/index-*.js`, so the fork's `table-repair.ts` cannot load as a
package there. This rewrites that one bundle entry: the compiled repair module is defined
ahead of the minified `MarkdownText` component, and the component repairs its `text` prop once
before either rendering arm reads it. Every other entry stays byte-identical; offsets, the
header pickle sizes, and the rewritten entry's integrity record are recomputed.

Usage:
  python .recon/build-markdown-repair-archive.py <source.asar> <out.asar> <repair.iife.js>
"""

from __future__ import annotations

import hashlib
import json
import struct
import sys
from pathlib import Path

BUNDLE_DIR = 'dsh/node_modules/@deepseek-ai/dsh-web-frontend/dist/assets/'
# The minified MarkdownText signature in the 0.2.0-rc.2 shell bundle.
SIGNATURE = 'j.memo(function({text:n,streaming:o=!1,labels:s,fileMentions:a,pathImages:u,variant:f="body"}){const h='
PATCHED = 'j.memo(function({text:__dshRawText,streaming:o=!1,labels:s,fileMentions:a,pathImages:u,variant:f="body"})' \
          '{const n=__dshTableRepair.repairMarkdownTables(__dshRawText),h='
MARKER = '/* dsh fork: markdown table repair */'
BLOCK = 4 * 1024 * 1024


def walk(node: dict, prefix: str = '') -> list[tuple[str, dict]]:
    """Every file entry of the header, depth first, in header order."""
    found: list[tuple[str, dict]] = []
    for name, entry in node.get('files', {}).items():
        path = f'{prefix}/{name}' if prefix else name
        if 'files' in entry:
            found.extend(walk(entry, path))
        elif 'link' not in entry:
            found.append((path, entry))
    return found


def integrity(payload: bytes) -> dict:
    """Electron's per-entry integrity record: whole-file and 4 MiB block SHA-256."""
    blocks = [hashlib.sha256(payload[i:i + BLOCK]).hexdigest() for i in range(0, max(len(payload), 1), BLOCK)]
    return {'algorithm': 'SHA256', 'hash': hashlib.sha256(payload).hexdigest(), 'blockSize': BLOCK, 'blocks': blocks}


def patch_bundle(body: str, repair: str) -> str:
    """Define the repair module before MarkdownText and route its text prop through it."""
    if MARKER in body:
        raise SystemExit('bundle already carries the table repair')
    if body.count(SIGNATURE) != 1:
        raise SystemExit(f'MarkdownText signature found {body.count(SIGNATURE)} times; expected exactly 1')
    at = body.index(SIGNATURE)
    statement = body.rindex('const ', 0, at)
    definition = f'{MARKER}{repair.strip().rstrip(";")};'
    patched = body[:statement] + definition + body[statement:]
    return patched.replace(SIGNATURE, PATCHED, 1)


def main() -> None:
    """Rewrite the shell bundle entry and repack the archive around it."""
    source, destination, repair_path = Path(sys.argv[1]), Path(sys.argv[2]), Path(sys.argv[3])
    raw = source.read_bytes()
    _, header_size, _, json_size = struct.unpack_from('<4I', raw, 0)
    directory = json.loads(raw[16:16 + json_size].decode('utf-8'))
    data_start = 8 + header_size
    entries = walk(directory)

    targets = [(p, e) for p, e in entries if p.startswith(BUNDLE_DIR) and p.endswith('.js') and not e.get('unpacked')
               and SIGNATURE.encode() in raw[data_start + int(e['offset']):data_start + int(e['offset']) + int(e['size'])]]
    if len(targets) != 1:
        raise SystemExit(f'expected one shell bundle carrying MarkdownText, found {[p for p, _ in targets]}')
    target_path = targets[0][0]

    data = bytearray()
    new_directory = json.loads(json.dumps(directory))
    for path, entry in entries:
        if entry.get('unpacked'):
            continue
        start = data_start + int(entry['offset'])
        payload = raw[start:start + int(entry['size'])]
        node = new_directory
        *parents, leaf = path.split('/')
        for part in parents:
            node = node['files'][part]
        record = node['files'][leaf]
        if path == target_path:
            payload = patch_bundle(payload.decode('utf-8'), repair_path.read_text(encoding='utf-8')).encode('utf-8')
            if 'integrity' in record:
                record['integrity'] = integrity(payload)
            print(f'patched: {path} ({entry["size"]} -> {len(payload)} bytes)')
        record['offset'] = str(len(data))
        record['size'] = len(payload)
        data.extend(payload)

    json_bytes = json.dumps(new_directory, separators=(',', ':')).encode('utf-8')
    padded = len(json_bytes) + (-len(json_bytes) % 4)
    payload_size = 4 + padded
    new_header_size = 4 + payload_size
    out = bytearray(struct.pack('<4I', 4, new_header_size, payload_size, len(json_bytes)))
    out.extend(json_bytes)
    out.extend(b'\0' * (padded - len(json_bytes)))
    out.extend(data)
    destination.write_bytes(bytes(out))
    print(f'wrote  : {destination} ({len(out)} bytes, header {header_size} -> {new_header_size})')


if __name__ == '__main__':
    main()
