import { describe, expect, it } from 'vitest'
import { createChatStore } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('starts without a selected Chat target', () => {
    const store = createChatStore().create()
    expect(store.store.getSnapshot()).toEqual({ selection: null, turnProcesses: [] })
  })

  it('selects and clears one Chat details target', () => {
    const store = createChatStore().create()
    store.actions.select({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    expect(store.store.getSnapshot().selection)
      .toEqual({ turnSeq: 3, callId: 'c1', toolName: 'bash' })
    store.actions.select(null)
    expect(store.store.getSnapshot().selection).toBeNull()
  })

  it('creates independent instances', () => {
    const handle = createChatStore()
    const first = handle.create()
    const second = handle.create()
    first.actions.select({ turnSeq: 1 })
    expect(second.store.getSnapshot().selection).toBeNull()
  })

  it('records the reader choice for one Turn-process generation', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, '2|3', true)
    expect(store.store.getSnapshot().turnProcesses)
      .toEqual([{ turn: 2, generation: '2|3', open: true }])

    store.actions.setTurnProcessOpen(2, '2|4', true)
    expect(store.store.getSnapshot().turnProcesses)
      .toEqual([{ turn: 2, generation: '2|4', open: true }])

    // A close is a choice too: a running Turn defaults open, so only an
    // explicit false can distinguish "the reader folded this" from "no opinion".
    store.actions.setTurnProcessOpen(2, '2|4', false)
    expect(store.store.getSnapshot().turnProcesses)
      .toEqual([{ turn: 2, generation: '2|4', open: false }])
  })

  it('keeps each Turn-process choice independent', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, '2|3', true)
    store.actions.setTurnProcessOpen(3, '3|4', false)

    expect(store.store.getSnapshot().turnProcesses).toEqual([
      { turn: 2, generation: '2|3', open: true },
      { turn: 3, generation: '3|4', open: false },
    ])
  })
})
