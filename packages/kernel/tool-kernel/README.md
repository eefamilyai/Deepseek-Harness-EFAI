# @deepseek-ai/dsh-tool-kernel

The **model-facing `kernel` tool**: run Python in a persistent namespace.

In a composition built around this package the kernel is not one tool among many — it is the model's entire hands. Reading a file, editing it, searching the disk, running a command, driving a browser: all of it is Python, written against the helpers the Kiln runtime preloads into the namespace.

That is why the roster this package expects to sit in has web access and little else beside it. A conventional harness hands the model one tool per verb; here it hands over a language, and the verbs come from the runtime.

## What the tool does

Forwards a cell's source to `ctx.kernel.execute(...)` and returns the captured output, including the value of each top-level bare expression. The namespace persists across calls, so a variable bound in one cell is live in the next.

A cell that carries no budget of its own gets `defaultTimeoutMs` from the seam.

## Not to be confused with

- `kernel-mode` — decides whether this tool is mounted at all.
- `kernel-python` — the backend this tool ends up executing against.
- `@deepseek-ai/dsh-rlm` — swaps the acting tool from this standalone tool to the recursive engine, which drives the same kernel directly. The two are alternatives, not layers: RLM mode unmounts this row.

## Images a cell returns

A cell can hand back pictures as well as text: `show()` in the Kiln runtime
queues an image on the cell's result, and this tool turns each one into an image
block in the model's own context. That is the difference between the model being
told what a screenshot contains and the model looking at it.

Three steps, in this order, and each one is a place the picture could be lost:

1. **The frame carries the bytes.** `kernel-python` validates whatever the child
   wrote in its `images` field and reports the survivors on `KernelExecuteResult`.
   A frame with no images simply omits the field.
2. **This tool commits them.** `admitCellImages` decodes each payload, asks the
   attachment store to store it, and returns durable `ImageAttachmentRef`s. The
   commit happens *before* the tool returns, because a canonical value that cited
   unstored bytes would replay as a broken picture for the rest of the session.
3. **The render emits blocks.** `kernelContent` produces the captured output,
   then one envelope line and one `image` block per stored picture, in queue
   order.

Refusal is per image, never per cell. An unsupported media type or an oversized
picture becomes a note shown beside the text and costs only itself: a cell that
produced a good traceback still delivers it even when one of its pictures could
not be stored. When the store refuses a whole batch — usually its aggregate byte
or count bound — the batch is retried one at a time so the images that do fit are
not lost with the one that does not.

Storing requires `attachments`, so this package declares it in `inject`. A kernel
tool that silently dropped a cell's pictures would be worse than one that refuses
to mount.

## Model Experience

### `kernel` tool schema

#### What the model sees

One tool named `kernel` with a required `code` string and an optional `timeoutMs`. The description states that variables and imports persist across calls, that shell commands run through `sh("...")`, and that the first line must be a `#` comment titling the cell. A separate `tool:kernel` prompt section requires the model to call `tool_help()` to discover the preloaded helpers *before* writing a cell, and to check the per-helper signature with `tool_help("<name>")` before relying on it. Dropping to a raw `os.walk` is allowed only after that lookup has shown no helper fits. See [`@deepseek-ai/dsh-tool-kernel`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-kernel) in the generated tool catalog.

##### Prompt section verbatim

```markdown
You have one tool for acting on this machine: `kernel`, which runs Python in a
persistent namespace. Variables and imports persist across calls, so build state
up instead of re-deriving it. To learn every preloaded helper, call `tool_help()`
with no argument; `tool_help("grep")` documents one.

Begin every cell with a single-line `#` comment stating what the script does.
That first line titles the call in the transcript, so make it a short, concrete
summary of the intent — `# Count the files under packages/`, not `# code` or a bare
restatement of the line below it. The cell body follows.

## Discover the helpers before you write anything

This is a requirement, not advice. The kernel ships a helper for nearly every
filesystem, search, and process task, and `tool_help()` is the only way to learn
what exists. A script written before you have called it is guesswork about your
own hands.

Make this the first cell of any session that will touch files, search, or
processes, and repeat it whenever you are about to write a loop you have not
written before:

1. `tool_help()` lists every preloaded helper and every harness tool reachable
   through `tools.<name>`, each with a one-line summary. Call it before you plan.
2. `tool_help("<name>")` gives one helper its full signature and semantics. Call
   it for every helper you intend to use, before you rely on its argument order.
