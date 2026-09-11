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
- `tests/transport.spec.ts` — frame-protocol coverage, driven by `tests/fixtures/fake-kernel.py` so the transport is tested without the real runtime.
- `tests/seam-tools-call.spec.ts` — the `tools.call` seam contract, unit-level.
- `tests/seam-tools-call.e2e.spec.ts` — the same capability end-to-end, driving the real `kernel_child.py` process and answering its seam frames through the real `dispatchSeam`.
- `python/kiln/runtime/test_harness_tools.py` — the schema-to-signature generator, offline: it slices `_make_tool_function` out of the runtime by marker and exercises it against a stubbed `call_tool`. That is the one part of the surface the seam tests cannot pin, because they drive dispatch rather than the generated signatures.

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

## Relationship to RLM

`kernel-python` also carries the `rlm.*` seam — the `ctx_write` / `answer` / `rlm_dump()` primitives — that `@deepseek-ai/dsh-kernel-rlm-context` reads back. The provider supplies the primitives; the read-back into agent context is a separate package.

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
