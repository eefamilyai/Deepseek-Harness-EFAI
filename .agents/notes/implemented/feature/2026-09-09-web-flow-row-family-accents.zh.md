# Agent Note: Flow-row family accents

Status: implemented

[English](2026-09-09-web-flow-row-family-accents.md) | 中文

## Problem

会话中的每一行紧凑流内行——think 折叠行、每次工具调用、context injection 行与 system prompt 行、以及 skill 行——的前导字形、标题与分隔点都取自同样三个中性 label token。滚动后的会话就是一列完全相同的灰色行，要找到最近一次 Python 调用或最近一次文件编辑，只能逐行读标题。唯一的例外是 `cordis_*` 覆盖规则：它证明了这种呈现有效，但只覆盖一个扩展族。code 行的字形让这列中性行更糟：`IconCodeOutline16` 是一个井号字形，读起来像 hashtag 而不像程序，而它标注的那一行标题正是 `Python`。

## Decision

`design-platform.css` 声明 `--dsw-alias-flow-*` alias 组，为每类行族各配一种色相：`think` 紫、`search` 蓝、`read` 青、`mutate` 绿（write 与 edit，二者本就共用一个图标）、`shell` 橙、`code` 黄、`instruct` 品红、`generic` 亮绿。`instruct` 覆盖 context injection 行及其 recall 变体、system prompt 行与 skill 行——注入的指令文件、skill 目录、被召回的会话与完整的 system prompt，都是放进模型指令里的文本，无论由谁产出都属于同一类行。`generic` 覆盖未分类的 `others` 变体；在本 harness 中它并非罕见回退：goal、RLM 与 preset 工具都落在它上面。

两套主题都在对 `--dsw-alias-bg-base` 保持 4.5:1 下限的前提下取各自表面所能承受的最高彩度——深色表面接近荧光色，浅色表面取全彩度中间调，因为在浅色表面上荧光值撑不起 13px 文本。两者差距最大的是黄与青，这两种色相本身就偏亮。该组刻意置于 `--dsw-alias-state-*` 之外，且没有任何流内色相落在 red 或 amber 色阶上：`ToolRow` 与 `SkillRow` 在调用失败或中断时会把前导字形换成红色或琥珀色 `StateDot`，因此取自这两条色阶的族强调色会被读成运行状态。

重新绑定的接缝由 `DisclosureRow` 拥有。它的 `.leading` 与 `.title` 读取 `var(--dsh-row-accent, <中性 token>)`，因此未设置强调色的行与旧的中性行内结构逐字节一致。但这条读取只是默认值，而非交付机制：**每个消费方还要在自己的样式表里给自己的字形、标题、chevron 与分隔点上色**，因为这两半分属不同的构建产物。插件 CSS 被编译进各自的 `lib/client.js`，由运行中的服务进程注入；`DisclosureRow` 的 CSS 则随服务作为静态文件提供的 `apps/web/dist` bundle 一起发布。当两者只有一边是最新时，色相跨越二者的行就会变灰——实地表现为除 `SkillRow` 之外每一行都失去强调色，而它正是唯一在自己样式表里从头到尾完成上色的行。各消费方的 `.root .leading, .root .title` 规则带两个 class，因此无论页面先发出哪张样式表，它都能压过该 primitive 的单 class 规则。摘要保持中性 tertiary 色调，因为它是该行的内容而非种类。

重新绑定落在行元素上，绝不落在外层容器上：`ToolCallTree` 把子调用渲染成父调用容器内部的嵌套行，绑在容器上会让每个自身未设置的子行继承父行的色相。因此 `ToolRow` 写作 `.root[data-variant='…'] .row`，`cordis_*` 规则也从同一位置重新绑定到产品强调色；这要求它排在被其覆盖的变体规则之后（特异性相同，只有源码顺序能打破平局）。

有三种行复制了 disclosure 行内结构而非组合 `DisclosureRow`，因此各自在自己的四处上重新绑定并应用强调色：`SkillRow`、`bash-sample.module.css` 中按 key 注册的 `bash` 视图，以及已经采用产品强调色的 Cordis 行。bash 那一处是陷阱：`bash` 会分派到该 keyed 视图，因此 `ToolRow` 的 `[data-variant='bash']` 规则对真实的 shell 调用根本不会生效，shell 色相本会成为死代码。`bash-sample.module.css` 中已有一条 TODO 建议迁移到 `DisclosureRow`，那将连同它那份字形规则一起删掉这份接线副本。

code 变体的字形换成新的 `IconBracesOutline16`：手工绘制的 `{ }`，采用图标族的 1.25 描边宽度。`IconCodeOutline16` 保留其余调用点（dock 头部动作与两个 Cordis 行）。

