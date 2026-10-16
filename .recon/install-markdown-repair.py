"""Install the markdown table repair into the Desktop app once the app has closed.

The candidate is rebuilt from whatever archive is installed when the app exits, so an app
update in the meantime is patched rather than downgraded. Installation reuses
install-archive.py: back up, swap atomically, validate with Electron's reader, and restore
the backup if validation fails. A receipt records the outcome.

Usage (pythonw, detached):
  pythonw .recon/install-markdown-repair.py
"""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
import time
from pathlib import Path

RECON = Path(r'D:\deepseek-kernel-harness\.recon')
ASAR = Path(r'D:\Deepseek-Desktop\resources\app.asar')
REPAIR = RECON / 'build-scratch' / 'table-repair.iife.js'
CANDIDATE = RECON / 'build-scratch' / 'app.asar.markdown-repair'
RECEIPT = RECON / 'markdown-repair-install.json'


def load(name: str):
    """Import a sibling recon script by file name."""
    spec = importlib.util.spec_from_file_location(name.replace('-', '_'), RECON / name)
    module = importlib.util.module_from_spec(spec)
    assert spec.loader is not None
    spec.loader.exec_module(module)
    return module


def main() -> int:
    """Wait for the app to exit, rebuild from the installed archive, install."""
    installer = load('install-archive.py')
    deadline = time.time() + 24 * 60 * 60
    RECEIPT.write_text(json.dumps({'status': 'waiting for the Desktop app to exit'}), encoding='utf-8')
    while installer.app_running() and time.time() < deadline:
        time.sleep(3)
    if installer.app_running():
        RECEIPT.write_text(json.dumps({'status': 'timed out waiting for the app to exit'}), encoding='utf-8')
        return 1
    time.sleep(2)
    build = subprocess.run([sys.executable, str(RECON / 'build-markdown-repair-archive.py'), str(ASAR), str(CANDIDATE), str(REPAIR)],
                           capture_output=True, text=True)
    if build.returncode != 0:
        RECEIPT.write_text(json.dumps({'status': 'rebuild refused; nothing installed', 'detail': (build.stdout + build.stderr)[-2000:]}),
                           encoding='utf-8')
        return 1
    return installer.install(ASAR, CANDIDATE, RECON / 'install-backups', RECON / 'install-staging', RECEIPT)


if __name__ == '__main__':
    sys.exit(main())
