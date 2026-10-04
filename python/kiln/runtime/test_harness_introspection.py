#!/usr/bin/env python
"""Offline tests for the harness-observation helpers in kernel_child.py.

Run:  python test_harness_introspection.py

`tool_help()` reflects over the module's globals, so these helpers ARE the kernel's
documentation of what the harness currently is: the agents it holds, the sessions it
can read, their recorded events, its settings, its loader rows, its model routes, its
workspaces, its jobs and schedules, its token accounting, its presets, its projections,
its terminals, and its assembled prompt.

The helper block is extracted from kernel_child.py by its banner rather than copied, and
exec'd against a stubbed `_seam_request`, so this test pins the op each helper sends, the
arguments it forwards, and how it unwraps a response — without a kernel, a harness, or a
network. It also pins the two properties a reflection-based surface depends on: every
helper has a docstring, and no helper name shadows one that already exists.
"""
import inspect
import os
import re
import sys

HERE = os.path.dirname(os.path.abspath(__file__))
SOURCE = os.path.join(HERE, "kernel_child.py")

RESULTS = []
BANNER = "# What the harness currently is"
END_MARKER = "def run_process("


def check(name, ok, detail=""):
    RESULTS.append((name, bool(ok), detail))
    print("%s  %s" % ("PASS" if ok else "FAIL", name))
    if not ok and detail:
        print("      %s" % detail)


def source_of_block():
    with open(SOURCE, "r", encoding="utf-8") as f:
        src = f.read()
    if BANNER not in src:
        raise SystemExit("helper banner not found in %s" % SOURCE)
    start = src.index(BANNER)
    start = src.rindex("\n# ", 0, start) + 1
    end = src.index(END_MARKER, start)
    return src[start:end]


def load_block(response=None, responder=None, detached=False):
    """Exec the helper block with `_seam_request` stubbed; return (namespace, calls)."""
    calls = []

    def _seam_request(op, args=None, timeout=15.0):
        calls.append((op, args, timeout))
        if detached:
            return None
        if responder is not None:
            return responder(op, args, timeout)
        if response is None:
            return {"id": "x", "ok": True, "value": {"op": op, "args": args}}
        return response

    ns = {"__name__": "under_test", "_seam_request": _seam_request}
    exec(compile(source_of_block(), "<harness introspection block>", "exec"), ns)
    ns["_calls"] = calls
    return ns, calls


NS, CALLS = load_block()


def op_of(name, *args, **kwargs):
    """Call one helper and return the (op, args, timeout) it sent."""
    before = len(CALLS)
    NS[name](*args, **kwargs)
    assert len(CALLS) == before + 1, "%s sent %d requests" % (name, len(CALLS) - before)
    return CALLS[-1]


# ── the surface a reflection-based tool_help depends on ─────────────────
HELPERS = [
    "seam_ops", "seam", "list_agents", "current_agent", "session_corpus", "session_events",
    "session_surface", "session_window", "session_trace", "harness_settings", "update_setting",
    "list_plugins", "list_model_providers", "list_models", "list_workspaces", "list_jobs",
    "list_schedules", "context_state", "list_presets", "current_preset", "read_projections",
    "session_title", "search_tools", "list_terminals", "prompt_sections",
]
for name in HELPERS:
    fn = NS.get(name)
    check("%s is a module-level function" % name, callable(fn), repr(fn))
    doc = (getattr(fn, "__doc__", None) or "").strip()
    check("%s documents itself for tool_help" % name, len(doc) > 20, repr(doc[:60]))
    check("%s has a one-line summary first" % name, doc.split("\n")[0].strip().endswith("."),
          repr(doc.split("\n")[0]) if doc else "")

# A later definition of the same name would silently replace an earlier helper, and a
# name that already exists elsewhere in the file is exactly that collision.
with open(SOURCE, "r", encoding="utf-8") as f:
    whole = f.read()
block = source_of_block()
for name in HELPERS:
    definitions = len(re.findall(r"^def %s\(" % re.escape(name), whole, re.M))
    check("%s is defined exactly once in kernel_child.py" % name, definitions == 1,
          "%d definitions" % definitions)
    check("%s is not also defined outside the block" % name,
          whole.count("def %s(" % name) == block.count("def %s(" % name), name)

# ── every helper sends its own op ───────────────────────────────────────
EXPECTED_OPS = {
    "seam_ops": "seam.ops",
    "list_agents": "agents.list",
    "current_agent": "agents.current",
    "session_corpus": "sessions.corpus",
    "session_trace": "sessions.trace",
    "harness_settings": "settings.describe",
    "list_plugins": "plugins.list",
    "list_model_providers": "models.providers",
    "list_workspaces": "workspaces.list",
    "list_jobs": "jobs.list",
    "list_schedules": "schedules.list",
    "context_state": "context.state",
    "list_presets": "presets.list",
    "current_preset": "presets.current",
    "session_title": "sessions.title",
    "list_terminals": "terminals.list",
}
for name, op in EXPECTED_OPS.items():
    sent_op = op_of(name)[0]
    check("%s sends %s" % (name, op), sent_op == op, sent_op)

# ── arguments are forwarded exactly as the seam reads them ──────────────
op, args, _ = op_of("session_events")
check("session_events defaults to this cell's session",
      args == {"sessionId": None, "limit": 40, "type": None}, repr(args))
_, args, _ = op_of("session_events", "session-abc", 5, "tool/result")
check("session_events forwards id, limit and type",
      args == {"sessionId": "session-abc", "limit": 5, "type": "tool/result"}, repr(args))

_, args, _ = op_of("session_surface", None, 10)
check("session_surface forwards its limit", args == {"sessionId": None, "limit": 10}, repr(args))

