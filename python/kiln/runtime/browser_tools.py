# browser_tools.py — sandboxed browser automation for Kiln-Kernel.
#
# The browser is ALWAYS headless: it never touches your mouse or keyboard and
# can't open windows on your desktop. Playwright drives it when installed;
# without Playwright the "navigate" action degrades to a plain HTTP text fetch
# and everything else explains what is available. The tool never raises.
#
# Every page action persists a small state file (KILN_BROWSER_DIR/state.json)
# plus screenshots, which the agent loop surfaces as a browser card in the UI.

import json
import locale
import os
import time
from html.parser import HTMLParser

_BROWSER_DIR = os.environ.get("KILN_BROWSER_DIR", "")
_UA = ("Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
       "(KHTML, like Gecko) Chrome/120.0 Safari/537.36")

# Injected before every page loads. Headless Chromium sets navigator.webdriver
# = true and drops a handful of properties that bot-detection (and search
# engines) key on to serve a challenge/degraded page instead of real content.
# Blanking them out makes pages behave as they would for a normal browser.
_STEALTH_JS = """
Object.defineProperty(navigator, 'webdriver', {get: () => undefined});
Object.defineProperty(navigator, 'languages', {get: () => ['en-US', 'en']});
Object.defineProperty(navigator, 'plugins', {get: () => [1, 2, 3, 4, 5]});
window.chrome = window.chrome || { runtime: {} };
"""


