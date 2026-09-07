/**
 * Model-facing `notebook_edit` over the Harness filesystem seam.
 * @module @deepseek-ai/dsh-tool-notebook-edit
 */

import { isAbsolute } from 'node:path'
import type { Context } from '@deepseek-ai/cordis'
import z from '@deepseek-ai/schemastery'
import { FsError } from '@deepseek-ai/dsh-fs'
import type { FsInfo, FsTarget, FsWriteIntent } from '@deepseek-ai/dsh-fs'
import { sandboxDenialMarker } from '@deepseek-ai/dsh-sandbox'
import type { SandboxExecutionPolicy } from '@deepseek-ai/dsh-sandbox'
import type { SandboxPolicyService } from '@deepseek-ai/dsh-sandbox-policy'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolCallView, ToolRunContext } from '@deepseek-ai/dsh-tools'

/** Jupyter cell kinds this tool understands; anything else is refused. */
const CELL_TYPES = ['code', 'markdown', 'raw'] as const
type NotebookCellType = typeof CELL_TYPES[number]

/** nbformat values stamped on newly created notebooks. */
const DEFAULT_NBFORMAT = 4
const DEFAULT_NBFORMAT_MINOR = 5

const TRUNCATED_MESSAGE = '<response clipped><NOTE>To save on context only part of this notebook has been shown. Narrow the view or target a single cell to inspect the rest.</NOTE>'

const DEFAULT_DESCRIPTION = [
  'Editing tool for Jupyter (.ipynb) notebooks. One schema, five commands.',
  '',
  "- 'view' renders every cell: zero-based index, cell type, code execution",
  "  count (or 'unexecuted'), and the cell source indented two spaces. It does",
  '  not modify the notebook.',
  "- 'create' writes a new notebook and refuses to overwrite an existing path.",
  "  Omit 'cells' for an empty notebook, or pass a JSON array of nbformat cells",
  "  (each with 'cell_type' and 'source').",
  "- 'str_replace' replaces one literal 'old_str' inside the 'cell_id' cell's",
  "  source. The match must be exact and unique within that cell; omit 'new_str'",
  '  (never null) to delete the match.',
  "- 'insert' adds a new cell at zero-based 'cell_id' (0 prepends, the cell",
  "  count appends) with 'cell_type' and 'source'.",
  "- 'delete' removes the cell at zero-based 'cell_id'.",
  '',
  'Cell indexes are zero-based and stable for a single command. Paths must be',
  'absolute. Mutating commands re-read the notebook and write the whole file',
  'back through the mounted filesystem policy.',
].join('\n')

interface NotebookCell {
  /** Zero-based position within the cells array. */
  index: number
  /** Normalized cell type. */
  cellType: NotebookCellType
  /** The cell source as one flat string, for viewing and literal editing. */
  source: string
  /** The parsed cell object verbatim (preserved byte-for-byte on rewrite). */
  record: Record<string, unknown>
}

interface Notebook {
  cells: NotebookCell[]
  /** The parsed top-level notebook object verbatim. */
  record: Record<string, unknown>
}

function isPlainRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/** Parse one cell source (nbformat allows a string or a list of strings). */
function normalizeSource(source: unknown, where: string): string {
  if (typeof source === 'string') return source
  if (Array.isArray(source) && source.every(line => typeof line === 'string')) {
    return source.join('')
  }
  throw new FsError(
    `notebook_edit: ${where} has an invalid 'source'; expected a string or an array of strings`,
    'FS_NOT_TEXT',
  )
}

/** Parse and normalize the smallest valid notebook shape. */
function parseNotebook(raw: string, displayPath: string): Notebook {
  let data: unknown
  try {
    data = JSON.parse(raw)
  } catch (error) {
    throw new FsError(
      `notebook_edit: ${displayPath} is not valid JSON; expected an .ipynb notebook`,
      'FS_NOT_TEXT',
      { cause: error },
    )
  }
  if (!isPlainRecord(data)) {
    throw new FsError(`notebook_edit: ${displayPath} is not a JSON object`, 'FS_NOT_TEXT')
  }
  if (!Array.isArray(data.cells)) {
    throw new FsError(`notebook_edit: ${displayPath} is missing a top-level 'cells' array`, 'FS_NOT_TEXT')
  }
  const cells = data.cells.map((rawCell, index): NotebookCell => {
    if (!isPlainRecord(rawCell)) {
      throw new FsError(`notebook_edit: ${displayPath} cell ${index} is not an object`, 'FS_NOT_TEXT')
    }
    const cellType = rawCell.cell_type
    if (typeof cellType !== 'string' || !(CELL_TYPES as readonly string[]).includes(cellType)) {
      throw new FsError(
        `notebook_edit: ${displayPath} cell ${index} has unsupported cell_type ${JSON.stringify(cellType)}`,
        'FS_NOT_TEXT',
      )
    }
    return {
      index,
      cellType: cellType as NotebookCellType,
      source: normalizeSource(rawCell.source, `${displayPath} cell ${index}`),
      record: rawCell,
    }
  })
  return { cells, record: data }
}

