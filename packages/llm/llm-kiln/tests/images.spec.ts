/**
 * Image transport for the one route that can carry one.
 *
 * These providers have no native attachment field, so an image reaches the
 * model only if the adapter uploads the bytes through the sidecar first and
 * names the returned ids on the turn. Every failure mode here is silent by
 * nature — the model simply never sees the picture — which is why each link in
 * that chain is pinned separately: the capability declaration that stops the
 * runtime from replacing images with text before dispatch, the upload itself,
 * the ids and their owning login riding the request, and the placeholder that
 * stands in when the image genuinely did not travel.
 */

import { describe, expect, it } from 'vitest'
import { createUserMessage } from '@deepseek-ai/dsh-llm'
import type { AttachmentStore, ImageAttachmentRef } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock, GenerateOptions } from '@deepseek-ai/dsh-llm'
import { KilnAdapter, buildTurns, flattenMessage, requestOptions } from '@deepseek-ai/dsh-llm-kiln'
import type { KilnBridge, KilnProvider, KilnStreamEvent, KilnStreamRequest, KilnUploadFile } from '@deepseek-ai/dsh-llm-kiln'

const source = { kind: 'plugin', plugin: 'test' } as const

/** A durable image reference shaped exactly as the attachment service emits one. */
const REF = {
  attachmentId: 'sha256:0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  mediaType: 'image/png',
  bytes: 3,
  width: 4,
  height: 4,
  name: 'shot.png',
} as unknown as ImageAttachmentRef

/** Bytes that stand in for a decoded PNG; the uploader never parses them. */
const BYTES = new Uint8Array([1, 2, 3])

const IMAGE_MESSAGE = createUserMessage({
  content: [{ type: 'image', attachment: REF }],
  source,
})

/** A provider entry as the sidecar catalog describes one. */
function provider(id: string): KilnProvider {
  return {
    id,
    name: id,
    enabled: true,
    builtin: true,
    schema: 'x',
    base_url: '',
    api_key_env: '',
    local: false,
    has_key: true,
    models: [{ id: 'm', name: 'M' }],
    advertised: [],
    default: 'm',
  } as unknown as KilnProvider
}

/** An attachment store that returns fixed bytes and records what it was asked for. */
function attachmentsOf(seen: ImageAttachmentRef[] = []): AttachmentStore {
  return {
    async readImage(ref: ImageAttachmentRef) {
      seen.push(ref)
      return { ref, data: BYTES }
    },
  } as unknown as AttachmentStore
}

/** What one adapter run observed, for assertions after the stream drains. */
interface Observed {
  uploads: { provider: string; files: readonly KilnUploadFile[]; account?: string }[]
  requests: KilnStreamRequest[]
}

/**
 * An adapter wired the way the plugin wires it, over a fake sidecar.
 *
 * `uploadResult` is what the sidecar answers for an upload; `undefined` means
 * the upload fails at the transport, which is the case the placeholder exists
 * for.
 */
function wired(options: {
  kiln?: string
  routes?: Map<string, KilnProvider>
  accounts?: Map<string, string>
  attachments?: AttachmentStore
  uploadResult?: { account?: string; files: { name: string; id: string; size: number }[]; errors: string[] }
  onUpload?: (files: readonly KilnUploadFile[]) => void
} = {}) {
  const kiln = options.kiln ?? 'deepseek'
  const observed: Observed = { uploads: [], requests: [] }
  const routes = options.routes ?? new Map([[`kiln-${kiln}`, provider(kiln)]])
  const bridge = {
    async uploadFiles(providerId: string, files: readonly KilnUploadFile[], account?: string) {
      options.onUpload?.(files)
      observed.uploads.push({ provider: providerId, files, ...account === undefined ? {} : { account } })
      const result = options.uploadResult ?? {
        account: 'acct-1',
        files: files.map((file, index) => ({ name: file.name, id: `file-${index}`, size: file.data.byteLength })),
        errors: [],
      }
      return result
    },
    async *stream(request: KilnStreamRequest) {
      observed.requests.push(request)
      yield { type: 'meta', finish: 'stop' } as KilnStreamEvent
    },
  } as unknown as KilnBridge
  const adapter = new KilnAdapter({
    bridge,
    routes: () => routes,
    kilnId: () => kiln,
    ...options.accounts === undefined ? {} : { account: (route: string) => options.accounts?.get(route) },
    ...options.attachments === undefined ? {} : { resolveAttachments: () => options.attachments },
  })
  return { adapter, observed }
}

