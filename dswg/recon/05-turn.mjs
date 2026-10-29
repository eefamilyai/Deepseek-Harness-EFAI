
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const profile = path.resolve('.recon/dsw-live/profile-account');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1440, height: 900 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });
const reqs = [];
ctx.on('requestfinished', async (req) => {
  if (!req.url().includes('/api/v0/')) return;
  let h = {}, status = null, body = null, respHeaders = {};
  try { h = await req.allHeaders(); } catch {}
  let buf = null; try { buf = req.postDataBuffer(); } catch {}
  try { const r = await req.response(); if (r) { status = r.status(); respHeaders = await r.allHeaders(); body = (await r.text()).slice(0, 12000); } } catch {}
  reqs.push({ url: req.url(), method: req.method(), headers: h, postData: (req.postData()||'').slice(0,3000),
              postBytes: buf ? buf.length : 0, postHex: buf ? buf.subarray(0,32).toString('hex') : '',
              status, respHeaders, body });
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(5000);
const composer = page.locator('textarea').first();
await composer.click();
await composer.fill('Reply with exactly: pong');
await page.waitForTimeout(400);
await composer.press('Enter');
await page.waitForTimeout(18000);
const text = await page.evaluate(() => document.body.innerText.slice(0, 1500));
fs.writeFileSync('.recon/dsw-live/turn1.json', JSON.stringify({ reqs, text, cookies: await ctx.cookies(), ls: await page.evaluate(() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); o[k]=String(localStorage.getItem(k)).slice(0,200);} return o; }) }, null, 2));
await page.screenshot({ path: '.recon/dsw-live/turn1.png' });
console.log(JSON.stringify(reqs.map(r => ({ m: r.method, u: r.url.slice(0,90), s: r.status, bytes: r.postBytes, enc: !!r.headers['x-request-encryption-key'], bodyLen: (r.body||'').length, start: (r.body||'').slice(0,120) })), null, 1));
console.log("PAGE TEXT:", text.slice(0, 400));
await ctx.close();
