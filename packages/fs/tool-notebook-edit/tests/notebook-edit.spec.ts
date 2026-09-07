import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { ToolCallId } from '@deepseek-ai/dsh-llm'
import { Session, SessionId } from '@deepseek-ai/dsh-session'
import AgentRegistry, { Inbox } from '@deepseek-ai/dsh-agent'
import type { Agent } from '@deepseek-ai/dsh-agent'
import LocalFileSystem from '@deepseek-ai/dsh-fs-local'
import * as FsPolicy from '@deepseek-ai/dsh-fs-observation-policy'
import SandboxedFileSystem from '@deepseek-ai/dsh-fs-sandbox'
import SandboxPolicy from '@deepseek-ai/dsh-sandbox-policy'
import SessionProjectionRegistry from '@deepseek-ai/dsh-session-projection'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import * as ToolNotebookEdit from '@deepseek-ai/dsh-tool-notebook-edit'

const contexts: Context[] = []
const roots: string[] = []
let callNumber = 0

afterEach(async () => {
  for (const ctx of contexts.splice(0)) await ctx.fiber.dispose()
  for (const root of roots.splice(0)) await rm(root, { recursive: true, force: true })
})

function agent(ctx: Context, cwd: string): Agent {
  const id = SessionId(`notebook-edit-owner-${callNumber}`)
  const scope = ctx.plugin(() => {})
  const session = Session.create(id, [], { version: 0, id, createdAt: 0, cwd })
  const value: Agent = {
    id,
    options: {},
    session,
    inbox: new Inbox(session, { inserted: () => {}, discarded: () => {}, claimed: () => {} }),
    status: 'idle',
    ctx: scope.ctx,
    send: () => {},
    followup: () => {},
    steer: () => ({ outcome: Promise.resolve({ status: 'rejected' as const }) }),
    inject: () => {},
    cancel() {},
    runMaintenance: task => task(new AbortController().signal),
    whenIdle: () => Promise.resolve(),
  }
  ctx.agents.register(value)
  return value
}

function text(result: { content: { type: string; text?: string }[] }): string {
  return result.content.filter(block => block.type === 'text').map(block => block.text).join('')
}

function expectToolError(
  result: Awaited<ReturnType<typeof call>>,
  messageContains: string,
  code?: string,
): void {
  expect(result.isError).toBe(true)
  if (!result.isError) return
  expect(result.error.message).toContain(messageContains)
  if (code !== undefined) expect(result.error.info?.code).toBe(code)
}

function call(ctx: Context, owner: Agent | undefined, args: unknown) {
  return ctx.tools.execute({
    signal: new AbortController().signal,
    callId: ToolCallId(`notebook-edit-${++callNumber}`),
    name: 'notebook_edit',
    arguments: args,
    ...owner === undefined ? {} : { agent: owner },
  })
}

async function setup(
  config: ToolNotebookEdit.Config = {},
  options: { fsPolicy?: boolean; sandboxMode?: 'read-only' | 'workspace-write' | 'danger-full-access' } = {},
) {
  const root = await mkdtemp(join(tmpdir(), 'dsh-tool-notebook-edit-'))
  roots.push(root)
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(SystemPrompt)
  await ctx.plugin(ToolRuntime)
  await ctx.plugin(AgentRegistry)
  if (options.sandboxMode === undefined) {
    await ctx.plugin(LocalFileSystem, { cwd: root })
  } else {
    await ctx.plugin(SessionProjectionRegistry)
    await ctx.plugin(SandboxPolicy, { mode: options.sandboxMode, workspaceRoot: root })
    await ctx.plugin(SandboxedFileSystem, { cwd: root })
  }
  if (options.fsPolicy === true) await ctx.plugin(FsPolicy)
  const fiber = await ctx.plugin(ToolNotebookEdit, config)
  return { ctx, root, fiber, owner: agent(ctx, root) }
}

function sampleNotebook(): string {
  return JSON.stringify({
    cells: [
      { cell_type: 'code', execution_count: 1, metadata: {}, outputs: [], source: ['print("hello")\n'] },
      { cell_type: 'markdown', metadata: {}, source: '# Title\n\nBody text\n' },
    ],
    metadata: { kernelspec: { display_name: 'Python 3', language: 'python', name: 'python3' } },
    nbformat: 4,
    nbformat_minor: 5,
  }, null, 2) + '\n'
}