侧边栏品牌组合采用同一套读法。两个 mark 位都取品牌蓝，而旁边的名称保持文本墨色——蓝色标记配深色字标正是两种占位者都预期的组合；figma 中把主屏实例定为黑色的那条注记管的是 name 位，mark 位本就没有自己的规则，只是继承了按钮的墨色。本地构建的版本徽标从 6px 的黑色方块改为 8px 的品牌蓝胶囊配前景墨色，因此它读起来属于该组合；两行堆叠也保持单行官方字标所占的 24px 槽位高度。

## Alternatives considered

**每个工具名一种色相。** 否决：调色板必须可被记住。八个族已经让相邻色相相距约 45°，深色侧接近荧光的取值撑得住，浅色侧则勉强；一个工具名一种色相会引入在滚动行上读起来相同的相邻色。

**给 skill 行单独一种色相。** 否决：那会是第九种，而且会拆散一个本就成立的族——skill 行与 context 行把同一类材料送进同一个地方。字形本身已经能区分它们。

**让未分类的 `others` 行保持中性。** 先这样发过，随后推翻：当初的理由是未分类的调用不应占用在已分类调用上有含义的色相。但在本 harness 中，这把最频繁出现的行排除在索引之外，因为 goal、RLM 与 preset 工具全都未分类。

**只给字形上色，标题保持中性。** 否决：字形只有 14px 的描边墨量，不足以让人一眼按列检索。给标题上色也正是既有 `cordis_*` 规则的做法，因此沿用它保持了一种呈现方式，而不是引入第二种。

**只依赖 `DisclosureRow` 的读取，不在各消费方另写颜色规则。** 在本次改动中途这样发过，随后回退：删掉各行的覆盖后，接缝从一条特异性约定变成一个属性，context 行与 skill 行也因此只需增加一条声明就能加入。但这同时把每一行的色相拆到了两个构建产物上，实地故障立刻且彻底——除 `SkillRow` 外每一行都是灰的。重新绑定的接缝保留；各消费方的颜色规则回到它旁边，理由从特异性换成了构建产物的相互独立。

**用 `</>` 尖括号作 code 字形。** 否决：`IconInspectOutline12` 已经是这个形状，并且它就作为轨迹入口渲染在同一个展开的 code 行下方。

**用 Python logo。** 否决：`code` 变体同时覆盖 `run_code` 与 `kernel`，且该标志是 PSF 商标，其几何形状缩到 14px 单色描边后无法保持。

**在 `design-platform.css` 之外另建 harness 自有的 `--dsh-flow-*` 样式表。** 否决：[ui-theme 的 README](../../../../packages/client/ui-theme/README.zh.md) 规定 token 样式表是颜色的唯一权威，新颜色须以一个 static 阶加一个语义 alias 的形式进入。再开一张样式表会白白拆分这一权威。

## Testing

`flow-accent-tokens.client.spec.ts` 读取 `design-platform.css` 并锁定该组：两套主题声明同样的八个强调色、每套主题各用不同的阶、没有两个族共用同一个阶、每个强调色都解析到该主题声明过的 static 阶、且没有任何强调色落在 red 或 amber 色阶上。`tool-row-accent-styles.client.spec.ts` 锁定每个变体到 token 的映射、ToolRow 自己上色的两处、cordis 规则位于变体规则之后、每条重新绑定的选择器都以 `.row` 而非 `.root` 结尾，以及按 key 注册的 bash 视图在自己的四处上都重新绑定了 shell 色相——即某条生效的变体规则却触及不到任何真实行的情形。`flow-row-accent-styles.client.spec.ts` 对 think 行与 context 行做同样的锁定；两个行 spec 都断言颜色规则与重新绑定位于同一张样式表——否则构建产物的拆分对单元测试完全不可见。`disclosure-row-styles.client.spec.ts` 锁定 primitive 的回退值，正是它让未设置强调色的行保持中性。它们都读 CSS 文本，因为 jsdom 不解析 cascade。

## Consequences

此后新增一个行族意味着在两个主题块各加一个 alias，再在行上加一条 `--dsh-row-accent` 声明；单边新增或复用已有阶会被 token 测试拦下，把某个变体留成中性、或把重新绑定放在会让子调用继承的位置，会被行测试拦下。调色板为此多出六种 static 色相（cyan、lime、orange、pink、violet、yellow）以及在既有色相上新增的三个阶，这是让八个可区分的族避开运行状态所占两条色阶的代价。受限的一侧是浅色主题：它的黄与青是中间调，而非深色表面所用的接近荧光的取值，因为白底上 13px 文本要满足 4.5:1 就不可能是荧光色。运行状态仍然压过族色相：失败的行在族色标题之上显示红色状态点与红色摘要。