class KilnBrowser:
    def __init__(self):
        self.pw = None
        self.browser = None
        self.context = None
        self.page = None
        self._requests = []          # (status, url)
        self._console = []           # (type, text)
        self._proxy = None
        self._storage_path = None

    # ── lifecycle ──────────────────────────────────────────────
    def _ensure(self):
        """Lazily launch the headless browser. Returns (ok, err_or_None)."""
        if self.page is not None and not self.page.is_closed():
            return True, None
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:
            return False, f"Playwright is not installed: {e}"
        try:
            self.pw = sync_playwright().start()
            launch_kw = {"headless": True,
                         "args": ["--disable-blink-features=AutomationControlled"]}
            if self._proxy:
                launch_kw["proxy"] = {"server": self._proxy}
            self.browser = self.pw.chromium.launch(**launch_kw)
            ctx_opts = {
                "user_agent": _UA,
                "viewport": {"width": 1440, "height": 900},
                "device_scale_factor": 2,   # high-res screenshots
                "locale": "en-US",
                "extra_http_headers": {"Accept-Language": "en-US,en;q=0.9"},
            }
            if self._storage_path and os.path.isfile(self._storage_path):
                ctx_opts["storage_state"] = self._storage_path
            self.context = self.browser.new_context(**ctx_opts)
            self.context.add_init_script(_STEALTH_JS)   # look like a real browser
            self.page = self.context.new_page()
            self._requests = []
            self._console = []
            self.page.on("response", lambda r: self._requests.append((r.status, r.url)))
            self.page.on("console", lambda m: self._console.append((m.type, m.text)))
            return True, None
        except Exception as e:
            return False, f"browser launch failed: {e}"

    def _state(self, **extra):
        st = {"ts": time.time(), "url": "", "title": "",
              "screenshot": "", "text_preview": "", "links": []}
        try:
            if self.page is not None and not self.page.is_closed():
                st["url"] = self.page.url
                st["title"] = self.page.title()
                try:
                    st["text_preview"] = self.page.inner_text("body")[:4000]
                except Exception:
                    pass
                try:
                    st["links"] = self.page.eval_on_selector_all(
                        "a[href]", "els => els.map(e => e.href)")[:60] or []
                except Exception:
                    pass
        except Exception:
            pass
        st.update(extra)
        self._write_state(st)
        return st

    def _write_state(self, st):
        if not _BROWSER_DIR:
            return
        try:
            os.makedirs(_BROWSER_DIR, exist_ok=True)
            with open(os.path.join(_BROWSER_DIR, "state.json"), "w",
                      encoding="utf-8") as f:
                json.dump(st, f, ensure_ascii=False)
        except Exception:
            pass

    def _shot(self, path=None):
        if not _BROWSER_DIR or self.page is None:
            return ""
        name = (os.path.basename(path) if path else "") or f"shot_{int(time.time() * 1000)}.png"
        if not name.endswith(".png"):
            name += ".png"
        try:
            self.page.screenshot(path=os.path.join(_BROWSER_DIR, name),
                                 full_page=True)
            return name
        except Exception:
            return ""

    # ── perception ─────────────────────────────────────────────
    def navigate(self, url):
        ok, err = self._ensure()
        if not ok:
            return _http_fetch_text(url)
        try:
            self.page.goto(url, timeout=30000, wait_until="domcontentloaded")
            shot = self._shot()
            st = self._state(screenshot=shot)
            return (f"URL: {self.page.url}\nTITLE: {st['title']}\n\n"
                    + st["text_preview"])
        except Exception as e:
            self._state()
            return f"navigate error: {e}"

    def screenshot(self, path=None):
        ok, err = self._ensure()
        if not ok:
            return f"screenshot needs Playwright ({err})"
        try:
            name = self._shot(path)
            self._state(screenshot=name)
            return f"screenshot saved: {name}"
        except Exception as e:
            return f"screenshot error: {e}"

    def snapshot(self):
        """Accessibility-tree style dump of the page (roles, names, coords).

        Playwright removed page.accessibility (v1.36+), so we build the tree
        ourselves from the DOM: for every visible, interactive or otherwise
        meaningful element we emit [role] name = value, indented by nesting.
        Inputs get their current value; links/buttons get their accessible
        name; the result is capped to keep the model's context small.
        """
        ok, err = self._ensure()
        if not ok:
            return f"snapshot needs Playwright ({err})"
        try:
            js = r'''(() => {
              const IGNORED = new Set(['SCRIPT','STYLE','NOSCRIPT','TEMPLATE','LINK','META']);
              const INTERACTIVE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY',
                'DETAILS','OPTION','LABEL','IFRAME','VIDEO','AUDIO','NAV']);
              const HEADINGS = new Set(['H1','H2','H3','H4','H5','H6']);
              const SECTION = new Set(['ARTICLE','ASIDE','HEADER','FOOTER','MAIN','SECTION','NAV',
                'FORM','DIALOG','MENU','UL','OL','TABLE','FIELDSET']);
              const TEXT_TAGS = new Set(['P','SPAN','DIV','LI','TD','TH','CAPTION','FIGCAPTION',
                'DT','DD','LEGEND','BLOCKQUOTE','PRE','CODE','EM','STRONG','SMALL','SUB','SUP','HGROUP']);

              function vis(el) {
                if (!el || el.nodeType !== 1) return false;
                const st = getComputedStyle(el);
                if (st.display === 'none' || st.visibility === 'hidden' || +st.opacity === 0) return false;
                const r = el.getBoundingClientRect();
                return r.width > 1 || r.height > 1;
              }
              function accName(el) {
                if (el.getAttribute && el.getAttribute('aria-label')) return el.getAttribute('aria-label');
                if (el.getAttribute && el.getAttribute('aria-labelledby')) {
                  const ref = document.getElementById(el.getAttribute('aria-labelledby'));
                  if (ref) return ref.textContent.trim();
                }
                if (el.getAttribute && el.getAttribute('alt')) return el.getAttribute('alt');
                if (el.getAttribute && el.getAttribute('title')) return el.getAttribute('title');
                if (el.getAttribute && el.getAttribute('placeholder'))
                  return 'placeholder: ' + el.getAttribute('placeholder');
                return (el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 100);
              }
              function role(el) {
                if (el.getAttribute && el.getAttribute('role')) return el.getAttribute('role');
                const t = el.tagName;
                if (t === 'A' && el.hasAttribute('href')) return 'link';
                if (t === 'BUTTON' || t === 'SUMMARY') return 'button';
                if (t === 'INPUT') {
                  const ty = (el.getAttribute('type') || 'text').toLowerCase();
                  if (ty === 'checkbox') return 'checkbox';
                  if (ty === 'radio') return 'radio';
                  if (ty === 'submit' || ty === 'button') return 'button';
                  return 'textbox';
                }
                if (t === 'SELECT') return 'combobox';
                if (t === 'TEXTAREA') return 'textbox';
                if (t === 'IMG') return 'img';
                if (t === 'IFRAME') return 'iframe';
                if (t === 'VIDEO') return 'video';
                if (t === 'AUDIO') return 'audio';
                if (HEADINGS.has(t)) return 'heading';
                if (t === 'UL' || t === 'OL') return 'list';
                if (t === 'LI') return 'listitem';
                if (t === 'TABLE') return 'table';
                if (t === 'NAV') return 'navigation';
                return 'generic';
              }
              function value(el) {
                const t = el.tagName;
                if (t === 'INPUT') {
                  const ty = (el.getAttribute('type') || 'text').toLowerCase();
                  if (ty === 'checkbox' || ty === 'radio') return el.checked ? 'checked' : 'unchecked';
                  return el.value;
                }
                if (t === 'TEXTAREA') return el.value;
                if (t === 'SELECT') return el.options[el.selectedIndex] ? el.options[el.selectedIndex].text : '';
                return '';
              }
              function want(el, role) {
                return INTERACTIVE.has(el.tagName) || HEADINGS.has(el.tagName) || SECTION.has(el.tagName)
                  || el.getAttribute && (el.getAttribute('role') || el.getAttribute('aria-label'))
                  || role === 'img' || role === 'iframe' || role === 'video' || role === 'audio';
              }

              const lines = [];
              function walk(el, depth) {
                if (el.nodeType !== 1 || IGNORED.has(el.tagName) || !vis(el)) return;
                const r = role(el);
                const meaningful = want(el, r);
                const name = accName(el);
                const val = value(el);
                if (meaningful && r !== 'generic') {
                  let line = '  '.repeat(Math.min(depth, 12)) + '[' + r + ']';
                  if (name) line += ' ' + name.slice(0, 100);
                  if (val) line += ' = ' + String(val).slice(0, 60);
                  lines.push(line);
                }
                // don't recurse into already-named leaf controls (links,
                // buttons, inputs); keep drilling into containers/nav/labels
                if (INTERACTIVE.has(el.tagName) && !['DETAILS','LABEL','NAV'].includes(el.tagName)) {
                  return;
                }
                for (const c of el.children) walk(c, depth + 1);
              }
              walk(document.body, 0);
              if (!lines.length) {
                // fallback: bare text dump for JS-heavy SPAs with no meaningful tree
                const txt = (document.body.innerText || '').trim().replace(/\n{3,}/g, '\n\n');
                lines.push('(no semantic elements found)');
                lines.push(txt.slice(0, 4000));
              }
              return lines.slice(0, 250).join('\n');
            })()'''
            body = self.page.evaluate(js)
            self._state()
            return f"TITLE: {self.page.title()}\n\n{body}"
        except Exception as e:
            return f"snapshot error: {e}"

    def dom(self, selector="body"):
        ok, err = self._ensure()
        if not ok:
            return f"dom needs Playwright ({err})"
        try:
            html = self.page.eval_on_selector(
                selector, "el => el.outerHTML")[:20000]
            self._state()
            return html or f"(no element matches {selector!r})"
        except Exception as e:
            return f"dom error: {e}"

    def coords(self, selector):
        ok, err = self._ensure()
        if not ok:
            return f"coords needs Playwright ({err})"
        try:
            box = self.page.locator(selector).first.bounding_box()
            if not box:
                return f"coords: no element matches {selector!r}"
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            self._state()
            return (f"{selector!r} center -> x={int(cx)}, y={int(cy)} "
                    f"(box {box['width']:.0f}x{box['height']:.0f})")
        except Exception as e:
            return f"coords error: {e}"

    # ── input (virtual mouse / keyboard) ──────────────────────
    @staticmethod
    def _target(page, target):
        """target is a CSS selector or 'x,y' coordinates -> (x, y, sel)."""
        if isinstance(target, str) and re_full(r"^\s*\d+[\s,]+-?\d+\s*$", target):
            x, y = (int(v) for v in re_split(r"[\s,]+", target.strip()))
            return x, y, None
        box = page.locator(target).first.bounding_box()
        if not box:
            raise ValueError(f"no element matches {target!r}")
        return box["x"] + box["width"] / 2, box["y"] + box["height"] / 2, target

    def move(self, x, y):
        ok, err = self._ensure()
        if not ok:
            return f"move needs Playwright ({err})"
        try:
            self.page.mouse.move(float(x), float(y), steps=10)
            self._state()
            return f"moved mouse to ({x}, {y})"
        except Exception as e:
            return f"move error: {e}"

    def click(self, target, button="left"):
        ok, err = self._ensure()
        if not ok:
            return f"click needs Playwright ({err})"
        try:
            x, y, sel = self._target(self.page, target)
            if sel:
                self.page.locator(sel).first.click(button=button, timeout=10000)
            else:
                self.page.mouse.move(x, y, steps=8)
                self.page.mouse.click(x, y, button=button)
            shot = self._shot()
            self._state(screenshot=shot)
            return f"clicked {target!r}"
        except Exception as e:
            return f"click error: {e}"

    def dblclick(self, target):
        ok, err = self._ensure()
        if not ok:
            return f"dblclick needs Playwright ({err})"
        try:
            x, y, sel = self._target(self.page, target)
            if sel:
                self.page.locator(sel).first.dblclick(timeout=10000)
            else:
                self.page.mouse.dblclick(x, y)
            self._state()
            return f"double-clicked {target!r}"
        except Exception as e:
            return f"dblclick error: {e}"

    def hover(self, target):
        ok, err = self._ensure()
        if not ok:
            return f"hover needs Playwright ({err})"
        try:
            x, y, sel = self._target(self.page, target)
            self.page.mouse.move(x, y, steps=10)
            self._state()
            return f"hovered {target!r}"
        except Exception as e:
            return f"hover error: {e}"

    def drag(self, src, dst):
        ok, err = self._ensure()
        if not ok:
            return f"drag needs Playwright ({err})"
        try:
            x1, y1, s1 = self._target(self.page, src)
            x2, y2, s2 = self._target(self.page, dst)
            self.page.mouse.move(x1, y1, steps=6)
            self.page.mouse.down()
            self.page.mouse.move((x1 + x2) / 2, (y1 + y2) / 2, steps=8)
            self.page.mouse.move(x2, y2, steps=8)
            self.page.mouse.up()
            self._state()
            return f"dragged {src!r} -> {dst!r}"
        except Exception as e:
            return f"drag error: {e}"

    def type(self, selector, text):
        ok, err = self._ensure()
        if not ok:
            return f"type needs Playwright ({err})"
        try:
            self.page.locator(selector).first.fill(str(text), timeout=10000)
            self._state()
            return f"typed {len(text)} chars into {selector!r}"
        except Exception as e:
            return f"type error: {e}"

    def key(self, combo):
        ok, err = self._ensure()
        if not ok:
            return f"key needs Playwright ({err})"
        try:
            self.page.keyboard.press(str(combo))
            self._state()
            return f"pressed {combo!r}"
        except Exception as e:
            return f"key error: {e}"

    def clear(self, selector):
        ok, err = self._ensure()
        if not ok:
            return f"clear needs Playwright ({err})"
        try:
            self.page.locator(selector).first.fill("", timeout=10000)
            self._state()
            return f"cleared {selector!r}"
        except Exception as e:
            return f"clear error: {e}"

    def scroll(self, dx=0, dy=0, amount=None, direction=None):
        ok, err = self._ensure()
        if not ok:
            return f"scroll needs Playwright ({err})"
        try:
            if amount is not None:
                dy = {"up": -amount, "down": amount, "left": -amount,
                      "right": amount}.get((direction or "down"), amount)
            self.page.mouse.wheel(int(dx or 0), int(dy or 0))
            self._state()
            return f"scrolled dx={dx} dy={dy}"
        except Exception as e:
            return f"scroll error: {e}"

    def zoom(self, factor=1.0):
        ok, err = self._ensure()
        if not ok:
            return f"zoom needs Playwright ({err})"
        try:
            self.page.evaluate(f"document.body.style.zoom = {float(factor)}")
            self._state()
            return f"zoom set to {factor}"
        except Exception as e:
            return f"zoom error: {e}"

    # ── session & tabs ─────────────────────────────────────────
    def save_state(self, path=None):
        ok, err = self._ensure()
        if not ok:
            return f"save_state needs Playwright ({err})"
        try:
            out = path or os.path.join(_BROWSER_DIR or ".", "browser_state.json")
            self.context.storage_state(path=out)
            self._storage_path = out
            return f"session state saved to {out} (cookies + local storage)"
        except Exception as e:
            return f"save_state error: {e}"

    def load_state(self, path):
        if not os.path.isfile(path):
            return f"load_state: file not found: {path}"
        self._storage_path = path
        # next context launch picks it up
        if self.page is not None and not self.page.is_closed():
            try:
                self.close_tab()
            except Exception:
                pass
        ok, err = self._ensure()
        if not ok:
            return f"load_state error: {err}"
        return f"loaded session state from {path}"

    def new_tab(self, url=None):
        ok, err = self._ensure()
        if not ok:
            return f"new_tab needs Playwright ({err})"
        try:
            page = self.context.new_page()
            if url:
                page.goto(url, timeout=30000, wait_until="domcontentloaded")
            self.page = page
            self._state()
            return f"opened new tab ({len(self.context.pages)} total)"
        except Exception as e:
            return f"new_tab error: {e}"

    def switch_tab(self, index):
        ok, err = self._ensure()
        if not ok:
            return f"switch_tab needs Playwright ({err})"
        try:
            pages = self.context.pages
            i = int(index)
            if not (-len(pages) <= i < len(pages)):
                return f"switch_tab: index {i} out of range ({len(pages)} tabs)"
            self.page = pages[i]
            self.page.bring_to_front()
            self._state()
            return f"switched to tab {i} ({len(pages)} total)"
        except Exception as e:
            return f"switch_tab error: {e}"

    def close_tab(self):
        ok, err = self._ensure()
        if not ok:
            return f"close_tab needs Playwright ({err})"
        try:
            pages = self.context.pages
            if len(pages) <= 1:
                return "only one tab — not closing it"
            p = self.page
            idx = pages.index(p) if p in pages else 0
            p.close()
            self.page = self.context.pages[min(idx, len(self.context.pages) - 1)]
            self._state()
            return f"closed tab ({len(self.context.pages)} remain)"
        except Exception as e:
            return f"close_tab error: {e}"

    def tabs(self):
        ok, err = self._ensure()
        if not ok:
            return f"tabs needs Playwright ({err})"
        try:
            out = []
            for i, p in enumerate(self.context.pages):
                mark = " *" if p is self.page else ""
                out.append(f"[{i}] {p.url}{mark}")
            self._state()
            return "\n".join(out) or "(no tabs)"
        except Exception as e:
            return f"tabs error: {e}"

    # ── network / console ──────────────────────────────────────
    def network(self, limit=40):
        ok, err = self._ensure()
        if not ok:
            return f"network needs Playwright ({err})"
        try:
            reqs = self._requests[-int(limit):]
            lines = [f"{s} {u[:160]}" for s, u in reqs]
            self._state()
            return "\n".join(lines) or "(no requests captured yet)"
        except Exception as e:
            return f"network error: {e}"

    def console(self, limit=40):
        ok, err = self._ensure()
        if not ok:
            return f"console needs Playwright ({err})"
        try:
            msgs = self._console[-int(limit):]
            lines = [f"{t}: {m[:200]}" for t, m in msgs]
            self._state()
            return "\n".join(lines) or "(no console messages)"
        except Exception as e:
            return f"console error: {e}"

    def clear_network(self):
        ok, err = self._ensure()
        if not ok:
            return f"clear_network needs Playwright ({err})"
        self._requests = []
        self._console = []
        self._state()
        return "cleared network + console logs"

    def search(self, query, limit=8):
        """Run a web search through the real headless browser.

        A raw HTTP scrape of a search engine gets bot-blocked or served an empty
        consent page; the actual browser renders the JS results, carries a real
        fingerprint + cookies, and clears the consent wall. Returns
        [{title,url,snippet}] or None so the caller can fall back to the scrape.
        Uses a THROWAWAY page so the model's own tab/session is left untouched.
        """
        query = (query or "").strip()
        if not query:
            return []
        ok, _err = self._ensure()
        if not ok:
            return None
        from urllib.parse import quote
        q = quote(query)
        page = None
        try:
            page = self.context.new_page()
            # Try each engine in turn; take the first that returns real results.
            # A blocked / challenge page yields [] (see _search_on) so we move on
            # rather than hand back garbage — wrong results are worse than none.
            # DuckDuckGo first: it either returns real results or a detectable
            # block page (never the subtly-wrong results Bing can serve a bot),
            # so it's the safer primary. Bing is the last-resort fallback.
            for url, sel in (
                ("https://html.duckduckgo.com/html/?q=" + q, ".result__body, .result"),
                ("https://lite.duckduckgo.com/lite/?q=" + q, "a.result-link"),
                ("https://www.bing.com/search?q=" + q, "li.b_algo"),
            ):
                results = self._search_on(page, url, sel, limit)
                if results:
                    return results
            return None
        except Exception:
            return None
        finally:
            if page is not None:
                try:
                    page.close()
                except Exception:
                    pass

    def _search_on(self, page, url, wait_sel, limit):
        try:
            page.goto(url, timeout=30000, wait_until="domcontentloaded")
            try:
                page.wait_for_selector(wait_sel, timeout=8000)
            except Exception:
                pass  # extract whatever rendered; the JS tolerates a miss
            # bail on a rate-limit / bot-challenge interstitial instead of
            # scraping its boilerplate as if it were results
            try:
                head = (page.inner_text("body") or "")[:600].lower()
            except Exception:
                head = ""
            if any(s in head for s in _BLOCK_MARKERS):
                return []
            rows = page.evaluate(_SEARCH_JS, int(limit) or 8) or []
        except Exception:
            return []
        out = []
        for r in rows:
            u = _clean_ddg_url(r.get("url") or "")
            if u:
                out.append({"title": r.get("title", ""), "url": u,
                            "snippet": r.get("snippet", "")})
        return out


