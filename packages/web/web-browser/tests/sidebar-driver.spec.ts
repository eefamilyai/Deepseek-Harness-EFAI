/**
 * The sidebar driver composes the tool's actions from the window's low-level page
 * operations, and the plugin picks it whenever a Desktop window is connected.
 */

import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AgentBrowserCall, AgentBrowserReply } from '@deepseek-ai/dsh-web-browser-sidebar'
import { SidebarBrowserDriver } from '../src/sidebar-driver.ts'
import { apply } from '../src/index.ts'

const SNAPSHOT = { title: 'Example', url: 'https://example.test/', elements: [{ ref: 1, tag: 'a', role: 'a', name: 'More' }], text: 'Hello page' }

const LIMITS = { navigationTimeoutMs: 30_000, actionTimeoutMs: 15_000, maxTextChars: 20_000, viewportWidth: 1280, viewportHeight: 800 }

/** An `agentBrowser` stand-in that answers each operation the way the window does. */
function fakeService(answer: (call: AgentBrowserCall) => Partial<AgentBrowserReply> = () => ({}), available = true) {
  const calls: AgentBrowserCall[] = []
  return {
    calls,
    available: () => available,
    run: (call: AgentBrowserCall) => {
      calls.push(call)
      const reply = call.op === 'evaluate' && call.script?.includes('data-ai-ref') && call.script.includes('elements')
        ? { value: JSON.stringify(SNAPSHOT) }
        : answer(call)
      return Promise.resolve({ id: 'x', ok: true, ...reply })
    },
  }
}

const TARGET = { pageId: 'child', displaySessionId: 'root' }

describe('the sidebar driver', () => {
  it('navigates with the navigation timeout and returns the page snapshot', async () => {
    const service = fakeService()
    const driver = new SidebarBrowserDriver(service as never, LIMITS)
    const snapshot = await driver.navigate(TARGET, 'https://example.test/')
    expect(snapshot.text).toBe('Hello page')
    expect(service.calls[0]).toMatchObject({ op: 'navigate', url: 'https://example.test/', pageId: 'child', displaySessionId: 'root', timeoutMs: 30_000, viewportWidth: 1280 })
    expect(service.calls[1]?.op).toBe('evaluate')
  })

  it('clicks the centre of the ref\'d element as a pointer would', async () => {
    const service = fakeService(call => call.op === 'evaluate' ? { value: JSON.stringify({ found: true, x: 40, y: 12 }) } : {})
    await new SidebarBrowserDriver(service as never, LIMITS).click(TARGET, 7)
    expect(service.calls[0]?.script).toContain('[data-ai-ref="7"]')
    expect(service.calls[1]).toMatchObject({ op: 'click', x: 40, y: 12 })
  })

  it('refuses a ref the page no longer has', async () => {
    const service = fakeService(() => ({ value: JSON.stringify({ found: false }) }))
    await expect(new SidebarBrowserDriver(service as never, LIMITS).click(TARGET, 9)).rejects.toThrow(/no element has ref 9/)
    const typing = fakeService(() => ({ value: 'false' }))
    await expect(new SidebarBrowserDriver(typing as never, LIMITS).type(TARGET, 9, 'x')).rejects.toThrow(/no element has ref 9/)
  })

  it('selects a field and inserts the text, or clears it for empty text', async () => {
    const service = fakeService(() => ({ value: 'true' }))
    const driver = new SidebarBrowserDriver(service as never, LIMITS)
    await driver.type(TARGET, 2, 'hello')
    expect(service.calls.map(call => call.op)).toEqual(['evaluate', 'insertText', 'evaluate'])
    expect(service.calls[1]?.text).toBe('hello')
    service.calls.length = 0
    await driver.type(TARGET, 2, '')
    expect(service.calls.map(call => call.op)).toEqual(['evaluate', 'evaluate'])
    expect(service.calls[0]?.script).toContain("el.value = ''")
  })

  it('presses, scrolls, and goes back through the window', async () => {
    const service = fakeService(() => ({ value: 'true' }))
    const driver = new SidebarBrowserDriver(service as never, LIMITS)
    await driver.press(TARGET, 'Enter')
    await driver.scroll(TARGET, 'up')
    await driver.back(TARGET)
    expect(service.calls.filter(call => call.op !== 'evaluate' || !call.script?.includes('elements')).map(call => call.op))
      .toEqual(['key', 'evaluate', 'back'])
    expect(service.calls.find(call => call.op === 'key')?.key).toBe('Enter')
    expect(service.calls.find(call => call.script?.includes('scrollBy'))?.script).toContain('-800')
  })

  it('decodes the window\'s screenshot', async () => {
    const service = fakeService(() => ({ png: Buffer.from([1, 2, 3]).toString('base64'), url: 'https://a.test/', title: 'A' }))
    const shot = await new SidebarBrowserDriver(service as never, LIMITS).screenshot(TARGET)
    expect([...shot.data]).toEqual([1, 2, 3])
    expect(shot).toMatchObject({ mediaType: 'image/png', url: 'https://a.test/', title: 'A' })
  })
})

