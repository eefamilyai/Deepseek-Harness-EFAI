// @vitest-environment jsdom
/**
 * Capturing a guest that is not painting: the capture runs in stages with a repaint
 * request between them, and a failure names why the page drew no frame.
 */
import { afterEach, describe, expect, it, vi } from 'vitest'
import { capture, type WebviewElement } from '../src/client/pages.ts'

const image = {
  isEmpty: () => false, getSize: () => ({ width: 3, height: 2 }), toDataURL: () => 'data:image/png;base64,AA==',
}
const never = () => new Promise<never>(() => {})

function guest(captures: (() => Promise<typeof image>)[], size = { width: 800, height: 600 }, repaint = vi.fn(async () => true)) {
  let call = 0
  const element = document.createElement('div') as unknown as WebviewElement & { capturePage: ReturnType<typeof vi.fn> }
  const box = { ...size, x: 0, y: 0, top: 0, left: 0, right: size.width, bottom: size.height, toJSON: () => ({}) }
  element.getBoundingClientRect = () => box
  element.capturePage = vi.fn(() => (captures[Math.min(call++, captures.length - 1)] ?? never)())
  element.executeJavaScript = repaint
  return { element, repaint }
}

afterEach(() => { vi.useRealTimers() })

describe('capture', () => {
  it('answers at once when the guest paints', async () => {
    const { element, repaint } = guest([async () => image])
    expect(await capture(element, 15_000)).toBe(image)
    expect(repaint).not.toHaveBeenCalled()
  })

  it('asks a stalled guest to paint and captures again', async () => {
    vi.useFakeTimers()
    const { element, repaint } = guest([never, async () => image])
    const pending = capture(element, 15_000)
    await vi.advanceTimersByTimeAsync(4000)
    expect(await pending).toBe(image)
    expect(repaint).toHaveBeenCalledOnce()
    expect(element.capturePage).toHaveBeenCalledTimes(2)
  })

  it('takes whichever capture answers first after a repaint', async () => {
    vi.useFakeTimers()
    let late: (value: typeof image) => void = () => {}
    const first = new Promise<typeof image>((resolve) => { late = resolve })
    const { element } = guest([() => first, never])
    const pending = capture(element, 15_000)
    await vi.advanceTimersByTimeAsync(4100)
    late(image)
    expect(await pending).toBe(image)
  })

  it('refuses a collapsed panel without waiting', async () => {
    const { element } = guest([never], { width: 0, height: 600 })
    await expect(capture(element, 15_000)).rejects.toThrow(/AI Browser panel is collapsed or hidden/)
    expect(element.capturePage).not.toHaveBeenCalled()
  })

  it('names a page that drew no frame, and a hidden window, when time runs out', async () => {
    vi.useFakeTimers()
    const failing = vi.fn(async () => { throw new Error('gone') })
    const { element } = guest([never], undefined, failing)
    const pending = capture(element, 3000).catch((error: unknown) => error as Error)
    await vi.advanceTimersByTimeAsync(5000)
    const error = await pending
    expect(error.message).toMatch(/timed out after 3000 ms: the page drew no new frame\. Bring the window to the front/)
    expect(error.message).not.toContain('minimized')
    vi.spyOn(document, 'hidden', 'get').mockReturnValue(true)
    const hidden = capture(guest([never]).element, 1000).catch((caught: unknown) => caught as Error)
    await vi.advanceTimersByTimeAsync(3000)
    expect((await hidden).message).toContain('The window is minimized or hidden')
  })
})
