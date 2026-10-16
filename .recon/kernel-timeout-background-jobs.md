# Kernel timeouts: registering a backgrounded cell as a real job

## The problem

A kernel cell that overran its primary budget was **backgrounded by the kernel but
never entered the background-job registry**. The cell kept running and its output
was reachable only by being prepended to whichever foreground cell happened to run
next — no job id, no `job_output`, no `job_kill`, nothing in `job_list`.

## Where each half already lived

* `packages/kernel/kernel/src/types.ts` — `KernelBackground { id; timeoutMs }`,
  `KernelBackgroundPoll { known; running?; status?; text? }`, and the optional
  provider methods `pollBackground(id)` / `stopBackground(id)`.
* `packages/kernel/kernel-python/src/provider.ts` — the Python side already
  detaches the cell and reports `background` on the frame when
  `frame.backgrounded === true`.
* `python/kiln/runtime/kernel_child.py` — `_ctrl_bg_poll` / `_ctrl_bg_stop`, with
  adoption on the first poll so text reaches the ring once and cannot surface twice.
* `packages/jobs/jobs/src/view.ts` — `JobKindMap`, merge-extensible by design.

The only missing link was that **nothing handed the detached cell to `ctx.jobs`**.

## The fix

All of it in `packages/kernel/tool-kernel/src/index.ts`, which is Tier-1
(fork-owned; the whole `packages/kernel/` tree is an addition against BASE):

1. `declare module '@deepseek-ai/dsh-jobs/view'` merges `kernel: 'kernel'` into
   `JobKindMap`. `packages/jobs/` is upstream-owned and in no patchGroup, so the
   kind has to arrive by declaration merging from the fork-owned producer —
   exactly how `tool-workflow` and `tool-terminal` already do it.
2. `attachBackgroundCell(ctx, background, code, pollMs, owner)` starts the job and
   owns its polling loop. It returns `{ id }` or `{ note }`; a registry that
   refuses (no controller for this owner, per-owner limit) must not swallow the
   backgrounded notice the kernel already produced.
3. `execute` calls it when `result.background` is set, appends a `NOTE:` to the
   body on refusal, and returns `jobId`.
4. `kernelContent` adds a `RUNNING IN THE BACKGROUND: background job <id>. Collect
   its output with job_output.` block, and the output schema declares `jobId`.
5. New `backgroundPollMs` config (default `DEFAULT_BACKGROUND_POLL_MS = 1000`).

## Design decisions

* **`ctx.get('jobs')`, not `inject`.** The kernel tool must still mount and run in
  a composition with no job registry; a missing registry is a note, not a failure.
* **No pull source.** The registry's pump cadence is a fixed 150 ms, far too fast
  for the kernel's serialized control queue. The tool owns its own timer instead.
* **`cancel` settles `killed` first**, then asks the kernel to stop. Waiting on the
  kernel's best-effort interrupt could hold the job ring open indefinitely.
* **`backgroundId` rides the frame, not the request id**, and is only treated as a
  job when that same frame says `backgrounded === true` — a frame is untrusted.

## Verification

* `tsc -b packages/kernel/tool-kernel/tsconfig.json` → rc=0.
* `vitest run packages/kernel/tool-kernel/tests/{images,background}.spec.ts`
  → **33 passed** (19 images + 14 background).
* Full `tsc -b tsconfig.host.json` → the only remaining errors are 5 pre-existing
  ones in `packages/jobs/` (`'workflow'` / `'pty-send'` not assignable to
  `JobKind`), in a tree with no diff against BASE.

## Known pre-existing breakage (NOT from this change)

`tsconfig.host.json` compiles test files, and two upstream specs fail typecheck:

* `packages/jobs/jobs-local/tests/jobs.spec.ts:318` — `kind: 'workflow'`
* `packages/jobs/tool-jobs/tests/tool-jobs.spec.ts:950,959,978,979` — `kind: 'pty-send'`

Both declare their own `JobKindMap` merge but the merge does not reach the
compilation unit the test is checked in. A merge can only widen the union, so no
change of mine can cause these; `git diff BASE -- packages/jobs` is empty.

## Live behaviour

**A harness restart is required** for this to take effect — the running process
holds the old `tool-kernel` in memory.
