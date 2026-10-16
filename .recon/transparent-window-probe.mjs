// Proof: does a transparent Electron window on this machine actually reveal what is behind
// it, and does a screen capture show it? Runs one throwaway window for a few seconds.
import { app, BrowserWindow } from 'electron'

const page = `data:text/html,${encodeURIComponent(`
  <body style="margin:0;background:transparent">
    <div style="position:absolute;inset:40px;border-radius:24px;
                background:rgba(255,255,255,0.35);backdrop-filter:blur(2px);
                font:600 28px system-ui;color:#111;display:flex;align-items:center;
                justify-content:center">transparent window test</div>
  </body>`)}`

app.whenReady().then(() => {
  const window = new BrowserWindow({
    width: 900,
    height: 520,
    x: 120,
    y: 120,
    frame: false,
    transparent: true,
    backgroundColor: '#00000000',
    hasShadow: false,
    alwaysOnTop: true,
    webPreferences: { sandbox: true },
  })
  void window.loadURL(page)
  console.log('transparent window up')
  setTimeout(() => { app.quit() }, 12000)
})
