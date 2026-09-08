# browser_tools.py — sandboxed browser automation for Kiln-Kernel.
#
# The browser is ALWAYS headless: it never touches your mouse or keyboard and
# can't open windows on your desktop. Playwright drives it when installed;
# without Playwright the "navigate" action degrades to a plain HTTP text fetch
# and everything else explains what is available. The tool never raises.
#
# Every page action persists a small state file (KILN_BROWSER_DIR/state.json)
# plus screenshots, which the agent loop surfaces as a browser card in the UI.

import concurrent.futures as _futures
import json
import locale
import os
import threading as _threading
import time
from html.parser import HTMLParser

_BROWSER_DIR = os.environ.get("KILN_BROWSER_DIR", "")

# ── one dedicated thread for ALL Playwright work ─────────────────────────────
# Playwright's sync API binds its dispatcher to the thread that started it, and
# refuses calls from any other thread ("cannot switch to a different thread").
# The kernel now runs each cell on its own short-lived worker thread (two-tier
# timeout / backgrounding), so a browser created in one cell's thread would be
# unusable from the next. Marshalling every browser call onto a single
# long-lived worker keeps the whole session on one consistent thread, no matter
# which cell thread called in. Calls serialize (Playwright sync isn't
# concurrent anyway); a call already on the worker thread runs inline so a
# nested browser_use -> search -> browser_search can't deadlock the sole worker.
_BROWSER_EXECUTOR = None
_BROWSER_THREAD_ID = None


def _browser_executor():
    global _BROWSER_EXECUTOR
    if _BROWSER_EXECUTOR is None:
        _BROWSER_EXECUTOR = _futures.ThreadPoolExecutor(
            max_workers=1, thread_name_prefix="kiln-browser")
        # The ThreadPoolExecutor registers its own interpreter-exit cleanup on
        # threading's internal callback list, and CPython drains that list LIFO
        # BEFORE any plain atexit hook. Registering ours right after the
        # executor's own hook therefore runs us FIRST -- while the worker thread
        # is still alive and schedulable -- so Playwright/screencast teardown
        # completes instead of raising "cannot schedule new futures after
        # shutdown" and leaving node writing into a closing pipe (the EPIPE).
        _register = getattr(_threading, "_register_atexit", None)
        if _register is not None:
            _register(_browser_shutdown)
    return _BROWSER_EXECUTOR


def _on_browser_thread(fn, *args, **kwargs):
    """Run fn on the single browser worker thread and wait for its result."""
    if _BROWSER_THREAD_ID is not None and _threading.get_ident() == _BROWSER_THREAD_ID:
        return fn(*args, **kwargs)  # already there — inline to avoid self-deadlock

    def _wrapped():
        global _BROWSER_THREAD_ID
        _BROWSER_THREAD_ID = _threading.get_ident()
        return fn(*args, **kwargs)

    return _browser_executor().submit(_wrapped).result()
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




# Per-tab navigation history. Purely functional over plain dicts so it is
# testable without Chromium; the same semantics the (reverted) chromium-surface
# host tests proved, now tracking the SHARED kernel browser instead of a separate
# instance. Each tab keeps back[] / current / forward[] (most recent last / first).
def _empty_history():
    return {"back": [], "current": None, "forward": []}


def _push_navigation(history, url, title):
    """Record a fresh navigation: append it, truncating any forward entries."""
    back = list(history.get("back") or [])
    current = history.get("current")
    if current is not None:
        back.append(current)
    return {"back": back, "current": {"url": url, "title": title}, "forward": []}


def _go_back(history):
    """Move one entry backward, or leave the history unchanged at the oldest entry."""
    back = list(history.get("back") or [])
    if not back:
        return history
    previous = back[-1]
    forward = list(history.get("forward") or [])
    current = history.get("current")
    if current is not None:
        forward.insert(0, current)
    return {"back": back[:-1], "current": previous, "forward": forward}


