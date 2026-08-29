"""Best-effort dependency check used by start.cmd / start.sh.

Reads a requirements.txt file and reports which pinned distributions are
missing from the CURRENT interpreter, mapping distribution names to their
importable module names where they differ (PyYAML -> yaml, python-dotenv ->
dotenv). Exits 0 when every distribution is importable, 1 when any is missing
(so callers run `pip install -r`), and 1 on any read error (so a broken check
degrades to a pip attempt rather than a hard failure).
"""
import importlib.util
import sys

# distribution name (lowercased) -> importable module name
ALIASES = {
    "pyyaml": "yaml",
    "python-dotenv": "dotenv",
    "python_dotenv": "dotenv",
}


def module_for(requirement: str) -> str:
    name = requirement.split(";", 1)[0].split("[", 1)[0].strip()
    for sep in ("~=", ">=", "<=", "==", "!=", ">", "<"):
        if sep in name:
            name = name.split(sep, 1)[0].strip()
    key = name.lower().replace("-", "_")
    return ALIASES.get(key, key)


def main(path: str) -> int:
    try:
        with open(path, encoding="utf-8") as f:
            lines = f.read().splitlines()
    except OSError:
        return 1
    missing = []
    for raw in lines:
        req = raw.strip()
        if not req or req.startswith("#") or req.startswith("-"):
            continue
        if importlib.util.find_spec(module_for(req)) is None:
            missing.append(req)
    for m in missing:
        print(f"[deps] missing: {m}", file=sys.stderr)
    return 1 if missing else 0


if __name__ == "__main__":
    sys.exit(main(sys.argv[1]) if len(sys.argv) > 1 else 1)