op, args, _ = op_of("session_window", 42)
check("session_window forwards a positional seq",
      (op, args) == ("sessions.window", {"sessionId": None, "seq": 42, "before": 5, "after": 5}), repr(args))
_, args, _ = op_of("session_window", 42, "s", 2, 3)
check("session_window forwards the window",
      args == {"sessionId": "s", "seq": 42, "before": 2, "after": 3}, repr(args))

_, args, _ = op_of("session_title", "s1")
check("session_title forwards the session", args == {"sessionId": "s1"}, repr(args))

_, args, _ = op_of("list_models", "kiln")
check("list_models forwards the provider", args == {"provider": "kiln"}, repr(args))

_, args, _ = op_of("update_setting", "kernel-python", {"a": 1}, 7)
check("update_setting forwards the namespace, patch and revision",
      args == {"ns": "kernel-python", "patch": {"a": 1}, "expectedRevision": 7}, repr(args))
_, args, _ = op_of("update_setting", "n", {})
check("update_setting sends a null revision when none was given",
      args == {"ns": "n", "patch": {}, "expectedRevision": None}, repr(args))

_, args, _ = op_of("read_projections", ["tokenUsage"], "s2")
check("read_projections forwards keys as a list",
      args == {"sessionId": "s2", "keys": ["tokenUsage"]}, repr(args))
_, args, _ = op_of("read_projections")
check("read_projections sends nulls when nothing was given",
      args == {"sessionId": None, "keys": None}, repr(args))

_, args, _ = op_of("search_tools", "browser", 5, "agent")
check("search_tools forwards query, limit and scope",
      args == {"query": "browser", "limit": 5, "scope": "agent"}, repr(args))
_, args, _ = op_of("search_tools")
check("search_tools defaults to every visible tool",
      args == {"query": "", "limit": 25, "scope": None}, repr(args))

_, args, _ = op_of("prompt_sections")
check("prompt_sections defaults to sizes only", args == {"full": False}, repr(args))
_, args, _ = op_of("prompt_sections", True)
check("prompt_sections asks for text when told to", args == {"full": True}, repr(args))

# ── the escape hatch forwards anything, and its own timeout ─────────────
op, args, timeout = op_of("seam", "tools.search", query="x", limit=2)
check("seam forwards an arbitrary op and its keywords",
      (op, args) == ("tools.search", {"query": "x", "limit": 2}), repr((op, args)))
check("seam carries its own longer timeout", timeout == 60.0, repr(timeout))
op, args, _ = op_of("seam", "future.op")
check("seam forwards an op with no arguments", (op, args) == ("future.op", {}), repr((op, args)))

# ── unwrapping: value, unavailable, refusal, no harness ────────────────
ok_ns, _ = load_block({"id": "x", "ok": True, "value": [1, 2, 3]})
check("a value is returned untouched", ok_ns["seam_ops"]() == [1, 2, 3], repr(ok_ns["seam_ops"]()))

none_ns, _ = load_block({"id": "x", "ok": True, "value": None})
check("a null value stays null", none_ns["current_agent"]() is None, repr(none_ns["current_agent"]()))

unavailable_ns, _ = load_block({"id": "x", "ok": False, "unavailable": True, "error": "ctx.sessionQuery is not mounted for this agent"})
message = unavailable_ns["session_events"]()
check("an unavailable service becomes an error carrying the reason",
      message == {"error": "ctx.sessionQuery is not mounted for this agent"}, repr(message))

refused_ns, _ = load_block({"id": "x", "ok": False, "error": "surface replace refused"})
check("a refusal becomes an error carrying its message",
      refused_ns["harness_settings"]() == {"error": "surface replace refused"},
      repr(refused_ns["harness_settings"]()))

bare_ns, _ = load_block({"id": "x", "ok": False})
check("a refusal with no message still reports an error",
      bare_ns["list_jobs"]() == {"error": "harness seam rejected the request"},
      repr(bare_ns["list_jobs"]()))

# `_seam_request` returns None when the cell is backgrounded or there is no harness.
detached_ns, _ = load_block(detached=True)
check("a detached cell reports the seam as unavailable",
      "unavailable" in detached_ns["list_plugins"]().get("error", ""),
      repr(detached_ns["list_plugins"]()))

# ── one timeout knob per helper, and a default for every call ──────────
_, _, timeout = op_of("session_events", timeout=99.0)
check("a helper timeout reaches the seam", timeout == 99.0, repr(timeout))
for name in HELPERS:
    fn = NS[name]
    parameters = inspect.signature(fn).parameters
    check("%s takes a timeout" % name, "timeout" in parameters, repr(list(parameters)))

# ── every helper is registered into the cell namespace ─────────────────
# Being a module global makes a helper discoverable by `tool_help`; being in
# `prompt_dict` is what makes it callable in a cell. A helper in only one of the two is
# the failure this pins: listed and unusable, or usable and invisible.
def registration_table():
    """The names registered for cells, read from the block that does the registering."""
    start = whole.index("_HARNESS_OBSERVERS = {")
    end = whole.index("\n}", start)
    return re.findall(r'^\s+"([a-z_]+)":', whole[start:end], re.M)


registered = registration_table()
check("the registration table is found in kernel_child.py", len(registered) >= len(HELPERS),
      "%d entries" % len(registered))
for name in HELPERS:
    check("%s is registered for cells" % name, name in registered, repr(registered[:5]))
check("the registration table has no stale entries",
      sorted(set(registered) - set(HELPERS)) == [], repr(sorted(set(registered) - set(HELPERS))))

failed = [name for name, ok, _ in RESULTS if not ok]
print("\n%d checks, %d failed" % (len(RESULTS), len(failed)))
if failed:
    for name in failed:
        print("  FAILED: %s" % name)
    sys.exit(1)
sys.exit(0)
