/**
 * The deferred-send service over a stand-in schedule service: which tasks it
 * owns, how each placement lands, and the structured refusals the dialog shows.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { RemoteError } from '@deepseek-ai/dsh-typert-protocol'
import PeakSend, { isDeferred, TITLE_PREFIX, titleFor } from '../src/index.ts'

const contexts: Context[] = []

afterEach(async () => {
  for (const ctx of contexts.splice(0).reverse()) await ctx.fiber.dispose()
})

interface Task {
  id: string
  kind: 'at' | 'every'
  title: string
  prompt: string
  scheduledAt: string
}

/** A schedule service holding tasks in creation order, with a switch to refuse updates. */
function scheduleStub(initial: Task[] = []) {
  const tasks = [...initial]
  let next = 0
  let updateAnswer: 'ok' | 'conflict' | 'error' = 'ok'
  return {
    tasks,
    refuseUpdates(answer: 'conflict' | 'error') { updateAnswer = answer },
    list: async () => tasks.map(task => ({ ...task })),
    create: async (_sessionId: string, request: { prompt: string; title: string; at: string }) => {
      const task: Task = { id: `t${String(++next)}`, kind: 'at', title: request.title, prompt: request.prompt, scheduledAt: new Date(request.at).toISOString() }
      tasks.push(task)
      return { ...task }
    },
    update: async (request: { id: string; prompt: string }) => {
      if (updateAnswer === 'conflict') return { id: request.id, updated: false, code: 'schedule_conflict' }
      if (updateAnswer === 'error') return { error: 'invalid_prompt' }
      const task = tasks.find(item => item.id === request.id)!
      task.prompt = request.prompt
      return { id: task.id, updated: true, record: { ...task } }
    },
  }
}

async function harness(initial: Task[] = []) {
  const ctx = new Context()
  contexts.push(ctx)
  const schedule = scheduleStub(initial)
  ctx.provide('schedule', schedule as never)
  await ctx.plugin(PeakSend)
  return { service: ctx.peakSend, schedule }
}

async function rejection(call: Promise<unknown>): Promise<RemoteError> {
  try {
    await call
  } catch (error) {
    if (error instanceof RemoteError) return error
    throw error
  }
  throw new Error('expected a rejection')
}

const AT = '2026-10-12T10:00:00.000Z'

describe('titles', () => {
  it('names a task by the first line of its message, cut to the schedule limit', () => {
    expect(titleFor('  hello\n  world ')).toBe(`${TITLE_PREFIX}hello`)
    expect(titleFor('a   b\tc')).toBe(`${TITLE_PREFIX}a b c`)
    const long = titleFor('x'.repeat(300))
    expect(long).toHaveLength(120)
    expect(long.endsWith('…')).toBe(true)
  })

  it('owns only one-shot tasks carrying the prefix', () => {
    expect(isDeferred({ id: 'a', kind: 'at', title: `${TITLE_PREFIX}x`, prompt: 'x', scheduledAt: AT } as never)).toBe(true)
    expect(isDeferred({ id: 'b', kind: 'at', title: 'Reminder', prompt: 'x', scheduledAt: AT } as never)).toBe(false)
    expect(isDeferred({ id: 'c', kind: 'every', title: `${TITLE_PREFIX}x`, prompt: 'x', scheduledAt: AT } as never)).toBe(false)
  })
})

describe('the peakSend service', () => {
  it('lists only its own waiting messages, earliest first', async () => {
    const { service } = await harness([
      { id: 'late', kind: 'at', title: `${TITLE_PREFIX}late`, prompt: 'late', scheduledAt: '2026-10-12T11:00:00.000Z' },
      { id: 'mine', kind: 'at', title: 'Reminder', prompt: 'not mine', scheduledAt: AT },
      { id: 'early', kind: 'at', title: `${TITLE_PREFIX}early`, prompt: 'early', scheduledAt: AT },
    ])
    expect(await service.pending('s1')).toEqual([
      { id: 'early', at: AT, text: 'early' },
      { id: 'late', at: '2026-10-12T11:00:00.000Z', text: 'late' },
    ])
  })

  it('defers a message on its own at the requested time', async () => {
    const { service, schedule } = await harness()
    expect(await service.defer({ sessionId: 's1', text: '  ask later  ', at: AT, placement: 'alone' })).toEqual({ id: 't1', at: AT })
    expect(schedule.tasks[0]).toMatchObject({ prompt: 'ask later', title: `${TITLE_PREFIX}ask later` })
  })

  it('queues a message after the earlier one, at its time, and merges one into it', async () => {
    const { service, schedule } = await harness()
    await service.defer({ sessionId: 's1', text: 'first', at: AT, placement: 'alone' })
    expect(await service.defer({ sessionId: 's1', text: 'second', at: '2030-01-01T00:00:00Z', placement: 'after', earlierId: 't1' }))
      .toEqual({ id: 't2', at: AT })
    expect(await service.defer({ sessionId: 's1', text: 'third', at: AT, placement: 'together', earlierId: 't2' }))
      .toEqual({ id: 't2', at: AT })
    expect(schedule.tasks.map(task => task.prompt)).toEqual(['first', 'second\n\nthird'])
  })

  it('refuses an empty message, a bad time, a missing earlier message, and a refused merge', async () => {
    const { service, schedule } = await harness()
    await service.defer({ sessionId: 's1', text: 'first', at: AT, placement: 'alone' })
    const cases: [Parameters<typeof service.defer>[0], string][] = [
      [{ sessionId: 's1', text: '   ', at: AT, placement: 'alone' }, 'a deferred message needs text'],
      [{ sessionId: 's1', text: 'x', at: 'soon', placement: 'alone' }, '"soon" is not a time'],
      [{ sessionId: 's1', text: 'x', at: AT, placement: 'after', earlierId: 'gone' }, 'the earlier deferred message is no longer waiting'],
    ]
    for (const [request, message] of cases) {
      const error = await rejection(service.defer(request))
      expect(error.code).toBe('peakSend/defer-rejected')
      expect(error.message).toBe(message)
      expect(error.details).toEqual({ sessionId: 's1' })
    }
    schedule.refuseUpdates('conflict')
    expect((await rejection(service.defer({ sessionId: 's1', text: 'x', at: AT, placement: 'together', earlierId: 't1' }))).message)
      .toBe('the earlier message could not be changed (schedule_conflict)')
    schedule.refuseUpdates('error')
    expect((await rejection(service.defer({ sessionId: 's1', text: 'x', at: AT, placement: 'together', earlierId: 't1' }))).message)
      .toBe('the earlier message could not be changed')
  })

  it('reports a non-Error failure as text', async () => {
    const { service, schedule } = await harness()
    schedule.create = vi.fn<typeof schedule.create>().mockRejectedValue('disk full')
    expect((await rejection(service.defer({ sessionId: 's1', text: 'x', at: AT, placement: 'alone' }))).message).toBe('disk full')
  })
})
