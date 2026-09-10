# browser_tools.py — sandboxed browser automation for Kiln-Kernel.
#
# The browser is a REAL Chromium: headed by default, so a genuine window opens
# on the desktop and the session the agent drives is the same one you can see
# and grab. Set KILN_BROWSER_HEADED=0 to force the windowless shell (CI, or a
# host with no display). Playwright drives it when installed;
# without Playwright the "navigate" action degrades to a plain HTTP text fetch
# and everything else explains what is available. The tool never raises.
#
# Every page action persists a small state file (KILN_BROWSER_DIR/state.json)
# plus screenshots, which the agent loop surfaces as a browser card in the UI.
#
# Browser preference order. When the DeepSeek Harness desktop app is running, the
# agent drives that app's embedded Chromium over CDP instead of opening a second
# browser, so the user and the agent share one window:
#
#   1. ``KILN_BROWSER_CDP_URL`` names a CDP endpoint directly (for example
#      ``http://127.0.0.1:9222``). Setting it to 0/false/no/off/none disables
#      attaching and discovery for the session.
#   2. ``desktop/harness-desktop/.cdp-target.json`` — the record the desktop app
#      writes at startup — supplies the port. It is only read while fresh: the
#      app stamps ``closed: true`` on exit, and an age ceiling of 24 h (mtime,
#      falling back to the record's ``ts`` field) rejects a leftover from an
#      earlier session. The app writes this file once per session, so the ceiling
#      has to cover a window left open all day; the short connect timeout, not the
#      age check, is what stops a dead endpoint from stalling an action.
#   3. Otherwise a fresh Chromium is launched exactly as before.
#
# Attaching is always best-effort. A refused connection, a timeout, or no
# recognisable browser target all fall back silently to launching, and a session
# that attached detaches on shutdown rather than closing a window the user owns.

import concurrent.futures as _futures
import json
import locale
import os
import threading as _threading
import time
from html.parser import HTMLParser

_BROWSER_DIR = os.environ.get("KILN_BROWSER_DIR", "")

# ── attaching to the desktop app's embedded browser ─────────────────────────
# See the module docstring for the preference order and the staleness rule.
_CDP_DISCOVERY_RELPATH = os.path.join("desktop", "harness-desktop", ".cdp-target.json")
_CDP_MAX_AGE_S = 24 * 60 * 60
# Short on purpose: an unreachable endpoint costs this much once, and the
# fallback launch then proceeds normally.
_CDP_CONNECT_TIMEOUT_MS = 3000
# Explicit off-switches, so attaching can be vetoed without naming an endpoint.
_CDP_OFF = ("0", "false", "no", "off", "none")


def _repo_root():
    """Repository root derived from this file's location. Best-effort."""
    try:
        here = os.path.abspath(__file__)
        return os.path.dirname(os.path.dirname(os.path.dirname(os.path.dirname(here))))
    except Exception:
        return ""


def _cdp_env_endpoint():
    """(explicit, url). ``explicit`` is True when the env var spoke at all."""
    raw = os.environ.get("KILN_BROWSER_CDP_URL")
    if raw is None:
        return False, ""
    raw = raw.strip()
    if raw.lower() in _CDP_OFF:
        return True, ""          # explicitly disabled
    return True, raw


def _cdp_discovery_mtime():
    """Mtime of the app's discovery record, or 0.0. Never raises.

    The app rewrites this file once per launch, so an mtime newer than the
    one a failed attach was based on means a window has appeared since and
    the attach is worth retrying.
    """
    try:
        root = _repo_root()
        if not root:
            return 0.0
        return os.stat(os.path.join(root, _CDP_DISCOVERY_RELPATH)).st_mtime
    except Exception:
        return 0.0


