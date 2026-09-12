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
import { KernelChild, decodeFrame, parseControlResult, withFrameImages } from '../src/child.ts'
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


/**
 * A frame's `images` is untrusted child output like any other part of it.
 *
 * The child decides what goes in that array, so the transport's job is to hand
 * on only entries a consumer can actually use — and to drop one bad entry
 * without discarding the whole cell's result or, worse, the pictures beside it.
 */
describe('KernelFrame images', () => {
  const PNG = { data: 'aGk=', mediaType: 'image/png', bytes: 3 }

  it('keeps a well-formed image list', () => {
    const frame = withFrameImages({ out: 'x', images: [PNG] } as never)
    expect(frame.images).toEqual([PNG])
  })

  it('reports no images when the frame carried none', () => {
    // Absent is the normal case for a cell that never called show().
    expect(withFrameImages({ out: 'x' }).images).toBeUndefined()
  })

  it('drops a malformed entry without losing the good ones beside it', () => {
    const frame = withFrameImages({
      out: 'x',
      images: [
        PNG,
        { data: '', mediaType: 'image/png', bytes: 0 },
        { data: 'aGk=', mediaType: 'image/tiff', bytes: 3 },
        { data: 'aGk=', mediaType: 'image/png', bytes: -1 },
        { data: 42, mediaType: 'image/png', bytes: 3 },
        null,
        'nope',
        { data: 'aGk=', mediaType: 'image/webp', bytes: 3, name: 'shot.webp', note: 'after the click' },
      ],
    } as never)
    expect(frame.images).toEqual([
      PNG,
      { data: 'aGk=', mediaType: 'image/webp', bytes: 3, name: 'shot.webp', note: 'after the click' },
    ])
  })

  it('normalises an empty-but-present list to no images', () => {
    // A child that sent `images: []` means "no pictures", not "an empty batch
    // to save" — the two must not reach a consumer as different states.
    expect(withFrameImages({ out: 'x', images: [] } as never).images).toBeUndefined()
  })

  it('ignores a non-array images field instead of throwing', () => {
    expect(withFrameImages({ out: 'x', images: 'oops' } as never).images).toBeUndefined()
    expect(withFrameImages({ out: 'x', images: { data: 'aGk=' } } as never).images).toBeUndefined()
  })

  it('carries images from the child through the frame reader', async () => {
    const child = startFake()
    try {
      const frame = await child.nextFrame(child.send(`IMAGES:${JSON.stringify([PNG])}`))
      expect(frame.out).toBe('images')
      expect(frame.images).toEqual([PNG])
    } finally {
      await child.kill()
    }
  })

  it('filters a bad entry that came over the wire', async () => {
    const child = startFake()
    try {
      const sent = [PNG, { data: 'aGk=', mediaType: 'image/bmp', bytes: 3 }]
      const frame = await child.nextFrame(child.send(`IMAGES:${JSON.stringify(sent)}`))
      expect(frame.images).toEqual([PNG])
    } finally {
      await child.kill()
    }
  })
})