/** Serialize a notebook, applying source edits for changed cells. */
function serializeNotebook(notebook: Notebook, edits: Map<number, string>): string {
  const cells = notebook.cells.map((cell) => {
    const nextSource = edits.get(cell.index)
    return nextSource === undefined ? cell.record : { ...cell.record, source: nextSource }
  })
  return JSON.stringify({ ...notebook.record, cells }, null, 2) + '\n'
}

/** Build a fresh, minimal cell record for 'insert' and 'create' paths. */
function buildCellRecord(cellType: NotebookCellType, source: string): Record<string, unknown> {
  if (cellType === 'code') {
    return { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source }
  }
  return { cell_type: cellType, metadata: {}, source }
}

/** Normalize caller-provided cells for 'create'. */
function parseCellsInput(cells: unknown): NotebookCell[] {
  if (!Array.isArray(cells)) {
    throw new FsError("notebook_edit: 'cells' must be a JSON array of notebook cells", 'FS_NOT_TEXT')
  }
  return cells.map((rawCell, index): NotebookCell => {
    if (!isPlainRecord(rawCell)) {
      throw new FsError(`notebook_edit: 'cells' item ${index} is not an object`, 'FS_NOT_TEXT')
    }
    const cellType = rawCell.cell_type
    if (typeof cellType !== 'string' || !(CELL_TYPES as readonly string[]).includes(cellType)) {
      throw new FsError(
        `notebook_edit: 'cells' item ${index} has unsupported cell_type ${JSON.stringify(cellType)}`,
        'FS_NOT_TEXT',
      )
    }
    return {
      index,
      cellType: cellType as NotebookCellType,
      source: normalizeSource(rawCell.source, `'cells' item ${index}`),
      record: rawCell,
    }
  })
}

function maybeTruncate(content: string, maxOutputChars: number): string {
  return content.length <= maxOutputChars
    ? content
    : content.slice(0, maxOutputChars) + TRUNCATED_MESSAGE
}

function formatNotebookView(path: string, notebook: Notebook, maxOutputChars: number): string {
  const rows: string[] = [`Here is the notebook ${path} with ${notebook.cells.length} cells:`]
  for (const cell of notebook.cells) {
    let execution = ''
    if (cell.cellType === 'code') {
      const count = cell.record.execution_count
      execution = typeof count === 'number' ? ` (execution ${count})` : ' (unexecuted)'
    }
    rows.push(`[${cell.index}] ${cell.cellType}${execution}`)
    for (const line of cell.source.split('\n')) rows.push(`  ${line}`)
  }
  return maybeTruncate(rows.join('\n') + '\n', maxOutputChars)
}

class MutationPolicy {
  private readonly policy: SandboxPolicyService | undefined

  constructor(ctx: Context) {
    this.policy = ctx.fs.sandboxMode === undefined ? undefined : ctx.get('sandboxPolicy')
    if (ctx.fs.sandboxMode !== undefined && this.policy === undefined) {
      throw new Error('tool-notebook-edit: the mounted filesystem confines but ctx.sandboxPolicy is missing')
    }
  }

  resolve(exec: ToolRunContext): SandboxExecutionPolicy | undefined {
    return this.policy?.resolve({
      ...exec.agent === undefined ? {} : { session: exec.agent.session },
    })
  }

  mapError(error: unknown, policy: SandboxExecutionPolicy | undefined): unknown {
    if (!(error instanceof FsError) || error.code !== 'FS_SANDBOX_DENIED') return error
    const mode = (policy as SandboxExecutionPolicy).mode
    return new FsError(sandboxDenialMarker(mode), 'FS_SANDBOX_DENIED', { cause: error })
  }
}

