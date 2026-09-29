/**
 * What a backgrounded cell becomes: a durable job in the registry.
 *
 * The kernel reports a detached cell either way, and the output is reachable
 * either way — it arrives prepended to whichever foreground cell runs next. The
 * thing that can silently fail is the attachment: a registry that is absent, or
 * that refuses the job, must leave the cell's own notice intact rather than
 * turning a running cell into a lost one.
 */
import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import type { JobHandle, JobSpec } from '@deepseek-ai/dsh-jobs'
import { SessionId } from '@deepseek-ai/dsh-session'
import type { KernelBackground, KernelBackgroundPoll } from '@deepseek-ai/dsh-kernel'
import { attachBackgroundCell, cellLabel, kernelContent } from '../src/index.ts'
import type { KernelOutcomeValue } from '../src/index.ts'

/** The handle the kernel returns for a cell that outlived its primary budget. */
const BACKGROUND: KernelBackground = { id: 7, timeoutMs: 1_000 }

/** One spec the fake registry accepted, kept so a test can run it by hand. */
interface Started {
  readonly spec: JobSpec
  readonly id: string
}

/**
 * A registry that records what it was asked to start, or refuses everything.
 *
 * Only `start` is exercised: the tool never reads, lists, or waits, because it
 * owns the polling loop rather than declaring a pull source.
 */
function fakeJobs(refusal?: string): { started: Started[]; start(spec: JobSpec): string } {
  const started: Started[] = []
  return {
    started,
    start(spec: JobSpec): string {
      if (refusal !== undefined) throw new Error(refusal)
      const id = `kernel-${started.length + 1}`
      started.push({ spec, id })
      return id
    },
  }
}

/** A context carrying an optional registry and a scripted poll. */
function fakeCtx(
  jobs: unknown,
  poll: (id: number) => Promise<KernelBackgroundPoll>,
  stopped: number[] = [],
): Context {
  return {
    get: (name: string) => (name === 'jobs' ? jobs : undefined),
    kernel: {
      pollBackground: poll,
      stopBackground: async (id: number) => { stopped.push(id) },
    },
  } as unknown as Context
}

/** A job handle recording everything the tool writes into the ring. */
function fakeHandle(): { handle: JobHandle; chunks: string[]; progress: string[] } {
  const chunks: string[] = []
  const progress: string[] = []
  const handle = {
    id: 'kernel-1',
    append: (text: string) => { chunks.push(text) },
    updateProgress: (line: string) => { progress.push(line) },
  }
  return { handle: handle as unknown as JobHandle, chunks, progress }
}

describe('cellLabel', () => {
  it('names the job by the cell\'s first line', () => {
    expect(cellLabel('print(1)\nprint(2)')).toBe('print(1)')
  })

  it('falls back to a generic name for a cell that opens with a blank line', () => {
    expect(cellLabel('\n  \nprint(1)')).toBe('python cell')
  })

  it('truncates a long first line so the job list stays readable', () => {
    const label = cellLabel('x'.repeat(400))
    expect(label).toHaveLength(120)
    expect(label.endsWith('\u2026')).toBe(true)
  })
})

