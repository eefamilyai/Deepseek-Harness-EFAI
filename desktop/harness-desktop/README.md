# dsh-harness-desktop

A native Windows desktop shell for DeepSeek Harness. It puts the DSH web UI and a
real Chromium browser side by side in one window, and exposes that browser over the
Chrome DevTools Protocol so the harness's Python browser automation drives the very
same page the user is looking at.

## Why this exists

A web page cannot embed a native browser: the `WebView`/`webview` tag is not
available to ordinary pages, and `window.open` hands the URL to the OS. So the DSH
web UI, on its own, can never show a genuine browser inside its own layout.

Electron can. An Electron `WebContentsView` *is* a Chromium frame, and Electron
exposes every such view as a CDP target on `--remote-debugging-port`. Pointing
Playwright at that port with `connect_over_cdp` therefore gives the agent and the
human **one shared browser**: the agent navigates, clicks, and reads the DOM while
the user watches the same pixels in the app window, and either side can take over.

## Layout

```
+--------------------------------------------------------------+
| toolbar:  <-  ->  reload  [ url ]                            |
+---------------------------+----------------------------------+
|                           |                                  |
|  DSH web UI               |  embedded browser                |
|  http://127.0.0.1:3080    |  (CDP-drivable)                  |
|                           |                                  |
+---------------------------+----------------------------------+
```

The DSH UI and the browser are separate `WebContentsView`s in a `BaseWindow`, so
the browser view is a first-class top-level CDP target rather than a nested frame.

## Install

Requires Node.js and npm. Electron is pinned to 44.3.0 and installs as a normal
`devDependency`; this directory is deliberately **not** a pnpm workspace member, so
it never perturbs the repository lockfile.

```
cd D:\deepseek-kernel-harness\desktop\harness-desktop
npm install
npx electron --version      # forces the ~250 MB binary download on first run
```

If the Electron binary did not download during `npm install` (the postinstall can
be skipped by some npm configurations), fetch it directly:

```
cd node_modules\electron
node install.js
```

## Run

```
npm start
```

or, to point at a different harness server:

```
set DSH_WEB_URL=http://127.0.0.1:3080
npm start
```

## Environment variables

| Variable | Default | Meaning |
| --- | --- | --- |
| `DSH_WEB_URL` | `http://127.0.0.1:3080` | URL loaded into the left (DSH UI) view. |
| `DSH_CDP_PORT` | `9222` | CDP port the app opens for remote debugging. |
| `DSH_LAYOUT` | `right` | Where the browser view sits: `right`, `left`, `top`, or `bottom`. |
| `DSH_BROWSER_URL` | (unused) | Reserved for a future start URL override. |

## The CDP discovery file

`--remote-debugging-port` publishes *every* view, so `http://127.0.0.1:9222/json/list`
returns several `"type": "page"` targets: the toolbar, the DSH UI, and the embedded
browser. Telling them apart by index is fragile, so the main process resolves the
browser's target on startup and writes it to:

```
desktop\harness-desktop\.cdp-target.json
```

```json
{
  "port": 9222,
  "wsUrl": "ws://127.0.0.1:9222/devtools/page/<id>",
  "pageUrl": "file:///.../chrome/browser-start.html",
  "title": "DSH-BROWSER-VIEW",
  "targetId": "8D7A8E63685D0DD86217602F756C9FFC",
  "viewWebContentsId": 3,
  "titleMarker": "DSH-BROWSER-VIEW",
  "dshWebUrl": "http://127.0.0.1:3080",
  "ts": "2026-09-10T12:00:00.000Z"
}
```

The browser view starts on `chrome/browser-start.html`, whose `<title>` is
`DSH-BROWSER-VIEW`. The main process matches that marker first and falls back to the
`browser-start.html` URL, so the record is correct even if the view is still loading.
On shutdown the file is rewritten with `"closed": true`.

`targetId` is the field to match on, and the only one that stays valid. The URL and
title markers identify the view *before its first real navigation*; the moment the
view loads any page, both are gone, while the target id does not change. A client
that matches on the markers alone will pick the wrong page on a second attach — and
the wrong page here is the toolbar or the DSH UI, which would put the agent's
keystrokes into the app's URL bar or the harness's own chat box.

### Driving it from Python

```python
import json
from playwright.sync_api import sync_playwright

with open(r"desktop\harness-desktop\.cdp-target.json", encoding="utf-8") as f:
    target_id = json.load(f)["targetId"]

with sync_playwright() as pw:
    browser = pw.chromium.connect_over_cdp("http://127.0.0.1:9222")
    pages = [p for ctx in browser.contexts for p in ctx.pages]

    # Match the recorded target id, never an index and never a URL: the toolbar
    # and the DSH UI are pages too, and both are harmful to drive.
    def target_of(page):
        session = page.context.new_cdp_session(page)
        try:
            return session.send("Target.getTargetInfo")["targetInfo"]["targetId"]
        finally:
            session.detach()

    page = next(p for p in pages if target_of(p) == target_id)
    page.goto("https://example.com")
    print(page.title())   # Example Domain
```

`browser_tools.py` does exactly this in `_pick_browser_page`, and falls back to the
markers only when the record carries no `targetId`. Its unit tests live in
`python/kiln/runtime/test_browser_page_pick.py`.

## Files

| File | Role |
| --- | --- |
| `main.js` | Main process: window, views, layout, CDP switches, target discovery. |
| `chrome/toolbar.html`, `chrome/toolbar.js` | Back / forward / reload buttons and the URL bar. |
| `chrome/toolbar-preload.js` | The toolbar's only privileged surface (`contextBridge` + IPC). |
| `chrome/browser-start.html` | Network-free start page; carries the `DSH-BROWSER-VIEW` marker. |
| `.cdp-target.json` | Generated at runtime; the CDP discovery record. |

The DSH UI and browser views run with `contextIsolation` on, `nodeIntegration`
off, and no preload, so neither holds privileged access to the machine.