async function resolveTarget(ctx: Context, path: string, signal: AbortSignal): Promise<FsTarget> {
  if (path.trim().length === 0) throw new Error('path must be a non-empty string')
  if (!isAbsolute(path)) {
    throw new Error(`The path ${path} is not an absolute path, it should start with '/'. Maybe you meant /${path}?`)
  }
  return ctx.fs.resolve(path, { signal })
}

async function statExisting(ctx: Context, target: FsTarget, exec: ToolRunContext): Promise<FsInfo> {
  const info = await ctx.fs.stat(target, exec.signal)
  if (info === undefined) {
    ctx.emit('fs/observed', target, { kind: 'absent' }, exec)
    throw new FsError(
      `The path ${target.displayPath} does not exist. Please provide a valid path.`,
      'FS_NOT_FOUND',
    )
  }
  if (info.type === 'directory') {
    throw new FsError(
      `The path ${target.displayPath} is a directory; 'notebook_edit' only edits .ipynb files`,
      'FS_NOT_REGULAR_FILE',
    )
  }
  return info
}

async function readNotebook(ctx: Context, target: FsTarget, exec: ToolRunContext): Promise<Notebook> {
  const content = await ctx.fs.readText(target, exec.signal)
  return parseNotebook(content, target.displayPath)
}

function requireCellIndex(value: number | undefined, command: 'str_replace' | 'insert' | 'delete', cellCount: number): number {
  if (value === undefined) {
    throw new Error(`Parameter 'cell_id' is required for command: ${command}`)
  }
  if (!Number.isInteger(value)) {
    throw new Error(`Parameter 'cell_id' must be an integer for command: ${command}`)
  }
  const upper = command === 'insert' ? cellCount : cellCount - 1
  if (value < 0 || value > upper) {
    throw new Error(`Invalid 'cell_id' ${value} for command '${command}': expected an integer in [0, ${upper}]`)
  }
  return value
}

async function writeNotebook(
  ctx: Context,
  policy: MutationPolicy,
  target: FsTarget,
  intent: FsWriteIntent,
  notebook: Notebook,
  edits: Map<number, string>,
  exec: ToolRunContext,
): Promise<void> {
  const sandboxPolicy = policy.resolve(exec)
  const next = serializeNotebook(notebook, edits)
  let outcome
  try {
    outcome = await ctx.fs.writeText(target, next, intent, exec.signal, sandboxPolicy)
  } catch (error: unknown) {
    throw policy.mapError(error, sandboxPolicy)
  }
  ctx.emit('fs/observed', target, { kind: 'present', version: outcome.version }, exec)
}

async function viewNotebook(ctx: Context, path: string, maxOutputChars: number, exec: ToolRunContext): Promise<string> {
  const target = await resolveTarget(ctx, path, exec.signal)
  const info = await statExisting(ctx, target, exec)
  const notebook = await readNotebook(ctx, target, exec)
  ctx.emit('fs/observed', target, { kind: 'present', version: info.version }, exec)
  return formatNotebookView(target.displayPath, notebook, maxOutputChars)
}

async function createNotebook(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  cells: unknown,
  exec: ToolRunContext,
): Promise<string> {
  const target = await resolveTarget(ctx, path, exec.signal)
  if (await ctx.fs.stat(target, exec.signal) !== undefined) {
    throw new Error(`File already exists at: ${target.displayPath}. Cannot overwrite files using command 'create'.`)
  }
  const intent: FsWriteIntent = await ctx.waterfall('fs/write-intent', target, exec, () => ({ kind: 'createIfAbsent' } as const)) ?? { kind: 'createIfAbsent' }
  const notebookCells = cells === undefined ? [] : parseCellsInput(cells)
  const record: Record<string, unknown> = {
    cells: notebookCells.map(cell => cell.record),
    metadata: {},
    nbformat: DEFAULT_NBFORMAT,
    nbformat_minor: DEFAULT_NBFORMAT_MINOR,
  }
  const notebook: Notebook = { cells: notebookCells, record }
  await writeNotebook(ctx, policy, target, intent, notebook, new Map(), exec)
  return `New notebook created successfully at: ${target.displayPath}`
}