3. Only then write the cell, calling those helpers instead of reimplementing them.

Skipping step 1 is the expensive mistake. A hand-rolled `os.walk` plus
`for line in open(f)` reads every file one line at a time, while the helpers
drive ripgrep and the git index; on a large repository that gap is minutes per
call, not milliseconds. The helpers below are the ones you will reach for most:

- `grep(pattern, path, include=, max_matches=)` — matching lines, `file:line:text`.
- `find(pattern, path)` — which files match, one hit per file.
- `glob(pattern, path)` — paths by pattern (`**/*.ts`).
- `search_files(query, path)` — filenames and contents together.
- `list_dir(path, depth)` / `tree(path, depth)` — a directory, bounded.
- `read_file` / `read` / `write` / `edit_file` / `append_file` — file I/O.
- `sh(cmd, result=True)` — a shell command; `result=True` gives `{ok, code, stdout}`.
- `run_process(argv, cwd=)` — argv without a shell, for quoting-sensitive commands.
- `read_json` / `write_json` / `read_yaml` / `read_csv` — structured data.
- `show(image)` — hand a real screenshot or image back to your own vision.

Only once `tool_help()` has shown that none of these fits may you drop to a raw
`os.walk`, `Path.rglob`, or a per-line Python loop — and then say so in a comment,
naming the helper you ruled out and why. "I did not check" is not a reason.

## Batch independent work into ONE cell

Kernel cells are serialized: the namespace is shared mutable state, so a second
cell waits for the first to finish. Issuing several `kernel` calls in parallel
therefore buys nothing — they run one after another regardless. The concurrency
you want is *inside* a cell:

    # Four independent questions, one call
    hits = {q: grep(q, "packages", max_matches=5) for q in QUERIES}

    # Or genuinely parallel reads
    from concurrent.futures import ThreadPoolExecutor
    with ThreadPoolExecutor(8) as pool:
        pages = list(pool.map(read_file, PATHS))

So do not split one investigation across four `kernel` turns. Write one cell that
does all four things and prints what you need to see. That single change removes
most of the wall-clock a task spends waiting on itself.

## Search wide, then narrow

One fast call beats five slow ones. `grep` with a broad pattern and a generous
`max_matches` costs about the same as a narrow one, so ask the whole question once
rather than guessing at paths. Prefer `include="*.ts"` over walking a subtree
yourself, and `find` over `grep` when you only need to know *which* files are
involved. If a cell is going to print a lot, print counts or a slice first and
fetch the detail once you know it matters.

## Read the result before the next call

Every cell returns its printed output plus the value of each top-level bare
expression. Print what you need to decide the next step, then decide. Do not fire
a speculative cell to find out what a path looks like when `list_dir` or `glob`
would have told you in one call.
```

#### Token effect

The description, its two parameter descriptions, and the prompt section are billed once per request as part of the stable prefix. A cell result is capped at `maxOutputChars` (default 200000) with the head and tail kept, because a traceback is the last thing a cell prints.

#### KV Cache effect

The schema and prompt section are static. Results append to the transcript as ordinary tool results.

### Empty and restarted cells

#### What the model sees

An empty output is reported in words rather than as silence: the model is told the cell produced no output and that it should print a value it expected rather than describe a result it did not see. A timeout that loses the namespace reports the restart, so the model knows its variables are gone.

#### Token effect

The empty-output notice and the restart flag are a fixed cost on the affected result only.

#### KV Cache effect

None of their own; both appear inside an ordinary tool result.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **The tool is not concurrency-safe** - the namespace is shared mutable state, so the registry treats a call as exclusive and two cells cannot run in parallel.
- **A cell that overruns its budget backgrounds** - the primary budget backgrounds the cell and a much larger secondary budget force-stops it, so a runaway cell can keep running long after the model stopped waiting.
- **Output is truncated at the cap** - a cell printing more than `maxOutputChars` loses the middle, keeping only the head and tail.
- **The caller names the working directory** - a call with no agent sends no `cwd` and runs wherever the kernel already is.
- **Images are bounded by the attachment store** - the kernel caps a cell at 8 images and 4 MB each, and the store applies its own aggregate bounds on top; an image that exceeds them is reported as a note rather than attached.

Fork-owned: `packages/kernel/tool-kernel` is Tier 1, so it touches no upstream file.
