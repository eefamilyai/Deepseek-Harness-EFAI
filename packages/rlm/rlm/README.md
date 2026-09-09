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

The companion fork-owned bundle `packages/bundle/efai-rlm` carries the
`rlm.enabled` toggle. When enabled it mounts this package and removes the
standalone `kernel`, filesystem, shell, and background-job tools — the things
the RLM REPL subsumes — while keeping the `kernel`/`kernel-python` *services*
alive underneath, because the engine's REPL is that kernel.

See `HARNESS-EDITS.md` for the fork's tier rules; this package is Tier 1.
