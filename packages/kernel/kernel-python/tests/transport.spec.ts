/**
 * The frame transport's correlation contract.
 *
 * These tests exist because of a real session that ran for ~40 further tool
 * calls on a kernel that had silently stopped answering. One cell called
 * `os.system(...)`, whose child inherited fd 1 and wrote a line of plain text
 * onto the frame channel. That line was decoded into an error frame, handed to
 * the cell that was waiting, and the cell's REAL frame then had no waiter — so
 * it was queued for the next cell. From that point every result was the
 * previous cell's, delivered in single-digit milliseconds, and nothing in the
 * stack noticed. The model was told the harness had degraded; the harness was
 * fine, the channel was one frame out of step.
 *
 * The contract these pin down: a frame answers the request whose id it carries,
 * or it answers nothing.
 */
import { join } from 'node:path'
import { describe, expect, it } from 'vitest'
import { KernelChild, decodeFrame, parseControlResult } from '../src/child.ts'
import { resolvePython } from '../src/index.ts'

const FAKE = join(import.meta.dirname, 'fixtures', 'fake-kernel.py')

const python = await resolvePython()
// Skipped rather than failed where no interpreter exists: this package's whole
// job is driving one, so "no Python here" is an environment fact, not a defect.
const describeChild = python === undefined ? describe.skip : describe

/** A child pointed at the fake runtime, with the launch fields it ignores. */
function startFake(): KernelChild {
  return new KernelChild({ python: python ?? 'python3', script: FAKE, cwd: process.cwd(), env: {} })
}

/** Run one directive against the fake and return its joined output. */
async function cell(child: KernelChild, code: string): Promise<string> {
  const frame = await child.nextFrame(child.send(code))
  return frame.out ?? ''
}

describe('decodeFrame', () => {
  it('decodes a base64 JSON frame', () => {
    const line = Buffer.from(JSON.stringify({ out: 'hi', error: null, id: 3 })).toString('base64')
    expect(decodeFrame(line)).toEqual({ out: 'hi', error: null, id: 3 })
  })

  it('rejects a line that is not a frame instead of inventing one', () => {
    // Plain words are inside the base64 alphabet, so Buffer.from(_, 'base64')
    // decodes them to plausible binary rather than failing. Turning that into
    // an error frame is what consumed a cell's waiter and shifted the channel.
    expect(decodeFrame('CONTAMINATION')).toBeUndefined()
    expect(decodeFrame('hello world')).toBeUndefined()
    expect(decodeFrame(Buffer.from('[1,2,3]').toString('base64'))).toBeUndefined()
    expect(decodeFrame(Buffer.from('not json').toString('base64'))).toBeUndefined()
  })
})

describeChild('KernelChild frame correlation', () => {
  it('answers each cell with its own frame', async () => {
    const child = startFake()
    try {
      expect(await cell(child, 'ECHO:one')).toBe('one')
      expect(await cell(child, 'ECHO:two')).toBe('two')
    } finally {
      await child.kill()
    }
  })

  it('stays aligned when a cell writes raw text onto the frame channel', async () => {
    const child = startFake()
    try {
      expect(await cell(child, 'ECHO:before')).toBe('before')
      // The regression: this cell's own answer must still be its own answer.
      expect(await cell(child, 'RAW:CONTAMINATION')).toBe('after-raw')
      // ...and the channel must not be one behind from here on.
      expect(await cell(child, 'ECHO:after')).toBe('after')
      expect(await cell(child, 'ECHO:later')).toBe('later')
      expect(child.discardedFrames).toBe(1)
    } finally {
      await child.kill()
    }
  })

  it('survives repeated contamination without accumulating a backlog', async () => {
    const child = startFake()
    try {
      for (let index = 0; index < 5; index += 1) {
        expect(await cell(child, `RAW:junk-${index}`)).toBe('after-raw')
        expect(await cell(child, `ECHO:probe-${index}`)).toBe(`probe-${index}`)
      }
      expect(child.discardedFrames).toBe(5)
    } finally {
      await child.kill()
    }
  })

  it('does not hand a cancelled cell\'s late frame to the next cell', async () => {
    const child = startFake()
    try {
      const controller = new AbortController()
      const id = child.send('ECHO:abandoned')
      controller.abort()
      await expect(child.nextFrame(id, controller.signal)).rejects.toThrow()
      // The fake has already answered `id`; that frame belongs to nobody and
      // must not be collected by whoever asks next.
      expect(await cell(child, 'ECHO:mine')).toBe('mine')
    } finally {
      await child.kill()
    }
  })

  it('marks a dead child rather than reporting an empty cell', async () => {
    const child = startFake()
    try {
      const id = child.send('EXIT')
      const frame = await child.nextFrame(id)
      // The distinction the provider turns into 'crashed' instead of "the cell
      // produced no output" — which is what a genuinely silent cell returns.
      expect(frame.dead).toBe(true)
      expect(child.dead).toBe(true)
    } finally {
      await child.kill()
    }
  })

  it('keeps an empty cell distinguishable from a dead one', async () => {
    const child = startFake()
    try {
      const frame = await child.nextFrame(child.send('SILENT'))
      expect(frame.dead).toBeUndefined()
      expect(frame.out).toBe('')
    } finally {
      await child.kill()
    }
  })

  it('correlates control requests too', async () => {
    const child = startFake()
    try {
      const frame = await child.nextFrame(child.sendControl({ cmd: 'list_names' }))
      expect(parseControlResult(frame)).toEqual({ names: ['a', 'b'] })
    } finally {
      await child.kill()
    }
  })
})
