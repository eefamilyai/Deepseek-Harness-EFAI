/**
 * End-to-end: a real Python cell returning a real image.
 *
 * The transport suite pins what a frame may carry, and the tool suite pins what
 * a committed image becomes. Neither runs the runtime. This one drives the REAL
 * `kernel_child.py` and asserts the picture actually crosses the process
 * boundary — the one link a mocked frame can never prove, because the failure it
 * guards against is `show()` existing in the runtime while nothing carries its
 * bytes out.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { KernelChild } from '../src/child.ts'
import type { SeamRequest } from '../src/seam.ts'
import { resolvePython } from '../src/index.ts'

const KERNEL = join(import.meta.dirname, '..', '..', '..', '..', 'python', 'kiln', 'runtime', 'kernel_child.py')

const python = await resolvePython()
// Skipped rather than failed where no interpreter exists: driving one is this
// package's whole job, so "no Python here" is an environment fact, not a defect.
const describeE2E = python === undefined ? describe.skip : describe

/** Booting a Python child and running a cell in it is not a 5-second operation. */
const CELL_TIMEOUT_MS = 60_000

/** Bytes of a real 2x2 PNG, so the runtime's own signature sniffing accepts it. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAIAAAACCAYAAABytg0kAAAAFUlEQVR4nGP8z8Dwn4GBgYGJAQoAHgQCAZ7i2mMAAAAASUVORK5CYII='

/**
 * A cell that writes the PNG to disk. The cell namespace deliberately preloads
 * only the helpers, so the standard library has to be imported by the cell.
 */
const writePng = [
  'import base64, os',
  `PNG = base64.b64decode(${JSON.stringify(PNG_BASE64)})`,
  'p = os.path.join(os.getcwd(), "e2e-shot.png")',
  'open(p, "wb").write(PNG)',
].join('\n')

describeE2E('a cell image reaches the frame', () => {
  let child: KernelChild

  beforeAll(() => {
    child = new KernelChild({
      python: python ?? 'python3',
      script: KERNEL,
      cwd: process.cwd(),
      env: {},
    })
    // The child asks the harness for its tool roster as it starts. Nothing here
    // needs those tools, but an unanswered request stalls the cell before it
    // runs, so every seam request gets a refusal and the child moves on.
    child.seamHandler = (seam: SeamRequest): void => {
      if (!child.dead) child.sendSeamResponse({ id: seam.id, ok: false, error: 'no harness in this test' })
    }
  }, CELL_TIMEOUT_MS)

  afterAll(async () => {
    await child?.kill()
  })

  /** Run one cell against the live child and return its frame. */
  async function run(code: string) {
    return child.nextFrame(child.send(code))
  }

  it('exposes show() and shown_images() to a cell', async () => {
    const frame = await run('print(callable(show), callable(shown_images))')
    expect(frame.error ?? null).toBeNull()
    expect(frame.out).toContain('True True')
  }, CELL_TIMEOUT_MS)

  it('documents show() through tool_help, so a cell author can find it', async () => {
    const frame = await run('print(tool_help("show"))')
    expect(frame.error ?? null).toBeNull()
    expect(frame.out).toContain('Show YOURSELF')
  }, CELL_TIMEOUT_MS)

  it('carries a file image out with its bytes intact', async () => {
    const frame = await run(`${writePng}\nprint(show(p, note="e2e"))`)
    expect(frame.error ?? null).toBeNull()
    expect(frame.images).toHaveLength(1)
    const [image] = frame.images ?? []
    // The media type comes from the bytes, and the payload decodes back to the
    // exact file: that round trip is the contract a consumer relies on.
    expect(image?.mediaType).toBe('image/png')
    expect(image?.bytes).toBe(77)
    expect(image?.name).toBe('e2e-shot.png')
    expect(image?.note).toBe('e2e')
    expect(image?.data).toBe(PNG_BASE64)
  }, CELL_TIMEOUT_MS)

  it('omits the field entirely for a cell that showed nothing', async () => {
    // Absent, not empty: a consumer tests for the field, and an empty array
    // would make "no images" indistinguishable from an image batch arriving.
    const frame = await run('print("plain")')
    expect(frame.error ?? null).toBeNull()
    expect(frame.images).toBeUndefined()
  }, CELL_TIMEOUT_MS)

  it('still carries an image queued before a later exception', async () => {
    const frame = await run(`${writePng}\nshow(p)\nraise ValueError("after the picture")`)
    expect(frame.error).toContain('after the picture')
    expect(frame.images).toHaveLength(1)
  }, CELL_TIMEOUT_MS)

  it('keeps queue order across several images in one cell', async () => {
    const frame = await run(
      `${writePng}\n`
      + 'show(p, name="first")\n'
      + 'show(PNG, name="second")\n'
      + 'print(shown_images()["count"])',
    )
    expect(frame.error ?? null).toBeNull()
    expect(frame.out).toContain('2')
    expect((frame.images ?? []).map(i => i.name)).toEqual(['first', 'second'])
  }, CELL_TIMEOUT_MS)

  it('reports an unsupported file as a message instead of raising', async () => {
    const frame = await run('print(show("definitely-not-here.png"))')
    expect(frame.error ?? null).toBeNull()
    expect(frame.out).toContain('no such file')
    expect(frame.images).toBeUndefined()
  }, CELL_TIMEOUT_MS)
})
