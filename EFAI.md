# DeepSeek Harness — EFAI Desktop fork

This repository is a fork of [deepseek-ai/deepseek-harness](https://github.com/deepseek-ai/deepseek-harness) built and released as a **Windows Desktop app** with the fork's plugins included. The upstream README still describes the shared core; this file describes what the fork adds and how to install it.

## Install

Download `deepseek-harness-<version>-win-x64-unsigned.exe` from the [releases page](https://github.com/eefamilyai/Deepseek-Harness-EFAI/releases) and run it. The installer is not code-signed, so Windows SmartScreen asks first: choose **More info → Run anyway**.

On first start the Desktop puts the fork's bundles on its profile, so every plugin below is active without any setup. A profile that already lists them is left as it is.

## What the fork adds

| Area | What you get |
|---|---|
| Skills tab | A sidebar page to list, write, and delete skills, with a Skill Builder chat beside the editor or in its own session. |
| Peak hours | A pill under the composer, and a dialog before a DeepSeek API message is sent at peak price: send anyway, schedule for when peak ends, or keep editing. Deferred messages queue or merge. |
| Providers | A show/hide switch on every provider card; providers and plugin switches are kept the same across profiles. |
| Sites | The `site` tool and kernel helpers publish agent-built pages at `https://<name>.dshai.reggilion.com` (needs `DESEC_TOKEN` and a GitHub login; see `packages/web/tool-sites/README.md`). |
| Kernel | A persistent Python kernel (Kiln) with file, search, vision, and real-window input helpers. |
| Profiles, Automation tasks, accounts, personalization | Profile hub, scheduled tasks, DeepSeek web-account pool, and appearance settings including window transparency. |

## Build the installer

```sh
pnpm install
pnpm run build
cd apps/desktop
pnpm run package:win:x64:unsigned
```

The installer is written to `apps/desktop/.desktop-build/targets/win-x64/unsigned-artifacts/`. Packaging needs `apps/desktop/.env.windows` (copy `.env.windows.example`; the fork's build sets `DSH_DESKTOP_APP_ID=com.eefamilyai.dsh`, `DSH_DESKTOP_AUTO_UPDATE_ENV=production`, and `DSH_DESKTOP_MANDATORY_UPDATE_PROD_ORIGIN=https://harness.deepseek.com`). On a machine where `pnpm` is the standalone executable, run the package script through a JavaScript pnpm (`node path/to/pnpm.mjs run package:win:x64:unsigned`).

## How the fork is kept apart from upstream

Fork code lives in fork-owned packages and two bundles (`packages/bundle/efai-base`, `packages/bundle/efai-web`). Edits to files upstream also owns are recorded as patches under `local-overlay/` and checked by `pnpm run verify-fork-overlay`; see `local-overlay/README.md` and `HARNESS-EDITS.md`.
