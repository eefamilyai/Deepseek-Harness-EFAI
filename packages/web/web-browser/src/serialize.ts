/**
 * Format a page snapshot as the text block the model reads.
 * @module @deepseek-ai/dsh-web-browser/serialize
 */

import type { RawSnapshot } from './page-script.ts'

/**
 * Render a snapshot as compact text: title, url, readable page text, then the
 * interactive elements each on its own `[n] role: name` line. The ref numbers
 * are what the model passes back to `click`/`type`, so they are the load-bearing
 * part — the model never needs a screenshot to act.
 * @param snap - the raw snapshot collected in the page.
 * @returns the model-facing text.
 */
export function formatSnapshot(snap: RawSnapshot): string {
  const lines: string[] = []
  if (snap.title.length > 0) lines.push(`# ${snap.title}`)
  lines.push(`URL: ${snap.url}`, '')
  if (snap.text.length > 0) lines.push(snap.text, '')

  if (snap.elements.length > 0) {
    lines.push('Interactive elements (pass the [n] ref to click/type):')
    for (const el of snap.elements) {
      const kind = el.type !== undefined ? `${el.role} ${el.type}` : el.role
      const value = el.value !== undefined && el.value.length > 0 ? ` = ${JSON.stringify(el.value)}` : ''
      const label = el.name.length > 0 ? el.name : '(no label)'
      lines.push(`[${el.ref}] ${kind}: ${label}${value}`)
    }
  } else {
    lines.push('(no interactive elements found on this page)')
  }
  return lines.join('\n')
}
