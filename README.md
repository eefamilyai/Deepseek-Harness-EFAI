# DeepSeek Harness EFAI

English | [中文](README.zh.md)

**DeepSeek Harness EFAI** is a community fork of [DeepSeek Harness](https://github.com/deepseek-ai/deepseek-harness) (`dsh`). It keeps the upstream everything-is-a-plugin architecture and adds a Python kernel, a multi-provider LLM registry, browser tools, a sidebar surface, and a notebook-edit tool.

The fork's full change contract lives in [HARNESS-EDITS.md](HARNESS-EDITS.md).

## Install

### One command

macOS or Linux:

```sh
curl -fsSL https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.sh | bash
```

Windows PowerShell:

```powershell
irm https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.ps1 | iex
```

The installer clones the fork to `~/.deepseek-harness` (Windows: `%USERPROFILE%\.deepseek-harness`), installs and builds, and adds `dsh` and `dsh-update` to `PATH`. Run the same command again to update in place.

### From source

```sh
git clone https://github.com/eefamilyai/Deepseek-Harness-EFAI.git
cd Deepseek-Harness-EFAI
pnpm install
pnpm run build
pnpm dsh web
```

`pnpm run build` prepares the repository artifacts; `pnpm dsh web` starts the Web UI.

## What this fork adds

- A Python kernel that executes code cells through the kernel tools.
- A multi-provider LLM registry with account pooling.
- A browser tool and a sidebar host bridge.
- A notebook-edit tool and RLM context read-back.

## Upstream

This fork tracks [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness). Read [HARNESS-EDITS.md](HARNESS-EDITS.md) before merging a new upstream release, so the fork's local features are not clobbered.

## License

See [LICENSE](LICENSE).