async function strReplaceCell(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  cellIndex: number | undefined,
  oldStr: string,
  newStr: string,
  exec: ToolRunContext,
): Promise<string> {
  const target = await resolveTarget(ctx, path, exec.signal)
  const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const info = await statExisting(ctx, target, exec)
  const notebook = await readNotebook(ctx, target, exec)
  const index = requireCellIndex(cellIndex, 'str_replace', notebook.cells.length)
  const cell = notebook.cells.find(candidate => candidate.index === index)
  if (cell === undefined) {
    throw new FsError(`notebook_edit: cell ${index} is missing from ${target.displayPath}`, 'FS_NOT_TEXT')
  }
  const offsets: number[] = []
  let offset = 0
  while (true) {
    const match = cell.source.indexOf(oldStr, offset)
    if (match < 0) break
    offsets.push(match)
    offset = match + oldStr.length
  }
  if (offsets.length === 0) {
    throw new FsError(
      `No replacement was performed, old_str '${oldStr}' did not appear verbatim in ${target.displayPath} cell ${index}.`,
      'FS_EDIT_NOT_FOUND',
    )
  }
  if (offsets.length > 1) {
    throw new FsError(
      `No replacement was performed. Multiple occurrences of old_str '${oldStr}' in ${target.displayPath} cell ${index}. Please ensure it is unique`,
      'FS_AMBIGUOUS_EDIT',
    )
  }
  const matchOffset = offsets[0] ?? 0
  const replacement = cell.source.slice(0, matchOffset) + newStr + cell.source.slice(matchOffset + oldStr.length)
  const expected: FsWriteIntent = intent === undefined
    ? { kind: 'replaceIfVersion', version: info.version }
    : { kind: 'replaceIfVersion', version: intent.version }
  await writeNotebook(ctx, policy, target, expected, notebook, new Map([[index, replacement]]), exec)
  return `The notebook ${target.displayPath} has been edited successfully.`
}

async function insertCell(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  cellIndex: number | undefined,
  cellType: NotebookCellType,
  source: string,
  exec: ToolRunContext,
): Promise<string> {
  const target = await resolveTarget(ctx, path, exec.signal)
  const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const info = await statExisting(ctx, target, exec)
  const notebook = await readNotebook(ctx, target, exec)
  const index = requireCellIndex(cellIndex, 'insert', notebook.cells.length)
  const newRecord = buildCellRecord(cellType, source)
  const cells: NotebookCell[] = [
    ...notebook.cells.slice(0, index),
    { index, cellType, source, record: newRecord },
    ...notebook.cells.slice(index),
  ]
  cells.forEach((cell, position) => { cell.index = position })
  const record: Record<string, unknown> = { ...notebook.record, cells: cells.map(cell => cell.record) }
  const expected: FsWriteIntent = intent === undefined
    ? { kind: 'replaceIfVersion', version: info.version }
    : { kind: 'replaceIfVersion', version: intent.version }
  await writeNotebook(ctx, policy, target, expected, { cells, record }, new Map(), exec)
  return `The notebook ${target.displayPath} has been edited successfully.`
}

async function deleteCell(
  ctx: Context,
  policy: MutationPolicy,
  path: string,
  cellIndex: number | undefined,
  exec: ToolRunContext,
): Promise<string> {
  const target = await resolveTarget(ctx, path, exec.signal)
  const intent = await ctx.waterfall('fs/edit-intent', target, exec, () => undefined)
  const info = await statExisting(ctx, target, exec)
  const notebook = await readNotebook(ctx, target, exec)
  const index = requireCellIndex(cellIndex, 'delete', notebook.cells.length)
  const cells = notebook.cells.filter(cell => cell.index !== index)
  cells.forEach((cell, position) => { cell.index = position })
  const expected: FsWriteIntent = intent === undefined
    ? { kind: 'replaceIfVersion', version: info.version }
    : { kind: 'replaceIfVersion', version: intent.version }
  const record: Record<string, unknown> = { ...notebook.record, cells: cells.map(cell => cell.record) }
  await writeNotebook(ctx, policy, target, expected, { cells, record }, new Map(), exec)
  return `The notebook ${target.displayPath} has been edited successfully.`
}

interface ResolvedConfig {
  maxOutputChars: number
  description: string
}

function presentEditorCall(args: {
  command: 'view' | 'create' | 'str_replace' | 'insert' | 'delete'
  path: string
}): ToolCallView {
  const title = `${args.command} ${args.path}`
  if (args.command === 'view') {
    return { card: 'generic', title, kind: 'read', locations: [{ path: args.path }] }
  }
  return { card: 'generic', title, kind: 'edit', locations: [{ path: args.path }] }
}

