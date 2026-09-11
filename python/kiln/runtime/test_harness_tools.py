#!/usr/bin/env python
"""Offline tests for the generated harness-tool functions in kernel_child.py.

Run:  python test_harness_tools.py

`_make_tool_function` turns a harness tool's JSON schema into a real Python
function by `exec`, so the resulting signature — parameter names, order,
defaults — is the tool's own schema. That is the one part of the `tools`
surface the seam tests cannot pin: `tests/seam-tools-call.e2e.spec.ts` drives
dispatch through a live kernel, not the generated signatures.

The generator block is extracted from kernel_child.py by text marker rather
than copied, so this test cannot drift from the shipped code. It is exec'd
against a stubbed `call_tool`: nothing here starts a kernel, opens a seam, or
needs a DeepSeek account.
"""
import inspect
import json
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "kernel_child.py")

RESULTS = []


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not ok and detail:
        print("      %s" % detail)


def load_generator():
    """Exec the generator block from the real source, with `call_tool` stubbed."""
    with open(SOURCE, "r", encoding="utf-8") as f:
        src = f.read()
    marker = "# Every harness tool as a real Python function"
    if marker not in src:
        raise SystemExit("generator banner not found in %s" % SOURCE)
    start = src.index(marker)
    start = src.rindex("# \u2500", 0, start)          # the banner line above it
    end = src.index("def _install_harness_tools", start)

    calls = []

    def call_tool(name, arguments=None, timeout=600.0, raw=False):
        calls.append((name, arguments, timeout, raw))
        return {"called": name, "args": arguments}

    ns = {"re": re, "json": json, "call_tool": call_tool, "__name__": "under_test"}
    exec(compile(src[start:end], "<generator block>", "exec"), ns)
    ns["_calls"] = calls
    return ns


NS = load_generator()
_make = NS["_make_tool_function"]
_UNSET = NS["_UNSET"]


def params_of(func):
    return list(inspect.signature(func).parameters.values())


# ── a required property is positional and has no default ────────────────
read = _make("read", {
    "name": "read",
    "description": "Read a file.",
    "parameters": {
        "type": "object",
        "properties": {"path": {"type": "string"}},
        "required": ["path"],
    },
})
sig = inspect.signature(read)
ps = params_of(read)
check("a required property is a real parameter", "path" in sig.parameters,
      repr(sig))
check("a required property has no default",
      sig.parameters["path"].default is inspect.Parameter.empty, repr(sig))
check("a required property is positional-or-keyword",
      sig.parameters["path"].kind is inspect.Parameter.POSITIONAL_OR_KEYWORD,
      repr(sig.parameters["path"].kind))
check("the controls are present", "timeout" in sig.parameters and "raw" in sig.parameters,
      repr(sig))
check("the generated name is the tool name", read.__name__ == "read", read.__name__)
check("the tool name is recorded on the function",
      getattr(read, "__harness_tool__", None) == "read", repr(read.__harness_tool__))

read(path="notes.txt")
check("a required argument reaches call_tool",
      NS["_calls"][-1] == ("read", {"path": "notes.txt"}, 600.0, False),
      repr(NS["_calls"][-1]))
check("the tool's value is returned", read(path="x") == {"called": "read", "args": {"path": "x"}},
      repr(read(path="x")))

# ── an optional non-nullable property defaults to None and is omitted ───
t = _make("t", {
    "name": "t",
    "parameters": {
        "type": "object",
        "properties": {"a": {"type": "string"}, "b": {"type": "integer"}},
        "required": ["a"],
    },
})
check("an optional non-nullable property defaults to None",
      inspect.signature(t).parameters["b"].default is None,
      repr(inspect.signature(t).parameters["b"]))
t(a="1")
check("an omitted optional property is NOT sent",
      NS["_calls"][-1][1] == {"a": "1"}, repr(NS["_calls"][-1][1]))
t(a="1", b=2)
check("a passed optional property IS sent",
      NS["_calls"][-1][1] == {"a": "1", "b": 2}, repr(NS["_calls"][-1][1]))
t(a="1", b=None)
check("an explicit None on a non-nullable property is treated as omitted",
      NS["_calls"][-1][1] == {"a": "1"}, repr(NS["_calls"][-1][1]))

# ── a NULLABLE property must be able to receive an explicit None ────────
n = _make("n", {
    "name": "n",
    "parameters": {
        "type": "object",
        "properties": {
            "opt": {"type": ["string", "null"]},
            "uni": {"anyOf": [{"type": "string"}, {"type": "null"}]},
        },
    },
})
check("a nullable optional property defaults to the sentinel",
      inspect.signature(n).parameters["opt"].default is _UNSET,
      repr(inspect.signature(n).parameters["opt"]))
n()
check("an omitted nullable property is NOT sent", NS["_calls"][-1][1] == {},
      repr(NS["_calls"][-1][1]))
n(opt=None)
check("an explicit None on a nullable property IS sent",
      NS["_calls"][-1][1] == {"opt": None}, repr(NS["_calls"][-1][1]))
