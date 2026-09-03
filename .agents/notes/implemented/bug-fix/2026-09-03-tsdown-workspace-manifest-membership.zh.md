# Agent Note: tsdown 工作区成员是包含包清单的目录

Status: implemented

[English](2026-09-03-tsdown-workspace-manifest-membership.md) | 中文

## 问题

`tsdown.config.ts` 曾把 `vendor/*`、`packages/*/*` 和 `apps/cli` 作为工作区模式直接交给 tsdown。tsdown 以 `onlyDirectories` 匹配这些模式且不检查包清单，因此 `packages/` 下两层的每个目录都会成为构建目标；随后它按最近的上层 package.json 为每个目标命名——对于没有包清单的目录，那就是仓库根。

删除一个包会在所有已有检出中留下它的 `lib/` 与 `node_modules/`，因为 git 只删除被跟踪的文件而保留生成物。因此，在含有该包的分支与不含该包的分支之间切换，会遗留下已不再是包的目录；本仓库的一对分支就会遗留四十个。一旦这样的目录不再含有 `lib/types/{index,invariant,startup}.js`，整个构建就会以 `[@deepseek-ai/dsh-root] Cannot find entry` 失败：该报错指向仓库根而非出问题的目录，且完全不给出路径。

## 决策

`tsdown.config.ts` 自行在文件系统上展开 `WORKSPACE_PATTERNS`，只保留含有 package.json 的目录。`*` 段匹配子目录，其余各段按字面匹配，足以覆盖构建声明的这三个模式；tsdown 收到的是解析后的仓库相对路径，而不是模式本身。

于是遗留的构建产物不再是构建目标，而真正缺失的入口现在会以其所属包的名字报出。

## 备选方案

**依赖 `pnpm run clean`。** 作为修复手段被否决：它只能在失败之后修复单个检出，而下一次跨越包删除的分支切换又会重现该状况。它仍然是回收这些遗留目录本身的方式。

**按名字排除这些陈旧目录。** 被否决，因为该集合随每次包删除而变化，且名单会退化为"哪些目录是包"的第二个事实来源。

**等待 tsdown 强制要求包清单。** 被否决，因为构建必须在当下所有已有检出上可用，而模式列表本就由该配置持有，过滤理应放在这里。

## 影响

- `packages/` 下没有 package.json 的目录不参与构建，无论其中有什么内容。
- 新增包仍然只需要它的 package.json；成员身份由文件系统发现，而非逐条列举。
- 该配置在加载时读取文件系统，并以 `import.meta.dirname` 而非进程工作目录为基准解析。
- 真实包缺失 `lib/types` 入口仍会使构建失败，只是现在会以该包的名字报出。

## 测试

`tsdown.config.ts` 位于仓库的 TypeScript 程序与 oxlint 路径之外，因此本次改动没有自动化闸门；验证在构建产物与源码一致的工作树上手工完成。删除某个遗留目录的 `lib/` 精确重现了 `[@deepseek-ai/dsh-root] Cannot find entry`；加入包清单过滤后，同一工作树通过配置解析进入 `Build start`，解析出 244 个包且未提及该遗留目录。独立运行的 `tsc --strict` 接受该文件。
