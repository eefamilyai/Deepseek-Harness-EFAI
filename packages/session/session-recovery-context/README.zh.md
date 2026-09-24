---
description: "压缩后的恢复：由代码维护的会话账本，在压缩发生的同一步里以交接消息重述，外加一行焦点提示与会话日志路径，供调优压缩后保留内容的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recovery-context

[English](README.md) | 中文

## 概述

`dsh-session-recovery-context` 让被压缩（compaction）的会话像什么都没丢一样继续下去。随着日志提交，它把摘要最先丢掉的那些事实——操作者的原话、动过的文件、执行过的命令、仍未解决的错误、待办清单——折叠进一本账本。在压缩发生的同一步里，它追加一条交接消息：重述这些事实，附上最近改动文件的当前内容，并以确切的续接位置收尾。轮次继续运行：不额外花费一步，也不要求任何确认。第一次压缩之后，运行时上下文中的一行焦点提示让进行中的待办和下一步始终在视野内。插件还把会话的日志路径、目录与 id 注册为提示词变量。从不压缩的会话只会得到日志路径那一行。

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

当会话足够长以至于会发生压缩，且模型必须接着操作者真正的任务、而不是任务的摘要继续工作时，挂载此插件。

### 何时选择它

任何挂载了压缩引擎、并在摘要取代完整记录之后继续工作的组合都应选择它。压缩之后的那一步，是最容易自信地接错任务的一步。模型写的摘要会转述操作者的说明、漏掉纠正、忘记改过哪些文件、丢掉仍未解决的错误——而下游无从察觉。若部署方从不压缩，则避免使用。本包没有回退包；替代方案是用一行提示词告诉模型自己去读日志，那会花掉轮次，而且可能被跳过。

### 最小配置

多数部署只需设置会话根目录，且它必须与持久化后端保持一致：