describe('attachBackgroundCell', () => {
  it('reports a note instead of throwing when no registry is loaded', () => {
    const ctx = fakeCtx(undefined, async () => ({ known: false }))
    const result = attachBackgroundCell(ctx, BACKGROUND, 'x = 1', 5, undefined)
    expect('note' in result && result.note).toContain('no background-job registry')
  })

  it('reports the refusal as a note rather than losing the cell', () => {
    const ctx = fakeCtx(fakeJobs('no controller serves this agent'), async () => ({ known: false }))
    const result = attachBackgroundCell(ctx, BACKGROUND, 'x = 1', 5, undefined)
    expect('note' in result && result.note).toBe('no controller serves this agent')
  })

  it('starts one kernel job labelled from the cell and carries the owner', () => {
    const jobs = fakeJobs()
    const ctx = fakeCtx(jobs, async () => ({ known: false }))
    const result = attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 5, SessionId('session-1'))
    expect('id' in result && result.id).toBe('kernel-1')
    expect(jobs.started[0]?.spec.kind).toBe('kernel')
    expect(jobs.started[0]?.spec.label).toBe('print(1)')
    expect(jobs.started[0]?.spec.owner).toBe(SessionId('session-1'))
  })

  it('omits the owner when the call carried no agent', () => {
    const jobs = fakeJobs()
    const ctx = fakeCtx(jobs, async () => ({ known: false }))
    attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 5, undefined)
    expect(jobs.started[0]?.spec.owner).toBeUndefined()
  })

  it('polls a still-running cell and settles completed with its drained text', async () => {
    const jobs = fakeJobs()
    let calls = 0
    const ctx = fakeCtx(jobs, async () => {
      calls += 1
      if (calls === 1) return { known: true, running: true }
      return { known: true, running: false, status: 'finished', text: 'done\n' }
    })
    attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 1, undefined)
    const spec = jobs.started[0]?.spec
    expect(spec).toBeDefined()
    const { handle, chunks, progress } = fakeHandle()
    const hooks = spec!.run(handle)
    expect(progress).toEqual(['running in the kernel (cell #7)'])
    const outcome = await hooks.done
    expect(outcome.status).toBe('completed')
    expect(chunks).toEqual(['done\n'])
  })

  it('settles killed when the kernel reports a stop, keeping the text', async () => {
    const jobs = fakeJobs()
    const ctx = fakeCtx(jobs, async () => ({
      known: true, running: false, status: 'stopped', text: 'partial\n',
    }))
    attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 1, undefined)
    const { handle, chunks } = fakeHandle()
    const outcome = await jobs.started[0]!.spec.run(handle).done
    expect(outcome.status).toBe('killed')
    expect(outcome.detail).toBe('stopped')
    expect(chunks).toEqual(['partial\n'])
  })

  it('fails a cell the kernel no longer holds instead of polling forever', async () => {
    const jobs = fakeJobs()
    const ctx = fakeCtx(jobs, async () => ({ known: false }))
    attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 1, undefined)
    const outcome = await jobs.started[0]!.spec.run(fakeHandle().handle).done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toContain('no longer holds')
  })

  it('fails the job when the poll itself rejects', async () => {
    const jobs = fakeJobs()
    const ctx = fakeCtx(jobs, async () => { throw new Error('kernel unreachable') })
    attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 1, undefined)
    const outcome = await jobs.started[0]!.spec.run(fakeHandle().handle).done
    expect(outcome.status).toBe('failed')
    expect(outcome.detail).toBe('kernel unreachable')
  })

  it('settles killed before asking the kernel to stop the cell', async () => {
    const jobs = fakeJobs()
    const stopped: number[] = []
    const ctx = fakeCtx(jobs, async () => ({ known: true, running: true }), stopped)
    attachBackgroundCell(ctx, BACKGROUND, 'print(1)', 1, undefined)
    const hooks = jobs.started[0]!.spec.run(fakeHandle().handle)
    hooks.cancel('user asked')
    const outcome = await hooks.done
    expect(outcome.status).toBe('killed')
    expect(outcome.detail).toBe('user asked')
    expect(stopped).toEqual([7])
  })
})

describe('kernelContent', () => {
  const value: KernelOutcomeValue = {
    output: 'cell output',
    outcome: 'backgrounded',
    restarted: false,
    images: [],
    imageNotes: [],
  }

  it('adds no background line for an ordinary cell', () => {
    expect(kernelContent(value)).toEqual([{ type: 'text', text: 'cell output' }])
  })

  it('names the job so the model can collect the output', () => {
    const blocks = kernelContent({ ...value, jobId: 'kernel-1' })
    expect(blocks).toHaveLength(2)
    const line = blocks[1] as { type: string; text: string }
    expect(line.text).toContain('RUNNING IN THE BACKGROUND')
    expect(line.text).toContain('kernel-1')
    expect(line.text).toContain('job_output')
  })
})