def _go_forward(history):
    """Move one entry forward, or leave the history unchanged at the newest entry."""
    forward = list(history.get("forward") or [])
    if not forward:
        return history
    nxt = forward[0]
    back = list(history.get("back") or [])
    current = history.get("current")
    if current is not None:
        back.append(current)
    return {"back": back, "current": nxt, "forward": forward[1:]}

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
        self._screencast = None       # DisposableStub while the CDP screencast runs
        self._last_frame = 0.0           # monotonic time of the last kept frame
        self._last_state = None       # last full state.json dict, merged per frame
        self._state_lock = _threading.Lock()   # serialize state.json writes (screencast + worker)
        self._histories = []          # per-page navigation history, aligned to context.pages

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
            self._start_screencast()
            return True, None
        except Exception as e:
            return False, f"browser launch failed: {e}"

    def _start_screencast(self):
        """Stream the live viewport to ``latest.jpg`` via Playwright's CDP screencast.

        Playwright wraps Chromium's Page.startScreencast: frames arrive as raw JPEG
        bytes on a per-page channel. Each frame is written to a stable filename
        (atomically) and the shared ``state.json`` timestamp is bumped, so the host
        bridge's fs.watch push emits exactly one change per frame. This is the live
        dock feed; the one-shot PNG ``_shot`` path remains for explicit screenshots.
        """
        if not _BROWSER_DIR or self._screencast is not None:
            return
        if self.page is None or self.page.is_closed():
            return
        try:
            def _on_frame(frame):
                data = frame.get("data")
                if not isinstance(data, (bytes, bytearray)):
                    return
                # Throttle the write side to ~15 fps: dropping surplus frames
                # costs nothing visually but keeps each base64 + state write a
                # small, fixed per-second load instead of spiking with the
                # producer's native rate.
                now = time.monotonic()
                if now - self._last_frame < 0.066:
                    return
                self._last_frame = now
                try:
                    os.makedirs(_BROWSER_DIR, exist_ok=True)
                    tmp = os.path.join(_BROWSER_DIR, "latest.jpg.tmp")
                    dst = os.path.join(_BROWSER_DIR, "latest.jpg")
                    with open(tmp, "wb") as f:
                        f.write(data)
                    os.replace(tmp, dst)
                except Exception:
                    return
                base = self._last_state
                if base is not None:
                    st = dict(base)
                    st["ts"] = time.time()
                    st["screenshot"] = "latest.jpg"
                    self._write_state(st)
            self._screencast = self.page.screencast.start(
                on_frame=_on_frame,
                quality=90,
                size={"width": 1440, "height": 900},
            )
        except Exception:
            # Screencast is best-effort: the PNG screenshot path still works.
            self._screencast = None

    def _stop_screencast(self):
        """Stop the CDP screencast, if one is running.

        ``page.screencast.start()`` returns a ``DisposableStub`` whose only
        public teardown is ``dispose()``/context-manager exit — it does NOT
        expose ``.stop()``. The real stop lives on the page's sync
        ``Screencast`` wrapper (``page.screencast.stop()``), which sends
        ``screencastStop`` and clears the frame callback. Stopping from the
        correct worker thread prevents the Playwright node driver from
        writing one more frame into a closing pipe — the unhandled EPIPE +
        node stack trace this teardown exists to avoid.
        """
        self._screencast = None
        if self.page is None:
            return
        try:
            self.page.screencast.stop()
        except Exception:
            # Best-effort: the screencast is already dead, or the page is gone.
            pass

    def shutdown(self):
        """Orderly teardown: stop the live feed, then close browser resources.

        Playwright's CDP screencast has no interpreter-exit hook, so a bare
        exit leaves its node driver writing into a closed pipe — an unhandled
        EPIPE plus a node stack trace. Stopping the screencast first, then
        closing context/browser/playwright in dependency order, lets the
        process exit quietly. Idempotent and never raises.
        """
        self._stop_screencast()
        if self.context is not None:
            try:
                self.context.close()
            except Exception:
                pass
        if self.browser is not None:
            try:
                self.browser.close()
            except Exception:
                pass
        if self.pw is not None:
            try:
                self.pw.stop()
            except Exception:
                pass
        self.page = None
        self.context = None
        self.browser = None
        self.pw = None

    def _state(self, **extra):
        # vw/vh are the CSS viewport the screenshot covers, so the dock pane can
        # scale a click on the image back to browser coordinates.
        st = {"ts": time.time(), "url": "", "title": "",
              "screenshot": "", "text_preview": "", "links": [],
              "vw": 1440, "vh": 900}
        try:
            if self.page is not None and not self.page.is_closed():
                st["url"] = self.page.url
                st["title"] = self.page.title()
                try:
                    vp = self.page.viewport_size
                    if vp:
                        st["vw"] = vp["width"]
                        st["vh"] = vp["height"]
                except Exception:
                    pass
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
        try:
            # One tidy per-tab record the client tab strip can render directly:
            # url/title for the label, a boolean active flag, and the tab's own
            # navigation history. Index is the position in context.pages.
            tabs = []
            pages = list(self.context.pages) if self.context is not None else []
            for i, page in enumerate(pages):
                h = self._histories[i] if i < len(self._histories) else _empty_history()
                try:
                    url = page.url if not page.is_closed() else ""
                    title = page.title() if not page.is_closed() else ""
                except Exception:
                    url = ""
                    title = ""
                tabs.append({"index": i, "url": url, "title": title,
                             "active": page is self.page, "history": h})
            st["tabs"] = tabs
            st["active"] = self._page_index()
            st["history"] = self._ensure_history()
        except Exception:
            st.setdefault("tabs", [])
            st.setdefault("active", -1)
            st.setdefault("history", _empty_history())
        st.update(extra)
        # The live CDP screencast is the dock's authoritative feed: a one-shot
        # PNG that an action just wrote must not overwrite ``latest.jpg`` while
        # the screencast is running, or the pane would flicker back to a still.
        if self._screencast is not None and os.path.isfile(os.path.join(_BROWSER_DIR, "latest.jpg")):
            st["screenshot"] = "latest.jpg"
        self._write_state(st)
        return st

    def _write_state(self, st):
        # The screencast callback runs on Playwright's dispatcher thread while
        # normal actions run on the browser worker thread; the lock keeps their
        # state.json writes from interleaving into a torn JSON document.
        with self._state_lock:
            self._last_state = st
            if not _BROWSER_DIR:
                return
            try:
                os.makedirs(_BROWSER_DIR, exist_ok=True)
                with open(os.path.join(_BROWSER_DIR, "state.json"), "w",
                          encoding="utf-8") as f:
                    json.dump(st, f, ensure_ascii=False)
            except Exception:
                pass

    def _page_index(self):
        try:
            return self.context.pages.index(self.page)
        except (ValueError, AttributeError):
            return -1

    def _ensure_history(self):
        """The active page's history, growing the list to cover its index."""
        i = self._page_index()
        if i < 0:
            return _empty_history()
        while len(self._histories) <= i:
            self._histories.append(_empty_history())
        return self._histories[i]

    def _set_history(self, history):
        """Commit one tab's history and persist the whole session model."""
        i = self._page_index()
        if i < 0:
            return
        while len(self._histories) <= i:
            self._histories.append(_empty_history())
        self._histories[i] = history
        self._persist_histories()

    def _persist_histories(self):
        # Tab metadata only: a headless browser process never survives a restart,
        # so live DOM/navigation state cannot be restored — the model on disk is
        # the durable session (tabs + per-tab history) the UI and a later
        # restore action consume.
        if not _BROWSER_DIR:
            return
        try:
            os.makedirs(_BROWSER_DIR, exist_ok=True)
            with open(os.path.join(_BROWSER_DIR, "history.json"), "w",
                      encoding="utf-8") as f:
                json.dump({"tabs": self._histories}, f, ensure_ascii=False)
        except Exception:
            pass

    def history(self):
        ok, err = self._ensure()
        if not ok:
            return f"history needs Playwright ({err})"
        try:
            h = self._ensure_history()
            lines = []
            for e in (h.get("back") or []):
                label = e.get("title") or e.get("url") or ""
                lines.append(f"< {label}  {e.get('url', '')}")
            cur = h.get("current")
            if cur is not None:
                label = cur.get("title") or cur.get("url") or ""
                lines.append(f"> {label}  {cur.get('url', '')}")
            for e in (h.get("forward") or []):
                label = e.get("title") or e.get("url") or ""
                lines.append(f"> {label}  {e.get('url', '')}")
            self._state()
            return "\n".join(lines) or "(no navigation history)"
        except Exception as e:
            return f"history error: {e}"

    def _shot(self, path=None):
        if not _BROWSER_DIR or self.page is None:
            return ""
        name = (os.path.basename(path) if path else "") or f"shot_{int(time.time() * 1000)}.png"
        if not name.endswith(".png"):
            name += ".png"
        # Viewport-only (not full_page): the interactive dock pane maps a click
        # on this image straight to viewport coordinates, which only holds when
        # the image IS the viewport. Scrolling moves the viewport. A shot taken
        # the instant a navigation settles can fail ("page is navigating"), so
        # retry once after a brief settle before giving up.
        for attempt in range(2):
            try:
                self.page.screenshot(path=os.path.join(_BROWSER_DIR, name),
                                     full_page=False)
                return name
            except Exception:
                if attempt == 0:
                    try:
                        self.page.wait_for_timeout(400)
                    except Exception:
                        pass
        return ""

    # ── perception ─────────────────────────────────────────────
    def navigate(self, url):
        ok, err = self._ensure()
        if not ok:
            return _http_fetch_text(url)
        try:
            self.page.goto(url, timeout=30000, wait_until="domcontentloaded")
            self._set_history(_push_navigation(self._ensure_history(),
                                               self.page.url, self.page.title()))
            shot = self._shot()
            st = self._state(screenshot=shot)
            return (f"URL: {self.page.url}\nTITLE: {st['title']}\n\n"
                    + st["text_preview"]
                    + "\n\n[call read_page() for the actionable [ref_N] tree, or get_text() for full text]")
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

              // Actionable elements get a stable [ref_N] handle stamped onto the
              // DOM (data-kiln-ref="N"), so the model reads the tree and acts by
              // ref — click(ref="ref_5") — instead of inventing a CSS selector or
              // guessing pixel coordinates. Clear any prior stamps first so refs
              // always match THIS snapshot.
              const ACTIONABLE = new Set(['A','BUTTON','INPUT','SELECT','TEXTAREA','SUMMARY','OPTION','LABEL']);
              const ACTION_ROLE = /^(button|link|tab|menuitem|menuitemcheckbox|menuitemradio|checkbox|radio|textbox|combobox|option|switch|slider|searchbox|spinbutton)$/;
              document.querySelectorAll('[data-kiln-ref]').forEach(e => e.removeAttribute('data-kiln-ref'));
              let refN = 0;
              const lines = [];
              function walk(el, depth) {
                if (el.nodeType !== 1 || IGNORED.has(el.tagName) || !vis(el)) return;
                const r = role(el);
                const meaningful = want(el, r);
                const name = accName(el);
                const val = value(el);
                if (meaningful && r !== 'generic') {
                  const roleAttr = (el.getAttribute && el.getAttribute('role')) || '';
                  const actionable = ACTIONABLE.has(el.tagName) || ACTION_ROLE.test(r) || ACTION_ROLE.test(roleAttr);
                  let prefix = '';
                  if (actionable) {
                    refN += 1;
                    el.setAttribute('data-kiln-ref', String(refN));
                    prefix = '[ref_' + refN + '] ';
                  }
                  let line = '  '.repeat(Math.min(depth, 12)) + prefix + '[' + r + ']';
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
            box = self.page.locator(self._as_selector(selector)).first.bounding_box()
            if not box:
                return f"coords: no element matches {selector!r}"
            cx, cy = box["x"] + box["width"] / 2, box["y"] + box["height"] / 2
            self._state()
            return (f"{selector!r} center -> x={int(cx)}, y={int(cy)} "
                    f"(box {box['width']:.0f}x{box['height']:.0f})")
        except Exception as e:
            return f"coords error: {e}"

    def find(self, query, limit=30):
        """Search the current page's actionable tree for elements whose role,
        name, or value matches `query` (case-insensitive), returning the [ref_N]
        lines so the model can act on the hit directly without reading the whole
        page."""
        ok, err = self._ensure()
        if not ok:
            return f"find needs Playwright ({err})"
        tree = self.snapshot()
        q = (query or "").strip().lower()
        if not q:
            return tree
        hits = [ln for ln in tree.splitlines() if "[ref_" in ln and q in ln.lower()]
        if not hits:
            return f"find: nothing matches {query!r} among the page's actionable elements"
        return "\n".join(hits[:int(limit) or 30])

    def get_text(self, selector="body", max_chars=20000):
        """Readable text of the page (or one element) — clean body/article text
        without the tree structure, for reading rather than acting."""
        ok, err = self._ensure()
        if not ok:
            return _http_fetch_text(self.page.url) if self.page else f"get_text needs Playwright ({err})"
        try:
            txt = self.page.locator(self._as_selector(selector)).first.inner_text(timeout=10000)
        except Exception:
            try:
                txt = self.page.inner_text("body")
            except Exception as e:
                return f"get_text error: {e}"
        self._state()
        return (txt or "").strip()[:int(max_chars) or 20000] or "(no text)"

    def back(self):
        ok, err = self._ensure()
        if not ok:
            return f"back needs Playwright ({err})"
        try:
            self.page.go_back(timeout=30000, wait_until="domcontentloaded")
            self._set_history(_go_back(self._ensure_history()))
            st = self._state(screenshot=self._shot())
            return f"URL: {self.page.url}\nTITLE: {st['title']}"
        except Exception as e:
            return f"back error: {e}"

    def forward(self):
        ok, err = self._ensure()
        if not ok:
            return f"forward needs Playwright ({err})"
        try:
            self.page.go_forward(timeout=30000, wait_until="domcontentloaded")
            self._set_history(_go_forward(self._ensure_history()))
            st = self._state(screenshot=self._shot())
            return f"URL: {self.page.url}\nTITLE: {st['title']}"
        except Exception as e:
            return f"forward error: {e}"

    def wait(self, selector=None, text=None, ms=None):
        """Wait for an element to appear, for page text to render, or a fixed
        delay — for content that arrives after load (SPAs, async results)."""
        ok, err = self._ensure()
        if not ok:
            return f"wait needs Playwright ({err})"
        try:
            if selector:
                self.page.locator(self._as_selector(selector)).first.wait_for(timeout=int(ms or 15000))
                return f"element {selector!r} appeared"
            if text:
                self.page.get_by_text(str(text)).first.wait_for(timeout=int(ms or 15000))
                return f"text {text!r} appeared"
            self.page.wait_for_timeout(int(ms or 1000))
            return f"waited {int(ms or 1000)}ms"
        except Exception as e:
            return f"wait error: {e}"

    def select_option(self, selector, value):
        ok, err = self._ensure()
        if not ok:
            return f"select_option needs Playwright ({err})"
        try:
            loc = self.page.locator(self._as_selector(selector)).first
            try:
                loc.select_option(str(value), timeout=10000)          # by value
            except Exception:
                loc.select_option(label=str(value), timeout=10000)    # ...or label
            self._state()
            return f"selected {value!r} in {selector!r}"
        except Exception as e:
            return f"select_option error: {e}"

    # ── input (virtual mouse / keyboard) ──────────────────────
    @staticmethod
    def _as_selector(target):
        """Map a snapshot ref handle to its stamped selector; pass a CSS selector
        or 'x,y' coordinates through unchanged. Accepts 'ref_5', 'ref-5', 'ref5',
        and a bare '5' — but never an 'x,y' pair, which stays coordinates. This is
        what lets the model act by the [ref_N] it read in the page tree instead of
        inventing a selector."""
        if isinstance(target, str):
            t = target.strip()
            if not re_full(r"^\s*\d+[\s,]+-?\d+\s*$", t):
                m = re_match(r"^(?:ref[_-]?)(\d+)$", t) or re_match(r"^(\d+)$", t)
                if m:
                    return '[data-kiln-ref="%s"]' % m.group(1)
        return target

    @staticmethod
    def _target(page, target):
        """target is a ref handle (ref_N / bare N from the last snapshot), a CSS
        selector, or 'x,y' coordinates -> (x, y, sel)."""
        target = KilnBrowser._as_selector(target)
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

    def type(self, selector, text, submit=False):
        ok, err = self._ensure()
        if not ok:
            return f"type needs Playwright ({err})"
        try:
            sel = self._as_selector(selector)
            loc = self.page.locator(sel).first
            loc.fill(str(text), timeout=10000)
            # `submit=True` presses Enter in the field — the common "type a query
            # then search" flow in one call instead of a type + key round-trip.
            if submit:
                loc.press("Enter")
                self.page.wait_for_load_state("domcontentloaded", timeout=15000)
            self._state()
            return f"typed {len(text)} chars into {selector!r}" + (" and pressed Enter" if submit else "")
        except Exception as e:
            return f"type error: {e}"

    def key(self, combo):
        ok, err = self._ensure()
        if not ok:
            return f"key needs Playwright ({err})"
        try:
            self.page.keyboard.press(str(combo))
            shot = self._shot()
            self._state(screenshot=shot)
            return f"pressed {combo!r}"
        except Exception as e:
            return f"key error: {e}"

    def type_text(self, text):
        """Type text into whatever is focused in the page (page.keyboard.type),
        for interactive typing where there is no ref — the dock pane sends the
        keys the user presses after clicking into a field."""
        ok, err = self._ensure()
        if not ok:
            return f"type_text needs Playwright ({err})"
        try:
            self.page.keyboard.type(str(text))
            shot = self._shot()
            self._state(screenshot=shot)
            return f"typed {len(str(text))} chars"
        except Exception as e:
            return f"type_text error: {e}"

    def clear(self, selector):
        ok, err = self._ensure()
        if not ok:
            return f"clear needs Playwright ({err})"
        try:
            self.page.locator(self._as_selector(selector)).first.fill("", timeout=10000)
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
            shot = self._shot()
            self._state(screenshot=shot)
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
            while len(self._histories) < len(self.context.pages):
                self._histories.append(_empty_history())
            if url and not page.is_closed():
                self._set_history(_push_navigation(_empty_history(), page.url, page.title()))
            else:
                self._persist_histories()
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

    def close_tab(self, index=None):
        ok, err = self._ensure()
        if not ok:
            return f"close_tab needs Playwright ({err})"
        try:
            pages = self.context.pages
            if len(pages) <= 1:
                return "only one tab — not closing it"
            if index is None:
                p = self.page
                idx = pages.index(p) if p in pages else 0
            else:
                idx = int(index)
                if not (-len(pages) <= idx < len(pages)):
                    return f"close_tab: index {idx} out of range ({len(pages)} tabs)"
                p = pages[idx]
            p.close()
            if 0 <= idx < len(self._histories):
                self._histories.pop(idx)
            remaining = self.context.pages
            self.page = remaining[min(idx, len(remaining) - 1)]
            self._persist_histories()
            self._state()
            return f"closed tab ({len(remaining)} remain)"
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

def _browser_shutdown():
    """Interpreter-exit hook: shut the shared browser down on ITS worker thread.

    Playwright's sync API is thread-affine: the live browser, its CDP
    screencast, and every close() belong to the single browser worker thread
    that ``browser_use`` marshals every call onto. This hook is registered via
    ``threading._register_atexit`` (inside ``_browser_executor``) so it runs
    before the executor's own exit cleanup -- while the worker thread is still
    alive and schedulable. Marshalling shutdown through that same worker keeps
    thread affinity; when the browser never launched there is nothing to
    marshal and shutdown on this thread is a no-op.
    """
    try:
        if BROWSER.page is not None or _BROWSER_EXECUTOR is not None:
            _on_browser_thread(BROWSER.shutdown)
        else:
            BROWSER.shutdown()
    except Exception:
        pass


def browser_search(query, limit=8):
    """Browser-backed web search. Returns [{title,url,snippet}], or None when the
    headless browser is unavailable so the caller can fall back to a scrape."""
    return _on_browser_thread(_browser_search_impl, query, limit)


def _browser_search_impl(query, limit=8):
    try:
        return BROWSER.search(query, limit=limit)
    except Exception:
        return None


def browser_use(action="navigate", **kw):
    """One entry point for every browser action. Never raises. Runs on the
    dedicated browser worker thread so Playwright always sees one thread."""
    return _on_browser_thread(_browser_use_impl, action, **kw)


def _browser_use_impl(action="navigate", **kw):
    """One entry point for every browser action. Never raises.

    Non-visual, ref-driven: call read_page() to get the page as a tree of
    [ref_N] handles, then act by ref — click(ref='ref_5'), type(ref='ref_2',
    text='...', submit=True), select(ref='ref_9', value='...'). No screenshots
    or pixel coordinates are needed (though click also accepts a CSS selector or
    'x,y'). Every action reports the outcome as text.

    Actions:
      read:       navigate(url), read_page()/snapshot() -> [ref_N] tree,
                  find(query) -> matching [ref_N] lines, get_text(selector?),
                  dom(selector?), coords(selector), screenshot(path?),
                  back(), forward(), wait(selector?|text?|ms?)
      act:        click(target|ref), dblclick(...), hover(...), drag(src,dst),
                  type(selector|ref, text, submit?), type_text(text), key(combo), clear(...),
                  select(selector|ref, value), scroll(dx?,dy?,amount?,direction?),
                  move(x,y), zoom(factor)
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
        if a in ("snapshot", "read_page", "read"):
            return b.snapshot()
        if a == "find":
            return b.find(kw.get("query") or kw.get("text") or "", int(kw.get("limit", 30) or 30))
        if a in ("get_text", "text", "read_text"):
            return b.get_text(kw.get("selector") or kw.get("ref") or "body",
                              int(kw.get("max_chars", 20000) or 20000))
        if a == "dom":
            return b.dom(kw.get("selector") or "body")
        if a == "coords":
            return b.coords(kw.get("selector") or kw.get("sel") or kw.get("ref") or "")
        if a in ("back", "go_back"):
            return b.back()
        if a in ("forward", "go_forward"):
            return b.forward()
        if a == "wait":
            return b.wait(kw.get("selector") or kw.get("ref"), kw.get("text"), kw.get("ms") or kw.get("timeout"))
        if a in ("select", "select_option"):
            return b.select_option(kw.get("selector") or kw.get("ref") or kw.get("sel") or "",
                                   kw.get("value") or kw.get("option") or "")
        if a == "move":
            return b.move(kw.get("x", 0), kw.get("y", 0))
        if a == "click":
            return b.click(kw.get("target") or kw.get("selector") or kw.get("ref") or "")
        if a == "dblclick":
            return b.dblclick(kw.get("target") or kw.get("selector") or kw.get("ref") or "")
        if a == "hover":
            return b.hover(kw.get("target") or kw.get("selector") or kw.get("ref") or "")
        if a == "drag":
            return b.drag(kw.get("from") or kw.get("src") or "",
                          kw.get("to") or kw.get("dst") or "")
        if a == "type":
            return b.type(kw.get("selector") or kw.get("sel") or kw.get("ref") or "",
                          kw.get("text") or "",
                          bool(kw.get("submit") or kw.get("enter")))
        if a in ("type_text", "insert_text", "keys"):
            return b.type_text(kw.get("text") or "")
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
            return b.close_tab(kw.get("index"))
        if a == "tabs":
            return b.tabs()
        if a == "history":
            return b.history()
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
        return (f"browser_use: unknown action {action!r}. Known: navigate, read_page, "
                f"find, get_text, snapshot, dom, coords, screenshot, back, forward, wait, "
                f"move, click, dblclick, hover, drag, type, key, clear, select, scroll, "
                f"zoom, save_state, load_state, new_tab, switch_tab, close_tab, tabs, history, "
                f"network, console, clear_network, search")
    except Exception as e:
        return f"browser_use error: {e}"


# Keep the full action reference discoverable on the public entry point.
browser_use.__doc__ = _browser_use_impl.__doc__


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


def re_match(pattern, s):
    import re
    return re.match(pattern, s)
