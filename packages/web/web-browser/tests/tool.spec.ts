/**
 * The `browser` tool's action dispatch, and the one action that answers in
 * pixels: `screenshot`'s capability gate, its durable commit, its image block,
 * and the text-only contract every other action keeps.
 *
 * The tool is driven directly rather than through a tool runtime, because what
 * is under test is the tool's own decisions — which arguments an action needs,
 * when a screenshot is refused, and what content blocks it produces.
 */

import { describe, expect, it } from 'vitest'
import type { Context } from '@deepseek-ai/cordis'
import { browserTool, BROWSER_ACTIONS } from '../src/tool.ts'
import type { BrowserManager, CapturedScreenshot } from '../src/browser.ts'
import type { RawSnapshot } from '../src/page-script.ts'

const PNG_BYTES = Uint8Array.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const REF = {
  attachmentId: 'sha256:ab', mediaType: 'image/png' as const,
  bytes: PNG_BYTES.byteLength, width: 1280, height: 720, name: 'browser-screenshot.png',
}

const SNAPSHOT: RawSnapshot = {
  url: 'https://example.test/', title: 'Example', text: 'Hello page', elements: [],
} as unknown as RawSnapshot

/** A manager that records the calls made and never launches a browser. */
function fakeBrowser(overrides: Partial<Record<string, unknown>> = {}) {
  const calls: string[] = []
  const shot: CapturedScreenshot = {
    data: PNG_BYTES, mediaType: 'image/png', url: 'https://example.test/a', title: 'Shot',
  }
  const manager = {
    calls,
    navigate: (key: string, url: string) => { calls.push(`navigate:${key}:${url}`); return Promise.resolve(SNAPSHOT) },
    read: (key: string) => { calls.push(`read:${key}`); return Promise.resolve(SNAPSHOT) },
    click: (key: string, ref: number) => { calls.push(`click:${key}:${ref}`); return Promise.resolve(SNAPSHOT) },
    type: (key: string, ref: number, text: string) => { calls.push(`type:${key}:${ref}:${text}`); return Promise.resolve(SNAPSHOT) },
    press: (key: string, k: string) => { calls.push(`press:${key}:${k}`); return Promise.resolve(SNAPSHOT) },
    scroll: (key: string, d: string) => { calls.push(`scroll:${key}:${d}`); return Promise.resolve(SNAPSHOT) },
    back: (key: string) => { calls.push(`back:${key}`); return Promise.resolve(SNAPSHOT) },
    screenshot: (key: string) => { calls.push(`screenshot:${key}`); return Promise.resolve(shot) },
    ...overrides,
  }
  return manager as unknown as BrowserManager & { calls: string[] }
}

/** The services the tool resolves off the context, each independently absent-able. */
function fakeCtx(options: { attachments?: boolean; llm?: boolean; modalities?: string[]; saveRejects?: Error } = {}) {
  const saved: unknown[] = []
  const ctx = {
    saved,
    get(name: string) {
      if (name === 'attachments') {
        if (options.attachments === false) return undefined
        return {
          saveImage: (input: unknown) => {
            saved.push(input)
            if (options.saveRejects !== undefined) return Promise.reject(options.saveRejects)
            return Promise.resolve(REF)
          },
        }
      }
      if (name === 'llm') {
        if (options.llm === false) return undefined
        const modalities = options.modalities ?? ['text', 'image']
        return { resolveModelInfo: () => Promise.resolve({ inputModalities: modalities }) }
      }
      return undefined
    },
  }
  return ctx as unknown as Context & { saved: unknown[] }
}

/** A calling agent pinned to one routed provider/model. */
function fakeExec(model = 'vision-model') {
  return {
    signal: new AbortController().signal,
    agent: {
      options: {},
      session: { id: 'session-1', requestHeader: () => ({ config: { provider: 'p', model } }) },
    },
  } as never
}

/** A calling agent whose route cannot be resolved, which is its own refusal arm. */
function fakeExecWithoutRoute() {
  return {
    signal: new AbortController().signal,
    agent: { options: {}, session: { id: 'session-1', requestHeader: () => undefined } },
  } as never
}

type Tool = ReturnType<typeof browserTool>

function run(tool: Tool, args: unknown, exec: unknown = fakeExec()) {
  return (tool as unknown as { execute: (a: unknown, e: unknown) => Promise<{ text: string; image?: { attachmentId: string } }> })
    .execute(args, exec)
}