# text that marks a rate-limit / bot-challenge page rather than real results
_BLOCK_MARKERS = ("if this persists", "unusual traffic", "detected unusual",
                  "verify you are a human", "are you a robot", "captcha",
                  "our systems have detected", "confirm you are a human")

# Pull result rows out of DuckDuckGo, Bing, or a generic SERP. Runs in the page.
_SEARCH_JS = r"""(limit) => {
  const out = [];
  const seen = new Set();
  const clean = s => (s || '').replace(/\s+/g, ' ').trim();
  const push = (title, url, snippet) => {
    title = clean(title);
    if (!title || !url || url.startsWith('javascript') || seen.has(url)) return;
    seen.add(url);
    out.push({ title: title.slice(0, 200), url, snippet: clean(snippet).slice(0, 300) });
  };
  // DuckDuckGo Lite: a flat table of result-link anchors + snippet cells
  const lite = document.querySelectorAll('a.result-link');
  if (lite.length) {
    lite.forEach(a => {
      let sn = '', n = a.closest('tr');
      n = n && n.nextElementSibling;
      const c = n && n.querySelector && n.querySelector('.result-snippet');
      if (c) sn = c.textContent;
      push(a.textContent, a.href, sn);
    });
    return out.slice(0, limit);
  }
  // Bing wraps every result URL in a bing.com/ck/a tracker; the real target is
  // the base64url `u=a1…` param (exact, with path), and the <cite> is a backup.
  const realUrl = (a, cite) => {
    let url = a.href || a.getAttribute('href') || '';
    if (url.includes('bing.com/ck/')) {
      let decoded = '';
      try {
        const u = new URL(url).searchParams.get('u') || '';
        if (u.startsWith('a1')) {
          let b = u.slice(2).replace(/-/g, '+').replace(/_/g, '/');
          b += '='.repeat((4 - b.length % 4) % 4);
          decoded = atob(b);
        }
      } catch (e) { /* fall through to cite */ }
      if (!/^https?:\/\//.test(decoded) && cite) {
        let c = clean(cite.textContent).split(' ')[0];
        decoded = /^https?:/.test(c) ? c : (c ? 'https://' + c : '');
      }
      if (decoded) url = decoded;
    }
    return url;
  };
  const sel = 'article[data-testid="result"], .react-results--main article, ' +
              'li.b_algo, div.result.results_links, div.result, .result, .web-result';
  document.querySelectorAll(sel).forEach(r => {
    const a = r.querySelector('a[data-testid="result-title-a"], h2 a, h3 a, a.result__a');
    if (!a) return;
    const url = realUrl(a, r.querySelector('cite'));
    if (!url || url.startsWith('javascript') || seen.has(url)) return;
    // Bing's title is the <h2> text; DDG's is the link text — both clean
    const h = r.querySelector('h2, h3');
    const title = clean((h && h.textContent) || a.textContent);
    if (!title) return;
    const sn = r.querySelector('[data-testid="result-snippet"], .result__snippet, ' +
                               '.b_caption p, .b_caption, p');
    seen.add(url);
    out.push({ title: title.slice(0, 200), url,
               snippet: sn ? clean(sn.textContent).slice(0, 300) : '' });
  });
  return out.slice(0, limit);
}"""


