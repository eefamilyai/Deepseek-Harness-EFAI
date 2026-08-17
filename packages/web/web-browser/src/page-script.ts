/**
 * The in-page snapshot collector, delivered as a script string.
 *
 * {@link snapshotScript} returns JavaScript that runs INSIDE the browser via
 * `page.evaluate`. It is a string, not a typed function, on purpose: the body
 * uses browser globals (`document`, `location`, …) that a Node package has no
 * business pulling the whole DOM lib in to type, and a string keeps them out of
 * TypeScript's sight entirely while still executing in Chromium.
 *
 * The contract is what makes a vision-less model able to act: it tags every
 * visible interactive element with a stable `data-ai-ref` and returns that ref
 * alongside the element's accessible name, so the model reads the page as text
 * and acts by ref number ("click 12") without ever seeing pixels.
 *
 * @module @deepseek-ai/dsh-web-browser/page-script
 */

/** One interactive element the model can act on, addressed by its ref number. */
export interface RawElement {
  /** Stable 1-based ref, written to the element as `data-ai-ref` for later clicks. */
  ref: number
  /** Lowercased tag name (`a`, `button`, `input`, …). */
  tag: string
  /** ARIA role when set, else the tag — what the element behaves as. */
  role: string
  /** Accessible name: aria-label, visible text, or a placeholder/title/name. */
  name: string
  /** `type` attribute for inputs, when present. */
  type?: string
  /** Current value for form fields, so the model sees what is already filled. */
  value?: string
}

/** The text projection of one page: title, url, readable text, and the ref'd controls. */
export interface RawSnapshot {
  title: string
  url: string
  elements: RawElement[]
  text: string
}

/**
 * Build the collector script. The character cap is inlined as a numeric literal
 * (never string-interpolated content), so there is nothing for a page to inject.
 * @param maxTextChars - cap on the returned page text.
 * @returns a self-contained JS expression that yields a {@link RawSnapshot}.
 */
export function snapshotScript(maxTextChars: number): string {
  const cap = Number.isFinite(maxTextChars) ? Math.max(0, Math.floor(maxTextChars)) : 20000
  return `(() => {
    var SEL = 'a[href],button,input,textarea,select,[role="button"],[role="link"],[role="tab"],[role="checkbox"],[role="radio"],[role="menuitem"],[role="textbox"],[contenteditable="true"],[onclick]';
    function vis(el){ var r = el.getBoundingClientRect(); if (r.width === 0 && r.height === 0) return false; var s = getComputedStyle(el); return s.visibility !== 'hidden' && s.display !== 'none' && s.opacity !== '0'; }
    function nameOf(el){ var a = el.getAttribute('aria-label'); if (a) return String(a).slice(0,120); var t = String(el.innerText || el.textContent || '').trim().replace(/\\s+/g,' '); if (t) return t.slice(0,120); var f = el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('name') || ''; return String(f).slice(0,120); }
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
    var body = String((document.body && document.body.innerText) || '').replace(/\\n{3,}/g,'\\n\\n').trim();
    return { title: String(document.title || ''), url: String(location.href), elements: els, text: body.length > ${cap} ? body.slice(0, ${cap}) : body };
  })()`
}
