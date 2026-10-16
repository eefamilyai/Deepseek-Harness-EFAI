import { describe, expect, it } from 'vitest'
import {
  DEFAULT_CALENDAR_UTC_OFFSET_MINUTES, DEFAULT_HOLIDAYS, DEFAULT_WEEKDAYS, DEFAULT_WINDOWS,
  isDate, msUntilChange, parseTime, peakState, scheduleProblems, windowMinutes, type PeakSchedule,
} from '../src/schedule.ts'
import { Config, apply } from '../src/index.ts'

const schedule: PeakSchedule = {
  windows: DEFAULT_WINDOWS,
  weekdays: DEFAULT_WEEKDAYS,
  holidays: DEFAULT_HOLIDAYS,
  calendarUtcOffsetMinutes: DEFAULT_CALENDAR_UTC_OFFSET_MINUTES,
}

const at = (iso: string): number => Date.parse(iso)

describe('peak schedule', () => {
  it('is peak inside each published window on a working day', () => {
    // 2026-10-13 is a Tuesday.
    expect(peakState(schedule, at('2026-10-13T01:00:00Z'))).toEqual({
      kind: 'peak', startedAt: at('2026-10-13T01:00:00Z'), endsAt: at('2026-10-13T04:00:00Z'),
    })
    expect(peakState(schedule, at('2026-10-13T09:59:59Z'))).toEqual({
      kind: 'peak', startedAt: at('2026-10-13T06:00:00Z'), endsAt: at('2026-10-13T10:00:00Z'),
    })
  })

  it('is off-peak at window ends, between windows, and overnight, naming the next start', () => {
    expect(peakState(schedule, at('2026-10-13T04:00:00Z'))).toEqual({
      kind: 'off-peak', reason: 'hours', nextPeakAt: at('2026-10-13T06:00:00Z'),
    })
    expect(peakState(schedule, at('2026-10-13T10:00:00Z'))).toEqual({
      kind: 'off-peak', reason: 'hours', nextPeakAt: at('2026-10-14T01:00:00Z'),
    })
    expect(peakState(schedule, at('2026-10-13T00:59:00Z'))).toMatchObject({ kind: 'off-peak', nextPeakAt: at('2026-10-13T01:00:00Z') })
  })

  it('keeps weekends off-peak and resumes on Monday', () => {
    // 2026-10-10 is a Saturday, and a make-up working day in China: still off-peak.
    expect(peakState(schedule, at('2026-10-10T02:00:00Z'))).toEqual({
      kind: 'off-peak', reason: 'weekend', nextPeakAt: at('2026-10-12T01:00:00Z'),
    })
  })

  it('keeps Chinese public holidays off-peak in full and names them', () => {
    // 2026-10-05 is a Monday inside the National Day break (Oct 1-7).
    expect(peakState(schedule, at('2026-10-05T02:00:00Z'))).toEqual({
      kind: 'off-peak', reason: 'holiday', holiday: 'National Day', nextPeakAt: at('2026-10-08T01:00:00Z'),
    })
    // The Spring Festival break runs Sunday 2026-02-15 to Monday 2026-02-23.
    expect(peakState(schedule, at('2026-02-23T07:00:00Z'))).toMatchObject({
      kind: 'off-peak', reason: 'holiday', holiday: 'Spring Festival', nextPeakAt: at('2026-02-24T01:00:00Z'),
    })
  })

  it('dates holidays in the configured calendar, not UTC', () => {
    // 16:30 UTC on Sept 30 is already Oct 1 in China; 01:00 UTC Oct 1 is a holiday morning.
    expect(peakState(schedule, at('2026-09-30T16:30:00Z'))).toMatchObject({ kind: 'off-peak', reason: 'holiday' })
    const shifted = { ...schedule, calendarUtcOffsetMinutes: -600 }
    // At UTC-10, 01:00 UTC on Oct 8 is still Oct 7, a holiday.
    expect(peakState(shifted, at('2026-10-08T01:30:00Z'))).toMatchObject({ kind: 'off-peak', reason: 'holiday' })
  })

  it('merges touching windows into one period', () => {
    const touching = { ...schedule, windows: [{ start: '01:00', end: '04:00' }, { start: '04:00', end: '05:00' }] }
    expect(peakState(touching, at('2026-10-13T03:00:00Z'))).toMatchObject({ kind: 'peak', endsAt: at('2026-10-13T05:00:00Z') })
  })

  it('reports no next peak when none falls within the lookahead', () => {
    expect(peakState({ ...schedule, weekdays: [] }, at('2026-10-13T02:00:00Z'))).toEqual({
      kind: 'off-peak', reason: 'weekend', nextPeakAt: null,
    })
  })

  it('times the next change from the current period', () => {
    const now = at('2026-10-13T02:00:00Z')
    expect(msUntilChange(peakState(schedule, now), now)).toBe(2 * 3_600_000)
    const idle = peakState({ ...schedule, weekdays: [] }, now)
    expect(msUntilChange(idle, now)).toBe(86_400_000)
  })

  it('parses times and dates strictly', () => {
    expect(parseTime('00:00')).toBe(0)
    expect(parseTime('23:59')).toBe(1439)
    expect(parseTime('24:00')).toBe(1440)
    expect(parseTime('24:01')).toBeUndefined()
    expect(parseTime('9:00')).toBeUndefined()
    expect(isDate('2026-02-29')).toBe(true)
    expect(isDate('2026-13-01')).toBe(false)
    expect(windowMinutes({ start: '06:00', end: '10:00' })).toEqual({ start: 360, end: 600 })
    expect(() => windowMinutes({ start: '6', end: '10:00' })).toThrow('invalid peak window 6-10:00')
  })

  it('lists every schedule problem', () => {
    expect(scheduleProblems(schedule)).toEqual([])
    expect(scheduleProblems({
      windows: [{ start: 'x', end: '25:00' }, { start: '10:00', end: '09:00' }],
      weekdays: [7, 1.5],
      holidays: [{ name: 'a', from: 'bad', to: 'bad' }, { name: 'b', from: '2026-02-02', to: '2026-02-01' }],
      calendarUtcOffsetMinutes: 0,
    })).toEqual([
      'windows[0].start "x" is not HH:MM',
      'windows[0].end "25:00" is not HH:MM',
      'windows[1] ends at or before it starts; split a window that crosses midnight in two',
      'weekday 7 is not 0-6',
      'weekday 1.5 is not 0-6',
      'holidays[0].from "bad" is not YYYY-MM-DD',
      'holidays[0].to "bad" is not YYYY-MM-DD',
      'holidays[1] ends before it starts',
    ])
  })
})

describe('host row', () => {
  const resolve = (patch: Record<string, unknown>) => Config(patch) as Parameters<typeof apply>[1]

  it('accepts the defaults', () => {
    const config = resolve({})
    expect(config.windows.get()).toEqual([{ start: '01:00', end: '04:00' }, { start: '06:00', end: '10:00' }])
    expect(config.holidays.get()).toHaveLength(7)
    expect(() => { apply(undefined, config) }).not.toThrow()
  })

  it('fails loud at load on an unusable schedule', () => {
    expect(() => { apply(undefined, resolve({ windows: [{ start: '10:00', end: '09:00' }] })) })
      .toThrow('ui-peak-hours: invalid schedule: windows[0] ends at or before it starts')
  })
})