n(uni=None)
check("a nullable anyOf property also passes None through",
      NS["_calls"][-1][1] == {"uni": None}, repr(NS["_calls"][-1][1]))
n(opt="v")
check("a value on a nullable property is sent",
      NS["_calls"][-1][1] == {"opt": "v"}, repr(NS["_calls"][-1][1]))

# ── a name that is not a legal parameter is renamed, and still dispatched ─
r = _make("r", {
    "name": "r",
    "parameters": {
        "type": "object",
        "properties": {
            "class": {"type": "string"},
            "timeout": {"type": "integer"},
            "raw": {"type": "integer"},
            "2weird": {"type": "string"},
        },
        "required": ["class"],
    },
})
rsig = inspect.signature(r)
check("a Python keyword is renamed", "class_" in rsig.parameters and "class" not in rsig.parameters,
      repr(rsig))
check("a property colliding with `timeout` is renamed", "timeout_2" in rsig.parameters, repr(rsig))
check("a property colliding with `raw` is renamed", "raw_2" in rsig.parameters, repr(rsig))
check("a leading-digit name is made legal", "_2weird" in rsig.parameters, repr(rsig))
check("the control parameters still exist",
      rsig.parameters["timeout"].default == 600.0 and rsig.parameters["raw"].default is False,
      repr(rsig))
r(class_="c", timeout_2=5, raw_2=1, _2weird="w")
check("a renamed property is dispatched under its SCHEMA name",
      NS["_calls"][-1][1] == {"class": "c", "timeout": 5, "raw": 1, "2weird": "w"},
      repr(NS["_calls"][-1][1]))
check("the renamed-property mapping is documented in the docstring",
      "class" in (r.__doc__ or "") and "passed as" in (r.__doc__ or ""),
      repr((r.__doc__ or "")[:200]))

# ── a schema with no properties still accepts the argument object ───────
e = _make("e", {"name": "e", "parameters": {"type": "object", "properties": {}}})
esig = inspect.signature(e)
check("a property-less schema takes `arguments` first",
      "arguments" in esig.parameters, repr(esig))
e({"x": 1})
check("a property-less tool receives the whole object",
      NS["_calls"][-1][1] == {"x": 1}, repr(NS["_calls"][-1][1]))
e()
check("a property-less tool can be called with nothing",
      NS["_calls"][-1][1] == {}, repr(NS["_calls"][-1][1]))
check("the docstring does not claim the tool takes no arguments",
      "Takes no declared arguments" in (e.__doc__ or ""), repr((e.__doc__ or "")[:200]))

# ── a schema declaring nothing at all must still not explode ────────────
for label, schema in (("no `parameters`", {"name": "z"}),
                      ("null `parameters`", {"name": "z", "parameters": None}),
                      ("`parameters` not a dict", {"name": "z", "parameters": []}),
                      ("`properties` not a dict", {"name": "z", "parameters": {"properties": 5}})):
    try:
        f = _make("z", schema)
        f({"k": 1})
        ok = NS["_calls"][-1][1] == {"k": 1}
        check("a malformed schema is tolerated: %s" % label, ok, repr(NS["_calls"][-1][1]))
    except Exception as exc:
        check("a malformed schema is tolerated: %s" % label, False,
              "%s: %s" % (type(exc).__name__, exc))

# ── `timeout` and `raw` reach the seam unchanged ────────────────────────
t(a="1", timeout=12.5, raw=True)
check("an explicit timeout and raw reach call_tool",
      NS["_calls"][-1] == ("t", {"a": "1"}, 12.5, True), repr(NS["_calls"][-1]))
check("`raw` is returned verbatim", t(a="1", raw=True) == {"called": "t", "args": {"a": "1"}},
      repr(t(a="1", raw=True)))

# ── extra keywords reach a property the signature had to rename ─────────
read(path="p", extra_key="v")
check("extra keyword arguments are passed through",
      NS["_calls"][-1][1] == {"path": "p", "extra_key": "v"}, repr(NS["_calls"][-1][1]))

# ── the docstring names the tool and its arguments ──────────────────────
check("the docstring names the tool", "`read`" in (read.__doc__ or ""),
      repr((read.__doc__ or "")[:120]))
check("the docstring lists the schema argument names", "path" in (read.__doc__ or ""),
      repr((read.__doc__ or "")[:200]))

# ── every generated function is independently named ─────────────────────
fns = [_make(nm, {"name": nm, "parameters": {"type": "object", "properties": {}}})
       for nm in ("alpha", "beta")]
check("generated functions carry distinct names",
      [f.__name__ for f in fns] == ["alpha", "beta"], repr([f.__name__ for f in fns]))

failed = [name for name, ok, _ in RESULTS if not ok]
print("\n%d checks, %d failed" % (len(RESULTS), len(failed)))
if failed:
    for name in failed:
        print("  FAILED: %s" % name)
    sys.exit(1)
sys.exit(0)
