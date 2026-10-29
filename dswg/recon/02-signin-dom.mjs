
import { chromium } from 'playwright';
import path from 'node:path';
const profile = path.resolve('.recon/dsw-live/profile-probe1');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1440, height: 900 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/sign_in', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
const dom = await page.evaluate(() => {
  const els = [...document.querySelectorAll('input,button,a,textarea,[role=button],.ds-button')];
  return els.slice(0, 60).map(e => ({ tag: e.tagName, type: e.getAttribute('type'), name: e.getAttribute('name'), id: e.id, cls: e.className?.toString().slice(0,80), ph: e.getAttribute('placeholder'), txt: (e.innerText||'').slice(0,60), aria: e.getAttribute('aria-label') }));
});
console.log(JSON.stringify(dom, null, 1));
await page.screenshot({ path: '.recon/dsw-live/signin.png' });
await ctx.close();
