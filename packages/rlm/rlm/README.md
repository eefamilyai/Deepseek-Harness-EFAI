# @deepseek-ai/dsh-rlm

First-party **Recursive Language Model** engine for the DeepSeek Harness.

RLMs are a task-agnostic inference paradigm: instead of answering a prompt in one shot, the model writes Python into a persistent REPL, keeps live variables, spawns recursive sub-calls, and signals completion by setting an `answer`. This package supplies the missing piece the harness's existing RLM overlay did not: the **recursive driver loop** that repeatedly

1. calls the harness LLM (`ctx.llm.stream`),
2. runs every `python` tool call the model emits through `ctx.kernel.execute`,
3. feeds the captured cell output back into the conversation,
4. reads the kernel's machine-readable `rlm_dump()` state, and
5. stops as soon as the model marks its answer ready.

It is a fork-owned package (`packages/rlm/rlm`), so it touches no upstream file. It builds on the existing fork seams:

- `ctx.llm` — the canonical streaming LLM service,
- `ctx.kernel` — the persistent Kiln Python namespace,
- `parseRlmDump` from `@deepseek-ai/dsh-kernel-rlm-context` — the shared `__KILN_RLM_STATE__` read-back protocol.

## Layering

- `src/engine.ts` — the pure recursive-loop driver. No workspace imports, so it is unit-tested in isolation with fake LLM and kernel dependencies.
- `src/protocol.ts` — the system prompt that teaches the model the REPL protocol and the answer/context primitives.
- `src/index.ts` — the Cordis plugin: injects `llm` + `kernel` + `systemPrompt`, provides `ctx.rlm.completion`, and registers the model-facing `rlm` tool.

## Composition

The `rlm.enabled` toggle is mounted from the host base composition (`packages/bundle/base/cordis.patch.yml`) alongside the `rlm-mode` settings row. When enabled, it mounts this package, unmounts the standalone `tool-kernel` row, and the engine drives the persistent kernel directly. The shell, filesystem, search, and background-job tools remain gated by `kernel.enabled`, because the RLM REPL subsumes them while it is active — and the `kernel`/`kernel-python` *services* stay alive underneath, since the engine's REPL is that kernel.

## Model Experience

### RLM REPL protocol in the system prompt

#### What the model sees

A system-prompt section stating the recursive REPL contract: the task is solved by writing Python into a persistent namespace rather than answering in one shot. It names the preloaded primitives (`set_answer`, `ctx_write`, `ctx_read`, `ctx_list`, `rlm_dump`, `llm_batch`), tells the model that `set_answer(ready=True)` is terminal, and that its `ctx_write` variables are re-injected every turn and survive a kernel restart.

##### Protocol statement verbatim (excerpt)

```markdown
You are a Recursive Language Model. You solve a task by writing Python code into a persistent REPL, not by answering in one shot.

The REPL gives you these preloaded primitives:
  set_answer(content, ready=True)  - publish your final answer; ready=True terminates the task.
  ctx_write(name, value)           - store a live, addressable context variable.
  ctx_read(name)                   - read a stored context variable.
  ctx_list()                       - list current non-callable variables.
  rlm_dump()                       - emit the machine-readable state snapshot (answers + binds).
  llm_batch(prompts)               - fan out clean recursive sub-calls.

When you are done, set the answer ready. Do not set an answer ready while you still need more computation: a ready answer ends the loop and is terminal.

Treat the persistent namespace as your memory. Variables you create with ctx_write survive the current cell, later turns, and even a kernel restart.
```

#### Token effect

The protocol statement is part of the stable prefix and is billed on every request in the loop. Each recursion re-sends the conversation so far, so a long REPL transcript is re-billed on every step until `maxSteps` is reached.

#### KV Cache effect

The statement itself is static, so it does not invalidate the cached prefix. Cells append to the conversation as tool results, which keeps the prefix stable while the loop runs.

### `rlm` one-shot tool

#### What the model sees

One tool named `rlm` with a required `prompt` and optional `model`, `provider`, and `max_steps`. Its result renders the recursive run's final answer, or the text `(no answer was set)` when the loop stopped without one. The tool is how a non-RLM caller delegates a task to the engine.

#### Token effect

The description and its four parameter descriptions are billed once per request. The result is the answer text only; the intermediate REPL transcript stays inside the nested run and is not returned.

#### KV Cache effect

The schema is static. The answer appends to the transcript as an ordinary tool result.


## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Terminal on a ready answer** - `set_answer(ready=True)` ends the loop immediately, so an answer published early cannot be revised in the same run.
- **Bounded by `maxSteps`** - the loop stops after a configured number of recursive turns, capped at `maxMaxSteps` (default 128), and the run ends without an answer if it never became ready.
- **A model must be selected** - the tool needs an explicit `model` or a default selection; with neither it throws rather than guessing a route.
- **Kernel restarts lose the namespace** - the protocol tells the model that `ctx_write` variables survive a restart, but they do so by being re-injected from the dump, not by the interpreter retaining them.
- **The engine drives the kernel directly** - it is an alternative to the standalone `kernel` tool rather than a layer over it, so RLM mode unmounts that row.

See `HARNESS-EDITS.md` for the fork's tier rules; this package is Tier 1.
