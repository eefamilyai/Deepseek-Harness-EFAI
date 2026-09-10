# @deepseek-ai/dsh-tool-notebook-edit

The model-facing **`notebook_edit`** tool: view, create, replace, insert, and delete cells in a Jupyter `.ipynb` notebook over the harness filesystem service.

It exists because a notebook is JSON, and a plain text editor makes it easy to produce a file that no longer parses. This tool parses the notebook, applies the edit to the cell's source, and writes the whole file back through the mounted filesystem policy, so an edit either lands as valid nbformat or is refused.

One schema, five commands:

| Command | Effect |
|---|---|
| `view` | Renders every cell: zero-based index, cell type, execution count or `unexecuted`, and the indented source. Does not modify the notebook. |
| `create` | Writes a new notebook and refuses to overwrite an existing path. Omit `cells` for an empty notebook, or pass a JSON array of nbformat cells. |
| `str_replace` | Replaces one literal `old_str` inside the `cell_id` cell's source. The match must be exact and unique within that cell. |
| `insert` | Adds a new cell at zero-based `cell_id`; `0` prepends and the cell count appends. |
| `delete` | Removes the cell at zero-based `cell_id`. |

Cell indexes are zero-based and stable for a single command. Paths must be absolute.

## Model Experience

### `notebook_edit` tool schema

#### What the model sees

One tool named `notebook_edit`, documented as a schema whose parameters are `command`, `path`, `cell_id`, `cell_type`, `source`, `old_str`, `new_str`, and `cells`. The description states each command and which fields it requires, so the model can tell a required field from an ignored one without a separate prompt section. See [`@deepseek-ai/dsh-tool-notebook-edit`](../../../docs/tool-catalog.md#deepseek-aidsh-tool-notebook-edit) in the generated tool catalog.

#### Token effect

The description and all eight parameter descriptions are billed once per request as part of the stable prefix. A `view` result is capped at `maxOutputChars`; over the cap the model receives a clipped response with a note telling it to narrow the view or target one cell.

#### KV Cache effect

The schema is static, so it does not invalidate the cached prefix. Notebook content returns as an ordinary tool result and appends to the transcript.

### Notebook rewrites

#### What the model sees

Nothing directly. A mutating command's confirmation is the tool's own result text; the rewritten notebook is on disk and reaches the model only if it calls `view` again.

#### Token effect

Only the confirmation text. The full notebook is not echoed back, so a rewrite costs the same tokens regardless of notebook size.

#### KV Cache effect

None of its own; the confirmation appends as an ordinary tool result.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **Five commands, no cell execution** - the tool edits notebook JSON; it never runs a cell and never reads an output back beyond what `view` renders.
- **`str_replace` requires a unique literal match** - a fragment appearing twice in one cell is refused rather than resolved by position.
- **Source edits only** - `str_replace` and `insert` change a cell's source; cell metadata, outputs, and execution counts are preserved verbatim and cannot be edited.
- **Rewrites are whole-file** - a mutating command re-reads the notebook and writes the entire file back, so concurrent editors of the same path can lose work.
- **Absolute paths only** - a relative `path` is refused.

Fork-owned: `packages/fs/tool-notebook-edit` is Tier 1, so it touches no upstream file.
