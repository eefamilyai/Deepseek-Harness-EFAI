# @deepseek-ai/dsh-rlm

First-party **Recursive Language Model** engine for the DeepSeek Harness.

RLMs are a task-agnostic inference paradigm: instead of answering a prompt in
one shot, the model writes Python into a persistent REPL, keeps live variables,
spawns recursive sub-calls, and signals completion by setting an `answer`. This
package supplies the missing piece the harness's existing RLM overlay did not:
the **recursive driver loop** that repeatedly

1. calls the harness LLM (`ctx.llm.stream`),
2. runs every `python` tool call the model emits through `ctx.kernel.execute`,
3. feeds the captured cell output back into the conversation,
4. reads the kernel's machine-readable `rlm_dump()` state, and
5. stops as soon as the model marks its answer ready.

It is a fork-owned package (`packages/rlm/rlm`), so it touches no upstream
file. It builds on the existing fork seams:

- `ctx.llm` — the canonical streaming LLM service,
- `ctx.kernel` — the persistent Kiln Python namespace,
- `parseRlmDump` from `@deepseek-ai/dsh-kernel-rlm-context` — the shared
  `__KILN_RLM_STATE__` read-back protocol.

## Layering

- `src/engine.ts` — the pure recursive-loop driver. No workspace imports, so it
  is unit-tested in isolation with fake LLM and kernel dependencies.
- `src/protocol.ts` — the system prompt that teaches the model the REPL
  protocol and the answer/context primitives.
- `src/index.ts` — the Cordis plugin: injects `llm` + `kernel` + `systemPrompt`,
  provides `ctx.rlm.completion`, and registers the model-facing `rlm` tool.

## Composition

The `rlm.enabled` toggle is mounted from the host base composition
(`packages/bundle/base/cordis.patch.yml`) alongside the `rlm-mode` settings
row. When enabled, it mounts this package, unmounts the standalone
`tool-kernel` row, and the engine drives the persistent kernel directly. The
shell, filesystem, search, and background-job tools remain gated by
`kernel.enabled`, because the RLM REPL subsumes them while it is active — and
the `kernel`/`kernel-python` *services* stay alive underneath, since the
engine's REPL is that kernel.

See `HARNESS-EDITS.md` for the fork's tier rules; this package is Tier 1.
