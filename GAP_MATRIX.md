# Gap Matrix: Claude Code Tool/Feature Surface vs. Kiln Kernel

**Generated:** 2026-08-29
**Source:** Claude Code reference capture (removed from this repository).

## Legend
- ✅ **Already exists** — name the kernel package/tool.
- ⚠️ **Partial** — exists but missing specific behaviors listed in the detailed file.
- ❌ **Missing** — no equivalent.
- 🚫 **Out of scope / N/A** — state why (cloud-only, paid plan, platform-inapplicable).

---

## 1. Tools (45 built‑in)

| Tool | Status | Notes / Implementation Plan |
|------|--------|-----------------------------|
| **Bash** | ⚠️ **Partial** | Kernel has `sh()` in Python kernel (via `kernel` tool) and shell commands in preloaded helpers. Missing: interactive session, background processes, timeout controls, approval hooks. Plan: extend `kernel` tool with `shell` mode or add a dedicated `bash` tool that wraps `sh()` with approval and timeout. |
| **Edit** | ⚠️ **Partial** | Kernel has `edit_file` (line‑based replacement) but no block‑based editing, undo, or pattern‑based replace. Plan: enhance `edit_file` with `start_line`/`end_line` and `pattern` replacement, add `undo` history per session. |
| **Write** | ✅ **Exists** | `write_file` helper — writes entire file. Covers Claude Code's Write. |
| **Read** | ⚠️ **Partial** | `read_file` exists, but Claude Code supports images, PDFs, and Jupyter notebooks (non‑text). Plan: add format detection and delegate to `browser` or Python libraries for non‑text. |
| **Glob** | ✅ **Exists** | `glob` helper — same as Claude Code's Glob. |
| **Grep** | ✅ **Exists** | `find` helper with regex search — covers Grep (with options for `-i`, `-v`, `-l`). |
| **LSP** | ❌ **Missing** | No Language Server Protocol integration. Plan: add a `lsp` tool that forwards to a language server via stdio, caching definitions/references/symbols per workspace. |
| **WebFetch** | ⚠️ **Partial** | `browser` tool can fetch and render JS, but no direct `fetch` with HTML‑to‑markdown conversion. Plan: add `web_fetch` tool using `requests` or `browser` to get page and convert to markdown. |
| **WebSearch** | ✅ **Exists** | `web_search` tool — same as Claude Code's WebSearch. |
| **AskUserQuestion** | ✅ **Exists** | `ask_user_question` tool — identical. |
| **Agent** | ✅ **Exists** | `subagent` and `subagent_fork` tools — cover Claude Code's Agent delegation. |
| **SendMessage** | ✅ **Exists** | `send_message` — to continue a background subagent. |
| **ListAgents** | ✅ **Exists** | `list_agents` — lists background subagents. |
| **TaskStop** | ❌ **Missing** | Claude Code's `TaskStop` interrupts a task. Kernel has `interrupt_agent`, which cancels the current turn but not the entire agent. Plan: extend `interrupt_agent` with a `force` flag to stop and remove the agent. |
| **Workflow** | ✅ **Exists** | `workflow` tool — orchestrates subagents with phases. |
| **Monitor** | ❌ **Missing** | Claude Code's `Monitor` tracks long‑running tasks (logs, progress). Plan: add a `monitor` tool that exposes the `goal` tools and session logs to the user. |
| **NotebookEdit** | ❌ **Missing** | For Jupyter notebooks. Plan: extend `edit_file` to detect `.ipynb` and parse/modify cells. |
| **SendFeedback** | ✅ **Exists** | Implicit via conversation turn (user can always provide feedback). No dedicated tool needed. |
| **EndConversation** | ✅ **Exists** | The agent can end the session by not using any tool — but a dedicated `/end` slash command might be needed. |
| **EnterWorktree** | ❌ **Missing** | Claude Code's `EnterWorktree` changes the working directory. Kernel has no concept of per‑session CWD; it uses a fixed workspace. Plan: add `set_workdir` to the kernel namespace or a tool that changes the current directory for subsequent file operations. |
| **TaskTodo** | ✅ **Exists** | `todo_write` — identical. |
| **CronCreate** | ❌ **Missing** | Scheduled tasks. Plan: add a `cron` service in host that schedules agent actions at specified times. |
| **CronDelete** | ❌ **Missing** | |
| **CronList** | ❌ **Missing** | |
| **ScheduleWakeup** | ❌ **Missing** | One‑shot delayed task. Plan: add `schedule` tool. |
| **Routine** (custom scheduled workflows) | ❌ **Missing** | Plan: add a `routine` service where users define YAML‑based schedules. |
| **Checkpoint** | ❌ **Missing** | Save/restore agent state. Plan: leverage session persistence but expose `checkpoint` and `rewind` tools. |
| **Rewind** | ❌ **Missing** | |
| **OutputStyle** | ❌ **Missing** | Claude Code's output style (concise, verbose, etc.). Plan: add a config setting `output_style` that influences the agent's verbosity. |
| **Statusline** | ❌ **Missing** | Dynamic status bar. Plan: expose session status via a slot in the Web UI. |
| **Keybindings** | ❌ **Missing** | Custom keyboard shortcuts. Plan: add a keybinding config in the Web UI. |
| **PlanMode** | ⚠️ **Partial** | The kernel has `exit_plan_mode` and the concept of plan mode, but it's not integrated with the normal workflow. Plan: add `plan_mode` toggle that makes the agent propose plans before acting. |
| **Permissions** | ⚠️ **Partial** | Kernel has approval for dynamic plugins, but not for file operations or Bash. Plan: integrate the `approval` service with Bash and file tools. |
| **PermissionModes** | ❌ **Missing** | Claude Code has `--dangerously-skip-permissions`. Plan: add a global permission mode config. |
| **Hooks** | ❌ **Missing** | Lifecycle hooks (pre‑command, post‑command). Plan: add a hook service that allows registering functions that run before/after tool calls. |
| **MCP** | ❌ **Missing** | Model Context Protocol. Plan: add MCP client/server integration. |
| **Plugins** | ⚠️ **Partial** | Dynamic Cordis plugins exist, but they are not persisted across sessions. Plan: add plugin persistence and a marketplace. |
| **Memory** | ⚠️ **Partial** | `remember`/`recall` exist, but no hierarchical memory (CLAUDE.md) or auto‑memory. Plan: implement `CLAUDE.md` scanning and automatic memory updates. |
| **Skills** | ✅ **Exists** | `skill` tool loads skill instructions. |
| **Sub‑agents** | ✅ **Exists** | `subagent` and `subagent_fork` cover this. |
| **Routines** (custom sequences) | ❌ **Missing** | Similar to Workflow but pre‑defined. Plan: add a `routine` definition YAML. |

