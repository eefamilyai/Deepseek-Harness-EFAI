/**
 * What a cell's returned images become by the time the model sees them.
 *
 * A picture reaches the transcript through three steps that must all hold: the
 * kernel frame carries the bytes, this tool commits them to the durable
 * attachment store, and the rendered content blocks reference the committed
 * objects. These tests pin the two that this package owns — the admission of
 * untrusted frame bytes, and the block shapes a model and a UI both read.
 */
import { describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import type { AttachmentStore, ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import { AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { KernelCellImage } from '@deepseek-ai/dsh-kernel'
import SystemPrompt from '@deepseek-ai/dsh-system-prompt'
import ToolRuntime from '@deepseek-ai/dsh-tools'
import {
  admitCellImages, apply, formatImageNote, imageRefFromValue, kernelContent,
  DEFAULT_BACKGROUND_TIMEOUT_MS, DEFAULT_KERNEL_TIMEOUT_MS, DEFAULT_MAX_OUTPUT_CHARS,
  DEFAULT_MAX_TIMEOUT_MS,
} from '../src/index.ts'
import type { Config as KernelToolConfig, KernelValueImage } from '../src/index.ts'

/** Bytes of a real 1x1 PNG, so a store that decodes them would accept them. */
const PNG_BASE64 =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg=='

function ref(overrides: Partial<ImageAttachmentRef> = {}): ImageAttachmentRef {
  return {
    attachmentId: AttachmentId('sha256:abc'),
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
    ...overrides,
  }
}

/**
 * A store that records what it was asked to save and answers with whatever the
 * test tells it to — including refusals, which are the interesting case.
 */
function fakeStore(options: {
  mediaTypes?: readonly ImageMediaType[]
  saveImages?: (inputs: readonly { data: Uint8Array }[]) => Promise<readonly ImageAttachmentRef[]>
  saveImage?: (input: { data: Uint8Array; name?: string }) => Promise<ImageAttachmentRef>
} = {}): AttachmentStore & { batchCalls: number; singleCalls: number } {
  const store = {
    imageLimits: {
      maxImageBytes: 1024 * 1024,
      maxImagesPerMessage: 4,
      maxMessageImageBytes: 4 * 1024 * 1024,
      maxImagePixels: 1024 * 1024,
      maxImageDimension: 4096,
      mediaTypes: options.mediaTypes ?? (['image/png', 'image/jpeg', 'image/webp', 'image/gif'] as const),
    },
    batchCalls: 0,
    singleCalls: 0,
    saveImages: async (inputs: readonly { data: Uint8Array }[]) => {
      store.batchCalls += 1
      if (options.saveImages !== undefined) return options.saveImages(inputs)
      return inputs.map(() => ref())
    },
    saveImage: async (input: { data: Uint8Array; name?: string }) => {
      store.singleCalls += 1
      if (options.saveImage !== undefined) return options.saveImage(input)
      return ref()
    },
  }
  return store as unknown as AttachmentStore & { batchCalls: number; singleCalls: number }
}

function image(overrides: Partial<KernelCellImage> = {}): KernelCellImage {
  return { data: PNG_BASE64, mediaType: 'image/png', bytes: 68, ...overrides }
}

describe('admitCellImages', () => {
  it('returns no references and no notes for a cell that showed nothing', async () => {
    const store = fakeStore()
    expect(await admitCellImages(store, [])).toEqual({ refs: [], notes: [] })
    // Nothing is stored and nothing is reported: "no images" is not a failure.
    expect(store.batchCalls).toBe(0)
  })

  it('saves one batch and returns the references in order', async () => {
    const first = ref({ attachmentId: AttachmentId('sha256:one') })
    const second = ref({ attachmentId: AttachmentId('sha256:two'), mediaType: 'image/webp' })
    const store = fakeStore({ saveImages: async () => [first, second] })
    const result = await admitCellImages(store, [image(), image({ mediaType: 'image/webp' })])
    expect(result.refs).toEqual([first, second])
    expect(result.notes).toEqual([])
    expect(store.batchCalls).toBe(1)
  })

  it('refuses a media type the deployment does not accept, keeping the rest', async () => {
    const store = fakeStore({ mediaTypes: ['image/png'] })
    const result = await admitCellImages(store, [
      image(),
      image({ mediaType: 'image/gif', name: 'anim.gif' }),
    ])
    expect(result.refs).toHaveLength(1)
    // The note names the image, so the author can tell which one was refused
    // without counting positions in the list.
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('anim.gif')
    expect(result.notes[0]).toContain('image/gif')
    expect(result.notes[0]).toContain('not accepted by this deployment')
  })

  it('reports an all-refused batch as notes rather than throwing', async () => {
    const store = fakeStore({ mediaTypes: ['image/jpeg'] })
    const result = await admitCellImages(store, [image(), image({ mediaType: 'image/webp' })])
    expect(result.refs).toEqual([])
    expect(result.notes).toHaveLength(2)
  })

  it('falls back to one at a time when the batch is refused', async () => {
    // The usual real cause is the store's aggregate byte or count bound, which
    // refuses the batch as a whole. Retrying singly is what saves the images
    // that do fit.
    const store = fakeStore({
      saveImages: async () => { throw new Error('batch exceeds the aggregate byte limit') },
      saveImage: async input => ref({ bytes: input.data.byteLength }),
    })
    const result = await admitCellImages(store, [image(), image(), image()])
    expect(store.batchCalls).toBe(1)
    expect(store.singleCalls).toBe(3)
    expect(result.refs).toHaveLength(3)
    expect(result.notes).toEqual([])
  })

  it('keeps the good images when one member of the retry fails', async () => {
    let call = 0
    const store = fakeStore({
      saveImages: async () => { throw new Error('refused') },
      saveImage: async () => {
        call += 1
        if (call === 2) throw new Error('at least one side exceeds the 4096px limit')
        return ref()
      },
    })
    const result = await admitCellImages(store, [
      image({ name: 'a.png' }),
      image({ name: 'b.png' }),
      image({ name: 'c.png' }),
    ])
    expect(result.refs).toHaveLength(2)
    expect(result.notes).toHaveLength(1)
    expect(result.notes[0]).toContain('b.png')
    expect(result.notes[0]).toContain('4096px')
  })

  it('stops storing when the caller cancels', async () => {
    const controller = new AbortController()
    const store = fakeStore({
      saveImages: async () => { throw new Error('refused') },
      saveImage: async () => {
        controller.abort(new Error('cancelled'))
        return ref()
      },
    })
    await expect(admitCellImages(store, [image(), image()], controller.signal))
      .rejects.toThrow('cancelled')
  })
})

describe('formatImageNote', () => {
  it('names the type, dimensions, and byte size', () => {
    const note = formatImageNote({
      attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 68, width: 1, height: 1,
    })
    expect(note).toBe('[image: image/png, 1x1 px, 68 bytes]')
  })

  it('includes the display name and the caption when present', () => {
    const note = formatImageNote({
      attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 68, width: 2, height: 3,
      name: 'shot.png', note: 'the dialog after saving',
    })
    expect(note).toBe('["shot.png": image/png, 2x3 px, 68 bytes \u2014 the dialog after saving]')
  })

  it('says when the store downscaled the image', () => {
    // The stored dimensions are what the model is looking at; the original is
    // what the file on disk holds, and confusing the two mislocates features.
    const note = formatImageNote({
      attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 68, width: 800, height: 600,
      originalDimensions: { width: 1600, height: 1200 },
    })
    expect(note).toContain('800x600 px')
    expect(note).toContain('downscaled from 1600x1200 px')
  })
})

describe('imageRefFromValue', () => {
  it('round-trips every field an image block carries', () => {
    const value: KernelValueImage = {
      attachmentId: 'sha256:abc',
      mediaType: 'image/webp',
      bytes: 68,
      width: 10,
      height: 20,
      name: 'shot.webp',
      originalDimensions: { width: 20, height: 40 },
    }
    expect(imageRefFromValue(value)).toEqual({
      attachmentId: 'sha256:abc',
      mediaType: 'image/webp',
      bytes: 68,
      width: 10,
      height: 20,
      name: 'shot.webp',
      originalDimensions: { width: 20, height: 40 },
    })
  })

  it('omits absent optional fields rather than writing undefined', () => {
    const value = imageRefFromValue({
      attachmentId: 'sha256:abc', mediaType: 'image/png', bytes: 1, width: 1, height: 1,
    })
    expect('name' in value).toBe(false)
    expect('originalDimensions' in value).toBe(false)
  })
})

describe('kernelContent', () => {
  const stored: KernelValueImage = {
    attachmentId: 'sha256:abc',
    mediaType: 'image/png',
    bytes: 68,
    width: 1,
    height: 1,
    name: 'shot.png',
    note: 'after the click',
  }

  it('renders text alone when the cell returned no images', () => {
    const blocks = kernelContent({
      output: 'hello', outcome: 'ok', restarted: false, images: [], imageNotes: [],
    })
    expect(blocks).toEqual([{ type: 'text', text: 'hello' }])
  })

  it('puts each image beside its own envelope line', () => {
    const blocks = kernelContent({
      output: 'cell done', outcome: 'ok', restarted: false, images: [stored], imageNotes: [],
    })
    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toEqual({ type: 'text', text: 'cell done' })
    expect(blocks[1]).toEqual({
      type: 'text',
      text: '["shot.png": image/png, 1x1 px, 68 bytes \u2014 after the click]',
    })
    expect(blocks[2]).toEqual({ type: 'image', attachment: imageRefFromValue(stored) })
  })

  it('reports a storage refusal as text beside whatever did get stored', () => {
    const blocks = kernelContent({
      output: 'cell done', outcome: 'ok', restarted: false,
      images: [stored],
      imageNotes: ['"huge.png" was not stored: too large'],
    })
    expect(blocks.map(block => block.type)).toEqual(['text', 'text', 'text', 'image'])
    expect(blocks[1]).toEqual({ type: 'text', text: '"huge.png" was not stored: too large' })
  })

  it('keeps the empty-output notice when a cell returned only images', () => {
    // The notice is what stops a model inventing a result it did not see, so an
    // image must not suppress it.
    const blocks = kernelContent({
      output: '', outcome: 'ok', restarted: false, images: [stored], imageNotes: [],
    })
    const first = blocks[0] as { type: 'text'; text: string }
    expect(first.text).toContain('OUTPUT: (empty')
  })

  it('orders multiple images the way the cell queued them', () => {
    const second: KernelValueImage = { ...stored, attachmentId: 'sha256:def', name: 'second.png' }
    const blocks = kernelContent({
      output: 'x', outcome: 'ok', restarted: false, images: [stored, second], imageNotes: [],
    })
    const images = blocks.filter(block => block.type === 'image')
    expect(images).toHaveLength(2)
    expect((images[0] as { attachment: { attachmentId: string } }).attachment.attachmentId)
      .toBe('sha256:abc')
    expect((images[1] as { attachment: { attachmentId: string } }).attachment.attachmentId)
      .toBe('sha256:def')
  })
})

/**
 * Mounting the plugin at all — the check whose absence let a schema the loader
 * rejects reach a rebuilt deployment.
 *
 * `apply` compiles both schemas through the value-schema DSL, and that compiler
 * rejects a `required` on an array's `items`. Every other test in this file
 * calls the helper functions directly, so none of them ever compiled the output
 * schema: the tool could pass the suite and still fail to mount. These tests
 * invoke the real `apply`, so a schema the DSL refuses fails here instead of at
 * preset mount time.
 */
describe('apply', () => {
  /** Every config field `apply` reads, spelled out rather than defaulted. */
  const config: KernelToolConfig = {
    timeoutMs: DEFAULT_KERNEL_TIMEOUT_MS,
    maxOutputChars: DEFAULT_MAX_OUTPUT_CHARS,
    maxTimeoutMs: DEFAULT_MAX_TIMEOUT_MS,
    backgroundTimeoutMs: DEFAULT_BACKGROUND_TIMEOUT_MS,
  }

  /** Mount the real plugin over a real tool registry and prompt service. */
  async function mount() {
    const ctx = new Context()
    await ctx.plugin(SystemPrompt)
    await ctx.plugin(ToolRuntime)
    apply(ctx, config)
    return ctx
  }

  it('mounts and registers the kernel tool', async () => {
    const ctx = await mount()
    expect(ctx.tools.get('kernel')).toBeDefined()
  })

  it('declares requiredness on the images property, not on its item schema', async () => {
    // The regression itself. Requiredness belongs to the `images` property that
    // holds the array; a top-level `required` on the authored item node is not
    // in the value-schema DSL's vocabulary, so `defineTool` rejects it and the
    // preset fails to mount. The compiled projection still describes each
    // item's own required fields, which is where the item-level requirement
    // actually lives.
    const ctx = await mount()
    const schema = ctx.tools.get('kernel')?.output.schema as {
      required?: string[]
      properties: { images: { type: string; items: { required?: string[] } } }
    }
    expect(schema.required).toContain('images')
    expect(schema.properties.images.type).toBe('array')
    expect(schema.properties.images.items.required).toEqual([
      'attachmentId', 'mediaType', 'bytes', 'width', 'height',
    ])
  })
})
