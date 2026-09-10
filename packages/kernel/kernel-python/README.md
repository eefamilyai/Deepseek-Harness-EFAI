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
- `tests/transport.spec.ts` — frame-protocol coverage, driven by `tests/fixtures/fake-kernel.py` so the transport is tested without the real runtime.

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

Fork-owned: `packages/kernel/kernel-python` is Tier 1, so it touches no upstream file.
