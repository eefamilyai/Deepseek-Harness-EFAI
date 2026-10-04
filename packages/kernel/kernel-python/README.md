# @deepseek-ai/dsh-kernel-python

The **Kiln-backed persistent Python provider** for the `ctx.kernel` seam.

The kernel itself is the Kiln runtime vendored under `python/kiln/runtime`, spawned as a child process and driven over its base64 frame protocol. Nothing about the engine is reimplemented here: the namespace semantics, the preloaded helpers (`remember`/`recall`, `sh`, `read_file`, `browser_use`, …), and the top-level-expression echo all belong to that runtime. This package is the adapter that puts it behind `ctx.kernel`.

## Composition

```yaml
- id: kernel-python
  name: '@deepseek-ai/dsh-kernel-python'
```

Mount it to make the Kiln runtime the backend the seam selects.

## Layering

- `src/index.ts` — the Cordis plugin; registers the provider on `ctx.kernel`.
- `src/provider.ts` — the `KernelProvider` implementation over the child process.
- `src/child.ts` — child lifecycle and the frame protocol.
- `src/seam.ts` — the deep bridge: dispatches Python→TS seam requests onto the harness seams reached through the calling agent's scoped context.
- `src/seam-harness.ts` — the observation half of that bridge: the ops that report what the harness currently is (agents, session history, settings, loader rows, model routes, workspaces, jobs, schedules, token accounting, presets, projections, terminals, the assembled prompt) plus `seam.ops`, the catalog of all of them.
- `tests/transport.spec.ts` — frame-protocol coverage, driven by `tests/fixtures/fake-kernel.py` so the transport is tested without the real runtime.
- `tests/seam-tools-call.spec.ts` — the `tools.call` seam contract, unit-level.
- `tests/seam-harness.spec.ts` — the observation ops, unit-level: the `unavailable` path per family, the projections each one reads, and that `seam.ops` lists exactly the ops the dispatcher answers.
- `tests/seam-tools-call.e2e.spec.ts` — the same capability end-to-end, driving the real `kernel_child.py` process and answering its seam frames through the real `dispatchSeam`.
- `python/kiln/runtime/test_harness_tools.py` — the schema-to-signature generator, offline: it slices `_make_tool_function` out of the runtime by marker and exercises it against a stubbed `call_tool`. That is the one part of the surface the seam tests cannot pin, because they drive dispatch rather than the generated signatures.
- `python/kiln/runtime/test_harness_introspection.py` — the observation helpers, offline: it slices their block out of `kernel_child.py` by marker and pins the op each helper sends, the arguments it forwards, and how it unwraps a response.

## Calling harness tools from Python

`call_tool` and a `tools` namespace are bound into every cell, so a cell reaches **any** tool the harness mounts — not just the handful of helpers the Kiln runtime preloads:

```python
tools.read({"path": "notes.txt"})          # attribute form
tools["my-tool"]({"x": 1})                 # exotic, reserved, or _-leading names
call_tool("read", {"path": "notes.txt"})   # direct form
tools.read({...}, raw=True)                # the full {isError, value, content, meta} envelope
```

The call travels through `ctx.tools.execute` — the same registry pipeline a model-issued call traverses — so pre-execute policy, the approval gate, guards, post-execute, and output validation all apply, and the returned value is the tool's canonical lossless-JSON value (the same value a `run_code` program receives). A refusal, a denial, or a tool error raises `ToolCallError`, so a failed call is never mistaken for a successful empty result.

The preloaded helpers (`read_file`, `sh`, `bash`, `web_search`, `remember`/`recall`, …) stay as they are: each is a fast local path for its common case, and keeps working when no harness is attached. `tools.<name>` is the general door beside them.

### Finding out what is available

`tool_help()` lists both kinds of callable — the preloaded helpers and every harness tool:

```python
tool_help()                 # helpers, then the harness tools as tools.<name>
tool_help(pattern="web")    # narrow both sections
tool_help("read_file")      # a helper's docstring
tool_help("tools.read")     # one harness tool's schema, as the model sees it
```

A bare harness name works too (`tool_help("read")`). With no harness attached the harness section says so explicitly rather than appearing empty — that difference is what tells a caller to fall back to the local helpers.

## Reading the harness from a cell

`tools.*` acts on the harness; the observation helpers report what it currently is. They are the same bridge, one op each, reachable from a cell by name:

```python
seam_ops()                                  # every op, its arguments, and what it returns
seam("sessions.surface", limit=20)           # call any op, including one with no helper yet

session_corpus()                             # every session this harness can read, live or stored
session_events(type="tool/result", limit=10) # the newest recorded events, with per-event summaries
session_surface(limit=20)                    # what the model would see now — a different list
session_window(seq=412)                      # the events around one seq
list_agents(), current_agent()               # who is running, and which one is this cell
harness_settings()                           # settings namespaces, effective values, revisions
update_setting("kernel-python", {"browserWindow": True})
list_plugins()                               # the loader rows this deployment composed
list_model_providers(), list_models("kiln")  # the routes a session can be run on
list_workspaces(), list_jobs(), list_schedules(), list_terminals()
context_state()                              # this session's token accounting
list_presets(), current_preset(), read_projections(["tokenUsage"])
session_title(), search_tools(query="browser"), prompt_sections(full=False)
list_storage_backends()                       # the storage backends this deployment registered
```

Two rules shape that family. **History is read through `ctx.sessionQuery`**, which owns the live-preferred corpus and can read a session this process never opened; the synchronous `Session` readers are `@deprecated` and new code may not call them. **A missing service is `unavailable`, not empty**: a deployment without `ctx.sessionQuery` answers with the reason, so a cell can tell "no such data" from "no such seam" — the same distinction `tool_help()` draws for tools. `seam_ops()` is the authoritative table; every helper above is a thin, documented wrapper over one entry.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-kernel`, which renders a cell's captured output for the model.

#### KV Cache effect

No direct invalidation; the model-facing tool owns any request-prefix changes.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **The backend is the vendored Kiln runtime** - the provider spawns `kernel_child.py` and speaks its base64 frame protocol; it does not implement namespace semantics itself.
- **A namespace is lost on restart** - any outcome that loses the child process restarts it, and variables bound in the old namespace are gone.
- **Arbitrary Python runs inside the namespace by design** - the child's environment is scrubbed of provider keys and auth tokens, but the capability itself is the point.
- **Windows has no PTY for the transport** - the frames are newline-delimited base64 over pipes, so the protocol carries no terminal semantics.
- **`tools.call` cannot dispatch under `mode: 'ptc'`** - a PTC-mode registry denies a native tool call that carries no parent token, and the kernel has no way to mint one. The denial is reported as a `ToolCallError` naming the route to take, so a cell fails loudly rather than silently. Every other `tools` mode is unaffected.

Fork-owned: `packages/kernel/kernel-python` is Tier 1, so it touches no upstream file.
