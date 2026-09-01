# DeepSeek Harness

English | [中文](README.zh.md)

DeepSeek Harness (`dsh`) is an open-source agent harness developed by [DeepSeek AI](https://deepseek.com).

It uses an architecture where **everything is a plugin**, and is powered by [Cordis](https://github.com/cordiverse/cordis), whose design is described in [_A Programming Paradigm for Spatiotemporal Composability_](https://github.com/cordiverse/paper).

## Developer preview

DeepSeek Harness is currently in _developer preview_ and is iterating rapidly. **THERE WILL BE COMPATIBILITY-BREAKING CHANGES.**

## Run

### Install once, run anywhere

This fork is not published to npm, so `npx` cannot reach it. Instead, one command installs it and puts `dsh` on your PATH:

```sh
curl -fsSL https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.sh | bash
```

On Windows, in PowerShell:

```powershell
irm https://raw.githubusercontent.com/eefamilyai/Deepseek-Harness-EFAI/master/install.ps1 | iex
```

The installer clones the repository to `~/.deepseek-harness`, installs dependencies, builds, provisions the bundled Python runtime, and writes a `dsh` launcher to `~/.local/bin` (`%LOCALAPPDATA%\dsh\bin` on Windows). After it finishes, `dsh web` works from any directory, and the kernel starts in whatever directory you launched it from.

Run `dsh-update` to pull the latest revision and rebuild. Re-running the installer does the same thing. Set `DSH_INSTALL_DIR` or `DSH_BIN_DIR` to move either location; `$DSH_HOME` (`~/.dsh`), where your settings and presets live, is never touched by an install or an update.

### Run from `npm`

Install `Node.js`, then run:

```sh
npx @deepseek-ai/dsh web
```

The command starts the Web UI, served at `http://127.0.0.1:3080` by default. See [Web UI guide](docs/user/guide/index.md).

### Run from source

To run from a repository checkout:

```sh
git clone https://github.com/deepseek-ai/deepseek-harness.git
cd deepseek-harness
pnpm install
pnpm run build
pnpm dsh web
```

## Community and support

- Feel free to submit feedback or bug reports through [GitHub Discussions](https://github.com/deepseek-ai/deepseek-harness/discussions).
- Add the [`dsh-plugin`](https://github.com/topics/dsh-plugin) topic to your plugin repository for discoverability.
- Join <a href="https://discord.gg/Ycq5dCaS4">DeepSeek Harness Discord community</a>.

## Contributing

See [CONTRIBUTING.md](CONTRIBUTING.md).

## Development

Start with the [development guide](docs/development.md) and [architecture documentation](docs/architecture.md).

For agents, follow [AGENTS.md](AGENTS.md).

## License

[MIT](LICENSE)

Third-party dependencies and their licenses are disclosed in [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
