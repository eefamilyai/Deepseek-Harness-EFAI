---
description: "Skills tab: list, write, and remove skills in the folders the skill loader scans, with a Skill Builder chat that helps author them."
kind: "package-reference"
---

# @deepseek-ai/dsh-skills-studio

## Summary

Adds a **Skills** entry to the sidebar, after Automation tasks. The page lists every skill the skill loader sees, grouped by folder, and edits one at a time: name, description, invocation switches, and the Markdown instructions. A broken file shows the reason the loader ignores it.

The **Skill Builder** writes skills with you in a chat, beside the editor or as a session of its own. Both start in the user's skill folder with `@skill skill-builder ` in the composer.

## Table of Contents

- [Use this package](#use-this-package)
- [Folders](#folders)
- [The Skill Builder](#the-skill-builder)
- [The `skillsStudio` namespace](#the-skillsstudio-namespace)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`packages/bundle/efai-base` mounts it. One row loads both halves: the Host service and the Skills page.

```yaml
- id: skills-studio
  name: '@deepseek-ai/dsh-skills-studio'
```

<a id="folders"></a>
## Folders

The page follows `@deepseek-ai/dsh-skill-filesystem`: the same folders, in the same order of precedence.

| Folder | Group label | Writable |
|---|---|---|
| `<workspace>/.dsh/skills` | Project · .dsh/skills | yes |
| `<workspace>/.agents/skills` | Project · .agents/skills | yes |
| `~/.dsh/skills` (or `$DSH_HOME/skills`) | My skills | yes; the default for new skills |
| `~/.agents/skills` (or `$DSH_AGENTS_HOME/skills`) | Shared | yes |
| `$DSH_BUNDLED_SKILL_DIR` | Bundled | no; **Copy to my skills** makes an editable copy |

A skill whose name a higher folder also uses is tagged as overridden. The loader watches these folders, so a saved skill reaches the next turn without a restart. While the Skill Builder is open, the list re-reads the folders every four seconds to show the skills it writes.

A skill is saved as `<folder>/<name>/SKILL.md`. Renaming a skill renames its folder. Every frontmatter key the page does not edit is kept as it was, comments included. **Delete** moves the folder to `~/.dsh/skills-trash/<name>-<time>` instead of deleting it. A folder on another volume, such as a junctioned `~/.dsh/skills`, is copied and then removed.

<a id="the-skill-builder"></a>
## The Skill Builder

The service installs `skill-builder` in `~/.dsh/skills`. That skill tells the agent where skills live, what the loader requires, and how to take the user from a goal to a saved, valid skill. The installed file carries `metadata.owner: '@deepseek-ai/dsh-skills-studio'` and a version. A newer package replaces its own older copy. A copy without that owner, which the user has taken over, is never overwritten.

Builder Sessions belong to a Workspace for the skill folder. That Workspace appears in the sidebar and groups the builder's chats. A Session outside every Workspace opens on the workspace chooser with its composer locked. The page remembers its embedded chat in browser storage, so the next visit reopens it; **New chat** starts another.

<a id="the-skillsstudio-namespace"></a>
## The `skillsStudio` namespace

| Method | Contract |
|---|---|
| `listSkills(projects)` | The folders for the given workspace paths and the skills in them. |
| `readSkill(file)` | One `SKILL.md` as fields, body, writability, and the loader's problem with it, if any. |
| `saveSkill(request)` | Creates `<root>/<name>/SKILL.md`, or updates a file and renames its folder when the name changed. |
| `trashSkill(file)` | Moves a skill folder to the trash and returns where it went. |
| `startBuilder()` | Installs or refreshes `skill-builder`, and returns the builder's folder and first draft. |

Every path a request names must be a `SKILL.md` one folder below a known root. A project root is known once `listSkills` has named its workspace. A refusal is a `RemoteError` with code `skillsStudio/rejected` and the path in `details`. The method names avoid `remove` and similar words, because the browser-side namespace service already has members with those names.

No runtime invariant companion is published: the service keeps no state beyond the project folders it was shown. Each answer is read from disk in the same call, and the package spec covers each method against temporary folders.

## Model Experience

### Skills saved from the page

#### What the model sees

A saved skill's name and description enter the skill catalog of later turns, and its body is loaded when the skill is invoked, exactly as for a `SKILL.md` written by hand. The page itself sends nothing to a model.

#### Token effect

Each skill adds its name and description to the catalog while it is model-invocable; a skill with `disable-model-invocation: true` adds nothing until a user runs it.

#### KV Cache effect

Saving, renaming, or removing a skill changes the catalog text of later requests, which changes their prefix from that point; past turns are unchanged.

### The Skill Builder's first message

#### What the model sees

The builder's composer starts with `@skill skill-builder `, so its first message loads the body of the installed `skill-builder` skill into that turn, as `/skill-builder` would.

#### Token effect

The first turn carries the builder skill's body, a few hundred words. Later turns carry it only through history.

#### KV Cache effect

The skill body appends with the first message; it does not alter the system prompt or earlier history.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The editor shows the Markdown source; it has no preview.
- Files beside `SKILL.md` (scripts, references) are not listed; the Skill Builder can create and edit them.
- Project folders are listed only for registered workspaces.