def _clean_ddg_url(u):
    """Decode a DuckDuckGo redirect (…/l/?uddg=<real>) to the real destination."""
    if not u:
        return u
    if u.startswith("//"):
        u = "https:" + u
    if "duckduckgo.com/l/" in u and "uddg=" in u:
        try:
            from urllib.parse import parse_qs, unquote, urlparse
            q = parse_qs(urlparse(u).query)
            if q.get("uddg"):
                return unquote(q["uddg"][0])
        except Exception:
            pass
    return u


BROWSER = KilnBrowser()


def browser_search(query, limit=8):
    """Browser-backed web search. Returns [{title,url,snippet}], or None when the
    headless browser is unavailable so the caller can fall back to a scrape."""
    try:
        return BROWSER.search(query, limit=limit)
    except Exception:
        return None


def browser_use(action="navigate", **kw):
    """One entry point for every browser action. Never raises.

    Actions:
      perception: navigate(url), screenshot(path?), snapshot(), dom(selector?),
                  coords(selector)
      input:      move(x,y), click(target), dblclick(target), hover(target),
                  drag(src,dst), type(selector,text), key(combo), clear(selector),
                  scroll(dx?,dy?,amount?,direction?), zoom(factor)
      session:    save_state(path?), load_state(path), new_tab(url?),
                  switch_tab(index), close_tab(), tabs()
      network:    network(limit?), console(limit?), clear_network()
      safety:     ALWAYS headless; the browser never touches your mouse/keyboard.
                  Pass proxy='http://...' on navigate to route through a proxy.
    """
    b = BROWSER
    try:
        a = (action or "navigate").lower().strip()
        if a == "navigate":
            if kw.get("proxy"):
                b._proxy = kw["proxy"]
            return b.navigate(kw.get("url") or kw.get("to") or "")
        if a == "screenshot":
            return b.screenshot(kw.get("path"))
        if a == "snapshot":
            return b.snapshot()
        if a == "dom":
            return b.dom(kw.get("selector") or "body")
        if a == "coords":
            return b.coords(kw.get("selector") or kw.get("sel") or "")
        if a == "move":
            return b.move(kw.get("x", 0), kw.get("y", 0))
        if a == "click":
            return b.click(kw.get("target") or kw.get("selector") or "")
        if a == "dblclick":
            return b.dblclick(kw.get("target") or kw.get("selector") or "")
        if a == "hover":
            return b.hover(kw.get("target") or kw.get("selector") or "")
        if a == "drag":
            return b.drag(kw.get("from") or kw.get("src") or "",
                          kw.get("to") or kw.get("dst") or "")
        if a == "type":
            return b.type(kw.get("selector") or kw.get("sel") or "", kw.get("text") or "")
        if a == "key":
            return b.key(kw.get("key") or kw.get("combo") or "")
        if a == "clear":
            return b.clear(kw.get("selector") or kw.get("sel") or "")
        if a == "scroll":
            return b.scroll(kw.get("dx", 0), kw.get("dy", 0),
                            kw.get("amount"), kw.get("direction"))
        if a == "zoom":
            return b.zoom(kw.get("factor", 1.0))
        if a == "save_state":
            return b.save_state(kw.get("path"))
        if a == "load_state":
            return b.load_state(kw.get("path") or "")
        if a == "new_tab":
            return b.new_tab(kw.get("url"))
        if a == "switch_tab":
            return b.switch_tab(kw.get("index", 0))
        if a == "close_tab":
            return b.close_tab()
        if a == "tabs":
            return b.tabs()
        if a == "network":
            return b.network(kw.get("limit", 40))
        if a == "console":
            return b.console(kw.get("limit", 40))
        if a == "clear_network":
            return b.clear_network()
        if a == "search":
            from kernel_child import search  # local import to avoid cycles
            return search(kw.get("query") or kw.get("text") or "",
                          limit=int(kw.get("limit", 8) or 8))
        return (f"browser_use: unknown action {action!r}. Known: navigate, screenshot, "
                f"snapshot, dom, coords, move, click, dblclick, hover, drag, type, key, "
                f"clear, scroll, zoom, save_state, load_state, new_tab, switch_tab, "
                f"close_tab, tabs, network, console, clear_network, search")
    except Exception as e:
        return f"browser_use error: {e}"


