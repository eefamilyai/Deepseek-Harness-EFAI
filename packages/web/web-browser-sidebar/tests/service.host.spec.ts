/**
 * The `agentBrowser` service: a Host caller's operation reaches the newest subscribed
 * window, and settles with that window's reply, its refusal, its silence, or its
 * disconnection.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import { AgentBrowser, AgentBrowserUnavailableError, type AgentBrowserCall, type AgentBrowserRequest } from '../src/index.ts'

const CALL: AgentBrowserCall = {
  op: 'navigate', pageId: 's1', displaySessionId: 's1', viewportWidth: 1280, viewportHeight: 800, timeoutMs: 1000, url: 'https://a.test/',
}

const lifetimes: AbortController[] = []
afterEach(() => { for (const lifetime of lifetimes.splice(0)) lifetime.abort() })

/** One subscribed window: the operations it received, read as they arrive. */
function subscribe(service: AgentBrowser) {
  const lifetime = new AbortController()
  lifetimes.push(lifetime)
  const iterator = service.commands(lifetime.signal)[Symbol.asyncIterator]()
  return {
    lifetime,
    next: async (): Promise<AgentBrowserRequest> => {
      const item = await iterator.next()
      if (item.done === true) throw new Error('stream ended')
      return item.value
    },
    close: async () => { lifetime.abort(); await iterator.return?.() },
  }
}

function service(replyGraceMs = 5000): AgentBrowser {
  return new AgentBrowser(new Context(), { replyGraceMs })
}

describe('agentBrowser', () => {
  it('refuses an operation while no window is subscribed', async () => {
    const agentBrowser = service()
    expect(agentBrowser.available()).toBe(false)
    await expect(agentBrowser.run(CALL)).rejects.toBeInstanceOf(AgentBrowserUnavailableError)
  })

  it('opens every stream with a hello, then delivers the operation and settles it with the reply', async () => {
    const agentBrowser = service()
    const window = subscribe(agentBrowser)
    expect((await window.next()).op).toBe('hello')
    expect(agentBrowser.available()).toBe(true)
    const running = agentBrowser.run(CALL)
    const request = await window.next()
    expect(request).toMatchObject({ op: 'navigate', url: 'https://a.test/', pageId: 's1' })
    expect(agentBrowser.respond({ id: request.id, ok: true, url: 'https://a.test/', title: 'A' })).toBe(true)
    await expect(running).resolves.toMatchObject({ ok: true, title: 'A' })
    // A second reply to the same operation has nothing to settle.
    expect(agentBrowser.respond({ id: request.id, ok: true })).toBe(false)
  })

  it('turns the window\'s refusal into the operation\'s failure', async () => {
    const agentBrowser = service()
    const window = subscribe(agentBrowser)
    await window.next()
    const running = agentBrowser.run(CALL)
    const request = await window.next()
    agentBrowser.respond({ id: request.id, ok: false, error: 'only http and https addresses can be opened' })
    await expect(running).rejects.toThrow('only http and https addresses can be opened')
  })

  it('sends work to the newest window', async () => {
    const agentBrowser = service()
    const older = subscribe(agentBrowser)
    await older.next()
    const newer = subscribe(agentBrowser)
    await newer.next()
    const running = agentBrowser.run(CALL)
    const request = await newer.next()
    agentBrowser.respond({ id: request.id, ok: true })
    await expect(running).resolves.toMatchObject({ ok: true })
  })

  it('fails what a window still holds when it disconnects', async () => {
    const agentBrowser = service()
    const window = subscribe(agentBrowser)
    await window.next()
    const running = agentBrowser.run(CALL)
    await window.next()
    await window.close()
    await expect(running).rejects.toBeInstanceOf(AgentBrowserUnavailableError)
    expect(agentBrowser.available()).toBe(false)
  })

  it('fails an operation the window never answers', async () => {
    const agentBrowser = service(0)
    const window = subscribe(agentBrowser)
    await window.next()
    await expect(agentBrowser.run({ ...CALL, timeoutMs: 10 })).rejects.toThrow(/did not answer "navigate" within 10 ms/)
  })

  it('stops waiting when the caller aborts', async () => {
    const agentBrowser = service()
    const window = subscribe(agentBrowser)
    await window.next()
    const abort = new AbortController()
    const running = agentBrowser.run(CALL, abort.signal)
    abort.abort(new Error('turn cancelled'))
    await expect(running).rejects.toThrow('turn cancelled')
  })
})