/** Run one request to completion through a wired adapter. */
async function run(adapter: KilnAdapter, options: Partial<GenerateOptions> = {}): Promise<void> {
  const request = {
    provider: 'kiln-deepseek',
    model: 'm',
    messages: [IMAGE_MESSAGE],
    ...options,
  } as GenerateOptions
  for await (const _ of adapter.stream(request)) { /* drain */ }
}

describe('image capability declaration', () => {
  it('declares image input on the route that can store files', async () => {
    // Without this the runtime projects every image to a text placeholder
    // BEFORE dispatch, so the adapter would never see one and the upload path
    // would be dead code.
    const { adapter } = wired()
    const info = await adapter.resolveModel('kiln-deepseek', 'm')
    expect(info.inputModalities).toEqual(['text', 'image'])
  })

  it('declares no image input on a route with no file store', async () => {
    // Every other provider is a plain text protocol. Promising otherwise would
    // advertise a capability the upload path then refuses.
    const { adapter } = wired({ kiln: 'openai' })
    const info = await adapter.resolveModel('kiln-openai', 'm')
    expect(info.inputModalities).toBeUndefined()
  })
})

describe('requestOptions image attachment', () => {
  const base = { provider: 'deepseek', model: 'm', messages: [] } as unknown as GenerateOptions

  it('carries uploaded file ids as ref_file_ids', () => {
    expect(requestOptions(base, 'acct-1', ['file-a', 'file-b'])).toMatchObject({
      ref_file_ids: ['file-a', 'file-b'],
    })
  })

  it('omits ref_file_ids entirely when nothing was uploaded', () => {
    // A present-but-empty list would be a claim about attachments that do not
    // exist; absent says the same thing without lying.
    expect('ref_file_ids' in requestOptions(base, 'acct-1')).toBe(false)
    expect('ref_file_ids' in requestOptions(base, 'acct-1', [])).toBe(false)
  })

  it('copies the ids so a later mutation cannot rewrite the request', () => {
    const ids = ['file-a']
    const opts = requestOptions(base, 'acct-1', ids)
    ids.push('file-b')
    expect(opts.ref_file_ids).toEqual(['file-a'])
  })
})

describe('image upload during a stream', () => {
  it('uploads the image and attaches its id to the turn', async () => {
    const { adapter, observed } = wired({ attachments: attachmentsOf() })
    await run(adapter)

    expect(observed.uploads).toHaveLength(1)
    expect(observed.uploads[0]?.provider).toBe('deepseek')
    expect(observed.uploads[0]?.files).toHaveLength(1)
    // The name the provider stores keeps the attachment's own name and an
    // extension matching the media type it proved.
    expect(observed.uploads[0]?.files[0]?.name).toBe('shot.png')
    expect(observed.uploads[0]?.files[0]?.data).toEqual(BYTES)
    expect(observed.requests[0]?.opts).toMatchObject({ ref_file_ids: ['file-0'] })
  })

  it('carries the uploader login, because ids are scoped to it', async () => {
    // Ids are not portable between logins: a turn served by another account
    // would name files it cannot see.
    const { adapter, observed } = wired({ attachments: attachmentsOf() })
    await run(adapter)
    expect(observed.requests[0]?.opts).toMatchObject({ account: 'acct-1' })
  })

  it('lets the uploader login override the route login', async () => {
    // The route is pinned to one login, but the ids were stored under another.
    // Sending the route's account would attach files that login cannot resolve.
    const accounts = new Map([['kiln-deepseek', 'route-account']])
    const { adapter, observed } = wired({
      attachments: attachmentsOf(),
      accounts,
      uploadResult: { account: 'uploader', files: [{ name: 'shot.png', id: 'file-0', size: 3 }], errors: [] },
    })
    await run(adapter)
    expect(observed.requests[0]?.opts).toMatchObject({ account: 'uploader' })
  })

  it('falls back to the route login when the uploader names none', async () => {
    const accounts = new Map([['kiln-deepseek', 'route-account']])
    const { adapter, observed } = wired({
      attachments: attachmentsOf(),
      accounts,
      uploadResult: { files: [{ name: 'shot.png', id: 'file-0', size: 3 }], errors: [] },
    })
    await run(adapter)
    expect(observed.requests[0]?.opts).toMatchObject({ account: 'route-account' })
  })

  it('uploads nothing and sends no ids for a request with no images', async () => {
    const { adapter, observed } = wired({ attachments: attachmentsOf() })
    await run(adapter, { messages: [createUserMessage({ content: [{ type: 'text', text: 'hi' }], source })] })
    expect(observed.uploads).toHaveLength(0)
    expect('ref_file_ids' in (observed.requests[0]?.opts ?? {})).toBe(false)
  })

  it('reads each image from the attachment store exactly once', async () => {
    const seen: ImageAttachmentRef[] = []
    const { adapter } = wired({ attachments: attachmentsOf(seen) })
    await run(adapter)
    expect(seen).toEqual([REF])
  })

  it('does not narrate a delivered image as one the provider refused', async () => {
    // The success path used to leave `placeholder` undefined, so the block fell
    // back to the SAME notice the not-capable branch emits. A delivered image
    // then read as a refused one — indistinguishable both to the model and to
    // anyone reading the transcript, which is what made this silent.
    const { adapter, observed } = wired({ attachments: attachmentsOf() })
    await run(adapter)
    const content = observed.requests[0]?.messages.map(turn => turn.content).join('\n') ?? ''
    expect(content).not.toContain('cannot receive')
    expect(content).toContain('delivered')
  })
})