function registerNotebookEditor(ctx: Context, config: ResolvedConfig): void {
  const policy = new MutationPolicy(ctx)
  ctx.tools.register(defineTool({
    name: 'notebook_edit',
    description: config.description,
    parameters: {
      command: {
        type: 'string',
        required: true,
        enum: ['view', 'create', 'str_replace', 'insert', 'delete'],
        description: "The command to run. Allowed options are: 'view', 'create', 'str_replace', 'insert', 'delete'.",
      },
      path: {
        type: 'string',
        required: true,
        description: 'Absolute path to the .ipynb notebook, e.g. /repo/analysis.ipynb.',
      },
      cell_id: {
        oneOf: [{ type: 'integer' }, { type: 'null' }],
        description: "Zero-based cell index. Required by 'str_replace', 'insert', and 'delete'; ignored by other commands.",
      },
      cell_type: {
        oneOf: [{ type: 'string', enum: [...CELL_TYPES] }, { type: 'null' }],
        description: "Cell type for 'insert' and 'create' cells: 'code', 'markdown', or 'raw'. Required by 'insert'; ignored otherwise.",
      },
      source: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: "Cell source for 'insert'. Required by 'insert'; ignored otherwise.",
      },
      old_str: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: "Required string of 'str_replace': the literal cell-source fragment to replace (must be unique within the target cell).",
      },
      new_str: {
        oneOf: [{ type: 'string' }, { type: 'null' }],
        description: "Optional replacement string of 'str_replace'; omit (never null) to delete the match.",
      },
      cells: {
        oneOf: [{ type: 'array' }, { type: 'null' }],
        description: "Optional JSON array of cells for 'create'; each cell is an nbformat object with 'cell_type' and 'source'.",
      },
    },
    output: {
      schema: { type: 'string' },
      render: (_args, value) => [{ type: 'text', text: value }],
    },
    async execute(args, exec) {
      switch (args.command) {
        case 'view':
          return viewNotebook(ctx, args.path, config.maxOutputChars, exec)
        case 'create':
          return createNotebook(ctx, policy, args.path, args.cells ?? undefined, exec)
        case 'str_replace':
          return strReplaceCell(ctx, policy, args.path, args.cell_id ?? undefined, args.old_str ?? '', args.new_str ?? '', exec)
        case 'insert': {
          if (args.cell_type === null || args.cell_type === undefined) {
            throw new Error("Parameter 'cell_type' is required for command: insert")
          }
          if (args.source === null || args.source === undefined) {
            throw new Error("Parameter 'source' is required for command: insert")
          }
          if (!(CELL_TYPES as readonly string[]).includes(args.cell_type)) {
            throw new Error(`Invalid 'cell_type' ${JSON.stringify(args.cell_type)} for command: insert`)
          }
          return insertCell(ctx, policy, args.path, args.cell_id ?? undefined, args.cell_type, args.source, exec)
        }
        case 'delete':
          return deleteCell(ctx, policy, args.path, args.cell_id ?? undefined, exec)
      }
    },
    presentCall: presentEditorCall,
  }))
}

export const name = 'tool-notebook-edit'
export const inject = ['tools', 'fs']

/** Configuration for the notebook editor tool. */
export interface Config {
  /** Maximum returned view characters before clipping (default 16000). */
  maxOutputChars?: number
  /** Model-facing tool description. */
  description?: string
}

/** Runtime configuration schema for the notebook editor tool. */
export const Config: z<Config> = z.object({
  maxOutputChars: z.number().default(16_000),
  description: z.string().default(DEFAULT_DESCRIPTION),
})

/** Register one 'notebook_edit' tool over ctx.fs. */
export function apply(ctx: Context, config: Config): void {
  const resolved: ResolvedConfig = {
    maxOutputChars: config.maxOutputChars ?? 16_000,
    description: config.description ?? DEFAULT_DESCRIPTION,
  }
  if (!Number.isSafeInteger(resolved.maxOutputChars) || resolved.maxOutputChars <= 0) {
    throw new Error('tool-notebook-edit: maxOutputChars must be a positive safe integer')
  }
  if (resolved.description.trim().length === 0) {
    throw new Error('tool-notebook-edit: description must be non-empty')
  }
  registerNotebookEditor(ctx, resolved)
}
