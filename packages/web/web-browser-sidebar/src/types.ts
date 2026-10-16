/**
 * The wire vocabulary between the `agentBrowser` Host service and the Desktop window
 * that carries the agent's browser pages.
 *
 * A Remote method's parameter and result types must be exported from a public
 * non-root subpath for the Typert generator, which is why this module exists
 * separately from `./index.ts`. It holds types only.
 *
 * @module @deepseek-ai/dsh-web-browser-sidebar/types
 */

/**
 * One low-level page operation the window performs on an agent page.
 *
 * - `hello` opens a command stream and carries no page operation.
 * - `navigate` loads `url` and waits for the load to finish or `timeoutMs` to pass.
 * - `evaluate` runs `script` in the page's main world and returns its JSON value.
 * - `click` presses and releases the left mouse button at (`x`, `y`) in page pixels.
 * - `insertText` commits `text` to the focused element, as an input method would.
 * - `key` presses and releases one key named as in `KeyboardEvent.key`.
 * - `back` and `forward` move through the page's history when an entry exists.
 * - `settle` waits until the page stops loading, or `timeoutMs` passes.
 * - `screenshot` captures the page's viewport as a PNG.
 * - `close` destroys the page.
 */
export type AgentBrowserOp =
  | 'hello'
  | 'navigate'
  | 'evaluate'
  | 'click'
  | 'insertText'
  | 'key'
  | 'back'
  | 'forward'
  | 'settle'
  | 'screenshot'
  | 'close'

/** One operation the Host asks the window to perform, as the command stream delivers it. */
export interface AgentBrowserRequest {
  /** Host-minted identity the window echoes in its reply; empty for `hello`. */
  readonly id: string
  /** The operation. */
  readonly op: AgentBrowserOp
  /** The agent Session that owns the page; one page exists per owning Session. */
  readonly pageId: string
  /** The conversation whose right sidebar shows the page: the owning Session, or its root for a subagent. */
  readonly displaySessionId: string
  /** CSS pixel width the page lays out at while its sidebar tab is hidden. */
  readonly viewportWidth: number
  /** CSS pixel height the page lays out at while its sidebar tab is hidden. */
  readonly viewportHeight: number
  /** Upper bound in milliseconds for an operation that waits on the page. */
  readonly timeoutMs: number
  /** `navigate`: the HTTP(S) address to load. */
  readonly url?: string
  /** `evaluate`: the script whose completion value is returned. */
  readonly script?: string
  /** `insertText`: the text to commit. */
  readonly text?: string
  /** `key`: the key name, for example `Enter`, `Tab`, or `ArrowDown`. */
  readonly key?: string
  /** `click`: the horizontal page coordinate. */
  readonly x?: number
  /** `click`: the vertical page coordinate. */
  readonly y?: number
}

/** The window's answer to one {@link AgentBrowserRequest}. */
export interface AgentBrowserReply {
  /** The request identity this reply settles. */
  readonly id: string
  /** Whether the operation completed. */
  readonly ok: boolean
  /** A plain failure reason when `ok` is false. */
  readonly error?: string
  /** Whether the page was created for this request, so it holds no earlier document. */
  readonly fresh?: boolean
  /** The page's address after the operation. */
  readonly url?: string
  /** The page's title after the operation. */
  readonly title?: string
  /** `evaluate`: the JSON text of the script's completion value. */
  readonly value?: string
  /** `screenshot`: the base64 PNG bytes. */
  readonly png?: string
  /** `screenshot`: the image width in pixels. */
  readonly width?: number
  /** `screenshot`: the image height in pixels. */
  readonly height?: number
}
