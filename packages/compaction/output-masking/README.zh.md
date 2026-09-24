---
description: "长会话的观察遮蔽：上下文逐渐填满时，旧的大块工具输出变为一行存根，从而推迟压缩——供调优上下文开销的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-output-masking

[English](README.md) | 中文

## 概述

`dsh-output-masking` 防止模型已经据以行动过的工具输出占满上下文。当路由模型窗口的使用量达到设定比例时，所有比最新几条更旧、长度超过阈值、且成功的纯文本结果，会被一次性批量替换为存根：写明调用、大小，以及首行与末行。推理与动作完整保留；只去掉大块内容，模型可以重新运行该调用来再次查看。原始内容保留在会话日志中。遮蔽不调用模型。它推迟压缩（compaction），并留给压缩一段更小、更密集的历史去总结。

## 目录

- [使用本包](#use-this-package)
- [理解实现](#understand-the-implementation)
- [进一步探索](#further-exploration)
- [模型体验](#model-experience)
- [已知限制与延期工作](#known-limitations-and-deferred-work)
- [开发备注](#dev-note)

-----

<a id="use-this-package"></a>
## 使用本包

当工具输出主导长会话时，把本包与压缩引擎一起挂载。

### 何时选择它

当会话在许多步中读文件、跑测试、查看输出时选择它，这涵盖了大多数编码工作。在 SWE-bench 智能体上的测量表明，遮蔽旧观察的解题率与摘要相当，成本约为一半，而且两者可以组合使用。若模型经常需要在许多步之后逐字重读某个输出、又不能重新运行调用，则避免使用——模型很久之后还要逐字引用的结果，最好保留。错误从不被遮蔽。

### 最小配置

```yaml
- name: '@deepseek-ai/dsh-output-masking'
  config:
    usageRatio: 0.5
    keepRecent: 8
    minChars: 2000
    minBatch: 4
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `usageRatio` | `0.5` | 上下文窗口使用量达到该比例时开始遮蔽 |
| `keepRecent` | `8` | 最新的这么多条工具结果从不遮蔽 |
| `minChars` | `2000` | 只遮蔽至少这么多字符的结果 |
| `minBatch` | `4` | 只有能遮蔽至少这么多条结果时才执行一次 |
| `contextWindow` | 无 | 无法解析路由模型窗口时假定的窗口；两者都没有则不执行 |

生成的[配置目录](../../../docs/config-catalog.md#deepseek-aidsh-output-masking)是完整来源。

### 何时执行遮蔽

在每一步之前、在 pre-step 链的其余部分（包括压缩）之前执行，因此落地的一次遮蔽会降低压缩在同一步中测得的压力。只有在没有进行中的压缩、至少有 `minBatch` 条结果符合条件、且已用 token 达到窗口的 `usageRatio` 时才执行。已用 token 在挂载了 token meter 时取其测量值，否则取表面自身的启发式价格。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

每次遮蔽都是工具结果修剪器自己的替换方式：先是一个 `compaction/prune` 影子价格，然后是一个恰好替换一个表面节点、并通过 `sourceEventSeqs` 引用原始事件的 `tool/result`。token meter、重放以及每个表面读取者都已理解这种形态，原始事件留在只追加的日志中。

这里不读取历史。一个 Session 投影折叠当前表面——每个节点的启发式价格，以及工具结果的调用、大小、首末行和标志，但从不保存其文本。价格来自 token meter 自己的估算器，作用于同一个派生消息，因此每次替换声明的影子价格恰好就是 meter 减去的数值。有一个测试把实时 meter 与同一日志的全新重放进行比对。

遮蔽成批落地，因为每次遮蔽都会从第一个被遮蔽的节点起改写请求前缀。有了 `minBatch`，缓存的前缀很少失效，而且只为实际的节省而失效。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：投影注册、pre-step 遮蔽、替换协议 |
| [`src/surface.ts`](src/surface.ts) | 表面投影的 schema 与折叠、候选选择、存根 |

**运行时不变量：** 不发布伴随件。每次替换都通过 session 不变量与压缩不变量的 `compaction/prune` 检查，有测试在打开的轮次内验证这一点。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

- [工具结果修剪器](../compaction-tool-result-pruner/README.md) —— 本包替换协议的来源：保留首尾的裁剪。
- [compaction basic 后端](../compaction-basic/README.md) —— 遮蔽在其之前运行的摘要后端。
- [`session-recovery-context/`](../../session/session-recovery-context/README.md) —— fork 的压缩后交接。
- [Token meter](../../llm/token-meter/README.md) —— 遮蔽读取的测量，以及其价格所用的估算器。
- [生成的配置目录](../../../docs/config-catalog.md#deepseek-aidsh-output-masking) —— 每个可接受的配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### 被遮蔽的工具结果

#### 模型看到什么

输出的位置上是一条工具结果，写明调用、输出大小及其首行与末行。它所应答的工具调用保持不变，因此模型仍能看到自己请求了什么。

##### 存根原文

```markdown
[output masked to keep the context small — <tool> <target>: <chars> characters over <lines> lines.
It began: <first non-blank line, clipped>
It ended: <last non-blank line, clipped>
Run the call again if you need the full output.]
```

#### Token 影响

被遮蔽的结果只花几十个 token，而不是它的全价。默认配置下，一次遮蔽至少移除四条各 2,000 字符以上的结果，即至少约 2,000 token。

#### KV Cache 影响

一次遮蔽会从第一个被遮蔽的节点起改写前缀，因此下一个请求会重新读取这一段。`minBatch` 与 `usageRatio` 让遮蔽很少发生。结果一旦被遮蔽就保持遮蔽，之后的遮蔽不会再碰它。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

- **细节从上下文中消失** —— 只存在于被遮蔽输出中的确切数值，必须通过重新运行调用才能再得到；存根保留首行与末行，不保留中间部分。
- **重新运行并不总是免费** —— 有副作用的调用，或输出已经变化的调用，会返回不同的内容。存根不说明重复执行是否安全。
- **只处理纯文本结果** —— 携带图片或其他非文本块的结果交给图片卸载处理。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

其所依据的调研总结在[压缩交接 Agent Note](../../../.agents/notes/implemented/feature/2026-09-24-compaction-handoff.zh.md)中。

</details>
