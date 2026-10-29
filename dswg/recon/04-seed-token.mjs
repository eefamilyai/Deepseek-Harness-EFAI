
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const token = fs.readFileSync('.recon/dsw-live/token.txt', 'utf8').trim();
const profile = path.resolve('.recon/dsw-live/profile-account');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1440, height: 900 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });
const reqs = [];
ctx.on('requestfinished', async (req) => {
  if (!req.url().includes('chat.deepseek.com/api/')) return;
  let h = {}, status = null, body = null;
  try { h = await req.allHeaders(); } catch {}
  try { const r = await req.response(); if (r) { status = r.status(); body = (await r.text()).slice(0, 1200); } } catch {}
  reqs.push({ url: req.url(), method: req.method(), headers: h, postData: (req.postData()||'').slice(0,600), status, body });
});
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(2500);
await page.evaluate((t) => { localStorage.setItem('userToken', JSON.stringify({ value: t, __version: '0' })); }, token);
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(6000);
const state = await page.evaluate(() => {
  const ls = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=String(localStorage.getItem(k)).slice(0,200);}
  return { url: location.href, ls, composer: !!document.querySelector('textarea, [contenteditable=true]') };
});
await page.screenshot({ path: '.recon/dsw-live/seeded.png' });
fs.writeFileSync('.recon/dsw-live/seeded.json', JSON.stringify({ state, reqs, cookies: await ctx.cookies() }, null, 2));
console.log(JSON.stringify({ url: state.url, composer: state.composer, userInfo: state.ls.__appKit_userInfo, reqs: reqs.map(r=>[r.status, r.method, r.url.slice(0,100), (r.body||'').slice(0,160)]) }, null, 1));
await ctx.close();
