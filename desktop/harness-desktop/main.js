// DeepSeek Harness desktop shell.
//
// A BaseWindow holding three WebContentsViews: a thin toolbar, the DSH web UI,
// and an embedded browser. The embedded browser is a real Chromium view, so the
// harness's Python browser automation can attach to it over CDP (port 9222) and
// drive the very same page the user is looking at.

const { app, BaseWindow, WebContentsView, ipcMain, shell } = require("electron");
const fs = require("node:fs");
const path = require("node:path");

const CDP_PORT = Number(process.env.DSH_CDP_PORT || 9222);
const WEB_URL = process.env.DSH_WEB_URL || "http://127.0.0.1:3080";
const LAYOUT = process.env.DSH_LAYOUT || "right"; // right | left | top | bottom

const TOOLBAR_HEIGHT = 36;
const SPLITTER = 8;
const DSH_RATIO = 0.45;

// The browser view's start page carries this title. The Python side matches on
// it so several CDP targets can coexist without ambiguity.
const BROWSER_TITLE_MARKER = "DSH-BROWSER-VIEW";
const TARGET_FILE = path.join(__dirname, ".cdp-target.json");

// Must precede app.whenReady(). remote-allow-origins is required by recent
// Chromium for a CDP client that sends an Origin header, as Playwright does.
app.commandLine.appendSwitch("remote-debugging-port", String(CDP_PORT));
app.commandLine.appendSwitch("remote-allow-origins", "*");

const views = { toolbar: null, dsh: null, browser: null };
let win = null;

function browserState() {
  const wc = views.browser && views.browser.webContents;
  if (!wc) {
    return { url: "about:blank", canGoBack: false, canGoForward: false, isLoading: false };
  }
  let canGoBack = false;
  let canGoForward = false;
  try {
    canGoBack = wc.navigationHistory.canGoBack();
    canGoForward = wc.navigationHistory.canGoForward();
  } catch {
    /* history is unavailable until the first navigation commits */
  }
  return {
    url: wc.getURL() || "about:blank",
    title: wc.getTitle(),
    canGoBack,
    canGoForward,
    isLoading: wc.isLoading(),
  };
}

function pushToolbarState() {
  const wc = views.toolbar && views.toolbar.webContents;
  if (!wc || wc.isDestroyed()) return;
  wc.send("dsh-toolbar:state", browserState());
}

function navigateBrowser(raw) {
  const wc = views.browser && views.browser.webContents;
  if (!wc) return;
  const text = String(raw || "").trim();
  if (!text) return;
  const hasScheme = /^[a-zA-Z][a-zA-Z0-9+.-]*:/.test(text);
  const looksLikeHost = /^[a-zA-Z0-9-]+(\.[a-zA-Z0-9-]+)+(:\d+)?(\/.*)?$/.test(text);
  const target = hasScheme
    ? text
    : looksLikeHost
      ? `https://${text}`
      : `https://duckduckgo.com/?q=${encodeURIComponent(text)}`;
  wc.loadURL(target).catch((err) => {
    console.error("[dsh-desktop] navigation failed:", target, err.message);
    pushToolbarState();
  });
}

function layout() {
  if (!win) return;
  const { width, height } = win.getContentBounds();
  views.toolbar.setBounds({ x: 0, y: 0, width, height: TOOLBAR_HEIGHT });

  const bodyY = TOOLBAR_HEIGHT;
  const bodyH = Math.max(0, height - TOOLBAR_HEIGHT);
  const horizontal = LAYOUT === "left" || LAYOUT === "right";

  let dshBox;
  let browserBox;
  if (horizontal) {
    const usable = Math.max(0, width - SPLITTER);
    const dshW = Math.round(usable * DSH_RATIO);
    const browserW = usable - dshW;
    if (LAYOUT === "left") {
      browserBox = { x: 0, y: bodyY, width: browserW, height: bodyH };
      dshBox = { x: browserW + SPLITTER, y: bodyY, width: dshW, height: bodyH };
    } else {
      dshBox = { x: 0, y: bodyY, width: dshW, height: bodyH };
      browserBox = { x: dshW + SPLITTER, y: bodyY, width: browserW, height: bodyH };
    }
  } else {
    const usable = Math.max(0, bodyH - SPLITTER);
    const dshH = Math.round(usable * DSH_RATIO);
    const browserH = usable - dshH;
    if (LAYOUT === "top") {
      browserBox = { x: 0, y: bodyY, width, height: browserH };
      dshBox = { x: 0, y: bodyY + browserH + SPLITTER, width, height: dshH };
    } else {
      dshBox = { x: 0, y: bodyY, width, height: dshH };
      browserBox = { x: 0, y: bodyY + dshH + SPLITTER, width, height: browserH };
    }
  }

  views.dsh.setBounds(dshBox);
  views.browser.setBounds(browserBox);
}

