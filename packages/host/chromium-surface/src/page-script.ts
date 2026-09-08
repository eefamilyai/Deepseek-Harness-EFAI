/**
 * The in-page snapshot collector, delivered as a script string — the same
 * string-transport pattern the agent-facing web-browser package uses, so no
 * DOM lib pollutes the host build.
 *
 * @module @deepseek-ai/dsh-host-chromium-surface/page-script
 */

/** One interactive element, addressed by a stable 1-based ref for click/type. */
export interface RawElement {
  ref: number
  tag: string
  role: string
  name: string
  type?: string
  value?: string
}

/** The text projection the surface returns for a tab. */
export interface RawSnapshot {
  title: string
  url: string
  text: string
  elements: RawElement[]
}

/**
 * Build the collector expression. The cap is inlined as a numeric literal so
 * page content can never inject script.
 */
export function snapshotScript(maxTextChars: number): string {
  const cap = Number.isFinite(maxTextChars) ? Math.max(0, Math.floor(maxTextChars)) : 20000
  return `(() => {
    var SEL = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="textbox"],[contenteditable="true"],[onclick]';
    function vis(el){ var r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false; var s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; }
    function nameOf(el){ var a = el.getAttribute('aria-label'); if (a) return String(a).slice(0,120); var t = String(el.innerText || el.textContent || '').trim().replace(/\s+/g,' '); if (t) return t.slice(0,120); var f = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || ''; return String(f).slice(0,120); }
    var els = []; var ref = 0; var nodes = document.querySelectorAll(SEL);
    for (var i = 0; i < nodes.length; i++) {
      var el = nodes[i];
      if (!vis(el)) continue;
      ref++;
      el.setAttribute('data-ai-ref', String(ref));
      var tag = String(el.tagName).toLowerCase();
      var rec = { ref: ref, tag: tag, role: el.getAttribute('role') || tag, name: nameOf(el) };
      var ty = el.getAttribute('type'); if (ty) rec.type = String(ty);
      if (tag === 'input' || tag === 'textarea' || tag === 'select') rec.value = String(el.value == null ? '' : el.value);
      els.push(rec);
      if (ref >= 400) break;
    }
    var body = String((document.body && document.body.innerText) || '').replace(/\n{3,}/g,'\n\n').trim();
    return { title: String(document.title || ''), url: String(location.href), elements: els, text: body.length > ${cap} ? body.slice(0, ${cap}) : body };
  })()`
}

/**
 * Render a snapshot as the text block the UI shows.
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
