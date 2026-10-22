Windows Desktop build of the EFAI fork of DeepSeek Harness, with every fork plugin included and turned on at first start.

## Install

1. Download `deepseek-harness-0.2.1-rc.3-win-x64-unsigned.exe` below.
2. Run it. The installer is **not code-signed**, so Windows SmartScreen asks first: choose **More info → Run anyway**.
3. On first start, sign in or add an API key. The Desktop then puts the fork's bundles on its profile, so the plugins below are active without setup.

This build uses its own app id (`com.eefamilyai.dsh`), so it installs alongside the official DeepSeek Harness. Both read profiles from `~/.dsh`; a profile that already lists the fork bundles is left as it is.

## What changed in this build

- **Kernel starts again.** The Kiln runtime was resolved inside `app.asar`, which a spawned Python cannot open, so every cell (even `tool_help()`) reported "Kernel crashed mid-run". The provider now resolves a runtime the child can read, refuses an archive path at load instead of looping, and retries a kernel that died before its first frame.
- **`browser eval` and `browser console`.** Run JavaScript in the page and read its completion value, and see console output, uncaught errors and unhandled rejections recorded since the last read. Both work on the Desktop sidebar and headless.
- **Image measurement in the kernel.** `analyze_image`, `compare_images`, `region_stats`, `luminance_rows`, `dominant_colors`, `image_diff_mask`, `preview_image` — silhouette box, per-band luminance, and changed-pixel counts, so a rendering check is a measurement instead of another screenshot to guess from.
- **`site secure`.** One call repairs HTTPS across every site: re-requests a certificate GitHub gave up on, enforces HTTPS once one is approved, and reports what each host actually serves. `site status` now says whether browsers can load the address instead of echoing the API's "approved".
- **Settings trimmed.** The Tools, Personalization and Accounts sections are no longer composed; their subjects live in Built-in plugins, General, and Models.

## What's included

- **Skills tab**: write, edit, and delete skills, with a Skill Builder chat beside the editor or in its own session.
- **Peak-hour guard**: a price pill under the composer, and a dialog before a DeepSeek API message is sent at peak.
- **Providers**: a show/hide switch on every provider card; providers and plugin switches stay the same across profiles.
- **Sites**: the `site` tool and kernel helpers publish agent-built pages at `https://<name>.dshai.reggilion.com` (needs `DESEC_TOKEN` and a GitHub login).
- **Kiln Python kernel** with file, search, vision, real-window input, and image-measurement helpers; whole-file reads and line-ending-safe writes.
- Profiles hub, Automation tasks, DeepSeek web-account pool, and the fork's tool fixes.

## Notes

- Built unsigned from commit `c44fe224e8` on `master`. Auto-update points at DeepSeek's feed, which serves the official app, so update this build from this releases page instead.
- See `EFAI.md` in the repository for how to build the installer yourself.

- Installer SHA-256: `8d2c35cef19f127d66f3984bd181777880306ddc6b5336b41fc4ada89065a816`
