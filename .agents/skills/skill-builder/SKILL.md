---
name: skill-builder
description: Use when the user wants to create, improve, review, rename, or delete a DeepSeek Harness skill (a SKILL.md file), or asks how skills work. Guides the conversation from the user's goal to a saved, valid skill.
metadata:
  owner: '@deepseek-ai/dsh-skills-studio'
  version: 1
---

# Skill Builder

You help the user write skills for DeepSeek Harness. A skill is a folder holding
a `SKILL.md` file: YAML frontmatter that tells the model when the skill applies,
and a Markdown body with the instructions it then follows. Your working
directory is the user's skill folder, `~/.dsh/skills`, where every new skill
goes unless the user asks for a project one.

## Where skills live

The loader scans these folders, highest priority first. A skill whose name
appears in two folders is taken from the higher one.

| Folder | Scope |
|---|---|
| `<project>/.dsh/skills/<name>/SKILL.md` | One project (workspace) |
| `<project>/.agents/skills/<name>/SKILL.md` | One project, shared with other agents |
| `~/.dsh/skills/<name>/SKILL.md` | Every session for this user (default) |
| `~/.agents/skills/<name>/SKILL.md` | Every session, shared with other agents |

Skills are picked up without a restart: the Skills tab and new turns see a saved
file at once.

## The file

```markdown
---
name: release-notes
description: Use when the user asks for release notes, a changelog entry, or a summary of what changed between two versions. Reads the git history and drafts notes in the project's style.
---

# Release notes

1. ...
```

Rules the loader enforces (a file that breaks one is silently ignored):

- `name`: lowercase letters, digits, and single hyphens (`release-notes`), at most
  64 characters. Name the folder the same.
- `description`: required. It is the only text the model sees before choosing
  to load the skill, so lead with **when to use it** ("Use when ...") and name
  the concrete triggers, then say what it does in one sentence.
- Optional `whenToUse`: extra trigger guidance.
- Optional `user-invocable: false`: hide it from the `/name` command list.
- Optional `disable-model-invocation: true`: only the user can run it, with
  `/name` or `@skill name`; the model never loads it by itself.
- Booleans must be real YAML booleans; the camelCase spellings are rejected.

## How to work

1. Ask what the skill should achieve, when it should trigger, and one or two
   example requests, unless the user already said. Ask at most a few questions
   at a time.
2. Check `~/.dsh/skills` (and the project folders when relevant) for an
   existing skill that already covers it; offer to improve that one instead.
3. Draft the frontmatter and body in the chat, short enough to review.
4. When the user agrees, write the file with your file tools, then read it back
   and check the frontmatter against the rules above.
5. Tell the user the skill's path and how to try it: `/name` or `@skill name`
   in a new message.

## Writing a good body

- Write instructions to a capable agent, in the imperative, ordered as the
  agent will need them.
- Put the steps that are easy to get wrong first; skip what any agent already
  knows.
- Prefer concrete commands, file paths, and examples over general advice.
- Keep it under about 300 lines. Move long reference material into extra
  files beside `SKILL.md` and say when to read them.
- Never put secrets, tokens, or passwords in a skill.

## Changing or removing a skill

Edit the file in place. To rename, rename the folder and the `name` field
together. Removing a skill is better done from the Skills tab, which moves the
folder to `~/.dsh/skills-trash` instead of deleting it; if you must delete it
yourself, confirm with the user first.
