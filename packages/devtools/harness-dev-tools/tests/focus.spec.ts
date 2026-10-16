/**
 * Keeping the operator's foreground window, the console lines the test instance logs,
 * and the protocol events a connection delivers.
 */
import { describe, expect, it, vi } from 'vitest'
import { foregroundWindow, powershell, restoreForeground } from '../src/focus.ts'
import { consoleLine } from '../src/desktop-instance.ts'

describe('foreground window', () => {
  it('reads the foreground handle on Windows only', () => {
    expect(foregroundWindow(() => '722642', 'win32')).toBe('722642')
    expect(foregroundWindow(() => '0', 'win32')).toBeUndefined()
    expect(foregroundWindow(() => 'error', 'win32')).toBeUndefined()
    const run = vi.fn(() => '1')
    expect(foregroundWindow(run, 'linux')).toBeUndefined()
    expect(run).not.toHaveBeenCalled()
  })

  it('gives the foreground back after an Alt press, and reports whether it took', () => {
    const run = vi.fn(() => 'True')
    expect(restoreForeground('42', run)).toBe(true)
    expect(run.mock.calls[0]![0]).toMatch(/keybd_event\(0x12[\s\S]*SetForegroundWindow/u)
    expect(run.mock.calls[0]![0]).toContain('[long]42')
    expect(restoreForeground('42', () => 'gone')).toBe(false)
    expect(restoreForeground(undefined, run)).toBe(false)
    expect(restoreForeground('1; Remove-Item', run)).toBe(false)
  })

  it('runs PowerShell without failing when it is missing or errors', () => {
    expect(typeof powershell('exit 3')).toBe('string')
  })
})

describe('console lines', () => {
  it('formats console calls, exceptions, and log errors, and ignores the rest', () => {
    expect(consoleLine('Runtime.consoleAPICalled', { type: 'error', args: [{ value: 'web boot:' }, { value: 3 }, { description: 'Error: x' }, { type: 'undefined' }, {}] }))
      .toBe('[window error] web boot: 3 Error: x undefined ')
    expect(consoleLine('Runtime.consoleAPICalled', {})).toBe('[window log] ')
    expect(consoleLine('Runtime.exceptionThrown', { exceptionDetails: { exception: { description: 'TypeError: y' } } })).toBe('[window exception] TypeError: y')
    expect(consoleLine('Runtime.exceptionThrown', { exceptionDetails: { text: 'Uncaught' } })).toBe('[window exception] Uncaught')
    expect(consoleLine('Runtime.exceptionThrown', {})).toBe('[window exception] an exception')
    expect(consoleLine('Log.entryAdded', { entry: { level: 'error', text: 'net', url: 'u' } })).toBe('[window error] net (u)')
    expect(consoleLine('Log.entryAdded', { entry: { level: 'warning' } })).toBe('[window warning] ')
    expect(consoleLine('Log.entryAdded', { entry: { level: 'info', text: 'x' } })).toBeUndefined()
    expect(consoleLine('Page.loadEventFired', {})).toBeUndefined()
  })
})
