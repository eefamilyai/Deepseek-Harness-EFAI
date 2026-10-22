# Settings redundancy removal (2026-10-21)

Instruction: remove everything redundant in Settings, deleting the entries the
fork added rather than editing upstream packages.

## What the Settings nav actually contained

Read from a running Desktop window (test instance, CDP), not from source:

```
General · Models · Built-in plugins · Agent presets · Tools · Personalization · Accounts
 (0)       (10)     (15)                 (20)              (25)    (26)            (30)
```

The first four are upstream (`ui-settings-general`, `ui-settings-models`,
`ui-settings-plugins`, `ui-agent-preset`). The last three are fork packages
(`ui-settings-tools`, `ui-personalization`, `ui-settings-accounts`), mounted by
`packages/bundle/efai-web/cordis.patch.yml`.

## Why those three are the redundant ones

Panel contents were read from the same window:

| Fork section | What it showed | Upstream section that already owns it |
| --- | --- | --- |
| Tools | conventional-tool switch, kernel switch, then **36 per-tool switches** | Built-in plugins lists every composed row with its enable/disable switch |
| Personalization | fonts, **font size**, line spacing, accent, width, corner scale, scrollbars | General already has **Appearance** (light/dark/system) and **Font size** |
| Accounts | add a DeepSeek web login | Models owns provider sign-in and the "Shown in the model picker" list |

So each fork section was a second place to set something an upstream section
already exposes.

## What changed

1. **Source** — `packages/bundle/efai-web/cordis.patch.yml`: the `ui-settings-tools`,
   `ui-personalization`, and `ui-settings-accounts` rows are gone, replaced by one
   comment saying why and how to restore them. YAML still parses (2 top-level
   entries). No other bundle or profile mounted these rows.
2. **Live profile** — `~/.dsh/profiles/general/cordis.patch.yml` disables the same
   three row ids. The installed Desktop app composes bundles from its package,
   not from this checkout, so the source change alone would not have reached the
   app the operator is running. Backup: `cordis.patch.yml.bak-settings-cleanup`.

The packages themselves are untouched: they remain installed and declared in the
bundle's `dependencies`, simply unmounted. Removing the dependency entries means
regenerating `pnpm-lock.yaml`, which is a separate step.

## Verification

A fresh test instance was cloned from the updated profile and driven over CDP:

- Settings nav reads `Settings / General / Models / Built-in plugins / Agent
  presets / Open configuration file` — none of the three fork sections.
- General still renders with `Appearance` and `Font size` intact, which is what
  made the removed Personalization section redundant.
- No `failed to load` or `Plugin failed` text anywhere in the window.

## Consequences to be aware of

- **Appearance engine.** `ui-personalization` is also the engine that applies
  token overrides, so custom fonts, accent, corner scale, widths, and
  transparency stop applying and the theme defaults return. The saved values stay
  in that row's config; re-enabling the row restores them.
- **Web logins.** The Accounts section was the only UI for adding a DeepSeek web
  login (`ds_config.json` by hand was the alternative). Models still carries
  sign-in. Re-enable `ui-settings-accounts` if that UI is needed again.
- **Restart.** The profile patch is read at boot; HMR watches it, so the change
  may apply to the running window without a restart, and certainly after one.
