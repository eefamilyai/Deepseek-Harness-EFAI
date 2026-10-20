Windows Desktop build of the EFAI fork of DeepSeek Harness, with every fork plugin included and turned on at first start.

## Install

1. Download `deepseek-harness-0.2.0-rc.2-win-x64-unsigned.exe` below.
2. Run it. The installer is **not code-signed**, so Windows SmartScreen asks first: choose **More info → Run anyway**.
3. On first start, sign in or add an API key. The Desktop then puts the fork's bundles on its profile, so the plugins below are active without setup.

This build uses its own app id (`com.eefamilyai.dsh`), so it installs alongside the official DeepSeek Harness. Both read profiles from `~/.dsh`; a profile that already lists the fork bundles is left as it is.

## What's included

- **Skills tab**: write, edit, and delete skills, with a Skill Builder chat beside the editor or in its own session.
- **Peak-hour guard**: a price pill under the composer, and a dialog before a DeepSeek API message is sent at peak: send anyway, schedule for when peak ends, or keep editing. Deferred messages can queue after or merge into the waiting one.
- **Providers**: a show/hide switch on every provider card; providers and plugin switches stay the same across profiles.
- **Sites**: the `site` tool and kernel helpers publish agent-built pages at `https://<name>.dshai.reggilion.com` (needs `DESEC_TOKEN` and a GitHub login).
- **Kiln Python kernel** with file, search, vision, and real-window input helpers; whole-file reads and line-ending-safe writes.
- Profiles hub, Automation tasks, DeepSeek web-account pool, appearance settings (including window transparency), and the fork's tool fixes.

## Notes

- Built unsigned from commit `ad29cf48e2` on `master`. Auto-update points at DeepSeek's feed, which serves the official app, so update this build from this releases page instead.
- See `EFAI.md` in the repository for how to build the installer yourself.

- Installer SHA-256: `22289a57afb91439bb4e0a290a39f074792d9e52e1fb7ad1f0a448b3f4e20f80`