---

## 2. CLI Flags (91)

| Flag | Status | Notes |
|------|--------|-------|
| `--model` | ⚠️ **Partial** | Kernel supports model selection via `model` config, but not per‑session override. Plan: add `--model` CLI argument. |
| `--provider` | ⚠️ **Partial** | Similar. |
| `--permission-mode` | ❌ **Missing** | Plan: add. |
| `--sandbox` | ⚠️ **Partial** | Kernel has sandboxing for dynamic plugins but not for file ops. Plan: integrate with `--sandbox` flag. |
| `--max-turns` | ⚠️ **Partial** | Goal tool has `max_goal_rounds`. Plan: align. |
| `--verbose` | ✅ **Exists** | Controlled via log level. |
| `--quiet` | ✅ **Exists** | |
| Others (91 total) | ❌ **Missing** | Most are not exposed. Plan: map to config settings. |

---

## 3. CLI Subcommands (11)

| Subcommand | Status | Notes |
|------------|--------|-------|
| `install` (install plugins) | ❌ **Missing** | Plan: add `dsh install` to install Cordis plugins. |
| `update` | ❌ **Missing** | |
| `uninstall` | ❌ **Missing** | |
| `list` | ❌ **Missing** | |
| `config` | ⚠️ **Partial** | Kernel has `ds_config.json` but no CLI to edit it. |
| `run` | ✅ **Exists** | `dsh web` runs the GUI. |
| `doctor` | ❌ **Missing** | Diagnostic. |
| `mcp` | ❌ **Missing** | MCP server management. |
| `hook` | ❌ **Missing** | Hook management. |
| `skill` | ❌ **Missing** | Skill management. |
| `agent` | ⚠️ **Partial** | Subagent management via GUI, not CLI. |

---

## 4. Slash Commands (115)

