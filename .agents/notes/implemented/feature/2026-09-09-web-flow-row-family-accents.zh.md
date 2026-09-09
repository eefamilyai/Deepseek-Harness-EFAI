# Agent Note: Flow-row family accents

Status: implemented

[English](2026-09-09-web-flow-row-family-accents.md) | 中文

## Problem

会话中的每一行紧凑流内行——think 折叠行与每次工具调用——的前导字形、标题与分隔点都取自同样三个中性 label token。滚动后的会话就是一列完全相同的灰色行，要找到最近一次 Python 调用或最近一次文件编辑，只能逐行读标题。唯一的例外是 `cordis_*` 覆盖规则：它证明了这种呈现有效，但只覆盖一个扩展族。code 行的字形让这列中性行更糟：`IconCodeOutline16` 是一个井号字形，读起来像 hashtag 而不像程序，而它标注的那一行标题正是 `Python`。

## Decision

`design-platform.css` 声明 `--dsw-alias-flow-*` alias 组，为每类行族各配一种色相：`think` 紫、`search` 蓝、`read` 青、`mutate` 绿（write 与 edit，二者本就共用一个图标）、`shell` 橙、`code` 黄。每个族在两套主题下解析不同的 static 阶——浅色表面取较深的阶，深色表面取较浅的阶——因此两者对该主题的 `--dsw-alias-bg-base` 均达到 4.5:1。该组刻意置于 `--dsw-alias-state-*` 之外，并完全避开 red 与 amber 色阶：`ToolRow` 在调用失败或中断时会把前导字形换成红色或琥珀色 `StateDot`，因此取自这两条色阶的族强调色会被读成运行状态。

`ToolRow` 按 `data-variant` 绑定一个 `--dsh-row-accent`，并将其应用到前导字形、标题、hover／展开时的 chevron 与分隔点；摘要保持中性 tertiary 色调，因为它是该行的内容而非种类。`ReasoningRow` 把 think 强调色应用到同样这四处。`others` 变体不设强调色，落回中性 label token——未分类的调用不应占用在已分类调用上有含义的色相——而 `cordis_*` 规则现在改为把 `--dsh-row-accent` 重新绑定到产品强调色，而不是重复写三处颜色；这要求它排在被其覆盖的变体规则之后（两者都是一个 class 加一个属性，只有源码顺序能打破平局）。

code 变体的字形换成新的 `IconBracesOutline16`：手工绘制的 `{ }`，采用图标族的 1.25 描边宽度。`IconCodeOutline16` 保留其余调用点（dock 头部动作与两个 Cordis 行）。

## Alternatives considered

**每个工具名一种色相。** 否决：调色板必须可被记住。覆盖全部已分类变体的六个族在 13px 下仍可区分；九到十种色相会引入在滚动行上读起来相同的相邻色，而 `search` 与 `read` 分成两种色相并不能带来其图标尚未提供的信息。

**只给字形上色，标题保持中性。** 否决：字形只有 14px 的描边墨量，不足以让人一眼按列检索。给标题上色也正是既有 `cordis_*` 规则的做法，因此沿用它保持了一种呈现方式，而不是引入第二种。

**用 `</>` 尖括号作 code 字形。** 否决：`IconInspectOutline12` 已经是这个形状，并且它就作为轨迹入口渲染在同一个展开的 code 行下方。

**用 Python logo。** 否决：`code` 变体同时覆盖 `run_code` 与 `kernel`，且该标志是 PSF 商标，其几何形状缩到 14px 单色描边后无法保持。

**在 `design-platform.css` 之外另建 harness 自有的 `--dsh-flow-*` 样式表。** 否决：[ui-theme 的 README](../../../../packages/client/ui-theme/README.zh.md) 规定 token 样式表是颜色的唯一权威，新颜色须以一个 static 阶加一个语义 alias 的形式进入。再开一张样式表会白白拆分这一权威。

## Testing

`flow-accent-tokens.client.spec.ts` 读取 `design-platform.css` 并锁定该组：两套主题声明同样的六个强调色、每套主题各用不同的阶、每个强调色都解析到该主题声明过的 static 阶、且没有任何强调色落在 red 或 amber 色阶上。`tool-row-accent-styles.client.spec.ts` 锁定变体到 token 的映射（含 `others` 的缺席）、强调色触及的四处，以及 cordis 规则位于变体规则之后。两者都读 CSS 文本，因为 jsdom 不解析 cascade。

## Consequences

此后新增一个行族意味着在两个主题块各加一个 alias，再加一条 `--dsh-row-accent` 规则；单边新增会被 token 测试拦下，把已分类变体留成中性会被行测试拦下。调色板为此多出四种 static 色相（cyan、orange、violet、yellow）与一个 green 阶，这是让整组避开运行状态所占两条色阶的代价。运行状态仍然压过族色相：失败的行在族色标题之上显示红色状态点与红色摘要。
