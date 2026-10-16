/** Model-facing key names become the Electron input events that press them. */

import { describe, expect, it } from 'vitest'
import { keyEvents } from '../src/client/keys.ts'

describe('keyEvents', () => {
  it('presses Enter with the char a form listens for', () => {
    expect(keyEvents('Enter')).toEqual([
      { type: 'keyDown', keyCode: 'Enter', modifiers: [] },
      { type: 'char', keyCode: '\r', modifiers: [] },
      { type: 'keyUp', keyCode: 'Enter', modifiers: [] },
    ])
  })

  it('maps arrow and function keys to accelerator codes, with no char', () => {
    expect(keyEvents('ArrowDown').map(event => event.keyCode)).toEqual(['Down', 'Down'])
    expect(keyEvents('f5').map(event => event.keyCode)).toEqual(['F5', 'F5'])
  })

  it('holds modifiers, and types nothing under Control', () => {
    expect(keyEvents('Control+A')).toEqual([
      { type: 'keyDown', keyCode: 'A', modifiers: ['control'] },
      { type: 'keyUp', keyCode: 'A', modifiers: ['control'] },
    ])
    expect(keyEvents('Shift+a').map(event => event.type)).toEqual(['keyDown', 'char', 'keyUp'])
    expect(keyEvents('+').map(event => event.keyCode)).toEqual(['+', '+', '+'])
  })

  it('refuses an empty name and an unknown modifier', () => {
    expect(() => keyEvents('')).toThrow(/needs a key name/)
    expect(() => keyEvents('Hyper+A')).toThrow(/"Hyper" is not a modifier/)
  })
})
