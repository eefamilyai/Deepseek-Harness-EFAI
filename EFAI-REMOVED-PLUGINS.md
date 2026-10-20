# Fork plugins switched off (and how to put them back)

The EFAI fork is being trimmed down to a small set of plugins: **focus mode**
(the focus-lock button in `@deepseek-ai/dsh-client-ui-effects`) and the
**Python kernel** (`dsh-kernel`, `dsh-kernel-python`, `dsh-tool-kernel`). This
file records each plugin that was taken out, so an AI agent (or a person) can
add it back exactly as it was.

## How removal works here

Every fork plugin is mounted by one row in a fork-owned bundle patch:

- `packages/bundle/efai-base/cordis.patch.yml` — host-side and frame-wide rows
- `packages/bundle/efai-web/cordis.patch.yml` — browser/client-only rows

Upstream never edits these files, so a plugin removed here stays removed through
upstream merges (`efai/merge_upstream.py`). Only the **row** is deleted; the
package source under `packages/` and its entry in the bundle's `package.json`
`dependencies` are kept, so the code still builds and ships with the Desktop
app and re-adding it is a one-row change.

## To add a plugin back

1. Paste its row (below) back into the `- insert:` list of the named bundle
   patch, at the position given. Keep the two-space-plus-dash indentation of the
   neighbouring rows.
2. If its package was also dropped from that bundle's `package.json`
   `dependencies`, add it back as `"<package name>": "workspace:*"` and run
   `pnpm install`.
3. Rebuild and repackage (see `EFAI.md` → "Build the installer"), then install.
4. Restore its line in the `EFAI.md` "What the fork adds" table.

Existing profiles need no edit: they list the bundles, not the rows.

---

## Removed 2026-10-20

### Profiles tab — `profile-hub`

- **Package:** `@deepseek-ai/dsh-profile-hub` (`packages/boot/profile-hub`)
- **Bundle:** `packages/bundle/efai-base/cordis.patch.yml`
- **Position:** after the `web-access` row, before `session-recovery-context`
- **What it did:** the frame-wide Profiles page (sidebar icon `ProfilesPanelIcon`,
  `ProfilesPanel`, and the `profile-hub.landing` startup page) listing the
  profiles under `~/.dsh/profiles`, creating new ones, and launching a second
  host for a profile other than the running one. It provides the `profileHub`
  service.
- **Still in place without it:** the Desktop still starts the profile named in
  `~/.dsh/profile-hub.json` (`apps/desktop/src/paths.ts` reads that file
  directly), and `profile-sync` keeps providers and plugin switches the same
  across profiles. Without the tab, switching profile means editing the
  `launcher` value in `~/.dsh/profile-hub.json` and restarting.
- **Row to restore:**

```yaml
    # The profiles on this machine, and the launch of a second host for one
    # other than the running profile. A host serves exactly one profile, so
    # entering a different one means starting it; this service owns that child.
    - id: profile-hub
      name: '@deepseek-ai/dsh-profile-hub'
```

- **Also restore** the closing comment at the end of the `- insert:` list in
  `packages/bundle/efai-web/cordis.patch.yml`:

```yaml
    # The `profileHub` service and its frame-wide profiles page are mounted by
    # `dsh-efai-base`, for the same single-row-id reason as the account pool
    # above.
```

### Skills tab — `skills-studio`

- **Package:** `@deepseek-ai/dsh-skills-studio` (`packages/skill/skills-studio`)
- **Bundle:** `packages/bundle/efai-base/cordis.patch.yml`
- **Position:** after the `peak-send` row, before `tool-sites`
- **What it did:** a Skills page in the sidebar after Automation tasks
  (`SkillsPanelIcon`, `SkillsPage`) to list, write and delete skills in the
  folders the skill loader scans, with an embedded Skill Builder chat
  (`BuilderConversation`) beside the editor or in its own session.
- **Still in place without it:** skills themselves still load and run (upstream
  skill loader), the `@skill` picker (`ui-skill-mention`) and `skill-injection`
  are separate rows and stay mounted. Skills are edited as files instead.
- **Row to restore:**

```yaml
    # The Skills tab: list, write, and remove skills in the folders the skill
    # loader scans, with an embedded Skill Builder chat. Both halves load from
    # this row; the page sits in the sidebar after Automation tasks.
    - id: skills-studio
      name: '@deepseek-ai/dsh-skills-studio'
```

- **`EFAI.md` table line to restore:**

```markdown
| Skills tab | A sidebar page to list, write, and delete skills, with a Skill Builder chat beside the editor or in its own session. |
```
