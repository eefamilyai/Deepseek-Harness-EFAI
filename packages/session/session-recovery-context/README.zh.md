---
description: "压缩后的恢复注入，携带操作者的全部提示词与会话日志尾部，并把会话日志路径作为提示词事实，供调优压缩后保留内容的部署方阅读。"
kind: "package-reference"
---

# @deepseek-ai/dsh-session-recovery-context

[English](README.md) | 中文

## 概述

`dsh-session-recovery-context` 在压缩（compaction）之后把记录放回去：注入一条消息，携带操作者的每一条提示词与会话日志尾部，每次压缩只送达一次，因此模型无需花费一个轮次去取回刚刚丢失的内容。它还把该记录作为 `Context file:` 事实留在系统提示词中，每当压缩替换该记录时重新读取，并把会话的日志路径、目录与 id 注册为提示词变量。没有发生压缩的会话不会收到任何内容。代价是每次压缩一条持久的 user 角色消息，其大小受配置的提示词与尾部预算约束。

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

当会话足够长以至于会发生压缩，且模型必须接着操作者真正的任务而不是任务的摘要继续工作时，挂载此插件。

### 何时选择它

任何挂载了压缩引擎、并在摘要取代完整记录之后继续工作的组合都应选择它。压缩之后的那一轮，是最容易自信地接错任务的一轮，因为压缩丢掉的内容里包含操作者自己的原话——委托这项工作的那份说明，以及此后的每一次纠正。若部署方从不压缩，或持久历史成本比压缩后的准确性更重要，则避免使用：注入的消息本身就是一条永久的会话事件。本包没有回退包；替代方案是用一条技能或提示词告诉模型自己去读日志，那会花掉一个轮次，而且可能被跳过。

### 最小配置

最小挂载除了会话根目录之外无需任何配置，而该根目录必须与持久化后端保持一致：

```yaml
- name: '@deepseek-ai/dsh-session-recovery-context'
  config:
    tailEvents: 50
```

| 字段 | 默认值 | 含义 |
|---|---|---|
| `root` | `dshHomePath('sessions')` | JSONL 后端写入的会话根目录，用于派生打印出的日志路径 |
| `compression` | `zstd` | 后端的产物编码，决定日志文件的后缀 |
| `tailEvents` | `50` | 摘要携带的尾部事件条数；`0` 表示完全不带尾部 |
| `promptChars` | `1200` | 每条提示词的字符预算，超出部分由截断标记替代 |
| `maxPrompts` | `0`（保留全部提示词） | 保留多少条操作者提示词 |
| `labelChars` | `120` | 尾部中每个事件标签的字符预算 |
| `preamble` | 随包发布的句子 | 注入消息的第一行 |

生成的[配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-recovery-context)是每个受支持字段及其 JSDoc 的穷尽式真源。

### 在你自己的文本中指名日志文件

插件注册三个提示词变量——`{{session_id}}`、`{{session_log}}` 与 `{{session_dir}}`——让部署方自有的 persona 文本可以指名日志写入器正在追加的那个确切文件。变量名采用 snake_case，因为提示词注册表拒绝 `/^[a-z][a-z0-9_]*$/` 之外的任何名称。引用未注册提供者的 `{{name}}` 会在每一轮装配时抛错，因此使用这些变量的文本不得被组合进省略本插件的插件树。

-----

<a id="understand-the-implementation"></a>
## 理解实现

<details>
<summary>实现细节——点击展开</summary>