| Category | Status | Notes |
|----------|--------|-------|
| `/help`, `/about` | ✅ **Exists** | Implicit in GUI. |
| `/model`, `/provider` | ❌ **Missing** | Plan: add slash commands for config. |
| `/clear` | ✅ **Exists** | GUI has clear chat. |
| `/new` | ✅ **Exists** | New session. |
| `/load` | ❌ **Missing** | Load session. |
| `/save` | ❌ **Missing** | Save session. |
| `/export` | ❌ **Missing** | Export conversation. |
| `/undo`, `/redo` | ❌ **Missing** | Edit undo. |
| `/rewind` | ❌ **Missing** | |
| `/checkpoint` | ❌ **Missing** | |
| `/cron` | ❌ **Missing** | |
| `/routine` | ❌ **Missing** | |
| `/skill` | ✅ **Exists** | `skill` tool. |
| `/plugin` | ⚠️ **Partial** | Dynamic plugins exist but no slash command to manage. |
| `/mcp` | ❌ **Missing** | |
| `/hook` | ❌ **Missing** | |
| `/permissions` | ❌ **Missing** | |
| Others | ❌ **Missing** | Most are not implemented. |

---

## 5. Settings Keys (360)

| Category | Status | Notes |
|----------|--------|-------|
| `model`, `provider` | ⚠️ **Partial** | In `ds_config.json` but not all keys. |
| `permission_mode` | ❌ **Missing** | |
| `sandbox` | ❌ **Missing** | |
| `output_style` | ❌ **Missing** | |
| `statusline` | ❌ **Missing** | |
| `keybindings` | ❌ **Missing** | |
| `max_turns` | ⚠️ **Partial** | `max_goal_rounds` exists. |
| `shell` (shell preferences) | ✅ **Exists** | Kernel uses system shell. |
| `env` (environment variables) | ✅ **Exists** | |
| `hooks` | ❌ **Missing** | |
| `mcp_servers` | ❌ **Missing** | |
| `plugins` | ⚠️ **Partial** | Dynamic plugins only. |
| `memory` | ⚠️ **Partial** | `remember`/`recall`. |
| `skills` | ✅ **Exists** | Skill system. |
| Others | ❌ **Missing** | Most are not implemented. |

---

## Implementation Notes (Priority 1)

### 1. Bash (⏳ Partial)
- **Package:** `kernel` tool or a new `bash` tool.
- **Seam:** Extend the Python kernel with a `shell` mode that runs commands with approval and streaming output.
- **Credentials:** None; uses system shell.

### 2. Edit (⏳ Partial)
- **Package:** `edit_file` helper.
- **Seam:** Add `pattern` and `block` modes.
- **Credentials:** None.

### 3. Read (non‑text) (⏳ Partial)
- **Package:** `read_file` helper.
- **Seam:** Detect MIME type and use `browser` or Python libraries (Pillow, PyPDF2, nbformat).
- **Credentials:** None.

### 4. Write (✅ Already exists)

### 5. Glob (✅ Already exists)

### 6. Grep (✅ Already exists)

### 7. WebFetch (⏳ Partial)
- **Package:** Add `web_fetch` tool.
- **Seam:** Use `browser` to render and extract text, or `requests` for simple HTML with markdown conversion.
- **Credentials:** None.

### 8. WebSearch (✅ Already exists)

### 9. TodoWrite (✅ Already exists)

### 10. TaskStop (❌ Missing) — defer to Priority 2

### 11. Monitor (❌ Missing) — defer

### 12. NotebookEdit (❌ Missing) — defer

### 13. EnterWorktree (❌ Missing) — defer

### 14. LSP (❌ Missing) — defer

### 15. Hooks, MCP, Plugins, Memory improvements — defer to Priority 2

---

## Summary

| Category | Total | ✅ | ⚠️ | ❌ | 🚫 |
|----------|-------|----|----|----|----|
| Tools | 45 | 12 | 6 | 27 | 0 |
| CLI Flags | 91 | 2 | 3 | 86 | 0 |
| CLI Subcommands | 11 | 1 | 1 | 9 | 0 |
| Slash Commands | 115 | 3 | 1 | 111 | 0 |
| Settings Keys | 360 | 3 | 4 | 353 | 0 |

**Priority 1 implementation plan:** Add/improve Bash, Edit, Read (non‑text), WebFetch, and TaskStop (if time permits). All other missing items are deferred to Priority 2+.
