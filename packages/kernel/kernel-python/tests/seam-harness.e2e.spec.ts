/**
 * End-to-end: a Python cell reading the harness it runs inside.
 *
 * This runs the REAL `kernel_child.py` process and answers its seam requests through the
 * REAL {@link dispatchSeam}, so it exercises the whole path a cell takes for the
 * observation family: `session_events()` in Python → `sessions.events` frame → the
 * `ctx.sessionQuery` seam → a projected event list → back over fd 3 → a Python value.
 *
 * The unit suites pin the two halves separately (`seam-harness.spec.ts` for the ops,
 * `test_harness_introspection.py` for the helpers); this pins that the halves are wired to
 * each other — that the helpers exist in a real cell, that their arguments survive the
 * frame, and that a missing service arrives as `{"error": ...}` rather than an exception or
 * an empty answer that a caller would misread as "the harness has no sessions".
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
// Skipped rather than failed where no interpreter exists: driving one is this package's
// whole job, so "no Python here" is an environment fact, not a defect.
const describeE2E = python === undefined ? describe.skip : describe

/** The recorded events the fake sessionQuery serves. */
const EVENTS = [
  { seq: 0, type: 'turn/start', time: 1, data: { turn: 1 } },
  { seq: 1, type: 'assistant/message', time: 2, data: { message: { content: [{ type: 'text', text: 'a recorded answer' }] } } },
  { seq: 2, type: 'tool/call', time: 3, data: { name: 'kernel' } },
]

/** A context carrying only the observation services these ops read. */
function fakeHarness(withQuery = true): { ctx: Context; agent: KernelAgent } {
  const services: Record<string, unknown> = {
    agents: {
      list: () => [{ id: 'root' }, { id: 'e2e-session' }],
      roots: () => [{ id: 'root' }],
      currentInitiator: () => ({ id: 'e2e-session' }),
    },
    sessions: {
      list: () => [{ id: 'e2e-session', header: { id: 'e2e-session', createdAt: 7 } }],
      get: (id: unknown) => id === 'e2e-session' ? { id: 'e2e-session' } : undefined,
    },
    settings: {
      describe: () => [{ ns: 'kernel-python', revision: 2, value: { browserWindow: true } }],
      update: async () => {},
    },
    jobs: { list: (caller?: string) => [{ id: 'job-1', kind: 'shell', label: 'run tests', state: 'running', sessionId: caller }] },
    sessionProjections: { snapshot: (_session: unknown, keys?: readonly string[]) => ({ keys }) },
  }
  if (withQuery) {
    services['sessionQuery'] = {
      listSessions: async () => [{ header: { id: 'e2e-session', createdAt: 7 }, live: true, persisted: true }],
      listEvents: async () => EVENTS,
      readSurface: async () => ({ events: EVENTS.slice(0, 2) }),
      readEvent: async (ask: { seq: number }) => ({ events: EVENTS.filter(event => event.seq === ask.seq) }),
      traceSession: async () => ({ ancestors: [], descendants: [], complete: true }),
    }
  }
  const agent = {
    id: 'e2e-session',
    session: { id: 'e2e-session', header: { agentPreset: 'standard' } },
  } as unknown as KernelAgent
  return { ctx: services as unknown as Context, agent }
}

/** One live kernel answering seam requests from a fixed context. */
interface Cell {
  readonly child: KernelChild
  run(code: string): Promise<{ out: string; error: string | null }>
}

async function open(ctx: Context, agent: KernelAgent): Promise<Cell> {
  const child = new KernelChild({ python: python ?? 'python3', script: KERNEL, cwd: process.cwd(), env: {} })
  child.seamHandler = (seam: SeamRequest): void => {
    void dispatchSeam(ctx, agent, seam).then(
      (response) => { if (!child.dead) child.sendSeamResponse(response) },
      (reason: unknown) => { if (!child.dead) child.sendSeamResponse({ id: seam.id, ok: false, error: String(reason) }) },
    )
  }
  return {
    child,
    async run(code) {
      const frame = await child.nextFrame(child.send(code))
      return { out: frame.out ?? '', error: frame.error ?? null }
    },
  }
}

describeE2E('kernel harness observation end to end', () => {
  let wired: Cell
  let bare: Cell

  beforeAll(async () => {
    const full = fakeHarness(true)
    wired = await open(full.ctx, full.agent)
    const partial = fakeHarness(false)
    bare = await open(partial.ctx, partial.agent)
  }, 120_000)

  afterAll(async () => {
    await wired?.child.kill()
    await bare?.child.kill()
  })

  it('binds the observation helpers into the cell', async () => {
    const { out, error } = await wired.run(
      'print(all(callable(globals().get(n)) for n in '
      + '["seam_ops", "seam", "list_agents", "session_events", "session_surface", "session_window", '
      + '"harness_settings", "list_jobs", "context_state", "read_projections"]))',
    )
    expect(error).toBeNull()
    expect(out).toContain('True')
  })

  it('lists the op table the harness actually answers', async () => {
    const { out, error } = await wired.run('ops = seam_ops()\nprint(len(ops) > 10, any(o["op"] == "sessions.events" for o in ops))')
    expect(error).toBeNull()
    expect(out).toContain('True True')
  })

  it('reads recorded events with their summaries', async () => {
    const { out, error } = await wired.run('print(session_events(limit=2))')
    expect(error).toBeNull()
    // The newest first, and the assistant answer summarized rather than dumped.
    expect(out).toContain("'seq': 2")
    expect(out).toContain("'summary': 'tool kernel'")
    expect(out).toContain('a recorded answer')
  })

  it('defaults to the calling session and forwards an explicit one', async () => {
    const { out, error } = await wired.run('print(session_events("e2e-session", 1)["sessionId"])')
    expect(error).toBeNull()
    expect(out).toContain('e2e-session')
  })

  it('reads the live agents and the corpus', async () => {
    const { out, error } = await wired.run('print(list_agents())\nprint(session_corpus())')
    expect(error).toBeNull()
    expect(out).toContain("'current': True")
    expect(out).toContain("'live': True")
  })

  it('reads settings, jobs and projections through the same bridge', async () => {
    const { out, error } = await wired.run(
      'print(harness_settings()[0]["ns"], list_jobs()[0]["id"], read_projections(["tokenUsage"])["keys"])',
    )
    expect(error).toBeNull()
    expect(out).toContain("kernel-python job-1 ['tokenUsage']")
  })

  it('calls an op that has no wrapper', async () => {
    const { out, error } = await wired.run('print(seam("sessions.surface", limit=1)["total"])')
    expect(error).toBeNull()
    expect(out).toContain('2')
  })

  it('reports a missing service as an error a caller can act on', async () => {
    const { out, error } = await bare.run('r = session_events()\nprint("error" in r, "ctx.sessionQuery" in r["error"])')
    expect(error).toBeNull()
    expect(out).toContain('True True')
  })
})
