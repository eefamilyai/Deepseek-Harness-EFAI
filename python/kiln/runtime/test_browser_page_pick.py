#!/usr/bin/env python
"""Regression tests for the embedded browser's CDP page selection.

Run:  python test_browser_page_pick.py

``KilnBrowser._pick_browser_page`` chooses which page of the desktop app to
drive once a CDP attach succeeds. Getting it wrong is not a cosmetic bug: the
app exposes three pages, and two of them are the agent's own furniture -- the
DSH web UI at 127.0.0.1:3080 and the app's own toolbar. Driving either one
types the agent's keystrokes into the harness's chat box or its URL bar.

The url and title markers only identify the browser view before its first real
navigation, so a second attach -- a later cell, or the same window after the
user browsed somewhere -- used to fall through to "first page that is not the
DSH UI", which is the toolbar. These tests pin the target-id match that fixes
that, and the toolbar exclusion that backstops it.

No Electron and no network: the contexts and pages are fakes.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))

from browser_tools import KilnBrowser

TOOLBAR_URL = "file:///D:/deepseek-kernel-harness/desktop/harness-desktop/chrome/toolbar.html"
START_URL = "file:///D:/deepseek-kernel-harness/desktop/harness-desktop/chrome/browser-start.html"
DSH_URL = "http://127.0.0.1:3080/"
MARKER = "DSH-BROWSER-VIEW"


class FakeSession:
    def __init__(self, target_id):
        self._target_id = target_id
        self.detached = False

    def send(self, method):
        assert method == "Target.getTargetInfo", method
        return {"targetInfo": {"targetId": self._target_id}}

    def detach(self):
        self.detached = True


class FakeContext:
    def __init__(self, target_id=None, raises=False):
        self._target_id = target_id
        self._raises = raises

    def new_cdp_session(self, page):
        if self._raises:
            raise RuntimeError("no cdp session")
        return FakeSession(self._target_id)


class FakePage:
    def __init__(self, url, title, target_id=None, closed=False, raises=False):
        self.url = url
        self._title = title
        self.closed = closed
        self.context = FakeContext(target_id, raises=raises)

    def is_closed(self):
        return self.closed

    def title(self):
        return self._title


class _Ctx:
    """Just enough of a Playwright BrowserContext for the page picker."""

    def __init__(self, pages):
        self.pages = pages


def pick(pages, target_id=None):
    return KilnBrowser._pick_browser_page([_Ctx(pages)], MARKER, "browser-start", target_id)


def app_pages(browser_url=START_URL, browser_title=MARKER, browser_target="T-BROWSER"):
    """The three pages the desktop app always exposes, in the order CDP lists
    them: browser view, DSH UI, toolbar."""
    return [
        FakePage(browser_url, browser_title, browser_target),
        FakePage(DSH_URL, "127.0.0.1:3080", "T-DSH"),
        FakePage(TOOLBAR_URL, "DSH-TOOLBAR", "T-TOOLBAR"),
    ]


def check(name, got, want):
    ok = got == want
    print(("PASS " if ok else "FAIL ") + name + "  got=" + repr(got) + " want=" + repr(want))
    return ok


def main():
    results = []

    # 1. The target id wins even after the view navigated away from its start
    #    page -- the original bug: markers are gone, toolbar is still there.
    pages = app_pages(browser_url="https://example.com/", browser_title="Example Domain")
    page, why = pick(pages, "T-BROWSER")
    results.append(check("target-id match survives navigation", why, "target"))
    results.append(check("target-id match picks the view", page.url, "https://example.com/"))

    # 2. Without a target id the url marker still works on a fresh view.
    page, why = pick(app_pages(), None)
    results.append(check("url marker on a fresh view", why, "url"))
    results.append(check("url marker picks the view", page.url, START_URL))

    # 3. Title marker is the next fallback.
    page, why = pick(app_pages(browser_url="about:blank"), None)
    results.append(check("title marker fallback", why, "title"))

    # 4. THE BACKSTOP. No target id, no markers, toolbar present: the toolbar
    #    must never be chosen. Before the fix this returned the toolbar.
    page, why = pick(app_pages(browser_url="https://example.com/", browser_title="Example Domain"), None)
    results.append(check("fallback is not the toolbar",
                         bool(page and "toolbar.html" not in page.url), True))
    results.append(check("fallback is not the DSH UI either",
                         bool(page and "3080" not in page.url), True))

    # 5. Only the toolbar and the DSH UI exist -> abandon the attach rather
    #    than drive the agent's own furniture.
    only_furniture = [
        FakePage(DSH_URL, "127.0.0.1:3080", "T-DSH"),
        FakePage(TOOLBAR_URL, "DSH-TOOLBAR", "T-TOOLBAR"),
    ]
    page, why = pick(only_furniture, "T-BROWSER")
    results.append(check("no browser view -> attach abandoned", page, None))

    # 6. A stale target id must not match anything.
    page, why = pick(app_pages(), "T-STALE")
    results.append(check("stale target id does not match the toolbar",
                         bool(page and "toolbar.html" not in page.url), True))

    # 7. A page whose CDP session cannot be opened is skipped, not fatal.
    bad = FakePage("https://example.com/", "Example Domain", raises=True)
    good = FakePage("https://good.example/", "Good", "T-GOOD")
    page, why = pick([bad, good], "T-GOOD")
    results.append(check("unqueryable page is skipped", why, "target"))
    results.append(check("unqueryable page is skipped (url)", page.url, "https://good.example/"))

    # 8. Closed pages are ignored.
    closed = FakePage("https://closed.example/", "Closed", "T-BROWSER", closed=True)
    page, why = pick([closed] + app_pages(), "T-BROWSER")
    results.append(check("closed page ignored", page.url, START_URL))

    # 9. No pages at all.
    page, why = pick([], "T-BROWSER")
    results.append(check("no pages", (page, why), (None, "no pages")))

    print("")
    if all(results):
        print("[runner] PASS=%d FAIL=0" % len(results))
        return 0
    print("[runner] PASS=%d FAIL=%d" % (results.count(True), results.count(False)))
    return 1


if __name__ == "__main__":
    sys.exit(main())