function createWindow() {
  win = new BaseWindow({
    width: 1600,
    height: 1000,
    title: "DeepSeek Harness",
    backgroundColor: "#1f2430",
  });

  views.toolbar = new WebContentsView({
    webPreferences: {
      preload: path.join(__dirname, "chrome", "toolbar-preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });

  views.dsh = new WebContentsView({
    webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true },
  });

  views.browser = new WebContentsView({
    // A plain web page: no preload surface, so the embedded browser holds
    // nothing privileged.
    webPreferences: { contextIsolation: true, nodeIntegration: false, webviewTag: true, sandbox: true },
  });

  win.contentView.addChildView(views.toolbar);
  win.contentView.addChildView(views.dsh);
  win.contentView.addChildView(views.browser);

  const browserWc = views.browser.webContents;
  browserWc.setWindowOpenHandler(({ url }) => {
    navigateBrowser(url);
    return { action: "deny" };
  });
  for (const event of [
    "did-start-loading",
    "did-stop-loading",
    "did-navigate",
    "did-navigate-in-page",
    "page-title-updated",
  ]) {
    browserWc.on(event, pushToolbarState);
  }

  views.toolbar.webContents.loadFile(path.join(__dirname, "chrome", "toolbar.html"));
  // A local, network-free start page gives the browser view a stable title to
  // match on before any real navigation happens.
  views.browser.webContents.loadFile(path.join(__dirname, "chrome", "browser-start.html"));
  views.dsh.webContents.loadURL(WEB_URL).catch((err) => {
    console.error("[dsh-desktop] DSH UI failed to load:", WEB_URL, err.message);
  });

  win.on("resize", layout);
  win.on("closed", () => {
    win = null;
  });

  layout();
  pushToolbarState();
}

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms));

async function cdpList() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json/list`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  return res.json();
}

// Resolve the browser view's CDP target by its title marker, falling back to
// the start page's file:// URL. Both survive the DSH UI view being present.
async function resolveBrowserTarget(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      const pages = (await cdpList()).filter((t) => t.type === "page");
      const byTitle = pages.find((t) => (t.title || "").includes(BROWSER_TITLE_MARKER));
      if (byTitle) return byTitle;
      const byUrl = pages.find((t) => (t.url || "").includes("browser-start.html"));
      if (byUrl) return byUrl;
    } catch (err) {
      lastError = err;
    }
    await sleep(250);
  }
  if (lastError) throw lastError;
  return null;
}

function writeTargetRecord(target) {
  let viewId = null;
  try {
    viewId = views.browser ? views.browser.webContents.id : null;
  } catch {
    /* the view may already be gone during shutdown */
  }
  const record = {
    port: CDP_PORT,
    wsUrl: target ? target.webSocketDebuggerUrl : null,
    pageUrl: target ? target.url : null,
    title: target ? target.title : null,
    targetId: target ? target.id : null,
    viewWebContentsId: viewId,
    titleMarker: BROWSER_TITLE_MARKER,
    dshWebUrl: WEB_URL,
    ts: new Date().toISOString(),
  };
  fs.writeFileSync(TARGET_FILE, `${JSON.stringify(record, null, 2)}\n`, "utf8");
  return record;
}

async function publishTarget() {
  try {
    const target = await resolveBrowserTarget();
    if (!target) {
      console.error("[dsh-desktop] could not resolve the embedded browser CDP target");
      return;
    }
    const record = writeTargetRecord(target);
    console.log(`[dsh-desktop] browser CDP target ${record.targetId} -> ${TARGET_FILE}`);
  } catch (err) {
    console.error("[dsh-desktop] CDP target discovery failed:", err.message);
  }
}

ipcMain.handle("dsh-toolbar:get-state", () => browserState());
ipcMain.handle("dsh-toolbar:back", () => {
  const wc = views.browser && views.browser.webContents;
  if (wc && wc.navigationHistory.canGoBack()) wc.navigationHistory.goBack();
  return browserState();
});
ipcMain.handle("dsh-toolbar:forward", () => {
  const wc = views.browser && views.browser.webContents;
  if (wc && wc.navigationHistory.canGoForward()) wc.navigationHistory.goForward();
  return browserState();
});
ipcMain.handle("dsh-toolbar:reload", () => {
  const wc = views.browser && views.browser.webContents;
  if (wc) wc.reload();
  return browserState();
});
ipcMain.handle("dsh-toolbar:navigate", (_event, url) => {
  navigateBrowser(url);
  return browserState();
});

// Links the DSH UI opens in a new window go to the system browser rather than
// replacing the harness UI.
app.on("web-contents-created", (_event, contents) => {
  contents.setWindowOpenHandler(({ url }) => {
    if (/^https?:/.test(url)) shell.openExternal(url);
    return { action: "deny" };
  });
});

app.whenReady().then(async () => {
  createWindow();
  await publishTarget();
  console.log(`[dsh-desktop] ready: dsh=${WEB_URL} cdp=${CDP_PORT} layout=${LAYOUT}`);
});

app.on("window-all-closed", () => {
  try {
    fs.writeFileSync(
      TARGET_FILE,
      `${JSON.stringify({ port: CDP_PORT, wsUrl: null, closed: true, ts: new Date().toISOString() }, null, 2)}\n`,
      "utf8",
    );
  } catch {
    /* advisory file only */
  }
  app.quit();
});

process.on("SIGINT", () => app.quit());
process.on("SIGTERM", () => app.quit());
