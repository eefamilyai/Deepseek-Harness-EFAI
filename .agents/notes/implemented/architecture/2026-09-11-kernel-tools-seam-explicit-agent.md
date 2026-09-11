# Agent Note: Kernel tool calls carry their owning Agent explicitly

Status: implemented

English | [中文](2026-09-11-kernel-tools-seam-explicit-agent.zh.md)

## Problem

A kernel cell can call any visible harness tool by name. The Python child sends a `tools.call` seam frame and the TypeScript side routes it through `ctx.tools.execute`, so every registry stage — pre-execute policy, approval, guards, post-execute, output validation — applies exactly as it does to a model-issued call.

The owning Agent reached that seam only through a reverse `Context.agent` read. A Cordis Context exposes no reverse Agent property: the [explicit Agent identity decision](2026-08-31-explicit-agent-runtime-identity.md) places Agent identity at the runtime boundary that owns it, and `agent.ctx` is a registration and lifecycle owner only. A property read that resolves in no fiber's store throws rather than returning `undefined`, so the seam callback threw on every frame. Dispatch resolves before the requested operation is known, so a cell that referenced no tool failed identically to one that did.

Every kernel call therefore returned:

```
Error: cannot get property "agent" without inject
```

No kernel cell could execute.

## Decision

The owning Agent travels as an explicit argument, matching the interfaces that already state it.

`KernelExecuteRequest` carries `agent?: KernelAgent`. The `KernelAgent` interface is a structural `{ id, session: { id } }` view declared in `dsh-kernel` rather than an import of `dsh-agent`: `ctx.kernel` is a provider-neutral capability, and a backend that only names its owner must not pull in the agent runtime to do it. A live `Agent` satisfies the shape, and the object is never a copy — the exact Agent crosses the seam as the authority credential.

`tool-kernel` passes both halves of the identity: `agentCtx` for the scoped Context that reaches the capability seams, and `agent` for the domain subject itself. `dispatchSeam(agentCtx, agent, request, signal)` threads the owner to the operations that need one — `subagents.*`, `goals.*`, `rlm.*`, and `tools.*`. `conversationOf` reads `request.agent` for the durable conversation key; `subagents.children`, `subagents.descendants`, and `subagents.start` read `agent.session.id` for parentage. An absent Agent means a direct or synthetic dispatch, and the Python side falls back to standalone behavior with no conversation key.

The `tools.call` operation backs the Python `tools` namespace: `tools.<name>(args)` and `tools["<name>"](args)` send the frame, and a failure raises a Python `ToolCallError` carrying the tool's model-facing error text. A failed call never surfaces as a successful empty result.

## Verification

`seam-tools-call.spec.ts` pins the unit contract: the owning Agent arrives as `dispatchSeam`'s explicit second argument and reaches `ctx.tools.execute` as `agent` on the execution, and a policy denial, an unknown tool name, and a malformed envelope each produce an error rather than a value. `seam-tools-call.e2e.spec.ts` drives the real `kernel_child.py` through the real `dispatchSeam`, asserting the visible tool set and the `ToolCallError` path. `transport.spec.ts` and `kernel-rlm-context.spec.ts` cover the surrounding seam. All 47 tests in `packages/kernel` pass.

## Alternatives considered

**Keep the reverse `Context.agent` read.** The property does not exist, and restoring it would reintroduce the ambiguity the explicit-identity decision removed: registration ownership would again select domain identity.

**Recover the Agent from the initiator `AsyncLocalStorage` scope.** A seam frame is dispatched from a child-process event callback, outside the initiating turn's asynchronous boundary, so no initiator scope encloses it.

**Reconstruct an Agent from `agentCtx`.** The scoped Context selects services and owns effects; it holds no reverse reference to the Agent, which is the reason the explicit field exists.

## Consequences

Each kernel dispatch states the identity it uses, and TypeScript checks both sides of the seam. The `KernelAgent` shape keeps `dsh-kernel` free of a runtime dependency on the agent package while still carrying the live object to seams that treat it as an authority credential. A backend that gains a new owner-dependent operation reads an argument instead of probing a context.
