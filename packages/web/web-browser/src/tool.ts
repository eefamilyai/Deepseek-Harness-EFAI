/**
 * The model-facing `browser` tool: drive a headless browser by text.
 *
 * A vision-less model cannot look at a screenshot, so every action returns the
 * page as text — its readable content plus each interactive element on a
 * `[n] role: name` line. The model reads that, picks a ref, and calls the tool
 * again ("click 12"). One tool with an `action` selector keeps the whole loop in
 * a single verb the model does not have to discover piecemeal.
 *
 * @module @deepseek-ai/dsh-web-browser/tool
 */

import { defineTool } from '@deepseek-ai/dsh-tools'
import type { BrowserManager } from './browser.ts'
import type { RawSnapshot } from './page-script.ts'
import { formatSnapshot } from './serialize.ts'

/** The actions the tool accepts, named in the schema and the error text. */
export const BROWSER_ACTIONS = ['navigate', 'read', 'click', 'type', 'press', 'scroll', 'back'] as const

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

/** Run one action, validating the fields that action needs. */
async function dispatch(browser: BrowserManager, sessionKey: string, args: BrowserArgs): Promise<RawSnapshot> {
  switch (args.action) {
    case 'navigate':
      if (args.url === undefined || args.url.length === 0) throw new Error('navigate needs a "url"')
      return browser.navigate(sessionKey, args.url)
    case 'read':
      return browser.read(sessionKey)
    case 'click':
      if (args.ref === undefined) throw new Error('click needs a "ref" — the [n] of an element from the last snapshot')
      return browser.click(sessionKey, args.ref)
    case 'type':
      if (args.ref === undefined) throw new Error('type needs a "ref"')
      if (args.text === undefined) throw new Error('type needs "text" to enter')
      return browser.type(sessionKey, args.ref, args.text)
    case 'press':
      if (args.key === undefined || args.key.length === 0) throw new Error('press needs a "key" such as Enter or Tab')
      return browser.press(sessionKey, args.key)
    case 'scroll':
      return browser.scroll(sessionKey, args.text === 'up' ? 'up' : 'down')
    case 'back':
      return browser.back(sessionKey)
    default:
      throw new Error(`unknown action "${args.action}"; use one of: ${BROWSER_ACTIONS.join(', ')}`)
  }
}

/**
 * Build the `browser` tool bound to one manager.
 * @param browser - the shared headless-browser manager.
 * @param maxOutputChars - cap on the text returned for one action.
 * @returns the tool definition to register with `ctx.tools`.
 */
export function browserTool(browser: BrowserManager, maxOutputChars: number) {
  return defineTool({
    name: 'browser',
    description: 'Drive a real headless browser by text. Returns the page as readable text plus a numbered list of'
      + ' interactive elements ([n] role: name). Read it, then act by ref: click/type take the [n] of an element.'
      + ' Actions: navigate (open a url), read (re-read the page), click (ref), type (ref + text), press (a key like'
      + ' Enter), scroll (text "up"/"down"), back. Refs are only valid until the next action; each action returns a'
      + ' fresh snapshot to act on.',
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
        properties: { text: { type: 'string', required: true } },
      },
      render: (_args, value) => [{ type: 'text', text: value.text }],
    },
    async execute(args, exec) {
      // One page per session, so parallel conversations do not share a tab.
      const sessionKey = String(exec.agent?.session.id ?? 'default')
      const snapshot = await dispatch(browser, sessionKey, args)
      return { text: capOutput(formatSnapshot(snapshot), maxOutputChars) }
    },
  })
}
