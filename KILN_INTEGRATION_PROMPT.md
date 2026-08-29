# Task: Integrate the full Claude Code tool/feature surface into the Kiln kernel

You are working in the DeepSeek Harness ("Kiln kernel") checkout at `D:\deepseek-kernel-harness`. Your job is to close the gap between what the Kiln kernel agent-loop can do and the complete, current Claude Code tool/feature surface, as captured in the reference files already on disk.

## Source of truth (already downloaded, do not re-fetch the web)
- `CLAUDE_CODE_REFERENCE.md` — full inventory: 45 built-in tools, 91 CLI flags, 11 CLI subcommands, 115 slash commands, 360 settings keys.
- `CLAUDE_CODE_TOOLS_DETAILED.md` — each of the 45 tools with its description plus the 14 deep behavior sections (Bash, Edit, Write, Read, Glob, Grep, LSP, WebFetch, WebSearch, Agent, AskUserQuestion, Monitor, NotebookEdit, SendFeedback, EndConversation, EnterWorktree).
- `.claude_code_docs/` — 43 raw reference pages (tools-reference, cli-reference, interactive-mode, settings-reference, skills, sub-agents, hooks, mcp, plugins, memory, workflows, permissions, permission-modes, routines, scheduled-tasks, checkpointing, output-styles, statusline, keybindings, model-config, env-vars, etc.) plus `llms.txt` (the 191-page index).

Use these files as the authoritative functional specification. Never invent features; where a Claude Code feature has no documented behavior beyond its name, mark it "name-only / needs spec" rather than guessing.

## First: map the existing kernel (do this before writing code)
1. Discover the current tool registry, capability seams, and agent-loop. Start from the docs the checkout ships: `docs/capability-seams.md`, `docs/subsystems/`, `AGENTS.md`, and the `packages/` layout. Identify the equivalents the kernel already has (e.g. its `web_search`/`web_fetch`, kernel/bash/file tools, subagents, skills, hooks, MCP).
2. Produce a one-page gap matrix: for every one of the 45 tools and every feature surface (skills, subagents, hooks, MCP, plugins, memory, workflows, permissions, permissions-modes, routines, scheduled tasks, checkpointing, output styles, statusline, keybindings), classify it as one of:
   - **already exists** (name the existing package/tool),
   - **partial** (exists but missing specific behaviors listed in the detailed file),
   - **missing** (no equivalent),
   - **out of scope / N/A on this platform** (state why, e.g. cloud-only, requires a paid claude.ai plan, or provider-inapplicable).
3. For each "missing" or "partial" item, write a short implementation note: which package it belongs in, the minimal seam it touches, and any config/credential it needs.

## Then: implement, in priority order
Work in small, reviewable, tested increments. Do NOT try to land all 45 tools at once.

Priority 1 — highest value, lowest risk:
- Tools with clear kernel equivalents that are missing or stubbed: `Glob`, `Grep`, `Read` (non-text: images/PDF/notebook), `Write`, `Edit`, `Bash`, `PowerShell` (on Windows), `WebFetch`, `WebSearch`, `Task*`/`TodoWrite` task tracking.
- Settings keys from `settings-reference.md` that map 1:1 to existing kernel config (env, model, permissions, shell, sandbox, output format).

Priority 2 — orchestration & extension:
- `Agent`, `SendMessage`, `ListAgents`, `TaskStop` (subagent lifecycle), `Workflow`.
- Skills, subagents, hooks, MCP, plugins, memory (CLAUDE.md hierarchy + auto memory).

Priority 3 — schedules & long-running:
- `CronCreate`/`CronDelete`/`CronList`, `ScheduleWakeup`, `Monitor`, routines, scheduled tasks, checkpointing, `/rewind`.

Priority 4 — surface polish & parity:
- Slash commands (`/` command palette) and CLI flags that the kernel CLI/Web UI do not yet expose; output styles; statusline; keybindings; plan mode.

For anything out of scope, leave a one-line `// not in scope:` comment in the gap matrix, not a stub implementation.

## Hard constraints
- Danger-full-access sandbox: you may edit files freely, but every change must be justified by a reference-file entry and pass the repo's existing checks.
- Follow the repo's own conventions (AGENTS.md, docs standards, the capability-seam pattern). Consult the `dsh-*` skills in this session only if they are relevant (e.g. `dsh-code-review`, `dsh-doc-standards`) — do not load them otherwise.
- Keep the kernel's existing architecture: a "tool" here is a capability seam, not a one-off. New tools must register through the same registry/consumer pattern the kernel already uses for web tools.
- Never delete or downgrade an existing working tool to add a new one. Where Claude Code and the existing kernel differ semantically, preserve the kernel's behavior and note the divergence.
- Web-facing credential boundaries stay intact: anything calling DeepSeek/Anthropic-provided backends must keep resolving secrets through the existing credentials seam, not process env fallback.

## Deliverables
1. `GAP_MATRIX.md` at the repo root — the full 45-tool + feature-surface classification with implementation notes.
2. Implemented, tested changes for at least Priority 1, each as a focused change with a short note explaining which reference-file entry it satisfies.
3. A final summary: what shipped, what is deliberately deferred, and any "name-only / needs spec" items that require a human decision.

Do not start a server. Do not touch the running Web GUI. Use `pwd`; never infer the working directory from the checkout path.
