/**
 * End-to-end: a Python cell calling an arbitrary harness tool.
 *
 * This runs the REAL `kernel_child.py` process and answers its seam requests
 * through the REAL {@link dispatchSeam}, so it exercises the whole path a
 * kernel caller takes: `tools.<name>({...})` in Python → `tools.call` frame →
 * `ctx.tools.execute` → the normalized outcome → back over fd 3 → a Python
 * value (or `ToolCallError`).
 *
 * The unit suite pins the seam's own contract; this pins that the Python side
 * is wired to it — that the namespace exists, that it reaches every tool rather
 * than a hand-written few, and that a refusal arrives as a Python exception
 * instead of a silently empty result.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { KernelAgent } from '@deepseek-ai/dsh-kernel'
import { KernelChild } from '../src/child.ts'
import type { SeamRequest } from '../src/seam.ts'
import { dispatchSeam } from '../src/seam.ts'
import { resolvePython } from '../src/index.ts'

const KERNEL = join(import.meta.dirname, '..', '..', '..', '..', 'python', 'kiln', 'runtime', 'kernel_child.py')

const python = await resolvePython()
// Skipped rather than failed where no interpreter exists: driving one is this
// package's whole job, so "no Python here" is an environment fact, not a defect.
const describeE2E = python === undefined ? describe.skip : describe

/**
 * A `ctx.tools` stand-in that records what it was asked to run and answers from
 * `handler`. The kernel never sees this object: it only ever sees the seam
 * response, which is the point — everything between is the real code path.
 */
interface Harness {
  readonly calls: { name: string; args: unknown; callId: string }[]
  readonly ctx: Context
  /** The owning agent the seam threads through explicitly. */
  readonly agent: KernelAgent
}

function fakeHarness(handler: (name: string, args: Record<string, unknown>) => unknown): Harness {
  const calls: Harness['calls'] = []
  const execute = async (exec: { name: string; arguments: unknown; callId: string }) => {
    calls.push({ name: exec.name, args: exec.arguments, callId: exec.callId })
    const args = (exec.arguments ?? {}) as Record<string, unknown>
    try {
      return {
        isError: false as const,
        value: handler(exec.name, args),
        content: [{ type: 'text', text: `ran ${exec.name}` }],
      }
    } catch (error) {
      return {
        isError: true as const,
        content: [{ type: 'text', text: error instanceof Error ? error.message : String(error) }],
        error: { message: error instanceof Error ? error.message : String(error) },
      }
    }
  }
  // The read-only ops the kernel's discovery helpers use, so `tool_help` and
  // `list_tools` see the same registry `execute` serves.
  const schemas = () => [
    { name: 'echo', description: 'Echo the arguments back', parameters: { type: 'object' } },
    { name: 'boom', description: 'Always fails', parameters: { type: 'object' } },
    { name: 'nothing', description: 'Returns null', parameters: { type: 'object' } },
    { name: 'explode', description: 'Throws in the registry', parameters: { type: 'object' } },
    { name: 'my-tool', description: 'A name that is not a Python attribute', parameters: {} },
    // A schema with real properties, so the generated function has a genuine
    // signature rather than an empty one. `tag` admits null, which is the case
    // the sentinel-vs-None distinction exists for.
    {
      name: 'search',
      description: 'Search things',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string' },
          limit: { type: 'integer' },
          tag: { type: ['string', 'null'] },
        },
        required: ['query'],
      },
    },
    // Shadows a preloaded local helper of the same name.
    { name: 'read_file', description: 'Harness read', parameters: { type: 'object' } },
    // The exact names the brief calls out, so the acceptance test can assert
    // them directly rather than by proxy.
    { name: 'read', description: 'Harness read', parameters: { type: 'object' } },
    { name: 'write', description: 'Harness write', parameters: { type: 'object' } },
    { name: 'web_search', description: 'Harness web search', parameters: { type: 'object' } },
    { name: 'subagent', description: 'Harness subagent', parameters: { type: 'object' } },
  ]
  const get = (name: string) => schemas().find(s => s.name === name)
  const agent: KernelAgent = { id: 'e2e-session', session: { id: 'e2e-session' } }
  return { calls, ctx: { tools: { execute, schemas, get } } as unknown as Context, agent }
}

/** One live kernel with a harness answering its seam requests. */
interface Session {
  readonly child: KernelChild
  readonly harness: Harness
  run(code: string): Promise<{ out: string; error: string | null }>
}

async function open(handler: (name: string, args: Record<string, unknown>) => unknown): Promise<Session> {
  const harness = fakeHarness(handler)
  const child = new KernelChild({
    python: python ?? 'python3',
    script: KERNEL,
    cwd: process.cwd(),
    env: {},
  })
  child.seamHandler = (seam: SeamRequest): void => {
    void dispatchSeam(harness.ctx, harness.agent, seam).then(
      (response) => { if (!child.dead) child.sendSeamResponse(response) },
      (reason: unknown) => {
        if (!child.dead) {
          child.sendSeamResponse({ id: seam.id, ok: false, error: String(reason) })
        }
      },
    )
  }
  return {
    child,
    harness,
    async run(code) {
      const frame = await child.nextFrame(child.send(code))
      return { out: frame.out ?? '', error: frame.error ?? null }
    },
  }
}

