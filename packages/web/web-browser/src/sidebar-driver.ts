/**
 * The {@link BrowserDriver} that carries the agent's page in the Desktop window's right
 * sidebar, through the `agentBrowser` service.
 *
 * The window performs only low-level page operations — load, run a script, click a
 * point, insert text, press a key — so this driver composes the tool's actions from
 * them: a click finds the ref'd element by script, scrolls it into view, and clicks
 * its centre as a real pointer would; typing focuses and selects the field, then
 * inserts the text as an input method would. Every acting action ends with the same
 * text snapshot the headless driver returns, collected by {@link snapshotScript}.
 *
 * @module @deepseek-ai/dsh-web-browser/sidebar-driver
 */

import type { AgentBrowser, AgentBrowserCall, AgentBrowserReply } from '@deepseek-ai/dsh-web-browser-sidebar'
import type { CapturedScreenshot } from './browser.ts'
import type { BrowserDriver, BrowserPageTarget } from './driver.ts'
import { snapshotScript, type RawSnapshot } from './page-script.ts'

/** Resolved limits the sidebar driver applies to each operation. */
export interface SidebarDriverLimits {
  /** Timeout for a page load (ms). */
  navigationTimeoutMs: number
  /** Timeout for a click, keystroke, or script (ms). */
  actionTimeoutMs: number
  /** Cap on the page text returned in a snapshot (chars). */
  maxTextChars: number
  /** CSS pixel width the page lays out at while its sidebar tab is hidden. */
  viewportWidth: number
  /** CSS pixel height the page lays out at while its sidebar tab is hidden. */
  viewportHeight: number
}

/** Where a ref'd element's centre is, after the script scrolled it into view. */
interface ElementPoint {
  readonly found: boolean
  readonly x?: number
  readonly y?: number
}

/**
 * The script that scrolls a ref'd element into view and returns its centre.
 * @param ref - the element's `data-ai-ref`, inlined as a number literal.
 * @returns a JS expression.
 */
function pointScript(ref: number): string {
  return `(() => {
    var el = document.querySelector('[data-ai-ref="${String(Math.floor(ref))}"]');
    if (!el) return { found: false };
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' });
    var r = el.getBoundingClientRect();
    return { found: true, x: r.left + r.width / 2, y: r.top + r.height / 2 };
  })()`
}

/**
 * The script that focuses a ref'd field and selects its content, so inserted text replaces it.
 * An empty replacement clears the field here, since inserting nothing would leave it.
 * @param ref - the element's `data-ai-ref`.
 * @param clear - whether to clear the field instead of selecting it.
 * @returns a JS expression yielding whether the element exists.
 */
function focusScript(ref: number, clear: boolean): string {
  return `(() => {
    var el = document.querySelector('[data-ai-ref="${String(Math.floor(ref))}"]');
    if (!el) return false;
    el.scrollIntoView({ block: 'center', behavior: 'instant' });
    el.focus();
    if (el.isContentEditable) {
      var range = document.createRange(); range.selectNodeContents(el);
      var selection = getSelection(); selection.removeAllRanges(); selection.addRange(range);
      if (${clear ? 'true' : 'false'}) document.execCommand('delete');
    } else if ('value' in el) {
      if (typeof el.select === 'function') el.select();
      if (${clear ? 'true' : 'false'}) {
        el.value = '';
        el.dispatchEvent(new Event('input', { bubbles: true }));
        el.dispatchEvent(new Event('change', { bubbles: true }));
      }
    }
    return true;
  })()`
}

/**
 * The script that scrolls the region under the viewport's centre, or the document.
 * @param delta - pixels to scroll; negative scrolls up.
 * @returns a JS expression.
 */
function scrollScript(delta: number): string {
  return `(() => {
    var el = document.elementFromPoint(innerWidth / 2, innerHeight / 2);
    while (el && el !== document.body && el !== document.documentElement) {
      var s = getComputedStyle(el);
      if ((s.overflowY === 'auto' || s.overflowY === 'scroll') && el.scrollHeight > el.clientHeight) { el.scrollBy(0, ${String(delta)}); return true; }
      el = el.parentElement;
    }
    window.scrollBy(0, ${String(delta)});
    return true;
  })()`
}

