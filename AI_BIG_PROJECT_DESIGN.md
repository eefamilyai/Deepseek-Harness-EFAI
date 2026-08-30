# What an AI needs to do a big project well

This is a design note on the conveniences that matter most when an AI agent is
driving a multi-step, multi-file engineering effort through the DSH kernel. It
records both what was just added to `kernel_child.py` and the next tranche worth
building.

## The core failure mode: unobservable failure

The single most expensive bug class in this harness is *silent wrongness*: a
helper returns an error as ordinary text (or `None`), the model reads it as
success output, and proceeds on fabricated state. Every convenience below exists
to make success and failure structurally distinguishable.

### Principle 1 — Results carry an `ok` bit

A string is ambiguous ("read_file error: …" could be a file whose content is
literally that). A dict is not. The new structured returns:

- `sh(cmd, result=True)`  -> `{ok, code, stdout, stderr, output}`
- `read_file(path, meta=True)` -> `{ok, path, size, total_chars, truncated, text}`
- `write(path, …)`        -> `{ok, path, bytes}`

`check=True` on `sh()` turns non-zero exit into a `RuntimeError`, so the model can
choose "fail loudly" semantics when it chains a build/test step.

**Next step:** extend this to the remaining string-error helpers
(`read_yaml`, `read_json`, `read_csv`, `unzip`, `download`, `edit_file`, …). The
mechanical pattern is identical; the payoff is one uniform "did it actually work"
signal across the whole surface.

### Principle 2 — Discovery is explicit and cheap

A model is bad at remembering forty tool signatures. It is good at asking. So:

- `tool_help()` lists every documented function with a one-line summary.
- `tool_help(pattern="*read*")` narrows to matching names.
- `tool_help("read_file")` returns the full docstring.

This makes the tool surface *queryable* instead of *memorized*. The kernel
system-prompt edit tells the model to call `tool_help()` rather than inlining
every behavior.

### Principle 3 — Project-level state is first-class

A big project is a tree plus a todo list plus a git log. The model needs to read
all three without composing them by hand each turn:

- `git_status(path=".")` -> `{in_git, branch, porcelain, summary}` — so "what
  did I change" is one call, not `os.popen` spelunking.
- `task_add(subject, status)` / `task_done(subject)` — append/complete individual
  tasks in the same `todos.json` the UI already renders.
- `run_cell(code)` -> `{ok, value}` or `{ok, traceback}` — namespace-round-trip
  as a value, so a helper can compute *and* read the answer in one call instead
  of guessing from stdout.

## What a big-project AI needs next, in priority order

1. **Uniform error envelopes everywhere.** Convert every remaining
   "return a string on failure" helper to `{"ok": False, "error": …}` when a
   `detail`/`meta` flag is set, keeping the legacy string default for
   compatibility. This alone would eliminate most silent-wrongness.

2. **A project context snapshot.** One call that returns:
   - repo root, branch, and a dirtiness summary (extend `git_status`),
   - the current todo list,
   - a list of recently modified files (mtime-sorted, from `file_info`).
   The model pays one round-trip to re-orient after any interruption.

3. **Checkpoint-before-risky-edit.** The kernel already has `checkpoint`/`rewind`
   for the *namespace*; the file layer has `_record_change` backups. Expose a
   `revert(path)` that restores the last backup so a bad multi-file edit is one
   call from undone.

4. **Batch verification idiom.** A `run_cell` that returns tracebacks as values
   (added) plus a `check(predicate, label)` helper in the namespace would let the
   model write table-driven self-tests in one cell and get a structured
   pass/fail list back — cheap, repeatable, and reviewable.

5. **Non-text readers.** `read_nontext` already degrades cleanly to base64; adding
   optional Pillow/pypdf/nbformat makes images, PDFs, and notebooks first-class.
   This removes the biggest remaining "the file is right there but I can't see it"
   gap.

6. **Session-scoped working memory.** `remember`/`recall` exist but depend on env
   wiring. A key-value store that is *always* available (even without
   `KILN_CONV_ID`) would give the model durable "decisions so far" notes that
   survive a kernel restart, closing the loop on Principle 3.

## The meta-observation

The conveniences an AI needs for a big project are not "more capability" — the
kernel already has enormous capability. They are **observability** (what did that
call actually do), **discoverability** (how do I find the right tool), and
**resumability** (where was I and what did I decide). Any new tool that serves one
of those three verbs earns its keep; anything else is likely redundant.
