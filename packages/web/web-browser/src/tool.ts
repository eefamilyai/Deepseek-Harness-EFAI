/**
 * The model-facing `browser` tool: drive a headless browser by text, and see it
 * when seeing it is the point.
 *
 * A vision-less model cannot look at a screenshot, so every action returns the
 * page as text — its readable content plus each interactive element on a
 * `[n] role: name` line. The model reads that, picks a ref, and calls the tool
 * again ("click 12"). One tool with an `action` selector keeps the whole loop in
 * a single verb the model does not have to discover piecemeal.
 *
 * `screenshot` is the one action that answers in pixels instead: it captures the
 * viewport and returns the image itself, so a model that can see can judge what
 * the page looks like rather than only what it says. It needs an image-capable
 * route and a mounted attachment store, because an image is useful only to a
 * caller that can look at it and reachable only through durable storage.
 *
 * @module @deepseek-ai/dsh-web-browser/tool
 */

import type { Context } from '@deepseek-ai/cordis'
import { AttachmentError, AttachmentId } from '@deepseek-ai/dsh-attachment'
import type { ImageAttachmentRef, ImageMediaType } from '@deepseek-ai/dsh-attachment'
import type { ContentBlock } from '@deepseek-ai/dsh-llm'
import { defineTool } from '@deepseek-ai/dsh-tools'
import type { ToolExecution } from '@deepseek-ai/dsh-tools'
import type { BrowserManager, CapturedScreenshot } from './browser.ts'
import type { RawSnapshot } from './page-script.ts'
import { formatSnapshot } from './serialize.ts'

/** The actions the tool accepts, named in the schema and the error text. */
export const BROWSER_ACTIONS = ['navigate', 'read', 'click', 'type', 'press', 'scroll', 'back', 'screenshot'] as const

/** Cut tool output to the cap, keeping the head (a page's most useful part). */
function capOutput(text: string, maxChars: number): string {
  if (text.length <= maxChars) return text
  return `${text.slice(0, maxChars)}\n\n[... ${text.length - maxChars} characters truncated; scroll or read again for more ...]`
}

/** One parsed `browser` call, before it is dispatched to the manager. */
interface BrowserArgs {
  action: string
  url?: string
  ref?: number
  text?: string
  key?: string
}

/**
 * What one dispatched action produces: a page snapshot, or the decision to
 * capture the viewport. Argument validation lives in the single switch below,
 * so `screenshot` is checked there even though `execute` carries it out.
 */
type DispatchOutcome =
  | { readonly kind: 'snapshot'; readonly snapshot: RawSnapshot }
  | { readonly kind: 'screenshot' }

/** Run one action, validating the fields that action needs. */
async function dispatch(browser: BrowserManager, sessionKey: string, args: BrowserArgs): Promise<DispatchOutcome> {
  const asSnapshot = async (pending: Promise<RawSnapshot>): Promise<DispatchOutcome> => ({
    kind: 'snapshot',
    snapshot: await pending,
  })
  switch (args.action) {
    case 'navigate':
      if (args.url === undefined || args.url.length === 0) throw new Error('navigate needs a "url"')
      return asSnapshot(browser.navigate(sessionKey, args.url))
    case 'read':
      return asSnapshot(browser.read(sessionKey))
    case 'click':
      if (args.ref === undefined) throw new Error('click needs a "ref" — the [n] of an element from the last snapshot')
      return asSnapshot(browser.click(sessionKey, args.ref))
    case 'type':
      if (args.ref === undefined) throw new Error('type needs a "ref"')
      if (args.text === undefined) throw new Error('type needs "text" to enter')
      return asSnapshot(browser.type(sessionKey, args.ref, args.text))
    case 'press':
      if (args.key === undefined || args.key.length === 0) throw new Error('press needs a "key" such as Enter or Tab')
      return asSnapshot(browser.press(sessionKey, args.key))
    case 'scroll':
      return asSnapshot(browser.scroll(sessionKey, args.text === 'up' ? 'up' : 'down'))
    case 'back':
      return asSnapshot(browser.back(sessionKey))
    case 'screenshot':
      return { kind: 'screenshot' }
    default:
      throw new Error(`unknown action "${args.action}"; use one of: ${BROWSER_ACTIONS.join(', ')}`)
  }
}

/**
 * The committed-image fields the output schema declares, mirroring `read_image`'s
 * shape. Not itself `required`: only the `screenshot` action produces an image,
 * so every other action's result legitimately omits it.
 */
const SCREENSHOT_VALUE_SCHEMA = {
  type: 'object',
  additionalProperties: false,
  properties: {
    attachmentId: { type: 'string', required: true },
    mediaType: { type: 'string', enum: ['image/png', 'image/jpeg', 'image/webp', 'image/gif'], required: true },
    bytes: { type: 'integer', required: true },
    width: { type: 'integer', required: true },
    height: { type: 'integer', required: true },
    name: { type: 'string' },
  },
} as const

/** The structured outcome declared by the `browser` output schema. */
interface BrowserValue {
  text: string
  image?: {
    attachmentId: string
    mediaType: ImageMediaType
    bytes: number
    width: number
    height: number
    name?: string
  }
}

/**
 * Enforce the strict image-capability gate for the calling route, so a
 * screenshot refuses before it captures anything the caller could not use.
 * Unknown capability is a refusal rather than an adapter failure after the work.
 * @param ctx - the plugin context used to resolve the optional `llm` service.
 * @param exec - the tool-execution context supplying the calling agent.
 */