/** Decode base64 into bytes. */
function bytesOf(base64: string): Uint8Array {
  return new Uint8Array(Buffer.from(base64, 'base64'))
}

/** The agent's browser page, carried by the Desktop window. */
export class SidebarBrowserDriver implements BrowserDriver {
  /** The page is in the right sidebar, where the operator can watch it. */
  readonly surface = 'sidebar' as const

  /**
   * @param service - the `agentBrowser` Host service.
   * @param limits - operation timeouts and the snapshot cap.
   */
  constructor(private readonly service: AgentBrowser, private readonly limits: SidebarDriverLimits) {}

  private call(target: BrowserPageTarget, op: AgentBrowserCall['op'], fields: Partial<AgentBrowserCall> = {}, timeoutMs = this.limits.actionTimeoutMs): Promise<AgentBrowserReply> {
    return this.service.run({
      op,
      pageId: target.pageId,
      displaySessionId: target.displaySessionId,
      viewportWidth: this.limits.viewportWidth,
      viewportHeight: this.limits.viewportHeight,
      timeoutMs,
      ...fields,
    }, target.signal)
  }

  private async evaluate<T>(target: BrowserPageTarget, script: string): Promise<T> {
    const reply = await this.call(target, 'evaluate', { script })
    return JSON.parse(reply.value ?? 'null') as T
  }

  private snapshot(target: BrowserPageTarget): Promise<RawSnapshot> {
    return this.evaluate<RawSnapshot>(target, snapshotScript(this.limits.maxTextChars))
  }

  async navigate(target: BrowserPageTarget, url: string): Promise<RawSnapshot> {
    await this.call(target, 'navigate', { url }, this.limits.navigationTimeoutMs)
    return this.snapshot(target)
  }

  read(target: BrowserPageTarget): Promise<RawSnapshot> {
    return this.snapshot(target)
  }

  async click(target: BrowserPageTarget, ref: number): Promise<RawSnapshot> {
    const point = await this.evaluate<ElementPoint>(target, pointScript(ref))
    if (!point.found || point.x === undefined || point.y === undefined) {
      throw new Error(`no element has ref ${String(ref)} on the current page; read the page again for fresh refs`)
    }
    await this.call(target, 'click', { x: point.x, y: point.y }, this.limits.navigationTimeoutMs)
    return this.snapshot(target)
  }

  async type(target: BrowserPageTarget, ref: number, text: string): Promise<RawSnapshot> {
    const found = await this.evaluate<boolean>(target, focusScript(ref, text.length === 0))
    if (!found) throw new Error(`no element has ref ${String(ref)} on the current page; read the page again for fresh refs`)
    if (text.length > 0) await this.call(target, 'insertText', { text })
    return this.snapshot(target)
  }

  async press(target: BrowserPageTarget, key: string): Promise<RawSnapshot> {
    await this.call(target, 'key', { key }, this.limits.navigationTimeoutMs)
    return this.snapshot(target)
  }

  async scroll(target: BrowserPageTarget, direction: 'up' | 'down'): Promise<RawSnapshot> {
    await this.evaluate<boolean>(target, scrollScript(direction === 'up' ? -800 : 800))
    return this.snapshot(target)
  }

  async back(target: BrowserPageTarget): Promise<RawSnapshot> {
    await this.call(target, 'back', {}, this.limits.navigationTimeoutMs)
    return this.snapshot(target)
  }

  async screenshot(target: BrowserPageTarget): Promise<CapturedScreenshot> {
    const reply = await this.call(target, 'screenshot')
    return { data: bytesOf(reply.png ?? ''), mediaType: 'image/png', url: reply.url ?? '', title: reply.title ?? '' }
  }
}
