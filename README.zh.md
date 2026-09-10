# DeepSeek Harness EFAI

<!-- DSH-FORK(brand): fork edit on an upstream-owned file. EXIT: the fork's product identity line moves to a prompt section. -->

[English](README.md) | 中文

**DeepSeek Harness EFAI** 是 [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness)（`dsh`）的社区分支。它保留上游“一切皆插件”的架构，并新增 Python 内核、多提供商 LLM 注册表、浏览器工具、侧边栏桥接，以及笔记本编辑工具。

本分支的完整改动契约见 [HARNESS-EDITS.md](HARNESS-EDITS.md)。

## 安装

### 一条命令

macOS 或 Linux：

```sh
curl -fsSL https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.sh | bash
```

Windows PowerShell：

```powershell
irm https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.ps1 | iex
```

安装程序会把分支克隆到 `~/.deepseek-harness`（Windows 为 `%USERPROFILE%\.deepseek-harness`），完成安装与构建，并把 `dsh` 和 `dsh-update` 加入 `PATH`。再次运行同一命令即可原地更新。

### 从源码构建

```sh
git clone https://github.com/eefamilyai/Deepseek-Harness-EFAI.git
cd Deepseek-Harness-EFAI
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` 准备仓库产物；`pnpm dsh web` 启动 Web UI。

## 启动服务器

Windows：

```powershell
.\start.cmd
```

macOS 或 Linux：

```sh
./start.sh
```

启动脚本会准备内置 Python 运行时、安装依赖、在需要时先构建，然后启动 Web UI，默认地址为 `http://127.0.0.1:3080`。传入 `--port 3100` 可更换端口，传入 `--build` 可强制重新构建。

通过一条命令安装后，改运行 `dsh web`；加上 `--port 3100` 可更换端口。

## 本分支新增内容

- 通过内核工具执行代码单元的 Python 内核。
- 带账户池化的多提供商 LLM 注册表。
- 浏览器工具与侧边栏主机桥接。
- 笔记本编辑工具与 RLM 上下文回读。

## 上游

本分支跟踪 [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness)。合并新的上游版本前，请先阅读 [HARNESS-EDITS.md](HARNESS-EDITS.md)，以免覆盖本分支的本地功能。

## 引用

```bibtex
@misc{deepseek-harness2026,
  title={DeepSeek Harness: Everything is a Plugin},
  author={DeepSeek-AI},
  year={2026},
  publisher={GitHub},
  howpublished={\url{https://github.com/deepseek-ai/deepseek-harness}},
}
```

## 许可证

见 [LICENSE](LICENSE)。