def _decode_bytes(data):
    """Self-contained copy of the kernel's BOM-aware decode (no cross-import)."""
    if not data:
        return ""
    if data.startswith(b"\xff\xfe") or data.startswith(b"\xfe\xff"):
        try:
            return data.decode("utf-16")
        except Exception:
            pass
    prefs = ["utf-8-sig", locale.getpreferredencoding(False) or "utf-8",
             "cp1252", "cp850", "latin-1"]
    for enc in prefs:
        try:
            return data.decode(enc, "strict")
        except (UnicodeDecodeError, LookupError):
            continue
    return data.decode("latin-1", "strict")


class _PageParser(HTMLParser):
    """Self-contained minimal HTML -> {title, text, links} extraction."""
    def __init__(self):
        super().__init__()
        self.title = ""
        self.text_parts = []
        self.links = []
        self._in_title = False
        self._in_script = False

    def handle_starttag(self, tag, attrs):
        attrs = dict(attrs)
        if tag == "title":
            self._in_title = True
        elif tag in ("script", "style"):
            self._in_script = True
        elif tag == "a" and attrs.get("href"):
            self.links.append((attrs["href"], ""))
        elif tag in ("p", "h1", "h2", "h3", "h4", "li", "pre", "code"):
            self.text_parts.append("\n")

    def handle_endtag(self, tag):
        if tag == "title":
            self._in_title = False
        elif tag in ("script", "style"):
            self._in_script = False

    def handle_data(self, data):
        if self._in_title:
            self.title += data
        elif not self._in_script:
            self.text_parts.append(data)