```yaml
- name: '@deepseek-ai/dsh-session-recovery-context'
  config:
    root: !!js dshHomePath('sessions')
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `dshHomePath('sessions')` | JSONL 后端写入的会话根目录；用于日志路径和每次压缩的记录文件 |
| `logCompression` | `zstd` | 后端的产物编码，决定日志文件的后缀 |
| `ledger` | `{ prompts: 24, promptChars: 4000, files: 60, commands: 12, errors: 6, errorChars: 400 }` | 账本保留内容的上限 |
| `rehydrate` | `{ files: 4, perFileChars: 8000, maxBytes: 524288 }` | 交接消息重新附上多少个改动过的文件，以及每个文件附多少 |
| `handoffShare` | `0.08` | 交接消息可占用的路由模型上下文窗口比例 |
| `handoffMinChars` / `handoffMaxChars` | `6000` / `24000` | 交接预算的下限与上限（字符） |
| `git` | `true` | 是否把 `git status` 快照写进交接消息 |

生成的[配置目录](../../../docs/config-catalog.md#deepseek-aidsh-session-recovery-context)是每个可接受字段及其 JSDoc 的完整来源。

### 在你自己的文本中指名日志文件

插件注册三个提示词变量——`{{session_id}}`、`{{session_log}}` 与 `{{session_dir}}`——让部署方自有的 persona 文本能指名日志写入器正在追加的那个确切文件。名称采用 snake_case，因为提示词注册表拒绝 `/^[a-z][a-z0-9_]*$/` 以外的任何名称。没有已注册提供者的 `{{name}}` 引用会在每一轮组装时抛错，因此使用这些变量的文本不得组合进省略了本插件的树。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现内部细节——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

设计由两个想法支撑。其一，摘要丢掉的正是代码可以确切知道的内容，所以由代码来保留：账本是对已提交事件的纯折叠，从不要求模型记住日志已经记录的东西。其二，恢复不能打断它所恢复的工作。交接消息搭乘压缩发生的那一步，因为回复中不调用任何工具的一步会结束轮次——额外的"确认记录"一步曾让每个在运行中途被压缩的任务停下来。

这里不扫描历史。一个 Session 投影对每个事件只折叠一次，这正是[同步读取弃用决定](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.md)所规定的做法，因此账本能在恢复（resume）后保留。幂等性经由日志实现：交接消息自身的来源（`{ kind: 'session-recovery', form: 'handoff', compactionId }`）被折叠回来，表示"这次压缩已被应答"，所以之后的步骤或恢复的会话都不会重复它。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：投影注册、pre-step 交接、记录文件、提示词变量、日志与焦点上下文行 |
| [`src/ledger.ts`](src/ledger.ts) | 账本 schema 及其纯折叠：操作者消息、待完成调用、文件、命令、未解决错误、待办、最新检查点 |
| [`src/handoff.ts`](src/handoff.ts) | 在预算内渲染交接消息，以及焦点行 |
| [`src/workspace.ts`](src/workspace.ts) | `git status` 快照与重新附上的文件内容 |
| [`src/log-path.ts`](src/log-path.ts) | 会话路径推导，镜像 JSONL 后端自己的净化逻辑 |

### 主流程

账本逐字保留每条操作者消息，至多 `promptChars` 个字符。达到 `prompts` 上限时从中间丢弃，因为第一条是任务说明，最新的几条是当前意图。在当前轮次已有一步结束之后到达的消息，被标记为轮次中途的纠正。工具调用按名称和参数分类：`read`、`write`、`edit`、`str_replace_editor` 与 `notebook_edit` 触及文件；`bash`、`pwsh` 与 `kernel` 是命令。每个结果依据其错误标志、非零退出状态或 Python traceback 判定成败。同一工具在同一目标上的后续成功，会消解此前在那里的失败。

pre-step 监听器以 prepend 方式注册，并先调用链上其余部分，因此在它读取账本时，运行于该链内部的压缩已经完成。若最新检查点尚无交接消息，它就构建一条。预算来自路由模型的上下文窗口；`git status` 快照与重新附上的文件来自会话的工作目录。监听器把交接消息和检查点写入会话目录中的 `compaction-<id>-<session>.md`，再把交接消息放在该步消息的最前面，使操作者自己的消息和运行时上下文仍然最靠近下一次生成。

交接消息从不重述检查点——检查点就在它上面一条消息的历史里。它以"Continue from here"收尾：检查点的 Current Work 与 Next Step 两节、进行中的待办，以及最近一条请求。这是模型生成之前读到的最后内容。

`src/log-path.ts` 镜像后端的路径净化逻辑而非导入它，因为该逻辑位于后端包不发布的文件中。`tests/log-path-oracle.spec.ts` 将该镜像与后端自己的推导逐字节钉住。

**运行时不变量：** 不发布伴随件。投影的状态 schema 在注册表边界校验每个折叠值。本包拥有的唯一关系——一条交接消息恰好应答一次压缩——由交接消息自身的来源记录在日志中，并由折叠读回。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

当包级契约不够用时阅读这些页面。它们从本插件折叠的事件流出发，经过触发它的引擎，直到完整的配置。

- [Session 投影子系统](../../../docs/subsystems/session-projection.md) —— 投影单元契约、驱动语义与状态版本。
- [压缩子系统](../../../docs/subsystems/compaction.md) —— 压缩保留什么、丢弃什么，以及摘要事件何时提交。
- [`output-masking/`](../../compaction/output-masking/README.md) —— fork 的遮蔽步骤，通过把旧工具输出换成存根来推迟压缩。
- [`session-persistence-jsonl/`](../session-persistence-jsonl/README.md) —— 写出本包所指名文件的后端，以及它写入的根目录。
- [`system-prompt/`](../../core/system-prompt/README.md) —— 提示词变量、运行时上下文贡献，以及严格的 `{{name}}` 规则。
- [session 分组地图](../README.md) —— 同级的持久会话数据包。
- [生成的配置目录](../../../docs/config-catalog.md#deepseek-aidsh-session-recovery-context) —— 每个可接受的配置字段及其源码声明。

-----

<a id="model-experience"></a>
## 模型体验

### 压缩后的交接消息

#### 模型看到什么

一条 user 角色消息，位于压缩发生那一步的消息之首，紧随检查点之后。没有内容可说的小节会被省略。文件内容只使用其他小节剩下的预算。

##### 交接消息

```markdown
# Handoff after context compaction

