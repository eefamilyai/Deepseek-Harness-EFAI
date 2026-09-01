# Agent Note：真实 API e2e job 在无密钥仓库中跳过而非失败

Status: implemented

[English](2026-09-01-e2e-skips-without-key.md) | 中文

## Problem

[.github/workflows/e2e.yml](../../../../.github/workflows/e2e.yml) 此前运行的 preflight 会把缺失的 `DEEPSEEK_API_KEY_EXTERNAL` 转化为 `exit 1`，使自跳过的套件永远不会报告虚假的绿色（[最初的决策](2026-06-19-real-api-e2e-ci.md)）。该守卫假定运行此工作流的每个仓库都持有该 secret。而不持有它的部署——镜像、下游副本、拥有者尚未配置 Actions secret 的仓库——会得到一个在每次推送和每个夜间运行中永远失败的 job，且失败原因不是任何提交能修复的。长期飘红的检查会训练读者忽略它，其损失的信号比该守卫所防范的虚假绿色更多。

## Decision

`preflight` job 读取 secret 并将 `key-present` 作为 job 输出发布；`e2e` job 声明 `needs: preflight` 与 `if: needs.preflight.outputs.key-present == 'true'`。在已配置 secret 的情况下，一切照旧：同样的可信事件会构建工作区并对 `https://api.deepseek.com` 运行 `pnpm run test:e2e`。在未配置的情况下，`e2e` 根本不会启动，而 preflight 会写出一条 `::notice::` 注解以及一段运行摘要，指明该 secret 及其配置位置。

该决策之所以拆成两个 job，是因为 job 级 `if:` 无法读取 `secrets` 上下文。在一个不检出代码的 job 中作判断，也意味着无密钥仓库不会把 runner 时间花在 checkout、install 或提权套件所需的 bubblewrap 配置上。

不可信 PR 的规则未变，现在落在 `preflight` 上：fork 和 Dependabot PR 按构造即无密钥，会跳过整个工作流。由于 `e2e` 依据的是输出而非事件，被跳过的 `preflight` 会留下空输出，`e2e` 也随之跳过——一个条件同时覆盖不可信与未配置两种情形。

## Alternatives considered

**保留硬失败。** 对持有该 secret 的仓库而言这是更强的守卫，[最初的记录](2026-06-19-real-api-e2e-ci.md)也写明了原因：被删除或重命名的 secret 会静默禁用整张真实 API 安全网。它在此落选，仅仅是因为它产生的失败与真实故障无法区分，而一个因 diff 之外的原因飘红的检查最终不再被阅读。依赖此 job 获取覆盖的仓库应当留意跳过通知，它现在是「没有真实 API 测试运行过」的唯一信号。

**在单个 job 内对步骤加门禁。** 活动部件更少，但除非 preflight 先运行，最早被加门禁的步骤上的 `if:` 就得读取 preflight 步骤尚未产生的输出，而且每新增一个步骤都要重复同一条件。job 边界只需在 GitHub 本就求值的位置陈述一次该条件。

**去掉定时触发，只保留 `workflow_dispatch`。** 这能在不触碰 preflight 的前提下终止反复飘红，但也终止了持有该 secret 的仓库的夜间覆盖——为修复一个呈现问题而交出一个真实信号。

**在套件层面检测密钥。** `test:e2e` 本就在无密钥时自跳过；让它自行处理并删除 preflight 是最小的改动。但它会报告一个什么都没跑的*通过* job，而这正是最初记录所拒绝的虚假绿色，并且要浪费一整轮 install 与 build 才抵达零断言。

## Consequences

未配置 secret 的仓库会得到一个绿色的、被跳过的 job 和一行运行摘要，其无密钥门禁仍是该提交上的唯一信号。已配置 secret 的仓库保持既有行为，代价是每次运行多出一个短命 job。针对 secret 消失的守卫，从一个失败的检查弱化为一条需要读者主动查看的通知；任何把此工作流当作真实 API 安全网的人，都应当核实 `e2e` job 确实运行过，而不是信任工作流的总体结论。
