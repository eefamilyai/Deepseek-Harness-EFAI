# Claude Code — Built-in Tools, Detailed

Source: https://code.claude.com/docs/en/tools-reference (fetched 2026-08-29)

## Agent

Spawns a subagent with its own context window to handle a task. With agent teams enabled, a call that carries a name can launch a teammate instead. See Agent tool behavior

The Agent tool spawns a subagent in a separate context window. The subagent works through its task autonomously, then returns a single text result to the parent conversation. The parent doesn't see the subagent's intermediate tool calls or outputs, only that final result. With [agent teams](/docs/en/agent-teams) enabled, a call that carries a `name` can launch a [teammate](/docs/en/agent-teams#how-claude-starts-agent-teams) instead, which reports back through team messages rather than by returning a result.

To cap how many turns a subagent runs, set `maxTurns` in the [subagent definition](/docs/en/sub-agents#supported-frontmatter-fields). When the subagent reaches the limit, Claude Code marks the returned result as partial output, and Claude can [resume the subagent](/docs/en/sub-agents#resume-subagents) to continue.

The same Agent tool also launches [forked subagents](/docs/en/sub-agents#fork-the-current-conversation) wherever [fork mode](/docs/en/sub-agents#turn-fork-mode-on-or-off) is on. A fork inherits the full parent conversation instead of starting fresh, runs in the background apart from the [cases that stay in the foreground](/docs/en/sub-agents#run-subagents-in-foreground-or-background), and still surfaces permission prompts in your terminal. The rest of this section describes non-fork subagents.

Which tools a non-fork subagent can use depends on the `tools` and `disallowedTools` fields in the [subagent definition](/docs/en/sub-agents):

* **Neither field set**: the subagent inherits every [tool available to subagents](/docs/en/sub-agents#available-tools).
* **`tools` only**: the subagent gets only the listed tools.
* **`disallowedTools` only**: the subagent gets every parent tool except the listed ones.
* **Both set**: `disallowedTools` takes precedence. A tool listed in both is removed.

In every case, the resolved set is limited to the [tools available to subagents](/docs/en/sub-agents#available-tools): a tool that isn't available to subagents is never granted, even when listed in `tools`.

If every entry in a subagent's `tools` list fails to match a usable tool, the Agent tool usually returns an error naming the entries instead of launching the subagent; see [Agent would be spawned with zero tools](/docs/en/errors#agent-would-be-spawned-with-zero-tools) for the message and how to fix each entry.

Launching the subagent doesn't itself prompt for permission. Claude Code checks the subagent's own tool calls against your permission rules as it runs.

Where you see a subagent's permission prompts depends on whether it runs in the foreground or the background. Claude Code runs subagents in the background by default, apart from the [cases that run in the foreground](/docs/en/sub-agents#run-subagents-in-foreground-or-background).

* **Foreground subagents** show the same permission prompts you would see in the main conversation, at the moment each tool call happens.
* **Background subagents** surface permission prompts in your main session as of v2.1.186. The prompt names which subagent is asking, and pressing Esc denies that one tool call without stopping the subagent. Before v2.1.186, background subagents auto-denied any tool call that would otherwise prompt and continued without that tool.

To [limit what a subagent can reach](/docs/en/sub-agents#control-subagent-capabilities) in the first place, narrow its `tools` field, for example by leaving Bash off the list, or set deny rules in your settings.

## Artifact

Publishes an HTML or Markdown file as an artifact: a private, interactive page on claude.ai. You can share it with a public link, or inside your organization on Team and Enterprise plans, where public sharing requires an Owner to enable it. Requires a Pro, Max, Team, or Enterprise plan and /login authentication; see Availability

## AskUserQuestion

Asks multiple-choice questions to gather requirements or clarify ambiguity. Questions stay open until you answer them by default. See AskUserQuestion tool behavior

Claude uses `AskUserQuestion` to ask you multiple-choice questions when it needs a decision or a clarification. Answer by picking an option, or type your own text through the `Other` row or the notes field.

When you answer by typing your own text, Claude Code relays the answer with neutral wording so Claude follows what you wrote, including a request to wait or explain first.

### Question auto-continue timeout

Questions stay open until you answer them. If you want a question you leave unanswered to eventually close and let Claude continue without you, set the [`askUserQuestionTimeout`](/docs/en/settings-reference#askuserquestiontimeout) setting to `60s`, `5m`, or `10m`, either in your user `settings.json` or from the **Question auto-continue timeout** row in `/config`.

After a question sits that long with no input, the dialog closes on its own: it submits any options you'd already selected and tells Claude you may be away from your keyboard, so Claude proceeds on its own judgment and can re-ask later. You see a countdown for the last 20 seconds. Press any key to restart the timer; on terminals that report focus, switching to the window restarts it too.

The timeout applies only to `AskUserQuestion`'s multiple-choice questions; permission prompts, including plan approval, never auto-resolve on idle.

## Bash

Executes shell commands in your environment. See Bash tool behavior

The Bash tool runs each command in a separate process.

### What persists between commands

* When Claude runs `cd` in the main session, the new working directory carries over to later Bash commands as long as it stays inside the project directory or an [additional working directory](/docs/en/permissions#working-directories) you added with `--add-dir`, `/add-dir`, or `additionalDirectories` in settings. Subagent sessions never carry over working directory changes.
  * If `cd` lands outside those directories, Claude Code resets to the project directory and appends `Shell cwd was reset to <dir>` to the tool result.
  * To disable this carry-over so every Bash command starts in the project directory, set `CLAUDE_BASH_MAINTAIN_PROJECT_WORKING_DIR=1`.
* Environment variables don't persist. An `export` in one command won't be available in the next.
* Aliases and shell functions defined in your shell startup file are available. At session start, Claude Code sources `~/.zshrc`, `~/.bashrc`, or `~/.profile` depending on your shell, captures the resulting aliases, functions, and shell options, and applies them to every Bash command.

Activate your virtualenv or conda environment before launching Claude Code. To make environment variables persist across Bash commands, set [`CLAUDE_ENV_FILE`](/docs/en/env-vars) to a shell script before launching Claude Code, or use a [SessionStart hook](/docs/en/hooks#persist-environment-variables) to populate it dynamically.

### Timeout and output limits

Each command runs under a timeout, and Claude manages it: when it wants longer than the default for a command, it passes the `timeout` parameter with that call — you never set a per-command timeout. Two [environment variables](/docs/en/env-vars) bound what Claude gets:

* `BASH_DEFAULT_TIMEOUT_MS` — the default when Claude passes no timeout; two minutes out of the box
* `BASH_MAX_TIMEOUT_MS` — with the default, sets the ceiling that caps whatever Claude requests: the effective ceiling is the larger of the two, ten minutes out of the box

#### Output limits

Claude Code streams a command's output to a working file as the command runs; a command whose output passes 5 GB is killed. When the command finishes, Claude Code reads the output back from that file, up to the read-back window described below. How much of the output reaches Claude inline depends on whether Claude Code treats the result as a failure:

| Result  | What Claude gets                                                                                                                                                                                                               |
| :------ | :----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Valid   | Inline up to roughly 30,000 characters; past that, the path of a file saved to the session directory, truncated past 64 MiB, plus a short preview from the start, and Claude reads or searches the file when it needs the rest |
| Failure | Inline up to roughly 10,000 characters; past that, a head-and-tail excerpt of that size cut from the read-back window, with no file path                                                                                       |

A command that exits 1 counts as a valid result for the Bash tool only when Claude Code recognizes exit code 1 as a benign outcome for that command: `grep`, `rg`, `egrep`, `fgrep`, `find`, `diff`, `test`, and `[`, plus `git diff` and `git grep`. Every other command that exits 1 counts as a failure, even when exit 1 is a benign informational outcome: no matches for `pgrep` and `jq -e`, files that differ for `cmp`.

[`BASH_MAX_OUTPUT_LENGTH`](/docs/en/env-vars) sets how many characters of output Claude Code reads back from the working file into a command's result: 30,000 by default, up to a hard ceiling of 150,000. Raise it when your commands routinely overflow that window, such as a verbose build or a full test-suite log. Raising it enlarges the read-back window, and the window a failing command's excerpt is cut from. It does not raise the inline ceilings above: a valid result over roughly 30,000 characters arrives as a file path plus preview regardless of this variable.

### Background commands

For long-running processes such as dev servers or watch builds, Claude can set `run_in_background: true` to start the command as a background task and continue working while it runs. List and stop background tasks with `/tasks`. When a [subagent running in the foreground](/docs/en/sub-agents#run-subagents-in-foreground-or-background) started the command, Claude Code ends it when that subagent gives its final response. Commands started by the main conversation or by a background subagent keep running. In non-interactive mode with the `-p` flag, [background tasks end shortly after the run's final result](/docs/en/headless#background-tasks-at-exit).

When a command reaches its timeout without finishing, Claude Code moves it to the background instead of stopping it. Claude keeps working while the command continues. Claude Code applies the same lifetime rules to a moved command as to any other background command, so it still ends a foreground subagent's command at that subagent's final response. Setting [`CLAUDE_CODE_DISABLE_BACKGROUND_TASKS=1`](/docs/en/env-vars#variables) disables auto-backgrounding along with the rest of the background task functionality.

Claude Code never auto-backgrounds three kinds of command. It stops them at the timeout instead:

* A command that starts with `sleep`.
* A command that runs `git` anywhere in it.
* A compound command Claude Code can't fully parse into simple commands.

The result of a command moved to the background states what happened:

* When the timeout triggers the move, the result reports it explicitly: `Command did not complete within its 120s timeout and was moved to the background`, with the seconds matching the timeout that applied, followed by the task ID and the path of the file the output is being written to.
* A `cd`, `pushd`, `popd`, or `chdir` inside a command that is moved to the background never carries over: the result states `Session cwd remains <dir>; directory changes made by the backgrounded command do not apply to subsequent commands.`, so Claude doesn't act on a directory change that didn't happen.

### Memory limit on Linux and WSL

On Linux and WSL, set [`CLAUDE_CODE_TOOL_MEMORY_LIMIT`](/docs/en/env-vars#variables) to a size such as `4G` to cap the memory that Bash, PowerShell, and [Monitor](#monitor-tool) tool commands can use, so one runaway build can't take the memory the rest of the session needs. Requires Claude Code v2.1.233 or later. Before v2.1.246, Monitor tool commands ran outside the cap.

* Write the size as a number of bytes or with a `K`, `M`, `G`, or `T` suffix. Set `0`, `off`, `false`, `no`, or `none` to turn the cap off. Claude Code ignores any other value it can't read as a size, such as `4e9`.
* Claude Code counts all of a session's Bash, PowerShell, and Monitor commands against the one cap, not each command on its own.
* Claude Code applies the cap with a memory cgroup. When it can't set the cgroup up, commands run without a cap, and the debug log from `claude --debug` says why.
* After the first process Claude Code starts has turned the cap on, or has turned it off because of an off value or a failed cgroup setup, Claude Code holds that result until you relaunch. To apply a changed or removed value, or a fixed setup, launch `claude` again.
* When commands can't stay under the cap, the kernel kills a command, and nothing in its result names the cap.

Claude Code can also count other kinds of processes it starts against the same limit. Set [`CLAUDE_CODE_TOOL_MEMORY_CGROUP_EXCLUDE`](/docs/en/env-vars#variables) to a comma-separated list of the kinds to exempt from the cap; Claude Code applies the cap to every kind not on your list. Set it to `none` to cap every kind, or to `all-new` to cap only Bash, PowerShell, and Monitor tool commands. Requires Claude Code v2.1.246 or later. The kinds you can name:

* `mcp`: local [MCP servers](/docs/en/mcp)
* `lsp`: [language servers](#lsp-tool-behavior)
* `hooks`: [hook](/docs/en/hooks) commands
* `plugin`: commands that [plugins](/docs/en/plugins) run
* `helper`: Claude Code's own helper commands, such as `git`
* `agent`: child Claude Code processes, such as [agent teammates](/docs/en/agent-teams)

Whatever you list, these rules apply:

* **Unknown names**: Claude Code ignores names it doesn't recognize
* **Bash, PowerShell, and Monitor**: Claude Code keeps Bash, PowerShell, and Monitor tool commands under the cap whatever you list
* **Variable unset**: Claude Code takes the set of other capped kinds from configuration Anthropic delivers from the server, and that set can change over time, so set the variable when you need a set that doesn't change
* **Permission-gating hooks**: even with every kind capped, Claude Code excludes from the cap a hook that can block or change the outcome of an action, and any MCP server that such a hook calls, so the kernel killing a permission-gating hook can't allow the action it was blocking

## CronCreate

Schedules a recurring or one-shot prompt within the current session. Tasks are session-scoped and restored on --resume or --continue if unexpired. See scheduled tasks

## CronDelete

Cancels a scheduled task by ID

## CronList

Lists all scheduled tasks in the session

## Edit

Makes targeted edits to specific files. See Edit tool behavior

The Edit tool performs exact string replacement. It takes an `old_string` and a `new_string` and replaces the first with the second. It doesn't use regex or fuzzy matching.

Three checks must pass for an edit to apply. Before any of them, a path matched by a [`Read` deny rule](/docs/en/permissions#tool-specific-permission-rules) is refused, including creating a new file there. The refusal requires Claude Code v2.1.208 or later.

* **Read-before-edit**: Claude reads the file in the current conversation before editing it, and a read cut short with a [`PARTIAL view` notice](#read-tool-behavior) doesn't count. Claude Opus 4.6, Claude Haiku 4.5, and older models always require the read. Newer models can edit an unread file when reading it wouldn't need a permission prompt and the Read tool is available.
* **Match**: `old_string` must appear in the file exactly as written. A single character of whitespace or indentation difference is enough to miss.
* **Uniqueness**: `old_string` must appear exactly once. When it appears more than once, Claude either supplies a longer string with enough surrounding context to pin down one occurrence, or sets `replace_all: true` to replace them all.

A file that changed on disk after Claude last read it can still be edited when `old_string` matches the current content exactly and unambiguously and Claude Code can read the file without prompting. Matching against the file's current content keeps this safe, and the result notes that the file carries other changes so Claude re-reads it before edits that depend on surrounding content. In any other case, such as a stale `old_string` or one that matches more than once without `replace_all`, Claude reads the file again before editing. The relaxed handling of unread and changed files requires Claude Code v2.1.208 or later; before that, Claude Code refused any edit to a file it hadn't read in the conversation or that changed on disk after the read.

Viewing a file with Bash also satisfies the read-before-edit requirement when the command is `cat`, `nl`, `bat`, `batcat`, `head`, `tail`, `sed -n 'X,Yp'`, `grep`, `egrep`, `fgrep`, or `rg` on a single file with no pipes or redirects. Piped output and other Bash commands don't count toward the read-before-edit check.

This affects edit eligibility only, not permissions. [Read and Edit deny rules](/docs/en/permissions#tool-specific-permission-rules) also apply to file commands Claude Code recognizes in Bash, such as `cat`, `head`, `tail`, `sed`, and `grep`, but not to arbitrary subprocesses that read or write files indirectly, like a Python or Node script that opens files itself. The set of commands recognized for deny rules is not the same as the read-before-edit list above: for example, `egrep` and `fgrep` count for read-before-edit but are not checked against Read deny rules. For OS-level enforcement that covers every process, [enable the sandbox](/docs/en/sandboxing).

## EndConversation

Ends the session, in rare cases of sustained abusive input or when you ask Claude to demonstrate the tool. Requires Claude Code v2.1.213 or later. See EndConversation tool behavior

The EndConversation tool ends the current session. Claude uses it only in two situations:

* as a last resort against sustained abusive input, after attempts to redirect the conversation have failed and after a clear warning in an earlier message
* when you explicitly ask to see the tool demonstrated and confirm that you want the session to end

General frustration, profanity, or a task going badly don't qualify, and neither do requests for harmful content, which Claude declines instead of ending the session. Claude Code follows the same approach as claude.ai, which can [end a rare subset of chats](https://www.anthropic.com/research/end-subset-conversations).

After Claude ends an interactive session, the session locks. New prompts and most commands return `Claude ended this conversation. Start a new session (or /clear) to continue.`, and only `/clear`, `/resume`, `/help`, `/exit`, and `/feedback` still run. Claude Code records the end in the session's transcript, so resuming an ended session restores the lock; the session's history isn't deleted.

Resuming an ended session in [non-interactive mode](/docs/en/headless) with the `-p` flag errors and exits with code 1, so a script doesn't read the ended run as a success.

The tool never prompts for permission, and [PreToolUse hooks](/docs/en/hooks#pretooluse) don't run for it. While any other tool remains, you can't block it either: [deny and ask rules](/docs/en/permissions#tool-specific-permission-rules) naming `EndConversation` have no effect, and neither `--disallowedTools` nor a `--tools` list can remove it. The exemption is deliberate: the tool does nothing except end the conversation, never reading or modifying files or data, and a safeguard of this kind holds only if the session it applies to can't turn it off. When your deny rules remove every other tool and also match `EndConversation`, as `"*"` does, Claude Code removes it too rather than leaving it as the only tool, unless an allow rule names `EndConversation` explicitly. A deny list that removes every other tool without matching `EndConversation` leaves it in place.

[Subagents](/docs/en/sub-agents) never get the tool. Background tasks that share the main conversation's tool list see it, but calling it there ends nothing.

The tool appears only when all of the following hold:

* **Version**: Claude Code v2.1.213 or later.
* **Model**: the session's model is Claude Opus 4.8, Claude Sonnet 5, Claude Fable 5, or a later version of one of those families.
* **Surface**: an interactive terminal session, including a `claude` session in an IDE's integrated terminal, which is how the [JetBrains plugin](/docs/en/jetbrains) runs it. Other surfaces don't include the tool, such as:
  * non-interactive `-p` runs
  * sessions through the [Agent SDK](/docs/en/agent-sdk/overview) TypeScript and Python packages
  * the [VS Code extension](/docs/en/vs-code) panel, which bundles its own CLI
  * [GitHub Actions](/docs/en/github-actions)
  * [Claude Code on the web](/docs/en/claude-code-on-the-web)
* **Startup mode**: not a [`--bare`](/docs/en/headless#start-faster-with-bare-mode) session. Bare mode loads only shell and file tools, so the tool is never registered there.
* **Provider**: not available on [Amazon Bedrock](/docs/en/amazon-bedrock), [Claude Platform on AWS](/docs/en/claude-platform-on-aws), [Google Cloud's Agent Platform](/docs/en/google-vertex-ai), or [Microsoft Foundry](/docs/en/microsoft-foundry), or on sessions signed in through a [cloud gateway](/docs/en/claude-apps-gateway).

## EnterPlanMode

Switches to plan mode to design an approach before coding

## EnterWorktree

Creates an isolated git worktree and switches into it. Pass a path to switch into an existing worktree instead of creating a new one. On first entry the target may be a worktree of the current repository or, in a multi-repo workspace, of a repository nested inside it. Before v2.1.203, a nested repository's worktree was rejected. A path outside .claude/worktrees/ prompts for your approval before entering, since it moves the session's working directory and write access to that location. New-worktree creation and paths under .claude/worktrees/ don't prompt. Before v2.1.206, Claude entered paths outside .claude/worktrees/ without a prompt. From within a worktree session, or from a subagent with a pinned working directory such as isolation: worktree, only the path form is available and the target must be under .claude/worktrees/ of the session's repository

## ExitPlanMode

Presents a plan for approval and exits plan mode

## ExitWorktree

Exits a worktree session and returns to the original directory. Not available to subagents that already run in their own working directory, such as with isolation: worktree

## Glob

Finds files based on pattern matching. See Glob tool behavior

The Glob tool finds files by name pattern. It supports standard glob syntax including `**` for recursive directory matching:

* `**/*.js` matches all `.js` files at any depth
* `src/**/*.ts` matches all `.ts` files under `src/`
* `*.{json,yaml}` matches `.json` and `.yaml` files in the current directory

Results are sorted by modification time and capped at 100 files. If the cap is hit, Claude sees a truncation flag in the result and can narrow the pattern.

Glob doesn't respect `.gitignore` by default, so it finds gitignored files alongside tracked ones. This differs from [Grep](#grep-tool-behavior), which skips gitignored files. To make Glob respect `.gitignore`, set `CLAUDE_CODE_GLOB_NO_IGNORE=false` before launching Claude Code.

A `pattern` or `path` value that contains a null byte returns an error asking Claude to remove it.&#x20;

## Grep

Searches for patterns in file contents. See Grep tool behavior

The Grep tool searches file contents for patterns. Where [Glob](#glob-tool-behavior) finds files by name, Grep finds lines inside them.

Grep is built on [ripgrep](https://github.com/BurntSushi/ripgrep) and uses ripgrep's regex syntax, not POSIX grep. Patterns that include regex metacharacters need escaping. For example, finding `interface{}` in Go code takes the pattern `interface\{\}`.

A pattern, glob, or file type that ripgrep rejects returns an error that includes ripgrep's diagnostic, so Claude can correct the input and search again. Before v2.1.208, Claude Code reported a rejected input as `No files found` instead of an error, even when the searched-for text existed in the target files.

Three output modes control what comes back:

* `files_with_matches`: file paths only, no line content. This is the default.
* `content`: matching lines with file and line number. When the tool's `offset` parameter points past the last match for a pattern that has matches, Grep returns `No entries at this offset`, so Claude widens or resets the offset instead of concluding the pattern doesn't match.
* `count`: match count per file, followed by a total across all matching files. The total covers every match even when the tool's `head_limit` or `offset` parameters truncate the listed per-file entries. Before v2.1.208, the total only summed the listed entries.

Claude can scope results by file with the `glob` parameter, such as `**/*.tsx`, or by language with the `type` parameter, such as `py` or `rust`. By default, patterns match within a single line. Claude can set `multiline: true` to match across line boundaries.

Grep respects `.gitignore`, so gitignored files are skipped. To search a gitignored file, Claude passes its path directly.

## ListAgents

Lists the agents Claude can message with SendMessage: subagents in the session, agent team teammates, your other local Claude Code sessions, and, while this session is connected to Remote Control, your Claude Code on the web sessions and your Remote Control sessions on other machines. Backs the /list-agents command. See cross-session messaging. Requires Claude Code v2.1.224 or later, and appears only in sessions where cross-session messaging is enabled. Teammate rows and the first line showing this session's own name require v2.1.239 or later

## ListMcpResourcesTool

Lists resources exposed by connected MCP servers

## LSP

Code intelligence via language servers: jump to definitions, find references, report type errors and warnings. See LSP tool behavior

The LSP tool gives Claude code intelligence from a running language server. After each file edit, it automatically reports type errors and warnings so Claude can fix issues without a separate build step. Claude can also call it directly to navigate code:

* Jump to a symbol's definition
* Find all references to a symbol
* Get type information at a position
* List symbols in a file
* Search for a symbol by name across the workspace
* Find implementations of an interface
* Trace call hierarchies

Claude Code keeps the tool inactive until you install a [code intelligence plugin](/docs/en/discover-plugins#code-intelligence) for your language. Claude Code takes the language server's configuration from the plugin, and you install the server binary yourself.

Claude Code keeps the tool active for the rest of a session once it has had a language server available in that session. Claude Code returns an error result for each LSP call on a file whose language server it can't start. Before v2.1.235, Claude Code deactivated the tool whenever every language server had crashed or failed to start and reactivated it when one recovered.

## Monitor

Runs a command in the background and feeds each output line back to Claude, so it can react to log entries, file changes, or polled status mid-conversation. Can also open a WebSocket and treat each incoming message as an event. See Monitor tool

## NotebookEdit

Modifies Jupyter notebook cells. See NotebookEdit tool behavior

NotebookEdit modifies a Jupyter notebook one cell at a time, targeting cells by their `cell_id`. It doesn't perform string replacement across the notebook the way [Edit](#edit-tool-behavior) does on plain files.

Three edit modes control what happens to the target cell:

* `replace`: overwrite the cell's source. This is the default.
* `insert`: add a new cell after the target. With no `cell_id`, the new cell goes at the start of the notebook. Requires `cell_type` set to `code` or `markdown`.
* `delete`: remove the target cell.

Permission rules use the `Edit(...)` path format. A rule like `Edit(notebooks/**)` covers NotebookEdit calls on files in that directory.

## PowerShell

Executes PowerShell commands natively. See PowerShell tool for availability

## PushNotification

Sends a desktop notification, and a phone push when Remote Control is connected, so a long-running task or scheduled task can reach you when you step away. Push delivery runs through Anthropic-hosted infrastructure, which is not accessible from Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry

## Read

Reads the contents of files. See Read tool behavior

The Read tool takes a file path and returns the contents with line numbers. Claude is instructed to always pass absolute paths.

By default, Read returns the file from the start. When a whole-file read exceeds the token limit, Read returns the first page with a `PARTIAL view` notice that tells Claude how much of the file it received and how to read more with `offset` and `limit`. A read that passes an explicit `offset` or `limit` and still exceeds the token limit returns an error.

A read with an explicit `limit` stops as soon as the selected lines exceed what the token limit could ever fit and returns an error without loading the rest of the range. The error tells Claude to use a smaller `limit`, or to search for specific content with [Grep](#grep-tool-behavior) instead when a single line is that large. Before v2.1.208, Claude Code loaded the whole range into memory before rejecting it, so reading a file with an extremely long single line could run it out of memory.

Reading an empty file returns a notice that the file exists but its contents are empty, and an `offset` past the last line returns a notice giving the file's line count. Before v2.1.208, reading an empty file returned the past-the-end notice instead.

Read handles several file types beyond plain text:

* **Images**: PNG, JPG, and other image formats are returned as visual content that Claude can see, not as raw bytes. Claude Code resizes and recompresses large images to fit the model's image size limits before sending them, so Claude may see a downscaled version of a large screenshot. As of v2.1.196, an image that is still larger than 500KB after that resize is re-encoded as a JPEG at reduced quality with its pixel dimensions unchanged. If Claude misses fine pixel-level detail in a large image, ask it to crop the region of interest first, for example with ImageMagick via Bash.
* **PDFs**: Claude reads short `.pdf` files whole. For PDFs longer than 10 pages, it reads in ranges with a `pages` parameter, such as `"1-5"`, up to 20 pages at a time.
* **Jupyter notebooks**: `.ipynb` files return all cells with their outputs, including code, markdown, and visualizations. Claude Code refuses to read a notebook file over 100 MB; the error tells Claude how to read a portion of the notebook instead, such as a slice of cells, with a shell command.

Read only reads files, not directories. Claude lists directory contents with a shell command such as `ls`.

## ReadMcpResourceTool

Reads a specific MCP resource by URI

## RemoteTrigger

Creates, updates, runs, and lists Routines on claude.ai. Backs the /schedule command. The RemoteTrigger input reference documents every action and the organization policies that remove the tool. Routines live on claude.ai and require a Pro, Max, Team, or Enterprise plan, so this tool is not accessible from Amazon Bedrock, Claude Platform on AWS, Google Cloud's Agent Platform, or Microsoft Foundry. Also unavailable when you turn off feature-flag fetching

## ReportFindings

Reports code-review findings as a structured list, with a file, summary, and failure scenario per finding, so Claude Code can render them instead of printing them as text. Claude calls it when active code-review instructions tell it to. Requires Claude Code v2.1.196 or later. As of v2.1.199, a finding can also carry an optional category slug, such as correctness or test-coverage, shown next to the file location in the rendered list

## ScheduleWakeup

Reschedules the next iteration of a self-paced /loop. Claude calls this at the end of each iteration to pick when the next one runs, between one minute and one hour out; you don't call it directly. To end the loop instead, Claude calls it with stop: true, which cancels the pending wakeup. The stop field requires Claude Code v2.1.202 or later. The pending wakeup appears in session_crons in Stop hook input

## SendFeedback

Drafts a feedback report about Claude Code, covering a product problem or Claude's own behavior in the session, and queues it on your machine for you to review. Claude Code sends nothing until you choose to send the draft. See SendFeedback tool behavior. Requires Claude Code v2.1.238 or later

Claude-drafted feedback is a feedback report about Claude Code that Claude writes for you. It requires Claude Code v2.1.238 or later. Claude Code saves each draft on your machine under `~/.claude/feedback/drafts/`, and nothing reaches Anthropic until you send it. Claude drafts one with the SendFeedback tool when:

* A tool or command keeps failing
* It can't help with something you asked for
* You point out a mistake it made, or it notices one
* You ask it to file feedback

### What you see when Claude drafts

After Claude queues a draft, you see a card above your prompt with the draft's title. Press `1` to review the draft, press `2` twice to send it as written, or press `0` to dismiss it. A dismissed draft stays in your queue. After you dismiss a card, Claude Code asks whether to turn Claude-drafted feedback off. It stops asking once you've declined twice.

By default, you see at most three cards in a session; Anthropic can adjust that limit from the server without a release. After the limit, and whenever you set [`feedbackDrafts`](/docs/en/settings-reference#feedbackdrafts) to `quiet`, you see only a count of queued drafts in the prompt footer.

### Review and edit a draft

Run `/feedback` with no argument to open your queue. It lists every queued draft from all your sessions, including drafts whose cards you dismissed or never saw. Select a draft to open it for review, where you can:

* Edit the title, area, and details
* Set **Send transcript** to `yes` or `no`. When the transcript from the session where Claude queued the draft is still available, it starts at `yes`, which sends that conversation to Anthropic; `no` sends the report only
* Send the draft, discard it, or leave it in the queue for later

To write a report yourself instead, press `w` for the standard feedback dialog. `/feedback` with text after it, and `/bug`, open that dialog directly.

### Send a draft

When you send a draft, Claude Code submits it the same way as a `/feedback` report, with the same [retention](/docs/en/data-usage#feedback-using-the-%2Ffeedback-command), and deletes the draft from your machine. When you send from the card, it shows `✓ Sent`; when you send from the queue, it closes with a receipt ID.

The report carries:

* Your title, area, and details
* Environment info, such as your Claude Code version, operating system, and model
* The IDs of recent API requests
* The conversation transcript, when you left **Send transcript** at `yes` in the review screen. Sending from the card never includes the transcript

Claude Code keeps your working directory in the local draft so it can find the transcript, and doesn't send the directory.

In [organizations with zero data retention](/docs/en/zero-data-retention#features-disabled-under-zdr), Claude Code leaves the tool out, as it does for `/feedback`. If a session in such an organization still offers the tool, drafts stay on your machine, and sending fails with `Feedback collection is not available for organizations with custom data retention policies.`

### Discard or keep a draft

When you discard a draft, Claude Code deletes it from your machine. A draft you leave in the queue expires after 30 days, or after [`cleanupPeriodDays`](/docs/en/settings-reference#cleanupperioddays) when that's shorter. The queue holds 10 drafts across all your sessions, and when Claude queues an eleventh, Claude Code deletes the oldest. When you run `/exit` with drafts from the session still in the queue, Claude Code asks whether to review them or discard them before exiting.

### Turn Claude-drafted feedback off

Set **Claude-drafted feedback** to `off` in `/config`, which writes the [`feedbackDrafts`](/docs/en/settings-reference#feedbackdrafts) setting, or set [`CLAUDE_CODE_SEND_FEEDBACK=0`](/docs/en/env-vars) for one session. With either, Claude can't queue drafts. To keep drafting on without cards, set `feedbackDrafts` to `quiet` instead. Administrators can set `feedbackDrafts` in [managed settings](/docs/en/managed-settings), which takes precedence over your own setting.

### Sessions without Claude-drafted feedback

Claude Code includes the tool in interactive terminal sessions on your own machine that use the Claude API rather than a cloud provider. It leaves the tool out of:

* Non-interactive `-p` runs and [Agent SDK](/docs/en/agent-sdk/overview) sessions, which have no screen to review the queue on
* Cloud sessions such as [Claude Code on the web](/docs/en/claude-code-on-the-web), which can't write to the queue on your machine
* Sessions on [Amazon Bedrock](/docs/en/amazon-bedrock), [Claude Platform on AWS](/docs/en/claude-platform-on-aws), [Google Cloud's Agent Platform](/docs/en/google-vertex-ai), or [Microsoft Foundry](/docs/en/microsoft-foundry)
* Sessions where you set [`CLAUDE_CODE_SEND_FEEDBACK=0`](/docs/en/env-vars) or [`DISABLE_FEEDBACK_COMMAND=1`](/docs/en/env-vars), set `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC` to any non-empty value, or turned off [feature-flag fetching](/docs/en/env-vars#features-that-need-feature-flag-fetching)
* Organizations that have turned off product feedback, and [organizations with zero data retention](/docs/en/zero-data-retention#features-disabled-under-zdr)

## SendMessage

Sends a message to another agent: an agent team teammate, a subagent it resumes by agent ID or name, or one of your other Claude Code sessions, on this machine or beyond it. Messaging other sessions requires Claude Code v2.1.224 or later. Cross-session messaging covers which sessions Claude can reach, what a message looks like when it arrives, and how Claude gets a notice when another session goes idle. Claude can include an optional summary input, typically 5-10 words, that Claude Code shows as a one-line preview. When Claude omits it on a plain-text message, Claude Code uses the first line of the message as the summary. Claude Code truncates a summary longer than 200 characters with an ellipsis

## SendUserFile

Sends files from the session to you with an optional caption, so a generated report, diagram, screenshot, or built artifact reaches your device instead of only being mentioned in the transcript. As of v2.1.196, the optional display input controls presentation: render opens the file inline in the client, attach shows a download card only, and when unset the client decides by file type. Available when a Remote Control client is connected or the session runs in a managed cloud environment such as Claude Code on the web. Delivery runs through Anthropic-hosted infrastructure, so the tool is not available on Amazon Bedrock, Google Cloud's Agent Platform, or Microsoft Foundry

## ShareOnboardingGuide

Uploads ONBOARDING.md and returns a share link teammates can open in Claude Code. Called from /team-onboarding after the guide is written. Available to claude.ai subscribers on Pro, Max, Team, and Enterprise plans

## Skill

Executes a skill within the main conversation

## TaskCreate

Creates a new task in the task list. Claude Code leaves it out on the models listed under Task tool availability unless you opt in

## TaskGet

Retrieves full details for a specific task. Claude Code leaves it out on the models listed under Task tool availability unless you opt in

## TaskList

Lists all tasks with their current status. Claude Code leaves it out on the models listed under Task tool availability unless you opt in

## TaskOutput

Retrieves output from a background task. Deprecated in favor of Read on the task's output file path. When no task matches the ID, the error lists the running background agents by ID and description. Before v2.1.203, the error named only the missing ID

## TaskStop

Stops a running background task by ID. It also accepts an agent-team teammate or a named background agent by agent ID or name. Before v2.1.198, it accepted only a background task ID. When no task matches the ID, the error lists the running background agents by ID and description, including agents that another agent spawned. Before v2.1.203, the error listed running teammates and named agents but not background agents another agent spawned, so those couldn't be identified or stopped from the main conversation

## TaskUpdate

Updates task status, dependencies, details, or deletes tasks. Claude Code leaves it out on the models listed under Task tool availability unless you opt in

## TodoWrite

Manages the session task checklist. Disabled by default in favor of TaskCreate, TaskGet, TaskList, and TaskUpdate. Set CLAUDE_CODE_ENABLE_TASKS=0 to re-enable it in sessions that have the task-tracking tools

## ToolSearch

Searches for and loads deferred tools when tool search is enabled

## WaitForMcpServers

Waits for one or more MCP servers that are still connecting in the background, so a request can use their tools without restarting the session. Claude calls it when a needed server isn't connected yet. Only appears when tool search is disabled, since ToolSearch handles the wait when it's enabled

## WebFetch

Fetches content from a specified URL. See WebFetch tool behavior

WebFetch takes a URL and a prompt describing what to extract. It fetches the page, converts the response to Markdown when the server returns HTML, and runs the prompt against the content using a small, fast model. For most fetches, Claude receives that model's answer, not the raw page. The conversion step is not configurable.

This makes WebFetch lossy by design. The extraction prompt determines what reaches Claude, so a result that says a page doesn't mention something may only mean the prompt didn't ask about it. Ask Claude to fetch again with a more specific prompt, or use `curl` via Bash for the unprocessed page.

A few behaviors shape the response Claude receives:

* HTTP URLs are automatically upgraded to HTTPS.
* Large pages are truncated to a fixed character limit before processing.
* WebFetch caches each response for 15 minutes by default, so repeated fetches of the same URL return quickly. On Claude Code v2.1.233 or later, set [`CLAUDE_CODE_WEBFETCH_CACHE_TTL_MS`](/docs/en/env-vars#variables) to change how long WebFetch keeps each response.
* When a URL redirects to a different host, WebFetch returns a text result that names the original URL and the redirect target instead of following it. Claude then fetches the new URL with a second WebFetch call.
* When the extraction step hits an overloaded API, Claude Code retries it with backoff; a fetch that still fails returns an error result. Before v2.1.212, the API error text could reach Claude as if it were the extracted page content.

In Manual and `acceptEdits` [permission modes](/docs/en/permission-modes), WebFetch prompts before fetching, except for domains your [permission rules](/docs/en/permissions#manage-permissions) already allow or deny and a built-in set of preapproved documentation domains that fetch without a prompt. Whatever your rules allow, a fetch also passes the [WebFetch domain safety check](/docs/en/data-usage#webfetch-domain-safety-check) first; that section covers what the check sends and the setting that skips it. The prompt offers three options:

* **Yes**: approves this fetch only. The next WebFetch call prompts again, even for the same domain.
* **Yes, and don't ask again for `<domain>`**: approves the fetch and saves a `WebFetch(domain:...)` allow rule for that domain to `.claude/settings.local.json` for that repository. See [how saved approvals persist](/docs/en/permissions#permission-system). When your organization sets [`allowManagedPermissionRulesOnly`](/docs/en/permissions#managed-only-settings), Claude Code hides this option.
* **No, and tell Claude what to do differently**: rejects the fetch.

To allow a domain in advance without a prompt, add an allow rule like `WebFetch(domain:example.com)`; `WebFetch(domain:*)` allows every domain. The `auto` and `bypassPermissions` [permission modes](/docs/en/permissions#permission-modes) skip the prompt, except for a domain an explicit `ask` rule matches.

An explicit `WebFetch(domain:...)` rule in `deny`, `ask`, or `allow` takes precedence over the preapproved set, so you can block a preapproved domain or require a prompt for it.

WebFetch sets a `User-Agent` header beginning with `Claude-User`, and an `Accept` header that prefers Markdown over HTML so servers that support content negotiation can return Markdown directly.

Sandboxed commands don't inherit WebFetch's built-in set of preapproved documentation domains. To let a sandboxed command reach a domain without a prompt, add the domain to [`allowedDomains`](/docs/en/settings-reference#sandbox-network-alloweddomains) or allow it with a `WebFetch(domain:...)` rule, which the [sandbox also honors](/docs/en/sandboxing#network-isolation). WebFetch never reads the sandbox allowlist in return, so adding a domain to a sandbox or organization network allowlist doesn't stop WebFetch from prompting for it.

## WebSearch

Performs web searches. See WebSearch tool behavior

WebSearch runs a query against Anthropic's [web search](https://platform.claude.com/docs/en/agents-and-tools/tool-use/web-search-tool) backend and returns result titles and URLs. It doesn't fetch the result pages. To read a page Claude finds in search results, it follows up with [WebFetch](#webfetch-tool-behavior).

The tool may issue up to eight backend searches per call, refining the search internally before returning results. Claude can scope results with `allowed_domains` to include only certain hosts, or `blocked_domains` to exclude them. The two lists can't be combined in a single call.

When the search request hits an overloaded API, Claude Code retries it with backoff; a call that still fails returns an error result. Before v2.1.212, the API error text could reach Claude as if it were search results.

WebSearch permission rules take no specifier. A bare `WebSearch` entry in `allow` or `deny` is the only form.

The search backend is not configurable. To search with a different provider, add an [MCP server](/docs/en/mcp) that exposes a search tool.

<Note>
  WebSearch is available on the Claude API and [Claude Platform on AWS](/docs/en/claude-platform-on-aws). On Microsoft Foundry it requires a [deployment hosted on Anthropic](https://platform.claude.com/docs/en/build-with-claude/claude-in-microsoft-foundry#hosting-options): deployments hosted on Azure don't support server-side tools, so the WebSearch call fails. On Google Cloud's Agent Platform it works with Claude 4 and later models, including Opus, Sonnet, and Haiku. Amazon Bedrock doesn't expose the server-side web search tool.
</Note>

### Session search limit

A session can make at most 200 WebSearch calls, counted across the main conversation and every [subagent](/docs/en/sub-agents) it spawns, so searches made by parallel research fan-outs count against the same limit. The limit requires Claude Code v2.1.212 or later. When Claude reaches the limit, further calls return a notice telling Claude to continue with the information it already gathered, rather than an error that would invite a retry. You don't see the notice: a capped call appears in the conversation as a search that did nothing, and if Claude needs more searches, the notice tells it to ask you to raise the limit.

Set the [`CLAUDE_CODE_MAX_WEB_SEARCHES_PER_SESSION`](/docs/en/env-vars) environment variable to change the cap; it accepts a positive whole number, so the cap can be raised but not turned off. Running [`/clear`](/docs/en/commands#all-commands) resets the count. If work that can still spawn [subagents](/docs/en/sub-agents) survives the clear, such as a running workflow, the count carries over instead.

## Workflow

Runs a dynamic workflow: a script that orchestrates many subagents in the background and returns one consolidated result

## Write

Creates or overwrites files. See Write tool behavior

The Write tool creates a new file or overwrites an existing one with the full content provided. It doesn't append or merge.

Whether Claude must read an existing file in the current conversation before overwriting it depends on the model and the file:

* Claude Opus 4.6, Claude Haiku 4.5, and older models always require the read, so a Write to an unread existing file fails with an error.
* Newer models can overwrite a file they never read this session under the same conditions as [read-before-edit](#edit-tool-behavior): reading it wouldn't need a permission prompt and the Read tool is available.
* Jupyter notebooks, and files Claude has read only partially with a [`PARTIAL view` notice](#read-tool-behavior), require the read on every model.

This constraint doesn't apply to new files. Before v2.1.228, every model required the read before overwriting an existing file.

Viewing the file with Bash also satisfies this requirement under the same rules described in [Edit tool behavior](#edit-tool-behavior).

For partial changes to an existing file, Claude uses Edit instead of Write.