describe('tool-notebook-edit', () => {
  it('registers the standalone schema and configurable description', async () => {
    const { ctx } = await setup({ description: 'custom notebook description' })
    const schemas = ctx.tools.schemas()
    expect(schemas.map(item => item.name)).toEqual(['notebook_edit'])
    expect(schemas[0]?.description).toBe('custom notebook description')
    const properties = (schemas[0]?.parameters as {
      properties: Record<string, { type?: string; oneOf?: { type?: string }[] }>
    }).properties
    expect(properties.command?.type).toBe('string')
    expect(properties.path?.type).toBe('string')
    expect(properties.cell_id?.oneOf?.map(option => option.type)).toEqual(['integer', 'null'])
    expect(properties.old_str?.oneOf?.map(option => option.type)).toEqual(['string', 'null'])
    expect(properties.new_str?.oneOf?.map(option => option.type)).toEqual(['string', 'null'])
    expect(properties.cells?.oneOf?.map(option => option.type)).toEqual(['array', 'null'])
  })

  it('views a notebook with zero-based indexed cells and padded source', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'a.ipynb')
    await writeFile(path, sampleNotebook(), 'utf8')
    const result = await call(ctx, owner, { command: 'view', path })
    const body = text(result)
    expect(body).toContain('Here is the notebook')
    expect(body).toContain('with 2 cells')
    expect(body).toContain('[0] code (execution 1)')
    expect(body).toContain('print("hello")')
    expect(body).toContain('[1] markdown')
    expect(body).toContain('# Title')
  })

  it('creates an empty notebook and refuses to overwrite', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'new.ipynb')
    const result = await call(ctx, owner, { command: 'create', path })
    expect(text(result)).toContain('created successfully')
    const record = JSON.parse(await readFile(path, 'utf8')) as Record<string, unknown>
    expect(record.cells).toEqual([])
    expect(record.nbformat).toBe(4)
    expect(record.nbformat_minor).toBe(5)
    expectToolError(await call(ctx, owner, { command: 'create', path }), 'already exists')
  })

  it('creates a notebook from provided cells', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'seeded.ipynb')
    const cells = [
      { cell_type: 'markdown', metadata: {}, source: '# Hi\n' },
      { cell_type: 'code', execution_count: null, metadata: {}, outputs: [], source: '1 + 1\n' },
    ]
    await call(ctx, owner, { command: 'create', path, cells })
    const record = JSON.parse(await readFile(path, 'utf8')) as { cells: unknown[] }
    expect(record.cells).toHaveLength(2)
    expect((record.cells[1] as { cell_type: string }).cell_type).toBe('code')
  })

  it('str_replaces one unique literal inside one cell', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'a.ipynb')
    await writeFile(path, sampleNotebook(), 'utf8')
    const result = await call(ctx, owner, { command: 'str_replace', path, cell_id: 1, old_str: 'Body text', new_str: 'Replacement' })
    expect(text(result)).toContain('edited successfully')
    const record = JSON.parse(await readFile(path, 'utf8')) as { cells: { source: string | string[] }[] }
    const source = record.cells[1]?.source
    expect(Array.isArray(source) ? source.join('') : source).toContain('Replacement')
  })

  it('rejects an ambiguous str_replace target', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'dup.ipynb')
    const record = {
      cells: [{ cell_type: 'markdown', metadata: {}, source: 'x x x\n' }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }
    await writeFile(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
    expectToolError(await call(ctx, owner, { command: 'str_replace', path, cell_id: 0, old_str: 'x' }), 'Multiple occurrences', 'FS_AMBIGUOUS_EDIT')
  })

  it('inserts a cell at the requested zero-based position', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'a.ipynb')
    await writeFile(path, sampleNotebook(), 'utf8')
    await call(ctx, owner, { command: 'insert', path, cell_id: 1, cell_type: 'markdown', source: 'Inserted\n' })
    const record = JSON.parse(await readFile(path, 'utf8')) as { cells: { cell_type: string; source: string | string[] }[] }
    expect(record.cells).toHaveLength(3)
    const middle = record.cells[1]?.source
    expect(Array.isArray(middle) ? middle.join('') : middle).toBe('Inserted\n')
  })

  it('deletes the requested cell', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'a.ipynb')
    await writeFile(path, sampleNotebook(), 'utf8')
    await call(ctx, owner, { command: 'delete', path, cell_id: 0 })
    const record = JSON.parse(await readFile(path, 'utf8')) as { cells: unknown[] }
    expect(record.cells).toHaveLength(1)
  })

  it('rejects malformed notebook JSON with FS_NOT_TEXT', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'bad.ipynb')
    await writeFile(path, 'not json', 'utf8')
    expectToolError(await call(ctx, owner, { command: 'view', path }), 'not valid JSON', 'FS_NOT_TEXT')
  })

  it('rejects an unsupported cell type', async () => {
    const { ctx, root, owner } = await setup()
    const path = join(root, 'weird.ipynb')
    const record = {
      cells: [{ cell_type: 'magic', metadata: {}, source: 'x\n' }],
      metadata: {},
      nbformat: 4,
      nbformat_minor: 5,
    }
    await writeFile(path, JSON.stringify(record, null, 2) + '\n', 'utf8')
    expectToolError(await call(ctx, owner, { command: 'view', path }), 'unsupported cell_type', 'FS_NOT_TEXT')
  })

  it('enforces read-before-edit through the observation policy', async () => {
    const { ctx, root, owner } = await setup({}, { fsPolicy: true })
    const path = join(root, 'a.ipynb')
    await writeFile(path, sampleNotebook(), 'utf8')
    expectToolError(
      await call(ctx, owner, { command: 'str_replace', path, cell_id: 1, old_str: 'Body text', new_str: 'Nope' }),
      'first',
      'FS_NOT_OBSERVED',
    )
  })
})
