"""Install a rebuilt archive when the desktop app is not running.

Two rules learned the hard way. The archive is never opened for writing: the replacement is
a whole-file `os.replace` of a staged copy in the same directory, which either succeeds
atomically or changes nothing. And the result is validated with Electron's own asar reader
afterwards; if that fails, the backup goes straight back.

Usage:
  python .recon/install-archive.py <asar-to-replace> <candidate> <backup-dir> <staging-dir> [--wait] [--receipt <path>]
"""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
import time
from datetime import datetime
from pathlib import Path

VALIDATOR = Path(r'D:\deepseek-kernel-harness\.recon\validate-asar.mjs')
APP = 'DeepSeek Harness.exe'


def app_running() -> bool:
    """Whether any desktop app process is alive."""
    out = subprocess.run(['tasklist', '/FI', f'IMAGENAME eq {APP}', '/NH'],
                         capture_output=True, text=True).stdout
    return APP in out


def validate(archive: Path) -> bool:
    """Whether Electron's own reader accepts the archive."""
    result = subprocess.run(['node', str(VALIDATOR), str(archive)],
                            capture_output=True, text=True, timeout=120)
    return 'INVALID' not in result.stdout and 'files       :' in result.stdout


def install(asar: Path, candidate: Path, backup_dir: Path, staging_dir: Path,
            receipt: Path | None) -> int:
    """Stage, swap, validate, and roll back on failure."""
    stamp = datetime.now().strftime('%Y%m%d-%H%M%S')
    backup = backup_dir / f'{asar.name}.orig-{stamp}'
    staged = staging_dir / f'{asar.name}.staged-{stamp}'
    record: dict[str, object] = {'at': stamp, 'archive': str(asar)}

    if not validate(candidate):
        record['status'] = 'candidate failed validation; nothing installed'
        if receipt is not None:
            receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
        return 1

    shutil.copy2(asar, backup)
    record['backup'] = str(backup)
    shutil.copy2(candidate, staged)
    try:
        staged.replace(asar)          # atomic; the only write the live file ever sees
    except OSError as error:
        record['status'] = f'replace failed: {error}'
        staged.unlink(missing_ok=True)
        if receipt is not None:
            receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
        return 1

    if validate(asar):
        record['status'] = 'installed'
        record['bytes'] = asar.stat().st_size
        code = 0
    else:
        shutil.copy2(backup, staged)
        staged.replace(asar)
        record['status'] = 'installed archive failed validation; backup restored'
        record['restored'] = str(backup)
        code = 1
    if receipt is not None:
        receipt.write_text(json.dumps(record, indent=2), encoding='utf-8')
    return code


def main() -> int:
    """Wait for the app to exit, then install."""
    args = [arg for arg in sys.argv[1:] if not arg.startswith('--')]
    asar, candidate, backup_dir, staging_dir = (Path(arg) for arg in args[:4])
    receipt = None
    if '--receipt' in sys.argv:
        receipt = Path(sys.argv[sys.argv.index('--receipt') + 1])
    if '--wait' in sys.argv:
        deadline = time.time() + 8 * 60 * 60
        while app_running() and time.time() < deadline:
            time.sleep(3)
        if app_running():
            if receipt is not None:
                receipt.write_text(json.dumps({'status': 'timed out waiting for the app to exit'}), encoding='utf-8')
            return 1
        time.sleep(2)
    return install(asar, candidate, backup_dir, staging_dir, receipt)


if __name__ == '__main__':
    sys.exit(main())
