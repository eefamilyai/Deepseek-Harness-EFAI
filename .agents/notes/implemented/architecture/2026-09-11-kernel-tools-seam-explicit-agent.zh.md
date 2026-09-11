# Agent Note：内核工具调用显式携带所属 Agent

Status: implemented

[English](2026-09-11-kernel-tools-seam-explicit-agent.md) | 中文

## Problem

内核单元可以按名称调用任意可见的 harness 工具。Python 子进程发送 `tools.call` seam 帧，TypeScript 侧将其路由至 `ctx.tools.execute`，因此每个注册表阶段——执行前策略、审批、守卫、执行后、输出校验——都与模型发起的调用完全一致地生效。

所属 Agent 只能通过反向读取 `Context.agent` 到达该 seam。Cordis Context 不暴露反向 Agent 属性：[显式 Agent 身份决策](2026-08-31-explicit-agent-runtime-identity.zh.md)将 Agent 身份放在拥有它的运行时边界上，而 `agent.ctx` 仅是注册与生命周期所有者。在任何 fiber 的存储中都无法解析的属性读取会抛出异常，而不是返回 `undefined`，因此 seam 回调在每一帧上都会抛出。分发在得知所请求的操作之前就已完成解析，所以不引用任何工具的单元与引用工具的单元以相同方式失败。

因此每次内核调用都返回：

```
Error: cannot get property "agent" without inject
```

没有任何内核单元能够执行。

## Decision

所属 Agent 作为显式参数传递，与已经声明它的那些接口保持一致。

`KernelExecuteRequest` 携带 `agent?: KernelAgent`。`KernelAgent` 接口是在 `dsh-kernel` 中声明的结构化 `{ id, session: { id } }` 视图，而不是对 `dsh-agent` 的导入：`ctx.kernel` 是 provider 中立的能力，只命名其所有者的后端不应为此引入 agent 运行时。真实的 `Agent` 满足该形状，且该对象绝不是副本——确切的 Agent 作为权威凭据穿过 seam。

`tool-kernel` 同时传递身份的两半：`agentCtx` 用于抵达能力 seam 的作用域 Context，`agent` 用于领域主体本身。`dispatchSeam(agentCtx, agent, request, signal)` 将所有者穿线至需要它的操作——`subagents.*`、`goals.*`、`rlm.*` 与 `tools.*`。`conversationOf` 读取 `request.agent` 以获得持久会话键；`subagents.children`、`subagents.descendants` 与 `subagents.start` 读取 `agent.session.id` 以获得亲子关系。Agent 缺失意味着直接或合成分发，Python 侧回退到无会话键的独立行为。

`tools.call` 操作支撑 Python `tools` 命名空间：`tools.<name>(args)` 与 `tools["<name>"](args)` 发送该帧，失败时抛出携带工具面向模型错误文本的 Python `ToolCallError`。失败的调用绝不会表现为成功的空结果。

## Verification

`seam-tools-call.spec.ts` 固定单元契约：所属 Agent 作为 `dispatchSeam` 的显式第二参数到达，并作为执行上的 `agent` 抵达 `ctx.tools.execute`；策略拒绝、未知工具名与畸形信封各自产生错误而非值。`seam-tools-call.e2e.spec.ts` 通过真实 `dispatchSeam` 驱动真实 `kernel_child.py`，断言可见工具集与 `ToolCallError` 路径。`transport.spec.ts` 与 `kernel-rlm-context.spec.ts` 覆盖周边 seam。`packages/kernel` 中全部 47 个测试通过。

## Alternatives considered

**保留反向 `Context.agent` 读取。** 该属性并不存在，恢复它会重新引入显式身份决策所移除的歧义：注册所有权会再次选择领域身份。

**从发起方 `AsyncLocalStorage` 作用域恢复 Agent。** seam 帧从子进程事件回调分发，位于发起回合的异步边界之外，因此没有发起方作用域包围它。

**从 `agentCtx` 重建 Agent。** 作用域 Context 选择服务并拥有副作用；它不持有指向 Agent 的反向引用，这正是显式字段存在的原因。

## Consequences

每次内核分发都声明它使用的身份，TypeScript 校验 seam 的两侧。`KernelAgent` 形状使 `dsh-kernel` 免于对 agent 包的运行时依赖，同时仍将活对象携带至把它视为权威凭据的 seam。获得新的依赖所有者操作的后端读取一个参数，而不是探测某个上下文。
