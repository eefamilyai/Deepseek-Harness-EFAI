"""Contract tests for the kernel's fast search backend.

`grep`, `find`, `glob`, and `search_files` are the helpers a cell reaches for
before it writes its own loop, and the thing that made them worth rewriting is
speed: a naive `os.walk` plus per-line Python scan took 229 seconds on this
repository where ripgrep takes half a second. These tests pin the two halves of
that contract -- the answers must not change, and the fast path must actually be
taken when a fast tool is present.

Run it directly:  python test_fast_search.py
"""

import importlib.util
import os
import re
import shutil
import subprocess
import sys
import tempfile
import time

_HERE = os.path.dirname(os.path.abspath(__file__))
_CHILD = os.path.join(_HERE, "kernel_child.py")

# `kernel_child.py` runs its own protocol loop at import time, so the functions
# under test are loaded by exec'ing the module source with the loop suppressed --
# the same text, without the side effect of standing up a second kernel.
_SRC = open(_CHILD, encoding="utf-8").read()


_LOADED = None


def _load():
    """The runtime namespace, imported exactly ONCE for the whole suite.

    `kernel_child.py` is a program as well as a library: its fd-1 quarantine,
    its stdout capture streams, and its `while True:` protocol loop would each
    hijack or hang a process that merely wanted its helpers. They are therefore
    behind a `if __name__ == "__main__":` guard, which makes a plain import the
    correct and complete way to reach `grep`/`find`/`glob`/`search_files`.

    The result is cached in `_LOADED`, so the module is imported once no matter
    how many tests run -- the import is not repeated per test.
    """
    global _LOADED
    if _LOADED is None:
        import importlib.util

        spec = importlib.util.spec_from_file_location("kernel_child_under_test", _CHILD)
        mod = importlib.util.module_from_spec(spec)
        sys.modules["kernel_child_under_test"] = mod
        spec.loader.exec_module(mod)
        _LOADED = vars(mod)
    return _LOADED


def _grep_paths(out):
    """The file paths in `grep`/`find` output (`file:line: text`).

    Split with a non-greedy path group rather than `line.split(":")[0]`: a
    Windows path carries a drive-letter colon, so the naive split returns "C"
    for every hit and silently collapses distinct files into one.
    """
    paths = []
    for line in out.splitlines():
        if not line.strip():
            continue
        m = re.match(r"^(.*?):(\d+):(.*)$", line)
        paths.append(m.group(1) if m else line)
    return paths


def _tree():
    """A small fixture tree with a git repo, an ignored file, and a hidden dir."""
    d = tempfile.mkdtemp(prefix="dsh-fastsearch-")
    os.makedirs(os.path.join(d, "src", "nested"))
    os.makedirs(os.path.join(d, ".hidden"))
    os.makedirs(os.path.join(d, "node_modules", "pkg"))
    open(os.path.join(d, "src", "alpha.py"), "w").write(
        "import os\nNEEDLE = 'alpha-needle'\n")
    open(os.path.join(d, "src", "nested", "beta.ts"), "w").write(
        "// beta\nexport const x = 'alpha-needle'\n")
    open(os.path.join(d, "src", "gamma.txt"), "w").write("nothing here\n")
    open(os.path.join(d, ".hidden", "secret.py"), "w").write("alpha-needle\n")
    open(os.path.join(d, "node_modules", "pkg", "dep.js"), "w").write("alpha-needle\n")
    return d


def _init_git(d):
    for argv in (["init", "-q"], ["add", "-A"], ["-c", "user.email=t@t", "-c", "user.name=t",
                                          "commit", "-q", "-m", "x"]):
        subprocess.run(["git"] + argv, cwd=d, capture_output=True)


def test_grep_finds_a_match_with_file_and_line():
    ns = _load()
    d = _tree()
    out = ns["grep"]("alpha-needle", d)
    assert "alpha.py" in out, out
    assert ":2:" in out, out


def test_grep_honours_include():
    ns = _load()
    d = _tree()
    out = ns["grep"]("alpha-needle", d, include="*.ts")
    assert "beta.ts" in out, out
    assert "alpha.py" not in out, out


def test_grep_respects_max_matches():
    ns = _load()
    d = _tree()
    out = ns["grep"]("alpha-needle", d, max_matches=1)
    assert len(out.splitlines()) == 1, out


def test_grep_reports_a_bad_regex_instead_of_raising():
    ns = _load()
    d = _tree()
    out = ns["grep"]("([unclosed", d)
    assert out.startswith("grep error:"), out


def test_grep_reports_a_missing_path():
    ns = _load()
    out = ns["grep"]("x", os.path.join(tempfile.gettempdir(), "dsh-no-such-dir-zzz"))
    assert "no such path" in out, out


def test_grep_says_so_when_nothing_matches():
    ns = _load()
    d = _tree()
    assert "no matches" in ns["grep"]("zzz-absent-zzz", d)


def test_grep_hidden_is_opt_in():
    ns = _load()
    d = _tree()
    assert "secret.py" not in ns["grep"]("alpha-needle", d)
    assert "secret.py" in ns["grep"]("alpha-needle", d, hidden=True)


def test_find_reports_one_hit_per_file():
    ns = _load()
    d = _tree()
    out = ns["find"]("alpha-needle", d)
    files = _grep_paths(out)
    assert files, out
    assert len(files) == len(set(files)), out