The earlier part of this session was condensed into the checkpoint above to free up context.
This message restates, from the session record itself, what you were asked and the exact state of the work.
You are continuing work already in progress: do not acknowledge this message and do not recap it.
Pick up at "Continue from here" at the end, and read the full record if you need an exact detail it does not carry.

## Your requests (verbatim, oldest first)

### 1. first request (seq <n>)

<operator-text>

### <k>. correction mid-turn (seq <n>)

<operator-text>

## State when the context was compacted

### Todo list
- [x] <completed>
- [~] <in progress>
- [ ] <pending>

### Files touched (newest first)
- `<path>` — created, edited, read ×<n>

### Unresolved errors (newest last)
- **<tool>** `<target>` (seq <n>):
  <error excerpt>

### Recent commands (newest last)
- ✓ <tool>: `<command>`
- ✗ <tool>: `<command>`

### Git
<git status --porcelain --branch, clipped>

## Recently changed files (current contents)

### `<path>`
<file contents, cut to fit>

## Full record

- This handoff and the checkpoint, as plain text: `<record-path>`
- The complete session log (zstd-compressed JSONL, one event per line): `<log-path>`

## Continue from here

**In progress when the context was compacted:** <checkpoint Current Work>
**Todo in progress:** <todo>
**Next step:** <checkpoint Next Step>
**Most recent request (seq <n>):** <operator text, clipped>
```

#### Token 影响

每次压缩一条，从不每步一条，之后留存在持久历史中。其大小为路由窗口的 `handoffShare`，并被限制在 `handoffMinChars`–`handoffMaxChars` 字符之间：默认为 6,000–24,000 字符，约 1,500–6,000 token。

#### KV Cache 影响

仅追加。触发它的压缩已经改写了前缀，而交接消息位于检查点之后，因此它不会使压缩尚未失效的任何内容失效。

### 运行时上下文中的焦点行与会话日志路径

#### 模型看到什么

始终有一行指名会话自己的日志文件。第一次压缩之后，第二行重新锚定计划。组装时没有附着会话则两行都为空。

##### 运行时上下文行

```markdown
This session is logged to <absolute-log-path>
Focus (this session was compacted; the handoff message has the full state): in progress: <todo> · <n> todo(s) open · next step at the last compaction: <next step>
```

#### Token 影响

每次组装一到两行，每次重新渲染。焦点行只花几十个 token，而且只出现在压缩过的会话里。

#### KV Cache 影响

运行时上下文作为追加到该步的消息投影，只在文本变化时重新发送。日志行在会话生命周期内保持不变。焦点行在待办清单或检查点变化时变化，而那正是模型最需要新文本的时候。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>

这些限制界定了恢复交接不适用的情形。它们是本包当前的约束。

- **打印出的根目录被声明了两次** —— `root` 与 `logCompression` 镜像持久化后端自己的配置而不是从中读取，因此移动会话根目录的部署必须同时移动两行，否则交接消息会指名一个不存在的文件。
- **路径推导是镜像而非调用** —— 后端的净化逻辑在此重新实现，并由一个 oracle 测试钉住，因为后端不发布它。
- **工具知识按名称识别** —— 账本按名称和参数键识别 harness 自己的文件与 shell 工具。它不认识的工具仍会被记为一次调用，但不会增添文件或命令。
- **重新附上的文件在交接时读取** —— 内容是构建交接消息那一刻的文件，而不是模型上次看到的样子。这正是目的，但外部修改会不加提示地出现。
- **持久成本** —— 每条交接消息都是永久的会话事件，因此反复压缩的会话每次压缩都会累积一条交接消息。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

设计及其背后的调研记录在[压缩交接 Agent Note](../../../.agents/notes/implemented/feature/2026-09-24-compaction-handoff.zh.md)中。

</details>
