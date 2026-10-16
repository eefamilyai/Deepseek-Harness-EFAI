// @vitest-environment jsdom
import { describe, expect, it } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import {
  CREATE_CHOICES, CREATE_INTERVAL_ERROR_KEYS, CREATE_WEEKDAY_RULE, initialCreateDraft, intervalCountFor,
  isClockChoice, isIntervalChoice, resolveCreate,
} from '../src/client/create-task.ts'
import type { CreateDraft } from '../src/client/create-task.ts'

/** A zone the runtime can always format in, so the defaults never depend on the device. */
const ZONE = 'UTC'

/** One instant the defaults are measured from: 09:04:30 local on 2030-05-06. */
const NOW = new Date(2030, 4, 6, 9, 4, 30)

/** The draft a reader submits, with any single field overridden. */
function draft(patch: Partial<CreateDraft> = {}): CreateDraft {
  return {
    ...initialCreateDraft('session-1' as SessionId, ZONE, NOW),
    title: 'Nightly sweep',
    prompt: 'Summarize the logs',
    ...patch,
  }
}

describe('creation draft defaults', () => {
  it('opens one hour ahead at whole minutes rather than at a time already past', () => {
    const opened = initialCreateDraft('session-1' as SessionId, ZONE, NOW)
    expect(opened.choice).toBe('daily')
    expect(opened.time).toBe('10:04:00')
    expect(opened.date).toBe('2030-05-06')
    expect(opened.timeZone).toBe(ZONE)
    // The weekly choice starts on the weekday it is opened, so its first submit
    // names a real day without the reader touching the pills.
    expect(opened.weekdays).toEqual([1])
  })

  it('opens with no Session when the catalog has none, and no staged content', () => {
    const opened = initialCreateDraft('', ZONE, NOW)
    expect(opened.sessionId).toBe('')
    expect(opened.title).toBe('')
    expect(opened.prompt).toBe('')
  })

  it('classifies each choice as a clock rule or an elapsed interval', () => {
    for (const choice of CREATE_CHOICES) {
      expect(isIntervalChoice(choice)).toBe(choice.startsWith('every-'))
      expect(isClockChoice(choice)).toBe(!choice.startsWith('every-') && choice !== 'once' && choice !== 'cron')
    }
  })

  it('states each interval choice opening quantity in its own unit', () => {
    expect(intervalCountFor('every-hour')).toBe('1')
    expect(intervalCountFor('every-minute')).toBe('1')
    // The floor is 60 seconds, so the seconds choice opens on a legal quantity.
    expect(intervalCountFor('every-second')).toBe('60')
  })
})

describe('creation validation', () => {
  it('reports the name before anything else the reader must fix', () => {
    expect(resolveCreate(draft({ title: '   ', sessionId: '' }))).toEqual({ error: 'rule.invalidTitle' })
    expect(resolveCreate(draft({ title: 'x'.repeat(121) }))).toEqual({ error: 'rule.invalidTitle' })
  })

  it('requires an instruction and a Session', () => {
    expect(resolveCreate(draft({ prompt: '  ' }))).toEqual({ error: 'rule.invalidPrompt' })
    expect(resolveCreate(draft({ sessionId: '' }))).toEqual({ error: 'create.sessionRequired' })
  })

  it('states an interval refusal in the unit the row shows', () => {
    for (const choice of ['every-hour', 'every-minute', 'every-second'] as const) {
      expect(resolveCreate(draft({ choice, count: '0' }))).toEqual({ error: CREATE_INTERVAL_ERROR_KEYS[choice] })
    }
    // 59 seconds is below the Host's one-minute floor; 60 is exactly it.
    expect(resolveCreate(draft({ choice: 'every-second', count: '59' }))).toEqual({ error: 'timing.invalidInterval.second' })
    expect(resolveCreate(draft({ choice: 'every-second', count: '60' }))).toMatchObject({ request: { every_seconds: 60 } })
  })

  it('refuses a fractional interval quantity rather than rounding it into another rule', () => {
    expect(resolveCreate(draft({ choice: 'every-hour', count: '1.5' })))
      .toEqual({ error: CREATE_INTERVAL_ERROR_KEYS['every-hour'] })
  })

  it('refuses a one-shot that names no real calendar day', () => {
    expect(resolveCreate(draft({ choice: 'once', date: '2030-02-31' }))).toEqual({ error: 'timing.invalid' })
    expect(resolveCreate(draft({ choice: 'once', date: '2030-02-28' }))).toMatchObject({
      request: { at: { date: '2030-02-28', time: '10:04:00', time_zone: ZONE } },
    })
  })

  it('refuses a zone this runtime cannot format in', () => {
    expect(resolveCreate(draft({ timeZone: 'Mars/Olympus' }))).toEqual({ error: 'timing.invalidZone' })
  })

  it('refuses a custom expression that is not a five-field cron rule', () => {
    expect(resolveCreate(draft({ choice: 'cron', expression: 'not a rule' }))).toEqual({ error: 'rule.cronInvalid' })
    expect(resolveCreate(draft({ choice: 'cron', expression: '0 9 * * 1-5' }))).toMatchObject({
      request: { cron: { expression: '0 9 * * 1-5', time_zone: ZONE } },
    })
  })

  it('refuses a weekly rule with no weekday left selected', () => {
    expect(resolveCreate(draft({ choice: 'weekly', weekdays: [] }))).toEqual({ error: 'create.weekdaysRequired' })
  })
})

describe('creation requests', () => {
  it('carries the Session binding, the trimmed name and instruction, and one selector', () => {
    const resolved = resolveCreate(draft({
      title: '  Nightly sweep  ', prompt: '  Summarize the logs  ', choice: 'weekly', weekdays: [5, 1], time: '08:30:00',
    }))
    expect(resolved).toEqual({
      request: {
        sessionId: 'session-1',
        title: 'Nightly sweep',
        prompt: 'Summarize the logs',
        weekly: { time: '08:30:00', time_zone: ZONE, weekdays: [1, 5] },
      },
    })
  })

  it('stores the Monday-to-Friday choice as the weekday set it names', () => {
    const resolved = resolveCreate(draft({ choice: 'weekdays' }))
    expect(resolved).toMatchObject({ request: { weekly: { weekdays: [...CREATE_WEEKDAY_RULE] } } })
  })

  it('submits exactly one selector for every choice', () => {
    const expected: Readonly<Record<string, string>> = {
      'every-hour': 'every_seconds', daily: 'daily', weekdays: 'weekly', weekly: 'weekly', once: 'at', cron: 'cron',
    }
    for (const [choice, selector] of Object.entries(expected)) {
      const resolved = resolveCreate(draft({ choice: choice as CreateDraft['choice'] }))
      if (!('request' in resolved)) throw new Error(`${choice} was refused: ${resolved.error}`)
      const keys = Object.keys(resolved.request).filter(key => !['sessionId', 'title', 'prompt'].includes(key))
      expect(keys, choice).toEqual([selector])
    }
  })
})