def test_glob_matches_by_pattern():
    ns = _load()
    d = _tree()
    out = ns["glob"]("**/*.py", d)
    assert "alpha.py" in out, out


def test_search_files_distinguishes_name_hits_from_content_hits():
    ns = _load()
    d = _tree()
    hits = ns["search_files"]("alpha", d)
    kinds = {h["hit"] for h in hits}
    assert "name" in kinds, hits
    assert "content" in kinds, hits


def test_search_files_returns_untouched_paths_for_colon_bearing_lines():
    """A content hit's path must not be truncated by the text after it."""
    ns = _load()
    d = _tree()
    open(os.path.join(d, "src", "colon.txt"), "w").write(
        "a: b: c: alpha-needle\n")
    hits = ns["search_files"]("alpha-needle", d)
    paths = [h["path"] for h in hits]
    assert any(p.endswith("colon.txt") for p in paths), paths


def test_the_fast_backend_is_used_when_present():
    """With ripgrep or git on PATH the helper must not fall back to Python."""
    ns = _load()
    tool, exe = ns["_search_probe"]()
    if tool is None:
        print("   (no ripgrep or git on PATH; fallback is the only option)")
        return
    d = _tree()
    calls = []
    real = ns["_run_argv"]

    def spy(argv, **kw):
        calls.append(argv[0])
        return real(argv, **kw)

    ns["_run_argv"] = spy
    ns["grep"]("alpha-needle", d)
    assert calls, "the fast path ran no external tool"
    ns["_run_argv"] = real


def test_grep_matches_ripgrep_on_the_same_tree():
    """When ripgrep is present the two must agree file-for-file."""
    rg = shutil.which("rg")
    if rg is None:
        print("   (ripgrep absent; parity check skipped)")
        return
    ns = _load()
    d = _tree()
    mine = {os.path.normcase(os.path.abspath(q))
            for q in _grep_paths(ns["grep"]("alpha-needle", d))}
    # The prune list (`!node_modules/`, `!.git/`, ...) is part of the contract,
    # so the reference has to search the same tree: build its flags from the
    # same helper rather than from a bare `rg -l`, which would descend into
    # node_modules and disagree for a reason that is not a bug.
    argv = ns["_rg_common"](rg) + ["-l", "-F", "-e", "alpha-needle", "--", "."]
    r = subprocess.run(argv, cwd=d, capture_output=True, text=True)
    theirs = set()
    for line in r.stdout.splitlines():
        line = line.strip()
        if not line:
            continue
        # ripgrep echoes the search root as given: "./x" here, ".\\x" on Windows.
        if line[:2] in ("./", ".\\"):
            line = line[2:]
        theirs.add(os.path.normcase(os.path.abspath(os.path.join(d, line))))
    assert mine == theirs, (mine, theirs)


def test_grep_prunes_build_and_dependency_directories():
    """`node_modules/` and friends are never searched, whatever the backend.

    A cell that greps a repo almost never wants a hit inside a dependency tree,
    and on a real checkout those trees are where the files -- and the seconds --
    are. The prune list is applied by every backend, so it belongs in the
    contract rather than in whichever argv happens to run.
    """
    ns = _load()
    d = _tree()
    out = ns["grep"]("alpha-needle", d)
    assert "dep.js" not in out, out
    assert "alpha.py" in out, out


def test_grep_is_fast_on_a_wide_tree():
    """The rewrite exists for speed; pin a generous ceiling so it stays fast."""
    ns = _load()
    if ns["_search_probe"]()[0] is None:
        print("   (no fast backend; timing check skipped)")
        return
    d = tempfile.mkdtemp(prefix="dsh-fastsearch-wide-")
    for i in range(150):
        sub = os.path.join(d, "d%03d" % i)
        os.makedirs(sub)
        for j in range(20):
            with open(os.path.join(sub, "f%02d.py" % j), "w") as fh:
                fh.write("padding\n" * 40 + "RARE_TOKEN_MARKER\n")
    t0 = time.time()
    out = ns["grep"]("RARE_TOKEN_MARKER", d, max_matches=5)
    dt = time.time() - t0
    assert out.strip(), out
    assert dt < 20.0, "grep took %.1fs on 3000 small files" % dt


def test_the_runtime_is_loaded_once_for_the_whole_suite():
    """Every test shares one parsed-and-executed runtime.

    The module is a program: it hijacks fd 1, swaps sys.stdout, and blocks on
    stdin. Re-executing it per test would cost seconds each time and, before the
    loader dropped the epilogue, hang the suite outright. `_load()` must be
    idempotent and must hand back the same namespace object.
    """
    first = _load()
    second = _load()
    assert first is second
    assert first.get("_STARTUP_CWD"), "module-level constants must survive the load"


if __name__ == "__main__":
    passed = failed = 0
    for _name, _fn in sorted(globals().items()):
        if _name.startswith("test_") and callable(_fn):
            try:
                _fn()
            except AssertionError as e:
                failed += 1
                print("FAIL %s\n     %s" % (_name, e))
            except Exception as e:
                failed += 1
                print("ERROR %s: %s: %s" % (_name, type(e).__name__, e))
            else:
                passed += 1
                print("ok   %s" % _name)
    print("\n%d passed, %d failed" % (passed, failed))
    sys.exit(1 if failed else 0)