describe('browser action dispatch', () => {
  it('names screenshot among the actions the schema advertises', () => {
    expect(BROWSER_ACTIONS).toContain('screenshot')
  })

  it('routes each acting action to its manager method and returns text only', async () => {
    const browser = fakeBrowser()
    const tool = browserTool(fakeCtx(), browser, 10_000)
    for (const [args, expected] of [
      [{ action: 'navigate', url: 'https://a.test/' }, 'navigate:session-1:https://a.test/'],
      [{ action: 'read' }, 'read:session-1'],
      [{ action: 'click', ref: 3 }, 'click:session-1:3'],
      [{ action: 'type', ref: 4, text: 'hi' }, 'type:session-1:4:hi'],
      [{ action: 'press', key: 'Enter' }, 'press:session-1:Enter'],
      [{ action: 'scroll' }, 'scroll:session-1:down'],
      [{ action: 'scroll', text: 'up' }, 'scroll:session-1:up'],
      [{ action: 'back' }, 'back:session-1'],
    ] as const) {
      const value = await run(tool, args)
      expect(browser.calls.at(-1)).toBe(expected)
      expect(value.image).toBeUndefined()
      expect(value.text).toContain('Hello page')
    }
  })

  it('rejects an action it does not know, naming the ones it does', async () => {
    const tool = browserTool(fakeCtx(), fakeBrowser(), 10_000)
    await expect(run(tool, { action: 'teleport' })).rejects.toThrow(/unknown action "teleport".*screenshot/s)
  })

  it('rejects each acting action whose required argument is missing', async () => {
    const tool = browserTool(fakeCtx(), fakeBrowser(), 10_000)
    await expect(run(tool, { action: 'navigate' })).rejects.toThrow(/navigate needs a "url"/)
    await expect(run(tool, { action: 'click' })).rejects.toThrow(/click needs a "ref"/)
    await expect(run(tool, { action: 'type', ref: 1 })).rejects.toThrow(/type needs "text"/)
    await expect(run(tool, { action: 'press' })).rejects.toThrow(/press needs a "key"/)
  })
})

describe('browser screenshot', () => {
  it('captures, commits the bytes, and returns the image beside its envelope', async () => {
    const browser = fakeBrowser()
    const ctx = fakeCtx()
    const value = await run(browserTool(ctx, browser, 10_000), { action: 'screenshot' })

    expect(browser.calls).toEqual(['screenshot:session-1'])
    expect(ctx.saved).toEqual([
      { data: PNG_BYTES, mediaType: 'image/png', name: 'browser-screenshot.png' },
    ])
    expect(value.image).toEqual(REF)
    // The image alone does not say what it depicts, so the envelope carries the page.
    expect(value.text).toContain('https://example.test/a')
    expect(value.text).toContain('Shot')
    expect(value.text).toContain('1280x720')
  })

  it('refuses before capturing when the model does not accept image input', async () => {
    const browser = fakeBrowser()
    const ctx = fakeCtx({ modalities: ['text'] })
    await expect(run(browserTool(ctx, browser, 10_000), { action: 'screenshot' }))
      .rejects.toThrow(/does not declare image input/)
    // The refusal costs no browser work and commits nothing.
    expect(browser.calls).toEqual([])
    expect(ctx.saved).toEqual([])
  })

  it('refuses when the calling route cannot be resolved', async () => {
    const tool = browserTool(fakeCtx(), fakeBrowser(), 10_000)
    await expect(run(tool, { action: 'screenshot' }, fakeExecWithoutRoute()))
      .rejects.toThrow(/route could not be resolved/)
  })

  it('refuses when no llm service is mounted', async () => {
    const tool = browserTool(fakeCtx({ llm: false }), fakeBrowser(), 10_000)
    await expect(run(tool, { action: 'screenshot' })).rejects.toThrow(/route could not be resolved/)
  })

  it('refuses when no attachment store is mounted, before capturing', async () => {
    const browser = fakeBrowser()
    const tool = browserTool(fakeCtx({ attachments: false }), browser, 10_000)
    await expect(run(tool, { action: 'screenshot' })).rejects.toThrow(/no attachment service is mounted/)
    expect(browser.calls).toEqual([])
  })

  it('reports a storage refusal as a tool error instead of leaking the raw failure', async () => {
    const { AttachmentError } = await import('@deepseek-ai/dsh-attachment')
    const failing = new AttachmentError('too big', 'IMAGE_TOO_LARGE')
    const tool = browserTool(fakeCtx({ saveRejects: failing }), fakeBrowser(), 10_000)
    await expect(run(tool, { action: 'screenshot' })).rejects.toThrow(/could not be stored \(IMAGE_TOO_LARGE\)/)
  })

  it('caps long page text without touching the image', async () => {
    const long = 'x'.repeat(500)
    const browser = fakeBrowser({ read: () => Promise.resolve({ ...SNAPSHOT, text: long }) })
    const value = await run(browserTool(fakeCtx(), browser, 100), { action: 'read' })
    expect(value.text).toContain('characters truncated')
    expect(value.image).toBeUndefined()
  })
})
