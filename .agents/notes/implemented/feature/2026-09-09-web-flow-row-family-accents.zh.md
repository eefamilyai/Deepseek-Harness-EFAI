# Agent Note: Flow-row family accents

Status: implemented

[English](2026-09-09-web-flow-row-family-accents.md) | 中文

## Problem

会话中的每一行紧凑流内行——think 折叠行、每次工具调用、context injection 行与 system prompt 行、以及 skill 行——的前导字形、标题与分隔点都取自同样三个中性 label token。滚动后的会话就是一列完全相同的灰色行，要找到最近一次 Python 调用或最近一次文件编辑，只能逐行读标题。唯一的例外是 `cordis_*` 覆盖规则：它证明了这种呈现有效，但只覆盖一个扩展族。code 行的字形让这列中性行更糟：`IconCodeOutline16` 是一个井号字形，读起来像 hashtag 而不像程序，而它标注的那一行标题正是 `Python`。

## Decision

`design-platform.css` 声明 `--dsw-alias-flow-*` alias 组，为每类行族各配一种色相：`think` 紫、`search` 蓝、`read` 青、`mutate` 绿（write 与 edit，二者本就共用一个图标）、`shell` 橙、`code` 黄、`instruct` 品红、`generic` 亮绿。`instruct` 覆盖 context injection 行及其 recall 变体、system prompt 行与 skill 行——注入的指令文件、skill 目录、被召回的会话与完整的 system prompt，都是放进模型指令里的文本，无论由谁产出都属于同一类行。`generic` 覆盖未分类的 `others` 变体；在本 harness 中它并非罕见回退：goal、RLM 与 preset 工具都落在它上面。

两套主题都在对 `--dsw-alias-bg-base` 保持 4.5:1 下限的前提下取各自表面所能承受的最高彩度——深色表面接近荧光色，浅色表面取全彩度中间调，因为在浅色表面上荧光值撑不起 13px 文本。两者差距最大的是黄与青，这两种色相本身就偏亮。该组刻意置于 `--dsw-alias-state-*` 之外，且没有任何流内色相落在 red 或 amber 色阶上：`ToolRow` 与 `SkillRow` 在调用失败或中断时会把前导字形换成红色或琥珀色 `StateDot`，因此取自这两条色阶的族强调色会被读成运行状态。

重新绑定的接缝由 `DisclosureRow` 拥有。它的 `.leading` 与 `.title` 读取 `var(--dsh-row-accent, <中性 token>)`，因此消费方只要设置一个自定义属性就能给字形与标题上色，而未设置的行与旧的中性行内结构逐字节一致。各消费方再把同一个值应用到共享行内结构不拥有的两处——自己的 hover／展开 chevron 与分隔点；摘要保持中性 tertiary 色调，因为它是该行的内容而非种类。`SkillRow` 自建行内结构而非组合 `DisclosureRow`，因此四处都由它自己重新绑定并应用。

重新绑定落在行元素上，绝不落在外层容器上：`ToolCallTree` 把子调用渲染成父调用容器内部的嵌套行，绑在容器上会让每个自身未设置的子行继承父行的色相。因此 `ToolRow` 写作 `.root[data-variant='…'] .row`，`cordis_*` 规则也从同一位置重新绑定到产品强调色；这要求它排在被其覆盖的变体规则之后（特异性相同，只有源码顺序能打破平局）。

code 变体的字形换成新的 `IconBracesOutline16`：手工绘制的 `{ }`，采用图标族的 1.25 描边宽度。`IconCodeOutline16` 保留其余调用点（dock 头部动作与两个 Cordis 行）。

## Alternatives considered

**每个工具名一种色相。** 否决：调色板必须可被记住。八个族已经让相邻色相相距约 45°，深色侧接近荧光的取值撑得住，浅色侧则勉强；一个工具名一种色相会引入在滚动行上读起来相同的相邻色。

**给 skill 行单独一种色相。** 否决：那会是第九种，而且会拆散一个本就成立的族——skill 行与 context 行把同一类材料送进同一个地方。字形本身已经能区分它们。

**让未分类的 `others` 行保持中性。** 先这样发过，随后推翻：当初的理由是未分类的调用不应占用在已分类调用上有含义的色相。但在本 harness 中，这把最频繁出现的行排除在索引之外，因为 goal、RLM 与 preset 工具全都未分类。

**只给字形上色，标题保持中性。** 否决：字形只有 14px 的描边墨量，不足以让人一眼按列检索。给标题上色也正是既有 `cordis_*` 规则的做法，因此沿用它保持了一种呈现方式，而不是引入第二种。

**由各消费方覆盖 `DisclosureRow` 的颜色。** 先这样发过，随后替换：当时每一行都带着能压过该 primitive 自身 `.leading` 与 `.title` 的双 class 选择器。把回退值移进 primitive 之后，这些覆盖被删掉，接缝从一条特异性约定变成一个属性，context 行与 skill 行也因此只需增加一条声明就能加入。

**用 `</>` 尖括号作 code 字形。** 否决：`IconInspectOutline12` 已经是这个形状，并且它就作为轨迹入口渲染在同一个展开的 code 行下方。

**用 Python logo。** 否决：`code` 变体同时覆盖 `run_code` 与 `kernel`，且该标志是 PSF 商标，其几何形状缩到 14px 单色描边后无法保持。

**在 `design-platform.css` 之外另建 harness 自有的 `--dsh-flow-*` 样式表。** 否决：[ui-theme 的 README](../../../../packages/client/ui-theme/README.zh.md) 规定 token 样式表是颜色的唯一权威，新颜色须以一个 static 阶加一个语义 alias 的形式进入。再开一张样式表会白白拆分这一权威。

## Testing

`flow-accent-tokens.client.spec.ts` 读取 `design-platform.css` 并锁定该组：两套主题声明同样的八个强调色、每套主题各用不同的阶、没有两个族共用同一个阶、每个强调色都解析到该主题声明过的 static 阶、且没有任何强调色落在 red 或 amber 色阶上。`tool-row-accent-styles.client.spec.ts` 锁定每个变体到 token 的映射、ToolRow 自己上色的两处、cordis 规则位于变体规则之后，以及每条重新绑定的选择器都以 `.row` 而非 `.root` 结尾。`disclosure-row-styles.client.spec.ts` 锁定 primitive 的回退值，正是它让未设置强调色的行保持中性。三者都读 CSS 文本，因为 jsdom 不解析 cascade。

## Consequences

此后新增一个行族意味着在两个主题块各加一个 alias，再在行上加一条 `--dsh-row-accent` 声明；单边新增或复用已有阶会被 token 测试拦下，把某个变体留成中性、或把重新绑定放在会让子调用继承的位置，会被行测试拦下。调色板为此多出六种 static 色相（cyan、lime、orange、pink、violet、yellow）以及在既有色相上新增的三个阶，这是让八个可区分的族避开运行状态所占两条色阶的代价。受限的一侧是浅色主题：它的黄与青是中间调，而非深色表面所用的接近荧光的取值，因为白底上 13px 文本要满足 4.5:1 就不可能是荧光色。运行状态仍然压过族色相：失败的行在族色标题之上显示红色状态点与红色摘要。
