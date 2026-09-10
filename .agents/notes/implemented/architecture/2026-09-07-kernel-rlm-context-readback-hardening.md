# Agent Note: Kernel RLM context read-back hardening

Status: implemented

English | [中文](2026-09-07-kernel-rlm-context-readback-hardening.zh.md)

## Problem

The kernel RLM "context-as-variable" overlay lets a model bind values with `ctx_write(name, value)`, fan out clean-context children with `llm_batch`, and settle a terminal `answer`, then reads that live state back through `ctx.kernel.execute({ code: 'rlm_dump()' })` inside a `system-prompt/assemble` listener. Four defects in that read-back path could corrupt or deadlock a turn:

- **Re-entrant deadlock.** `llm_batch` fans out child LLM calls inside one kernel cell; a child's prompt assembly fires the same global listener, which queues a `rlm_dump()` read on the serialized kernel behind the still-running fan-out cell. The read waits forever, and the fan-out waits on the child.
- **Clean-context leak.** The listener is global, so an in-process child agent's assembly also reads the parent kernel and injects its binds, defeating the child's clean context.
- **Terminal amplification.** A settled `answer` and the accumulated `sub_N` fan-out results are terminal values the parent already consumed; re-injecting them every turn grows the snapshot without adding state.
- **Duplicate context entry.** The listener appended a `kernel:rlm` context on every assembly, so a repeated assembly could carry several same-named entries.

A fifth hazard sat on the Python side: `ctx_write` wrote straight into the shared namespace, so a bind named `remember`, `recall`, or `llm_batch` silently replaced a harness helper.

## Decision

The overlay read-back is hardened at two seams, both update-safe local files — no `packages/core/agent-loop` or `packages/core/system-prompt` edit.

`packages/kernel/kernel-rlm-context/src/index.ts` hardens the listener:

- **`busy()` gate.** `KernelContextService.read()` checks `this.ctx.kernel.busy()` and returns without queuing a read while any cell is queued or running, so a re-entrant `rlm_dump()` can never queue behind an in-flight `llm_batch`.
- **`ownerAgentId` scoping.** Config `ownerAgentId` pins the contribution to one agent id; a child agent with a different id is skipped, preserving its clean context. Omitting the field restores the legacy broad behavior for single-agent compositions.
- **Terminal suppression.** When `snapshot.answer.ready` is true the listener contributes nothing (the parent already has the answer), and `renderRlmContext()` filters `answer` and `sub_*` keys out of the live binds. A not-ready answer still renders.
- **Replace-not-append.** The listener filters out any existing `kernel:rlm` entry before appending, so one assembly carries at most one.

The plumbing those guards read is in the kernel seam: `KernelProvider.busy?(): boolean` (optional, `packages/kernel/kernel/src/types.ts`), `KernelRuntime.busy()` (returns `false` when no backend resolves), and `KilnKernelProvider`'s `pending` counter that is non-zero while `serialize()` has a cell queued or running (`packages/kernel/kernel-python/src/provider.ts`).

`python/kiln/runtime/rlm_context.py` refuses reserved binds. `RlmContext.__init__` snapshots every pre-existing callable in the namespace, `install()` adds the facet's own primitive names (`answer`, `set_answer`, `answer_ready`, `answer_content`, `ctx_write`, `ctx_read`, `ctx_list`, `llm_batch`, `rlm_dump`), and `ctx_write()` returns a refusal instead of overwriting any name in `_reserved`.

A hard "stop driving once `answer.ready`" decision is deliberately out of scope: that belongs to core agent-loop tool-result handling, which the update-safe surface does not edit. The overlay only stops re-injecting the settled answer; a true hard-stop remains a core patch.

## Verification

- `pnpm exec vitest run packages/kernel/kernel-rlm-context` — 5/5 pass, including the ready-answer and terminal-key render shapes.
- `py_compile` on `rlm_context.py` — clean.
- Package `tsc --noEmit` — clean.
- `pnpm run verify-cordis-config` fails on `apps/cli/tests/profiles/acp/cordis.yml` ("root must be a Loader entry array"); that file is unmodified against HEAD and is a pre-existing failure, not a regression from this change.

## Alternatives considered

**Hard-stop inside the overlay.** Making `answer.ready` stop the driver from the read-back listener would close the loop without a core edit, but the listener has no authority over turn termination, and inventing a side channel would duplicate the machine's existing stop-on-tool-result decision. The overlay suppresses the answer instead and leaves the real stop to core tool-result handling.

**Global listener with no owner scoping.** Omitting `ownerAgentId` keeps the single-agent behavior, which is why it remains the default; it cannot express "this agent only" for a multi-agent composition, so the field is opt-in rather than a replacement.

**Reading busy state through a separate query.** The optional `busy?()` on `KernelProvider` is the cheapest truthful signal; a provider that cannot report it leaves the guard false rather than blocking, so the seam document records the expectation that callers gate re-entrant reads on `false`.

## Consequences

The deadlock, child leak, and terminal amplification are removed at the seams the overlay already owned, and the Python namespace can no longer lose a harness helper to a bind. The costs are a new optional provider method that every re-entrant reader must opt into, and an `ownerAgentId` value the composition must supply for multi-agent isolation; single-agent callers keep the old behavior with no config.