def _http_fetch_text(url):
    """Playwright-less fallback for navigate: fetch + strip to readable text."""
    status, body = _http_get(url)
    if status == 0:
        return f"browser_use error: {body.decode('utf-8', 'replace')}"
    p = _PageParser()
    try:
        p.feed(_decode_bytes(body))
    except Exception:
        pass
    text = " ".join(ln.strip() for ln in " ".join(p.text_parts).split())[:20000]
    links = [f"{h}  ({t.strip()[:50]})" for h, t in p.links[:40]]
    out = f"URL: {url}\nTITLE: {p.title.strip()}\n\n{text}"
    if links:
        out += "\n\nLINKS:\n" + "\n".join(links)
    if _BROWSER_DIR:
        try:
            os.makedirs(_BROWSER_DIR, exist_ok=True)
            with open(os.path.join(_BROWSER_DIR, "state.json"), "w",
                      encoding="utf-8") as f:
                json.dump({"ts": time.time(), "url": url, "title": p.title.strip(),
                           "screenshot": "", "text_preview": text[:4000],
                           "links": [h for h, _ in p.links[:60]]}, f,
                          ensure_ascii=False)
        except Exception:
            pass
    return out


def _http_get(url, timeout=30):
    headers = {"User-Agent": _UA}
    try:
        import curl_cffi.requests as cr
        r = cr.get(url, headers=headers, timeout=timeout, impersonate="chrome120")
        return r.status_code, r.content
    except Exception:
        pass
    try:
        import urllib.request
        req = urllib.request.Request(url, headers=headers)
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, resp.read()
    except Exception as e:
        return 0, str(e).encode()


# tiny regex helpers (no re import at module top to keep it light)
def re_full(pattern, s):
    import re
    return re.fullmatch(pattern, s) is not None


def re_split(pattern, s):
    import re
    return re.split(pattern, s)
