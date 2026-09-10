import { describe, expect, it } from 'vitest'
import { createChatStore } from '../src/client/stores.ts'

describe('createChatStore', () => {
  it('records the reader choice for one Turn-process answer', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 3, open: true }])

    store.actions.setTurnProcessOpen(2, 4, true)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4, open: true }])

    // A close is a choice too: a running Turn defaults open, so only an
    // explicit false can distinguish "the reader folded this" from "no opinion".
    store.actions.setTurnProcessOpen(2, 4, false)
    expect(store.store.getSnapshot().turnProcesses).toEqual([{ turn: 2, answerStep: 4, open: false }])
  })

  it('keeps each Turn-process choice independent', () => {
    const store = createChatStore().create()
    store.actions.setTurnProcessOpen(2, 3, true)
    store.actions.setTurnProcessOpen(3, 4, false)

    expect(store.store.getSnapshot().turnProcesses).toEqual([
      { turn: 2, answerStep: 3, open: true },
      { turn: 3, answerStep: 4, open: false },
    ])
  })
})
