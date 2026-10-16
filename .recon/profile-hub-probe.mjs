// Probe one dsh host page with a real browser: dump every console message and
// page error, then screenshot. Playwright resolves from apps/web (the repo's
// only installed copy).
import { createRequire } from 'node:module'
import { writeFileSync } from 'node:fs'

const require = createRequire('D:/deepseek-kernel-harness/apps/web/package.json')
const { chromium } = require('playwright')

const url = process.argv[2]
const shot = process.argv[3] ?? 'D:/deepseek-kernel-harness/.recon/probe.png'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const lines = []
page.on('console', (message) => { lines.push(`[console:${message.type()}] ${message.text()}`) })
page.on('pageerror', (error) => { lines.push(`[pageerror] ${error.message}\n${error.stack ?? ''}`) })
page.on('requestfailed', (request) => { lines.push(`[requestfailed] ${request.url()} ${request.failure()?.errorText ?? ''}`) })
page.on('response', (response) => {
  if (response.status() >= 400) lines.push(`[http ${response.status()}] ${response.url()}`)
})
await page.goto(url, { waitUntil: 'networkidle', timeout: 60000 }).catch((error) => { lines.push(`[goto] ${error.message}`) })
await page.waitForTimeout(2500)
await page.screenshot({ path: shot, fullPage: false })
const text = await page.evaluate(() => document.body.innerText.slice(0, 4000))
writeFileSync(`${shot}.log.txt`, `${lines.join('\n')}\n\n===== BODY TEXT =====\n${text}\n`)
console.log(lines.join('\n'))
console.log('===== BODY TEXT =====')
console.log(text)
await browser.close()