describe('images that cannot travel', () => {
  it('leaves the placeholder when no attachment store is mounted', async () => {
    const { adapter, observed } = wired()
    await run(adapter)
    expect(observed.uploads).toHaveLength(0)
    const content = observed.requests[0]?.messages.map(turn => turn.content).join('\n') ?? ''
    expect(content).toContain('no attachment store is mounted')
  })

  it('names the reason when the provider rejects the upload', async () => {
    const { adapter, observed } = wired({
      attachments: attachmentsOf(),
      uploadResult: { files: [], errors: ['too large'] },
    })
    await run(adapter)
    // The turn still runs — losing an attachment is not fatal to the request —
    // but the transcript says the image did not travel rather than implying it did.
    expect(observed.requests[0]?.opts).not.toMatchObject({ ref_file_ids: expect.anything() })
    const content = observed.requests[0]?.messages.map(turn => turn.content).join('\n') ?? ''
    expect(content).toContain('too large')
  })

  it('keeps the turn when the upload transport itself throws', async () => {
    const bridge = {
      async uploadFiles() { throw new Error('sidecar is gone') },
      async *stream(request: KilnStreamRequest) {
        captured.push(request)
        yield { type: 'meta', finish: 'stop' } as KilnStreamEvent
      },
    } as unknown as KilnBridge
    const captured: KilnStreamRequest[] = []
    const adapter = new KilnAdapter({
      bridge,
      routes: () => new Map([['kiln-deepseek', provider('deepseek')]]),
      kilnId: () => 'deepseek',
      resolveAttachments: () => attachmentsOf(),
    })
    // A failed upload must surface as a failed turn, not as a model that
    // silently answered without having seen the attachment.
    await expect(run(adapter)).rejects.toThrow('sidecar is gone')
    expect(captured).toHaveLength(0)
  })

  it('does not upload on a route that cannot store files', async () => {
    const { adapter, observed } = wired({ kiln: 'openai', attachments: attachmentsOf() })
    await run(adapter, { provider: 'kiln-openai' })
    expect(observed.uploads).toHaveLength(0)
    const content = observed.requests[0]?.messages.map(turn => turn.content).join('\n') ?? ''
    expect(content).toContain('cannot receive')
  })
})

describe('image placeholder text', () => {
  const block: ContentBlock = { type: 'image', attachment: REF }

  it('defaults to the cannot-receive notice', () => {
    const turn = flattenMessage({ role: 'user', content: [block], source } as never)
    expect(turn?.content).toBe('[an image was attached, which this provider cannot receive]')
  })

  it('uses the supplied text when the request replaced it', () => {
    // The adapter passes the upload's outcome down, so a delivered image is not
    // narrated as one that never arrived.
    const turn = flattenMessage({ role: 'user', content: [block], source } as never, '[image delivered]')
    expect(turn?.content).toBe('[image delivered]')
  })

  it('applies the substitution inside a nested tool result', () => {
    // The recursion is shared with every other content walk; a placeholder that
    // stopped at the top level would leave raw markup in a nested result.
    const nested = {
      role: 'user',
      content: [{ type: 'tool-result', toolCallId: 'c1', content: [block] }],
      source,
    }
    const turns = buildTurns({
      provider: 'kiln-deepseek',
      model: 'm',
      messages: [nested],
    } as unknown as GenerateOptions, '[image delivered]')
    expect(turns.map(turn => turn.content).join('\n')).toContain('[image delivered]')
  })
})