本节解释插件的设计；可观察行为见[使用本包](#use-this-package)。

### 设计理念

这里不扫描历史。一个 Session projection 在事件提交时折叠操作者提示词、滚动的事件尾部，以及最新一次压缩的序号，这正是[同步读取弃用说明](../../../.agents/notes/implemented/architecture/2026-09-09-deprecate-synchronous-session-event-reads.zh.md)用以取代读日志的做法：状态能在恢复后存续，且每个事件只需一次纯折叠。一个前置注册的 `agent/pre-step` 监听器先委托下游，随后在进入的决策所属会话的最新压缩尚未被回应时，追加一条带来源的 `UserMessage`。

幂等性经由日志而不是进程内存实现。注入的消息把 `{ kind: 'plugin', plugin: 'session-recovery-context' }` 记为自己的来源，同一个折叠把它读回为“这次压缩已被回应”，因此同一轮次中的第二个步骤不会重复注入，恢复后的会话也不会重新注入。

### 源码地图

| 文件 | 职责 |
|---|---|
| [`src/index.ts`](src/index.ts) | 插件入口：projection 折叠、pre-step 注入器、提示词变量与日志上下文行 |
| [`src/log-path.ts`](src/log-path.ts) | 会话路径派生，镜像 JSONL 后端自身的净化逻辑 |

### 主要流程

折叠把每条操作者提示词裁剪到 `promptChars` 并按顺序保留；触及 `maxPrompts` 上限时从中间丢弃，因为第一条提示词是任务说明，最后几条是当前意图，上限能承受失去的是中间的引导。尾部为每个事件保留一条摘要——序号、类型，以及从该事件实际携带的负载中按结构读出的短标签，因此本文件之后新增的事件类型依然能清晰呈现。渲染把开场白、编号后的提示词、尾部，以及一行指明持有上文所有被截断内容的日志文件的收尾句拼接起来。

`src/log-path.ts` 镜像而非导入后端的路径净化逻辑，因为那段逻辑位于后端包并未发布的文件中；它导入的是两处公开的格式策略部件。`tests/log-path-oracle.spec.ts` 在多种根目录、工作目录与会话 id 上，将该镜像逐字节对齐后端自身的派生结果，因此漂移会导致测试失败，而不是打印出一条指向不存在文件的路径。

**运行时不变式：** 不发布配套模块（No companion is published）。projection 的状态 schema 在注册表边界校验每个被折叠的值；而本包唯一拥有的关系——一次注入恰好回应一次压缩——由注入消息自身的来源记录在日志中，折叠会把它重新读出。

</details>

-----

<a id="further-exploration"></a>
## 进一步探索

包级约定不够用时阅读以下页面。它们从本插件折叠的事件流出发，经由触发它的引擎，抵达穷尽式配置。

- [会话 projection 子系统](../../../docs/subsystems/session-projection.zh.md)——projection 单元约定、驱动语义与状态版本。
- [压缩子系统](../../../docs/subsystems/compaction.zh.md)——压缩保留什么、丢弃什么，以及摘要事件何时提交。
- [`session-persistence-jsonl/`](../session-persistence-jsonl/README.zh.md)——写入本包所指名文件的后端，以及它写入的根目录。
- [`system-prompt/`](../../core/system-prompt/README.zh.md)——提示词变量、运行时上下文贡献，以及严格的 `{{name}}` 规则。
- [session 组地图](../README.zh.md)——相邻的持久会话数据包。
- [生成的配置目录](../../../docs/config-catalog.zh.md#deepseek-aidsh-session-recovery-context)——每个受支持配置字段及其源声明。

-----

<a id="model-experience"></a>
## 模型体验

### 压缩后的恢复消息

#### 模型看到的内容

一条 user 角色消息，在压缩之后第一个进入的步骤上注入。`<preamble>` 是配置的第一行；提示词按从旧到新编号，并裁剪到 `promptChars`，附带 `[+N chars, whole text in the session log]` 标记；当 `tailEvents` 为 `0` 时，尾部小节被整段省略。

##### 注入的消息

```markdown
<preamble>

## Operator prompts, oldest first
1. [seq <n>] <operator-text-or-clip>

## Last <count> session events, oldest first
[seq <n>] <event-type> — <label-when-the-payload-has-one>

The whole record, including everything clipped above, is in this session's log: <absolute-log-path>
```

#### Token 影响

每次压缩一条消息，而不是每个步骤一条，且此后持久留在历史中。其大小受 `promptChars` 乘以保留的提示词条数、加上 `tailEvents` 乘以 `labelChars` 约束；按默认值，一次典型注入在数千 token 量级的低位。

#### KV Cache 影响

仅追加；该消息位于可复用请求前缀之后，不会使现有 KV Cache 条目失效。触发它的那次压缩本身已经重写了前缀。

### 系统提示词中的会话日志路径

#### 模型看到的内容

一行运行时上下文，指明本会话自己的日志文件，另有 `{{session_id}}`、`{{session_log}}` 与 `{{session_dir}}` 三个变量供部署方自有的提示词文本使用。当装配没有附带会话时，它们全部为空。

##### 运行时上下文行

```markdown
This session is logged to <absolute-log-path>
```

#### Token 影响

稳定系统提示词中的单独一行，每次装配重新渲染。它替代了模型为定位自己的日志本来要花费的若干次工具调用。

#### KV Cache 影响

该行在一个会话的生命周期内保持稳定，因此它贡献于可复用前缀而非使其失效；只有会话本身改变时它才改变。

### 系统提示词中的压缩记录

#### 模型看到的内容

一条运行时上下文事实，先指名当前的压缩记录，随后是记录自身的文本：一行 `Context file:` 加该文件的内容，每当压缩替换该记录时重新读取。首次压缩之前该事实为空；在压缩发生到其记录写入之间，它只携带路径。

##### 运行时上下文事实

```markdown
Context file: <absolute-record-path>

# Compaction record
...
```

#### Token 影响

记录的完整文本进入系统提示词，因此代价就是该记录自身的大小——与恢复步骤携带的是同一份文档，受配置的事件与提示词预算约束。

#### KV Cache 影响

该事实恰好在压缩替换记录时改变，而那正是前缀本来就要被重写的时刻。两次压缩之间它保持稳定。

## 已知限制与延期工作

<a id="known-limitations-and-deferred-work"></a>


这些限制说明恢复注入何时不合适。它们是当前包约束。

- **打印所用的根目录被写了两遍**：`root` 与 `compression` 镜像持久化后端自身的配置，而不是从它那里读取，因此移动会话根目录的部署方必须同时移动两处配置，否则提示词会指名一个并不存在的文件。
- **路径派生是镜像而非调用**：后端的净化逻辑在此被重新实现，并由一个 oracle 测试固定，因为后端并不发布它；上游的一次未发布改动会让该测试失败，而不是被自动吸收。
- **每次压缩一条注入，无论压缩规模**：丢弃一小时工作的压缩与丢弃一分钟工作的压缩，产生同样受约束的消息。
- **持久成本**：注入的消息是一条永久会话事件，因此反复压缩的会话会按压缩次数累积恢复消息。
- **标签按结构读取**：尾部从每个事件中读取 `content`、`name`、`summary`、`reason`、`mode` 或 `title`，对这些字段都没有的事件只渲染裸类型名。

<a id="dev-note"></a>
### 开发备注

<details>
<summary>维护者的工作上下文——点击展开</summary>

无。

</details>
