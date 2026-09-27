# Agent Note: `/compact` 的参数会送达摘要器

Status: implemented

[English](2026-09-27-compact-argument-admission.md) | 中文

## 问题

操作者输入 `/compact <text>` 来指定检查点要保留什么。压缩确实执行了，但指令没有出现在摘要里。两个彼此独立的断点造成了这个结果，而每一个都掩盖了另一个。

**被争论的那一行从未成为命令输入。** 命令定义通过 input 描述符声明自己是否接受参数。`compact` 定义没有声明，因此 composer 不把该行当作本命令的参数：文本作为普通聊天交给模型，`command/run` 记录下 `args: ''`。命令平面从未收到的参数，下游无法恢复。

**摘要器以 Agent 身份运行。** 压缩请求把会话按真实角色重放——Agent 自己的系统提示词在起作用，它的工具模式仍在提供——于是模型把该请求读作一次编码会话的下一轮，继续扮演 Agent 的角色。回复是一个工具调用、一段围栏代码块、对指令的复述，或面向操作者的散文，而绝不是检查点。在文本通道路由上还有第二条指令使问题叠加：`packages/llm/llm-kiln/src/adapter.ts` 导出自己的 `SUMMARIZER_SYSTEM`，当 `options.purpose === 'compaction'` 时 `buildTurns` 用它替换工具协议。只修引擎，会让该路由继续向一个没有工具通道的请求教授工具协议。

两个断点都位于上游拥有的文件中，因此都是带有合并成本的 seam 编辑：成本必须说明理由，退出条件必须写明。

## 决策

命令声明自己接受参数，并且该参数作为数据而不是提示词文本进入请求。

**准入。** `packages/compaction/command-compact/src/index.ts` 在 `compact` 定义上声明 `input: { hint: '[<instruction>]' }`。正是该描述符让客户端把被争论的那一行当作本命令的参数；没有它，该行不会被宣告为容忍参数，composer 会把它发给模型。该编辑带有 `DSH-FORK(kiln)` 标记和退出条件：上游声明了 input 描述符，或默认让被争论的一行抵达已注册命令。

**传递。** 每次调用的指令经过四跳，每跳都标记为 `DSH-FORK(kiln)`：

1. `packages/compaction/compaction/src/index.ts` —— `CompactionEngine.compactNow` 增加第四个参数 `instruction?: string`。
2. `packages/compaction/compaction-basic/src/index.ts` —— `compactNow` 接收它，并把 `{ instruction }` 展开进事务。
3. `packages/compaction/compaction-basic/src/region.ts` —— `CompactionTransaction` 携带 `readonly instruction?: string`，`buildSummarizationInput(session, shadowedSeqs, instruction)` 把它放到 `SummarizationInput` 上。
4. `packages/compaction/compaction-basic/src/summarizer.ts` —— `summarizeWithLlm` 读取 `input.instruction`，并交给 `buildCompactionInstruction`。

**请求形状。** `summarizeWithLlm` 构造出阻止 Agent 角色读法的请求：系统槽承载 `SUMMARIZER_ROLE`，绝不承载被重放的 Agent 提示词；消息是一条引用的重放轮次，后接一条指令轮次；请求不提供工具；并携带 `purpose: 'compaction'`，使适配器可以特判它。`quotedReplay` 把每条被重放的消息压平为一条用户轮次，在 `<summarized-conversation>` 标签内按角色标注，并把非文本块原样附加，以便图像卸载恢复仍能找到它们。末尾轮次是 `buildCompactionInstruction(readInstructionFile(), input.instruction)`：角色、必需的检查点结构、常驻的操作者文本，然后是本次调用的文本，两个操作者块都从属于角色。

**适配器的一半。** `packages/llm/llm-kiln/src/adapter.ts` 中的 `SUMMARIZER_SYSTEM` 在文本通道路由上继续占据系统槽，替换工具协议。同一文件的 `planCompactionFold` / `foldRequest` 在路由限制单条消息、需要把记录折成多段时执行同样的替换。

## 测试

`packages/compaction/command-compact/tests/command-compact.spec.ts` 记录每次 `compactNow` 调用收到的指令，`tests/loader-composition.spec.ts` 断言装配后的命令平面列出的描述符——`input: { hint: '[<instruction>]' }`——因此丢失 input 描述符的定义会让 Loader 组合测试失败，而不是悄悄退回普通聊天。两个 spec 都是记录在 `local-overlay/SEAM.json` 中的 seam 路径。

## 考虑过的替代方案

**让客户端把任何被争论的一行都准入到已注册命令。** 这会一次性修好所有命令，成本是 fork 本来不触碰的客户端包中的一处编辑。规则由上游制定，而 fork 本地的准入改动会比一个表达同样意图的描述符构成更大的 seam。

**只把指令放进系统提示词。** 系统槽是角色陈述所在之处，与它共享位置的操作者指令读起来像引擎配置，而不是每次调用的请求。把常驻操作者文本与本次调用的指令保留为各自独立的末尾块，能让引擎保持角色的主导地位。

**按真实角色重放记录，让末尾一句“总结这些”来治理。** 这正是产生 Agent 声音输出的读法。已经在进行中的对话会压过末尾的指令；修复必须改变请求的形状，而不是给它的最后一轮加语气。

**只修引擎，放过适配器。** 两条指令是不同路由上的两段独立文本。只修引擎的 fork，会在每个由适配器替换自身摘要器陈述的路由上继续产出工具调用块。

## 后果

`/compact <text>` 现在会在请求中包含操作者文本的情况下执行压缩，而检查点由一个陈述自身角色的请求产出。指令是请求上的数据，因此适配器、折叠或测试都能观察到它，无需解析散文。

代价是 seam 上的三个上游路径：`command-compact/src/index.ts`、`command-compact/tests/command-compact.spec.ts` 和 `command-compact/tests/loader-composition.spec.ts`，在此前指令已穿过的引擎、region 与摘要器路径之上。每个都带有 `DSH-FORK(kiln)` 标记，使合并解析者无需重建即可读懂 fork 一侧。

准入是客户端的规则，不是本包的规则：描述符是 fork 能够声明的东西，而改变对被争论一行的处理方式的客户端，会在不修改该定义的情况下改变它的行为。

## 相关决策

[压缩交接](2026-09-24-compaction-handoff.zh.md) 拥有账本、同一步交接、固定与折叠，也就是这个请求形状所服务的对象。fork 的 [`dsh-compaction-pipeline`](../../../skills/dsh-compaction-pipeline/SKILL.md) 技能以面向操作者的侦察形式承载同一条路径。