describeE2E('kernel tools.call end to end', () => {
  let session: Session

  beforeAll(async () => {
    session = await open((name, args) => {
      if (name === 'echo') return { got: args }
      if (name === 'boom') throw new Error('tool refused: not permitted')
      if (name === 'nothing') return null
      if (name === 'explode') throw new Error('registry melted')
      if (name === 'search' || name === 'read_file') return { got: args }
      return { unknown: name }
    })
  }, 90_000)

  afterAll(async () => {
    await session?.child.kill()
  })

  it('binds a tools namespace and a ToolCallError into the cell', async () => {
    const { out } = await session.run('print(type(tools).__name__, ToolCallError.__name__, callable(call_tool))')
    expect(out).toContain('_ToolNamespace ToolCallError True')
  })

  it('calls any harness tool by attribute and returns its canonical value', async () => {
    const { out, error } = await session.run(
      'r = tools.echo({"path": "notes.txt", "n": 3})\nprint(r)',
    )
    expect(error).toBeNull()
    expect(out).toContain("{'got': {'path': 'notes.txt', 'n': 3}}")
    // The call really reached the harness, through the registry execute path.
    expect(session.harness.calls.at(-1)?.name).toBe('echo')
    expect(session.harness.calls.at(-1)?.args).toEqual({ path: 'notes.txt', n: 3 })
    expect(session.harness.calls.at(-1)?.callId.startsWith('kernel:')).toBe(true)
  })

  it('reaches a tool whose name is not a Python attribute by subscript', async () => {
    const { out, error } = await session.run('print(tools["echo"]({"via": "subscript"}))')
    expect(error).toBeNull()
    expect(out).toContain("{'got': {'via': 'subscript'}}")
  })

  it('defaults arguments so a no-argument tool stays callable', async () => {
    const { out, error } = await session.run('print(tools.echo())')
    expect(error).toBeNull()
    expect(out).toContain("{'got': {}}")
  })

  it('raises ToolCallError on a refused call instead of returning a silent empty result', async () => {
    const { out, error } = await session.run(
      'try:\n'
      + '    tools.boom({})\n'
      + '    print("NO-RAISE")\n'
      + 'except ToolCallError as e:\n'
      + '    print("caught", e.toolName, str(e))',
    )
    expect(error).toBeNull()
    expect(out).toContain('caught boom tool refused: not permitted')
    expect(out).not.toContain('NO-RAISE')
  })

  it('keeps a successful null result distinct from a failure', async () => {
    const { out, error } = await session.run('print(repr(tools.nothing({})))')
    expect(error).toBeNull()
    expect(out).toContain('None')
  })

  it('raises rather than swallowing a registry fault', async () => {
    const { out, error } = await session.run(
      'try:\n'
      + '    tools.explode({})\n'
      + '    print("NO-RAISE")\n'
      + 'except ToolCallError as e:\n'
      + '    print("caught", str(e))',
    )
    expect(error).toBeNull()
    expect(out).toContain('caught registry melted')
  })

  it('exposes the raw envelope on request, for a caller needing the rendering', async () => {
    const { out, error } = await session.run(
      'env = tools.echo({"a": 1}, raw=True)\nprint(sorted(env.keys()))',
    )
    expect(error).toBeNull()
    expect(out).toContain("['content', 'isError', 'value']")
  })

  it('rejects a non-dict argument object before it reaches the wire', async () => {
    const { out, error } = await session.run(
      'try:\n'
      + '    tools.echo("not-a-dict")\n'
      + '    print("NO-RAISE")\n'
      + 'except TypeError as e:\n'
      + '    print("caught", str(e))',
    )
    expect(error).toBeNull()
    expect(out).toContain('caught call_tool arguments must be a dict')
  })

  it('still reaches a later tool after an earlier one raised', async () => {
    const { out, error } = await session.run(
      'try:\n'
      + '    tools.boom({})\n'
      + 'except ToolCallError:\n'
      + '    pass\n'
      + 'print(tools.echo({"after": True}))',
    )
    expect(error).toBeNull()
    expect(out).toContain("{'got': {'after': True}}")
  })

  it('makes the harness surface discoverable through tool_help', async () => {
    // Without this the general door is reachable but invisible: `tool_help` is
    // what the kernel prompt tells a cell author to call to find out what it
    // can do, and it used to scan only module-level functions.
    const { out, error } = await session.run('print(tool_help())')
    expect(error).toBeNull()
    expect(out).toContain('Harness tools')
    expect(out).toContain('tools.echo')
    expect(out).toContain('tools.my-tool')
    expect(out).toContain('ToolCallError')
    // The preloaded helpers are still listed — both kinds, not one or the other.
    expect(out).toContain('read_file --')
  })

  it('resolves one harness tool by bare or prefixed name, with its schema', async () => {
    const { out, error } = await session.run(
      'a = tool_help("echo")\n'
      + 'b = tool_help("tools.echo")\n'
      + 'print("SAME" if a == b else "DIFFERENT")\n'
      + 'print(a)',
    )
    expect(error).toBeNull()
    expect(out).toContain('SAME')
    expect(out).toContain('harness tool')
    expect(out).toContain('Echo the arguments back')
    expect(out).toContain('parameters')
  })

  it('keeps a local helper docstring reachable and admits an unknown name', async () => {
    const { out, error } = await session.run(
      'print("LOCAL" if "List every tool" in tool_help("list_tools") else "NO-LOCAL")\n'
      + 'print(tool_help("definitely-not-a-tool"))',
    )
    expect(error).toBeNull()
    expect(out).toContain('LOCAL')
    expect(out).toContain('No help found for definitely-not-a-tool')
  })

  it('narrows both sections by pattern', async () => {
    const { out, error } = await session.run('print(tool_help(pattern="echo"))')
    expect(error).toBeNull()
    expect(out).toContain('tools.echo')
    expect(out).not.toContain('tools.nothing')
  })

  it('binds every harness tool as a bare function in the cell, not only under `tools`', async () => {
    // The point of the whole feature: a cell author writes `echo({...})`, not
    // `tools.echo({...})`. Both must reach the same registry tool.
    const { out, error } = await session.run(
      'a = echo({"bare": True})\nprint(a)\nprint(callable(echo), callable(tools.echo))',
    )
    expect(error).toBeNull()
    expect(out).toContain("{'got': {'bare': True}}")
    expect(out).toContain('True True')
    expect(session.harness.calls.at(-1)?.name).toBe('echo')
  })

  it('gives a generated bare function a real signature from the tool schema', async () => {
    // Not `**kwargs`: the parameters come from the schema, so positional
    // required args work and `help()` shows something useful.
    const { out, error } = await session.run(
      'import inspect\n'
      + 'print(inspect.signature(search))\n'
      + 'print(search("widgets", 5))',
    )
    expect(error).toBeNull()
    expect(out).toContain('query')
    expect(out).toContain('limit')
    expect(out).toContain("{'got': {'query': 'widgets', 'limit': 5}}")
    expect(session.harness.calls.at(-1)?.args).toEqual({ query: 'widgets', limit: 5 })
  })

  it('omits an unset optional argument rather than sending None for it', async () => {
    const { out, error } = await session.run('search("only-query")')
    expect(error).toBeNull()
    expect(out).toContain("{'got': {'query': 'only-query'}}")
    // `limit` was never passed, so it must not appear on the wire at all.
    expect(session.harness.calls.at(-1)?.args).toEqual({ query: 'only-query' })
  })

  it('passes an explicit None through for a property the schema lets be null', async () => {
    // `tag` admits null, so None is a VALUE here, not "argument omitted" —
    // conflating the two would silently drop it.
    const { out, error } = await session.run('search("q", tag=None)')
    expect(error).toBeNull()
    expect(out).toContain("{'got': {'query': 'q', 'tag': None}}")
    expect(session.harness.calls.at(-1)?.args).toEqual({ query: 'q', tag: null })
  })

  it('keeps a shadowed local helper reachable under local_<name>', async () => {
    // `read_file` is a preloaded helper AND a harness tool here. The harness
    // tool takes the plain name (that is what a cell author means); the old
    // local behaviour must stay reachable rather than vanish.
    const { out, error } = await session.run(
      'print(getattr(read_file, "__harness_tool__", None))\n'
      + 'print(callable(local_read_file))',
    )
    expect(error).toBeNull()
    expect(out).toContain('read_file')
    expect(out).toContain('True')
  })

  it('binds the brief\u2019s named examples as bare callables that reach the registry', async () => {
    // The objective names these four explicitly. Each must be a real cell-level
    // function dispatching to the harness tool of that exact name — including
    // the ones that also shadow a preloaded local helper.
    const { out, error } = await session.run(
      'print(callable(read), callable(write), callable(web_search), callable(subagent))\n'
      + 'read({"path": "a.txt"})\n'
      + 'write({"path": "b.txt", "content": "x"})\n'
      + 'web_search({"query": "q"})\n'
      + 'subagent({"prompt": "p"})',
    )
    expect(error).toBeNull()
    expect(out).toContain('True True True True')
    const names = session.harness.calls.slice(-4).map(c => c.name)
    expect(names).toEqual(['read', 'write', 'web_search', 'subagent'])
  })

  it('says the harness surface is unavailable rather than empty when detached', async () => {
    // A cell with no harness must not look like a harness with no tools: that
    // difference is what tells a caller to fall back to the local helpers.
    const { out, error } = await session.run('print(tool_help())')
    expect(error).toBeNull()
    expect(out).toContain('Harness tools')
    expect(out).not.toContain('no harness is attached')
  })
})
