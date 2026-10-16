// Click Enter on one profile row and report where the browser ends up.
import { createRequire } from 'node:module'

const require = createRequire('D:/deepseek-kernel-harness/apps/web/package.json')
const { chromium } = require('playwright')

const url = process.argv[2]
const target = process.argv[3] ?? 'school'
const shot = process.argv[4] ?? 'D:/deepseek-kernel-harness/.recon/profile-hub-entered.png'

const browser = await chromium.launch()
const page = await browser.newPage({ viewport: { width: 1440, height: 900 } })
const errors = []
page.on('pageerror', (error) => { errors.push(`[pageerror] ${error.message.split('\n')[0]}`) })
page.on('console', (message) => { if (message.type() === 'error') errors.push(`[console] ${message.text().split('\n')[0]}`) })
await page.goto(url, { waitUntil: 'domcontentloaded', timeout: 60000 })
await page.waitForTimeout(4000)

// The row whose slug matches the target, then its Enter button: walk up from
// the slug element to the first ancestor that holds an Enter button, so the
// create form's own text cannot be mistaken for a row.
const clicked = await page.evaluate((name) => {
  const slug = [...document.querySelectorAll('[role="dialog"] span')]
    .find(span => span.textContent?.trim() === name)
  if (slug === undefined || slug === null) return 'no slug'
  let node = slug.parentElement
  while (node !== null && [...node.querySelectorAll('button')].every(b => b.textContent?.trim() !== 'Enter')) {
    node = node.parentElement
  }
  if (node === null) return 'no row'
  const button = [...node.querySelectorAll('button')].find(b => b.textContent?.trim() === 'Enter')
  if (button === undefined) return 'no enter'
  button.click()
  return 'clicked'
}, target)
console.log(`Enter on ${target}: ${clicked}`)

await page.waitForTimeout(45000)
console.log('final url:', page.url())
await page.screenshot({ path: shot })
const text = await page.evaluate(() => document.body.innerText.slice(0, 1200))
console.log('===== BODY TEXT =====')
console.log(text)
if (errors.length > 0) { console.log('===== ERRORS ====='); console.log(errors.slice(0, 8).join('\n')) }
await browser.close()
