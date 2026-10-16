// Measure the profiles landing dialog: every button, and the scroll geometry of
// the content region. Playwright resolves from apps/web.
import { createRequire } from 'node:module'

const require = createRequire('D:/deepseek-kernel-harness/apps/web/package.json')
const { chromium } = require('playwright')

const url = process.argv[2]
const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(4000)
const report = await page.evaluate(() => {
  const dialog = document.querySelector('[role="dialog"]')
  const rows = [...document.querySelectorAll('[role="dialog"] button')].map((b) => {
    const r = b.getBoundingClientRect()
    return { text: b.textContent?.trim().slice(0, 24), top: Math.round(r.top), height: Math.round(r.height), visible: r.height > 0 }
  })
  const scroller = [...document.querySelectorAll('[role="dialog"] *')].find(el => el.scrollHeight > el.clientHeight + 4)
  return {
    dialog: dialog === null ? null : (() => { const r = dialog.getBoundingClientRect(); return { top: Math.round(r.top), height: Math.round(r.height), scrollHeight: dialog.scrollHeight, clientHeight: dialog.clientHeight } })(),
    buttons: rows,
    overflowing: scroller === undefined ? null : { tag: scroller.tagName, className: scroller.className, scrollHeight: scroller.scrollHeight, clientHeight: scroller.clientHeight },
    bodyOverflow: { scrollHeight: document.body.scrollHeight, clientHeight: document.body.clientHeight },
  }
})
console.log(JSON.stringify(report, null, 1))
await browser.close()