async function assertImageCapableRoute(ctx: Context, exec: ToolExecution): Promise<void> {
  const routed = exec.agent?.session.requestHeader()?.config
  const provider = routed?.provider ?? exec.agent?.options.provider
  const model = routed?.model ?? exec.agent?.options.model
  const llm = ctx.get('llm')
  if (provider === undefined || model === undefined || llm === undefined) {
    throw new Error('cannot take a screenshot: the current model route could not be resolved')
  }
  const active = await llm.resolveModelInfo(provider, model, exec.signal)
  if (active.inputModalities === undefined || !active.inputModalities.includes('image')) {
    throw new Error(`cannot take a screenshot: model "${model}" does not declare image input; switch to an image-capable model to see the page`)
  }
}

/**
 * Format the screenshot's model-facing envelope, which carries the page the
 * picture was taken from — an image block alone does not say what it depicts.
 * @param shot - the capture, for the page identity and the stored dimensions.
 * @param image - the committed image metadata.
 * @returns the envelope text that rides beside the image block.
 */
function formatScreenshotOutput(shot: CapturedScreenshot, image: NonNullable<BrowserValue['image']>): string {
  const where = shot.title.length > 0 ? `${shot.url} — ${shot.title}` : shot.url
  return `<url>${where}</url>
<type>image</type>
<content>
${image.mediaType} screenshot of the viewport, ${image.width}x${image.height} px, ${image.bytes} bytes
</content>`
}

/**
 * Capture the viewport, commit it, and return it beside its envelope.
 *
 * The gate runs before the capture so a refusal costs no browser work, and the
 * image is persisted before returning so the image block references a durably
 * committed object by the time the tool/result event is appended.
 */
async function captureScreenshot(
  ctx: Context,
  browser: BrowserManager,
  sessionKey: string,
  exec: ToolExecution,
): Promise<BrowserValue> {
  const attachments = ctx.get('attachments')
  if (attachments === undefined) {
    throw new Error('cannot take a screenshot: no attachment service is mounted, so the image could not be stored')
  }
  await assertImageCapableRoute(ctx, exec)
  const shot = await browser.screenshot(sessionKey)
  let ref: ImageAttachmentRef
  try {
    ref = await attachments.saveImage({ data: shot.data, mediaType: shot.mediaType, name: 'browser-screenshot.png' })
  } catch (error: unknown) {
    if (!(error instanceof AttachmentError)) throw error
    throw new Error(`cannot take a screenshot: the image could not be stored (${error.code})`, { cause: error })
  }
  const image: NonNullable<BrowserValue['image']> = {
    attachmentId: ref.attachmentId,
    mediaType: ref.mediaType,
    bytes: ref.bytes,
    width: ref.width,
    height: ref.height,
    ...ref.name === undefined ? {} : { name: ref.name },
  }
  return { text: formatScreenshotOutput(shot, image), image }
}

/**
 * Build the `browser` tool bound to one manager.
 * @param ctx - the registration scope; execution resolves the optional
 *   `attachments` and `llm` services through it.
 * @param browser - the shared headless-browser manager.
 * @param maxOutputChars - cap on the text returned for one action.
 * @returns the tool definition to register with `ctx.tools`.
 */
export function browserTool(ctx: Context, browser: BrowserManager, maxOutputChars: number) {
  return defineTool({
    name: 'browser',
    description: 'Drive a real headless browser by text. Returns the page as readable text plus a numbered list of'
      + ' interactive elements ([n] role: name). Read it, then act by ref: click/type take the [n] of an element.'
      + ' Actions: navigate (open a url), read (re-read the page), click (ref), type (ref + text), press (a key like'
      + ' Enter), scroll (text "up"/"down"), back. Refs are only valid until the next action; each action returns a'
      + ' fresh snapshot to act on. The one exception is screenshot, which returns the viewport image itself instead'
      + ' of a text snapshot — use it when how the page LOOKS is the point; it requires a model that accepts image'
      + ' input.',
    parameters: {
      action: { type: 'string', required: true, description: `What to do. One of: ${BROWSER_ACTIONS.join(', ')}.` },
      url: { type: 'string', description: 'For navigate: the URL to open (include https://).' },
      ref: { type: 'integer', description: 'For click and type: the [n] ref of the element from the last snapshot.' },
      text: { type: 'string', description: 'For type: the text to enter. For scroll: "up" or "down" (default down).' },
      key: { type: 'string', description: 'For press: a key name — Enter, Tab, ArrowDown, Escape, etc.' },
    },
    output: {
      schema: {
        type: 'object',
        additionalProperties: false,
        properties: {
          text: { type: 'string', required: true },
          image: SCREENSHOT_VALUE_SCHEMA,
        },
      },
      render: (_args, value) => {
        const blocks: ContentBlock[] = [{ type: 'text', text: value.text }]
        const image = value.image
        if (image !== undefined) {
          blocks.push({
            type: 'image',
            attachment: {
              attachmentId: AttachmentId(image.attachmentId),
              mediaType: image.mediaType,
              bytes: image.bytes,
              width: image.width,
              height: image.height,
              ...image.name === undefined ? {} : { name: image.name },
            },
          })
        }
        return blocks
      },
    },
    async execute(args, exec) {
      // One page per session, so parallel conversations do not share a tab.
      const sessionKey = String(exec.agent?.session.id ?? 'default')
      const outcome = await dispatch(browser, sessionKey, args)
      if (outcome.kind === 'screenshot') return captureScreenshot(ctx, browser, sessionKey, exec)
      return { text: capOutput(formatSnapshot(outcome.snapshot), maxOutputChars) }
    },
  })
}