def _cdp_discovery_record():
    """The desktop app's CDP record, or None when absent, closed, or stale.

    Never raises: discovery must not be able to break a normal browser action.
    """
    try:
        root = _repo_root()
        if not root:
            return None
        path = os.path.join(root, _CDP_DISCOVERY_RELPATH)
        age = time.time() - os.stat(path).st_mtime
        if age > _CDP_MAX_AGE_S or age < -300:      # negative: clock skew
            return None
        with open(path, encoding="utf-8") as f:
            rec = json.load(f)
        if not isinstance(rec, dict) or rec.get("closed") is True:
            return None
        return rec
    except Exception:
        return None

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
        # Headed by default: the whole point is a real window the user can use,
        # not a screenshot of one. KILN_BROWSER_HEADED=0 restores the headless
        # shell for CI and for hosts with no display.
        _h = os.environ.get("KILN_BROWSER_HEADED", "1").strip().lower()
        self._headed = _h not in ("0", "false", "no", "off")
        # A dedicated profile keeps logins and cookies across restarts WITHOUT
        # touching the user's own Chrome profile (which would fight over its
        # lock file and mix the agent's session into their real browsing).
        self._profile_dir = (os.path.join(_BROWSER_DIR, "profile")
                             if _BROWSER_DIR else "")
        self._persistent = False      # persistent context owns its own browser
        # Attaching to the desktop app's embedded browser over CDP. ``_attached``
        # means the Browser belongs to the user's Electron app: shutdown must
        # detach, never close it. ``_cdp_attempted`` keeps a failed attach from
        # costing its timeout again on every later action.
        self._attached = False
        self._cdp_attempted = False
        self._cdp_url = ""
        self._cdp_error = ""
        self._page_marker = None     # stamped onto every state write while attached
        # A failed attach must not be permanent. The desktop app is often
        # started *after* the kernel -- the kernel is long-lived, the window
        # is not -- so treating the first refusal as final would strand this
        # process on a private Chromium for its whole lifetime while the dock,
        # which reads the app's state.json, kept showing the embedded view.
        # Retry when the app rewrites its discovery record (that is the app
        # announcing itself), or after a short backstop.
        self._cdp_attempt_ts = 0.0
        self._cdp_retry_after_s = 15.0
        self._cdp_record_mtime = 0.0   # record mtime that attempt was based on
        self._launched_ts = 0.0        # when a self-launched browser took over

    # ── lifecycle ──────────────────────────────────────────────
    def _ensure(self):
        """Lazily launch the real browser. Returns (ok, err_or_None).

        Headed by default (``KILN_BROWSER_HEADED=0`` opts out), launched as a
        PERSISTENT context over a dedicated profile directory so logins survive
        restarts. A fixed viewport is kept even when headed: the dock maps its
        own pixels to page coordinates through state.json's vw/vh, so the
        viewport must stay a known size rather than following the window.
        """
        if self.page is not None and not self.page.is_closed():
            return True, None
        try:
            from playwright.sync_api import sync_playwright
        except Exception as e:
            return False, f"Playwright is not installed: {e}"
        try:
            self.pw = sync_playwright().start()
            # Prefer the desktop app's embedded browser when it is there: the
            # agent then drives the window the user is already looking at.
            attached, _err = self._try_cdp_attach()
            if attached:
                return True, None
            launch_kw = {"headless": not self._headed,
                         "args": ["--disable-blink-features=AutomationControlled"]}
            if self._proxy:
                launch_kw["proxy"] = {"server": self._proxy}
            ctx_opts = {
                "user_agent": _UA,
                "viewport": {"width": 1440, "height": 900},
                "device_scale_factor": 2,   # high-res screenshots
                "locale": "en-US",
                "extra_http_headers": {"Accept-Language": "en-US,en;q=0.9"},
            }
            if self._headed and self._profile_dir:
                # A persistent context IS the browser: it has no separate
                # ``browser`` handle, and closing the context closes Chromium.
                os.makedirs(self._profile_dir, exist_ok=True)
                self.context = self.pw.chromium.launch_persistent_context(
                    self._profile_dir, **launch_kw, **ctx_opts)
                self.browser = None
                self._persistent = True
            else:
                self.browser = self.pw.chromium.launch(**launch_kw)
                if self._storage_path and os.path.isfile(self._storage_path):
                    ctx_opts["storage_state"] = self._storage_path
                self.context = self.browser.new_context(**ctx_opts)
                self._persistent = False
            self.context.add_init_script(_STEALTH_JS)   # look like a real browser
            # A persistent context can restore the previous session's tabs, so
            # adopt one when present instead of always adding another.
            _existing = list(self.context.pages)
            self.page = _existing[0] if _existing else self.context.new_page()
            self._requests = []
            self._console = []
            self.page.on("response", lambda r: self._requests.append((r.status, r.url)))
            self.page.on("console", lambda m: self._console.append((m.type, m.text)))
            self._launched_ts = time.time()
            self._start_screencast()
            return True, None
        except Exception as e:
            return False, f"browser launch failed: {e}"

    # ── attaching to the desktop app's embedded browser ────────
    def _cdp_candidates(self):
        """CDP endpoints to try, in preference order. Never raises.

        ``KILN_BROWSER_CDP_URL`` wins outright — an explicit endpoint is an
        instruction, not a hint, so discovery is skipped when it is set (even
        when it is set to an off value, which disables attaching entirely).
        """
        urls = []
        explicit, url = _cdp_env_endpoint()
        if explicit:
            if url:
                urls.append(url)
            return urls
        rec = _cdp_discovery_record()
        if rec:
            port = rec.get("port") or 9222
            if isinstance(port, (int, str)) and str(port).isdigit():
                urls.append(f"http://127.0.0.1:{int(port)}")
        return urls

    @staticmethod
    def _page_target_id(page):
        """The page's CDP target id, or None. Never raises.

        ``Target.getTargetInfo`` on a session bound to this page reports the id
        the desktop app records in its discovery file. That id is stable across
        navigations, which the url and title markers are not.
        """
        try:
            session = page.context.new_cdp_session(page)
            try:
                info = session.send("Target.getTargetInfo") or {}
            finally:
                try:
                    session.detach()
                except Exception:
                    pass
            return ((info.get("targetInfo") or {}).get("targetId")) or None
        except Exception:
            return None

    @staticmethod
    def _pick_browser_page(contexts, title_marker, url_marker, target_id=None):
        """The embedded browser's page, or (None, why).

        A CDP attach sees every page the Electron app hosts: the toolbar, the
        DSH UI at 127.0.0.1:3080, and the embedded browser. Driving the DSH UI
        would type the agent's keystrokes into the harness's own chat box, so
        the marker match is strict and the fallback is deliberately narrow: the
        first page that is neither the DSH UI nor about:blank. If nothing
        qualifies the attach is abandoned and a browser is launched instead.

        The desktop app records the browser view's CDP target id, and that id
        survives the view navigating away from its start page -- unlike the url
        and title markers, which only identify the view before its first real
        navigation. The id is tried first, then the markers.
        """
        pages = []
        for ctx in contexts or []:
            try:
                pages.extend(ctx.pages)
            except Exception:
                continue
        live = []
        for page in pages:
            try:
                if page.is_closed():
                    continue
                live.append((page, page.url or "", (page.title() or "").strip()))
            except Exception:
                continue
        if not live:
            return None, "no pages"
        skip = ("127.0.0.1:3080", "localhost:3080", "toolbar.html")
        if target_id:
            for page, url, title in live:
                if KilnBrowser._page_target_id(page) == target_id:
                    return page, "target"
        for page, url, title in live:
            if url_marker and url_marker in url:
                return page, "url"
        for page, url, title in live:
            if title_marker and title_marker in title:
                return page, "title"
        for page, url, title in live:
            if any(s in url for s in skip) or url in ("", "about:blank"):
                continue
            return page, "fallback"
        return None, "no browser page among %d targets" % len(live)

    def _try_cdp_attach(self):
        """Attach to a running CDP endpoint instead of launching Chromium.

        Returns ``(True, None)`` when attached, ``(False, reason)`` otherwise.
        Everything here is best-effort: an unreachable endpoint, a timeout, or
        no recognisable browser page must degrade to the normal launch, never
        break it. A failed attempt is remembered for the process lifetime so a
        missing desktop app does not pay this timeout on every action.
        """
        if self._cdp_attempted:
            # Retry only when the app has announced a new session (its
            # discovery record was rewritten) or after the backstop. A
            # successful launch of our own browser clears the way on the
            # next action once the window exists.
            rec_mtime = _cdp_discovery_mtime()
            fresh_record = rec_mtime > 0.0 and rec_mtime != self._cdp_record_mtime
            if not fresh_record and (time.time() - self._cdp_attempt_ts) < self._cdp_retry_after_s:
                return False, self._cdp_error or "already tried"
            if self.page is not None and not self.page.is_closed():
                # Something is already driving a real page; do not yank it.
                return False, self._cdp_error or "already tried"
        self._cdp_attempted = True
        self._cdp_attempt_ts = time.time()
        self._cdp_record_mtime = _cdp_discovery_mtime()
        if self._headed is False and os.environ.get("KILN_BROWSER_CDP_URL") is None:
            # Headless is an explicit request for a private browser; do not
            # hijack the user's window instead.
            self._cdp_error = "headless"
            return False, self._cdp_error
        urls = self._cdp_candidates()
        if not urls:
            self._cdp_error = "no CDP endpoint"
            return False, self._cdp_error
        marker = os.environ.get("KILN_BROWSER_CDP_TITLE", "DSH-BROWSER-VIEW")
        for url in urls:
            try:
                browser = self.pw.chromium.connect_over_cdp(
                    url, timeout=_CDP_CONNECT_TIMEOUT_MS)
                contexts = list(browser.contexts)
                page, why = self._pick_browser_page(
                    contexts, marker, "browser-start",
                    (_cdp_discovery_record() or {}).get("targetId"))
                if page is None:
                    self._cdp_error = f"{url}: {why}"
                    try:
                        browser.close()
                    except Exception:
                        pass
                    continue
                # A CDP Browser owns the pages it exposes: there is no
                # new_context() here, the existing context is reused as-is.
                self.browser = browser
                self.context = next((c for c in contexts if page in list(c.pages)),
                                    contexts[0] if contexts else None)
                if self.context is None:
                    self._cdp_error = f"{url}: no context"
                    self.browser = None
                    continue
                self.page = page
                self._attached = True
                self._persistent = False
                self._cdp_url = url
                self._cdp_error = ""
                self._page_marker = {"title_marker": marker, "matched_by": why,
                                     "cdp_url": url,
                                     "target_id": (_cdp_discovery_record() or {}).get("targetId")}
                self._requests = []
                self._console = []
                try:
                    page.on("response",
                            lambda r: self._requests.append((r.status, r.url)))
                    page.on("console",
                            lambda m: self._console.append((m.type, m.text)))
                except Exception:
                    pass     # instrumentation is optional
                self._start_screencast()
                return True, None
            except Exception as e:
                # Includes the short connect timeout: fall through to launching.
                self._cdp_error = f"{url}: {type(e).__name__}: {e}"
                continue
        return False, self._cdp_error

    def _detach_cdp(self):
        """Release a CDP attachment without closing the user's browser.

        ``Browser.close()`` on a CDP connection closes the *connected* browser —
        for the desktop app that means quitting the window the user is working
        in. The connection is torn down by stopping Playwright instead, which
        disconnects the client and leaves the Electron app running.
        """
        self._attached = False
        self._cdp_url = ""
        self._page_marker = None
        self._cdp_attempted = False    # a later action may attach again
        self._cdp_error = ""
        self.browser = None
        self.context = None
        self.page = None

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
                    # Only the fields a frame actually changes. Re-serializing
                    # the 4 kB text_preview and 60 links at 15 fps was pure
                    # overhead: they are identical to the last action's write.
                    st = dict(base)
                    st["ts"] = time.time()
                    st["screenshot"] = "latest.jpg"
                    st["text_preview"] = ""
                    st["links"] = []
                    self._write_state(st, remember=False)
            self._screencast = self.page.screencast.start(
                on_frame=_on_frame,
                # A live view is judged in motion, not per still: 60 is visually
                # indistinguishable here and roughly a third of the bytes of 90,
                # which the whole pipeline (disk -> watch -> socket) pays for.
                quality=60,
                size={"width": 1280, "height": 720},
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

    def _reattach_screencast(self, page):
        """Move the live CDP feed to `page`, which just became the active tab.

        The screencast is per-page: Playwright attaches it to one Page at a
        time. Without re-attaching here, new_tab/switch_tab would leave the
        mirror showing the previous tab's last frame indefinitely, which reads
        as the new tab "never loading".
        """
        self._stop_screencast()
        self.page = page
        self._start_screencast()

    def shutdown(self):
        """Orderly teardown: stop the live feed, then close browser resources.

        Playwright's CDP screencast has no interpreter-exit hook, so a bare
        exit leaves its node driver writing into a closed pipe — an unhandled
        EPIPE plus a node stack trace. Stopping the screencast first, then
        closing context/browser/playwright in dependency order, lets the
        process exit quietly. Idempotent and never raises.
        """
        self._stop_screencast()
        if self._attached:
            # The browser belongs to the desktop app the user is working in:
            # closing it would quit their window. Detach instead, and stop
            # Playwright WITHOUT a browser.close() to drop the CDP connection.
            self._detach_cdp()
            if self.pw is not None:
                try:
                    self.pw.stop()
                except Exception:
                    pass
            self.pw = None
            self._persistent = False
            return
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
        self._persistent = False
        self.pw = None

    def _window_id(self):
        """CDP window id for the active page, or None. Best-effort."""
        try:
            cdp = self.context.new_cdp_session(self.page)
            return cdp, cdp.send("Browser.getWindowForTarget").get("windowId")
        except Exception:
            return None, None

    def show_window(self):
        """Bring the real Chromium window to the front and focus it.

        The whole point of a headed browser is that the user can take over, and
        that only works if the window is actually in front of everything else.
        """
        ok, err = self._ensure()
        if not ok:
            return f"show_window needs Playwright ({err})"
        if not getattr(self, "_headed", False):
            return ("browser is headless; set KILN_BROWSER_HEADED=1 and restart "
                    "the harness to get a real window")
        try:
            self.page.bring_to_front()
            try:
                cdp, wid = self._window_id()
                if wid is not None:
                    # A minimized window stays minimized through bring_to_front.
                    cdp.send("Browser.setWindowBounds",
                             {"windowId": wid, "bounds": {"windowState": "normal"}})
                    self.page.bring_to_front()
            except Exception:
                pass   # bounds are cosmetic; bring_to_front already raised it
            return "browser window shown"
        except Exception as e:
            return f"show_window error: {e}"

    def window_state(self):
        """Report headed/headless, the profile dir, and the live window bounds."""
        info = {"headed": bool(getattr(self, "_headed", False)),
                "profile": self._profile_dir or None,
                "bounds": None}
        ok, err = self._ensure()
        if not ok:
            info["error"] = err
            return json.dumps(info)
        if info["headed"]:
            try:
                cdp, wid = self._window_id()
                if wid is not None:
                    info["bounds"] = cdp.send(
                        "Browser.getWindowBounds", {"windowId": wid}).get("bounds")
            except Exception:
                pass
        return json.dumps(info)

    def _state(self, light=False, **extra):
        # vw/vh are the CSS viewport the screenshot covers, so the dock pane can
        # scale a click on the image back to browser coordinates.
        st = {"ts": time.time(), "url": "", "title": "",
              "screenshot": "", "text_preview": "", "links": [],
              "vw": 1440, "vh": 900,
              # A plain bool, deliberately: the dock needs to know whether a
              # real window exists, but querying window bounds over CDP on
              # every state write would re-add the per-action latency that
              # light mode exists to avoid.
              "headed": bool(getattr(self, "_headed", False)),
              # Cheap bools only: the dock shows whether the agent is driving the
              # desktop app's own window, and querying CDP here would re-add the
              # per-action latency the light path exists to avoid.
              "attached": bool(getattr(self, "_attached", False)),
              "attached_url": getattr(self, "_cdp_url", "") or ""}
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
                if not light:
                    try:
                        st["text_preview"] = self.page.inner_text("body")[:4000]
                    except Exception:
                        pass
                    try:
                        st["links"] = self.page.eval_on_selector_all(
                            "a[href]", "els => els.map(e => e.href)")[:60] or []
                    except Exception:
                        pass
                else:
                    # Tab-strip ops only need url/title/tabs/active/history — a
                    # fresh full-DOM walk here is the dominant per-click cost and
                    # buys the dock nothing. Carry the last known preview forward
                    # so the pane never blanks between navigations.
                    last = self._last_state
                    if last is not None:
                        st["text_preview"] = last.get("text_preview", "")
                        st["links"] = last.get("links", [])
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
        if self._page_marker:
            st["marker"] = self._page_marker
        st.update(extra)
        # The live CDP screencast is the dock's authoritative feed: a one-shot
        # PNG that an action just wrote must not overwrite ``latest.jpg`` while
        # the screencast is running, or the pane would flicker back to a still.
        if self._screencast is not None and os.path.isfile(os.path.join(_BROWSER_DIR, "latest.jpg")):
            st["screenshot"] = "latest.jpg"
        self._write_state(st)
        return st

    def _write_state(self, st, remember=True):
        # The screencast callback runs on Playwright's dispatcher thread while
        # normal actions run on the browser worker thread; the lock keeps their
        # state.json writes from interleaving into a torn JSON document.
        #
        # `remember=False` is for the ~15 fps frame path: it publishes a small
        # document without overwriting `_last_state`, so the full text/links
        # captured by the last real action are not lost to a frame tick.
        with self._state_lock:
            if remember:
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
                json.dump({"tabs": self._histories, "active": self._page_index()},
                          f, ensure_ascii=False)
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

    def restore(self):
        """Reopen the persisted tab set from ``history.json``.

        The headless Chromium process does not survive a restart, so live DOM
        state cannot be resurrected; what IS durable is the tab/history model.
        This reopens one page per recorded tab, navigates each to its most
        recent URL, and re-seeds the per-tab histories so back/forward still
        work after the restore. Best effort: a URL that now 403s/redirects is
        left blank but its history record is kept.
        """
        ok, err = self._ensure()
        if not ok:
            return f"restore needs Playwright ({err})"
        try:
            path = os.path.join(_BROWSER_DIR, "history.json")
            saved = None
            if _BROWSER_DIR and os.path.isfile(path):
                with open(path, "r", encoding="utf-8") as f:
                    saved = json.load(f)
            records = (saved or {}).get("tabs") or []
            if not records:
                return "(no saved session to restore)"
            active = int((saved or {}).get("active", 0) or 0)
            # The first existing page hosts the first restored tab; the rest get
            # fresh pages in order, so tab order matches the saved order.
            pages = self.context.pages
            self._histories = []
            for i, record in enumerate(records):
                if i < len(pages):
                    page = pages[i]
                else:
                    page = self.context.new_page()
                cur = (record or {}).get("current")
                if cur and cur.get("url"):
                    try:
                        page.goto(cur["url"], timeout=30000,
                                  wait_until="domcontentloaded")
                    except Exception:
                        pass
                # The page's real post-navigation URL is the current entry; keep
                # the saved stack but refresh current.url/title from the live page.
                try:
                    live_url = page.url if not page.is_closed() else (cur or {}).get("url", "")
                    live_title = page.title() if not page.is_closed() else (cur or {}).get("title", "")
                except Exception:
                    live_url = (cur or {}).get("url", "")
                    live_title = (cur or {}).get("title", "")
                restored = dict(record or {})
                if restored.get("current") is not None:
                    restored["current"] = dict(restored["current"])
                    restored["current"]["url"] = live_url
                    restored["current"]["title"] = live_title
                self._histories.append(restored)
            # Close any surplus pages left over from a pre-restore blank tab.
            for extra in pages[len(records):]:
                try:
                    extra.close()
                except Exception:
                    pass
            if 0 <= active < len(self.context.pages):
                self.page = self.context.pages[active]
            else:
                self.page = self.context.pages[0]
            self._persist_histories()
            self._state()
            return f"restored {len(records)} tab(s)"
        except Exception as e:
            return f"restore error: {e}"

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

    def ui_mouse(self, kind, x=None, y=None, button="left", clicks=1, dy=0, dx=0):
        """Forward one raw mouse event from the dock's live pane.

        ``kind`` is move / down / up / click / wheel. Coordinates are already in
        page space: the dock scales the pixels the user clicked on its image by
        the vw/vh it read from state.json, so the kernel never has to guess.
        No screenshot is taken — the live screencast emits the resulting frame.
        """
        ok, err = self._ensure()
        if not ok:
            return f"ui_mouse needs Playwright ({err})"
        try:
            if kind == "move":
                self.page.mouse.move(float(x or 0), float(y or 0))
            elif kind == "down":
                self.page.mouse.move(float(x or 0), float(y or 0))
                self.page.mouse.down(button=button)
            elif kind == "up":
                self.page.mouse.up(button=button)
            elif kind == "click":
                self.page.mouse.move(float(x or 0), float(y or 0))
                self.page.mouse.click(float(x or 0), float(y or 0),
                                      button=button, click_count=int(clicks or 1))
            elif kind == "wheel":
                self.page.mouse.wheel(float(dx or 0), float(dy or 0))
            else:
                return f"ui_mouse: unknown kind {kind!r}"
            return f"ui_mouse {kind} ok"
        except Exception as e:
            return f"ui_mouse error: {e}"

    def ui_key(self, key=None, text=None):
        """Forward a keystroke or literal text to the focused element.

        ``key`` is a Playwright key/combo ("Enter", "Control+A"); ``text`` types
        literally through the keyboard, which is what character input needs.
        """
        ok, err = self._ensure()
        if not ok:
            return f"ui_key needs Playwright ({err})"
        try:
            if text:
                self.page.keyboard.type(str(text))
                return f"ui_key typed {len(str(text))} chars"
            self.page.keyboard.press(str(key))
            return f"ui_key pressed {key!r}"
        except Exception as e:
            return f"ui_key error: {e}"

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
            self._reattach_screencast(page)
            while len(self._histories) < len(self.context.pages):
                self._histories.append(_empty_history())
            if url and not page.is_closed():
                self._set_history(_push_navigation(_empty_history(), page.url, page.title()))
            else:
                self._persist_histories()
            self._state(light=True)
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
            self._reattach_screencast(pages[i])
            self.page.bring_to_front()
            self._state(light=True)
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
            self._reattach_screencast(remaining[min(idx, len(remaining) - 1)])
            self._persist_histories()
            self._state(light=True)
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
        self._state(light=True)
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
        if a == "ui_mouse":
            return b.ui_mouse(kw.get("kind") or "click", kw.get("x"), kw.get("y"),
                              button=kw.get("button") or "left",
                              clicks=kw.get("clicks") or 1,
                              dx=kw.get("dx") or 0, dy=kw.get("dy") or 0)
        if a == "ui_key":
            return b.ui_key(kw.get("key"), kw.get("text"))
        if a in ("show_window", "show"):
            return b.show_window()
        if a in ("window_state", "window"):
            return b.window_state()
        if a == "history":
            return b.history()
        if a in ("restore", "restore_session"):
            return b.restore()
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
                f"zoom, save_state, load_state, new_tab, switch_tab, close_tab, tabs, history, restore, "
                f"show_window, window_state, ui_mouse, ui_key, "
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