/** Mount the plugin over stand-in seams and return the registered tool. */
function mounted(options: { driver?: 'auto' | 'sidebar' | 'headless'; service?: ReturnType<typeof fakeService>; agents?: Record<string, unknown> }) {
  let tool: { execute: (args: unknown, exec: unknown) => Promise<{ text: string }> } | undefined
  const ctx = {
    systemPrompt: { section: () => () => {} },
    tools: { register: (definition: typeof tool) => { tool = definition } },
    web: { registerFetchProvider: () => () => {} },
    effect: () => {},
    get: (name: string) => {
      if (name === 'agentBrowser') return options.service
      if (name === 'agents') return { get: (id: string) => options.agents?.[id] }
      return undefined
    },
  }
  apply(ctx as unknown as Context, { driver: options.driver ?? 'auto', viewportWidth: 1280, viewportHeight: 800, navigationTimeoutMs: 30_000, actionTimeoutMs: 15_000, maxTextChars: 20_000, maxOutputChars: 40_000, headless: true, userAgent: 'x', fetchProvider: false })
  if (tool === undefined) throw new Error('the plugin registered no tool')
  return tool
}

/** A calling agent: a subagent of `root` two levels down. */
function subagentExec() {
  return {
    signal: new AbortController().signal,
    agent: { options: {}, session: { id: 'grandchild', header: { id: 'grandchild', origin: 'subagent', parentSession: 'child' } } },
  }
}

describe('choosing the browser', () => {
  it('uses the sidebar whenever a window is connected, showing a subagent\'s page in its root conversation', async () => {
    const service = fakeService()
    const tool = mounted({
      service,
      agents: {
        child: { session: { header: { id: 'child', origin: 'subagent', parentSession: 'root' } } },
        root: { session: { header: { id: 'root' } } },
      },
    })
    const value = await tool.execute({ action: 'read' }, subagentExec())
    expect(value.text).toContain('Hello page')
    expect(service.calls[0]).toMatchObject({ op: 'evaluate', pageId: 'grandchild', displaySessionId: 'root' })
  })

  it('refuses when the sidebar is required and no window is open', async () => {
    const tool = mounted({ driver: 'sidebar', service: fakeService(() => ({}), false) })
    await expect(tool.execute({ action: 'read' }, subagentExec())).rejects.toThrow(/no desktop window is open/)
    const without = mounted({ driver: 'sidebar' })
    await expect(without.execute({ action: 'read' }, subagentExec())).rejects.toThrow(/has no sidebar browser/)
  })

  it('leaves the sidebar alone when the headless browser is chosen', async () => {
    const service = fakeService()
    const tool = mounted({ driver: 'headless', service })
    // The headless browser rejects the bad argument before it would launch anything.
    await expect(tool.execute({ action: 'navigate' }, subagentExec())).rejects.toThrow(/navigate needs a "url"/)
    expect(service.calls).toEqual([])
  })
})
