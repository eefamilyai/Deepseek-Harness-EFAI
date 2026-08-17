# config.py — central settings and logging for Kiln-Kernel.
#
# Settings are read from environment variables (KILN_*) with code defaults, so
# the server can be configured without touching code. `dbg()` is kept for
# backwards compatibility with ds_direct.py and prints to stderr when DEBUG is
# on; all new code should use logging.getLogger("kiln.<module>").
import logging
import os
import re
import sys
import tempfile

# ---------------------------------------------------------------------------
# Settings (env-overridable)
# ---------------------------------------------------------------------------

DEBUG = os.environ.get("KILN_DEBUG", "1") not in ("0", "false", "False", "")

DEFAULT_PORT = 50122
DEFAULT_HOST = "127.0.0.1"


# Names of variables loaded from the .env file. These are secret-bearing by
# definition (provider API keys, tokens), and kernel subprocesses must NOT
# inherit them: provider calls happen in the server process, so the model's
# Python has no legitimate need for any of them.
ENV_FILE_VARS = set()


def load_env_file(path=None, override=True):
    """Load a .env file into os.environ.

    Uses python-dotenv when installed; otherwise a tiny stdlib parser that
    handles `KEY=VALUE` lines, `#` comments, and quoted values. Returns the
    path that was loaded, or None if the file doesn't exist.

    Every variable name loaded here is recorded in ENV_FILE_VARS so callers
    (kernel.py) can scrub them from child processes.
    """
    if path is None:
        path = os.path.join(os.path.dirname(os.path.abspath(__file__)), ".env")
    if not os.path.isfile(path):
        return None
    loaded = set()
    try:
        from dotenv import load_dotenv
        load_dotenv(path, override=override)
        # dotenv doesn't tell us which names it set; parse the file ourselves
        # for the names (cheap, and avoids guessing at dotenv internals).
        with open(path, "r", encoding="utf-8-sig") as f:
            for line in f:
                line = line.strip()
                if not line or line.startswith("#") or "=" not in line:
                    continue
                k = line.partition("=")[0].strip()
                if k:
                    loaded.add(k)
        ENV_FILE_VARS.update(loaded)
        return path
    except ImportError:
        pass
    with open(path, "r", encoding="utf-8-sig") as f:
        for line in f:
            line = line.strip()
            if not line or line.startswith("#") or "=" not in line:
                continue
            k, _, v = line.partition("=")
            k = k.strip()
            v = v.strip().strip('"').strip("'")
            if k and (override or k not in os.environ):
                os.environ[k] = v
            if k:
                loaded.add(k)
    ENV_FILE_VARS.update(loaded)
    return path


_VALID_ENV_NAME = re.compile(r"^[A-Za-z_][A-Za-z0-9_]*$")


def env_file_path():
    # KILN_ENV_FILE lets tests (and unusual deployments) redirect the secret
    # store away from the repo's own .env
    return os.environ.get("KILN_ENV_FILE") or os.path.join(
        os.path.dirname(os.path.abspath(__file__)), ".env")


def _quote_env_value(value):
    # keep simple keys bare; quote only when a bare value would be misparsed
    if value == "" or re.search(r'[\s#"\'\\]', value):
        return '"' + value.replace("\\", "\\\\").replace('"', '\\"') + '"'
    return value


def set_env_var(name, value, path=None):
    """Persist a secret into the .env file and apply it live to this process.

    The value is written ONLY to .env (which is gitignored) and os.environ —
    never to app_settings.json, a log line, or any API response. Used by the
    Settings › Providers key form so the user can paste a key without editing
    files. Updates an existing assignment in place; appends otherwise. Records
    the name in ENV_FILE_VARS so kernel subprocesses still get it scrubbed.
    """
    name = (name or "").strip()
    if not _VALID_ENV_NAME.match(name):
        raise ValueError("invalid environment variable name")
    value = "" if value is None else str(value)
    if "\n" in value or "\r" in value:
        raise ValueError("value must be a single line")
    if path is None:
        path = env_file_path()
    lines = []
    if os.path.isfile(path):
        with open(path, "r", encoding="utf-8-sig") as f:
            lines = f.read().splitlines()
    assignment = "%s=%s" % (name, _quote_env_value(value))
    out = []
    found = False
    for line in lines:
        s = line.strip()
        if s and not s.startswith("#") and "=" in s and s.partition("=")[0].strip() == name:
            out.append(assignment)
            found = True
        else:
            out.append(line)
    if not found:
        out.append(assignment)
    folder = os.path.dirname(os.path.abspath(path)) or "."
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".env-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            f.write("\n".join(out) + "\n")
        # best-effort owner-only perms before the value lands at the real path
        try:
            os.chmod(tmp, 0o600)
        except OSError:
            pass
        os.replace(tmp, path)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise
    os.environ[name] = value
    ENV_FILE_VARS.add(name)
    return True


def _env_int(name, default):
    try:
        return int(os.environ.get(name, "") or default)
    except (TypeError, ValueError):
        return default


PORT = _env_int("KILN_PORT", DEFAULT_PORT)
HOST = os.environ.get("KILN_HOST", DEFAULT_HOST)
LAN_KEY = os.environ.get("KILN_LAN_KEY", "")

# ---------------------------------------------------------------------------
# Logging
# ---------------------------------------------------------------------------

_LOG_FORMAT = "[%(levelname)s] %(name)s: %(message)s"
_logging_configured = False


def setup_logging(level=None, log_file=None, verbose=False):
    """Configure the root logger once. Safe to call from any entry point.

    level   - int or string logging level (default: DEBUG if KILN_DEBUG,
              else INFO). Pass verbose=True to force DEBUG.
    log_file- optional path; a FileHandler is added when given.
    """
    global _logging_configured
    if _logging_configured:
        return
    _logging_configured = True
    if level is None:
        level = logging.DEBUG if (DEBUG or verbose) else logging.INFO
    root = logging.getLogger()
    root.setLevel(level)
    handler = logging.StreamHandler()
    handler.setFormatter(logging.Formatter(_LOG_FORMAT))
    root.addHandler(handler)
    if log_file:
        try:
            fh = logging.FileHandler(log_file, encoding="utf-8")
            fh.setFormatter(logging.Formatter(_LOG_FORMAT))
            root.addHandler(fh)
        except OSError as e:
            logging.getLogger("kiln.config").warning(
                "could not open log file %r: %s", log_file, e)


def get_logger(name):
    """Convenience: a logger under the 'kiln' namespace, e.g. 'kiln.server'."""
    return logging.getLogger("kiln." + name)


# ---------------------------------------------------------------------------
# Legacy debug helper (ds_direct.py depends on this API)
# ---------------------------------------------------------------------------

def dbg(fmt, *args, **kwargs):
    if not DEBUG:
        return
    try:
        msg = fmt % args if args else fmt
    except Exception:
        msg = fmt + (" " + " ".join(str(a) for a in args) if args else "")
    print("[ds_direct]", msg, file=sys.stderr, **kwargs)
