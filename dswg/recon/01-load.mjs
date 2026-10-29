
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';

const OUT = path.resolve('.recon/dsw-live');
fs.mkdirSync(OUT, { recursive: true });
const stamp = new Date().toISOString().replace(/[:.]/g, '-');
const profile = path.resolve('.recon/dsw-live/profile-probe1');

const ctx = await chromium.launchPersistentContext(profile, {
  channel: 'chrome',
  headless: false,
  viewport: { width: 1440, height: 900 },
  locale: 'en-US',
  args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'],
});

const records = [];
ctx.on('requestfinished', async (req) => {
  const u = req.url();
  if (!u.includes('deepseek.com')) return;
  const r = req.postData() || '';
  let headers = {};
  try { headers = await req.allHeaders(); } catch {}
  let status = null, respHeaders = {};
  try { const resp = await req.response(); if (resp) { status = resp.status(); respHeaders = await resp.allHeaders(); } } catch {}
  records.push({ url: u, method: req.method(), headers, postData: r.slice(0, 4000), status, respHeaders });
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(9000);

const info = await page.evaluate(() => {
  const ls = {};
  for (let i = 0; i < localStorage.length; i++) { const k = localStorage.key(i); ls[k] = String(localStorage.getItem(k)).slice(0, 400); }
  const ss = {};
  for (let i = 0; i < sessionStorage.length; i++) { const k = sessionStorage.key(i); ss[k] = String(sessionStorage.getItem(k)).slice(0, 400); }
  return { ua: navigator.userAgent, platform: navigator.platform, href: location.href, title: document.title, ls, ss, cookie: document.cookie.slice(0, 2000) };
});
const cookies = await ctx.cookies();
const file = path.join(OUT, `load-${stamp}.json`);
fs.writeFileSync(file, JSON.stringify({ info, cookies, records }, null, 2));
await page.screenshot({ path: path.join(OUT, `load-${stamp}.png`), fullPage: false });
console.log(JSON.stringify({ file, ua: info.ua, title: info.title, href: info.href, nreq: records.length, lsKeys: Object.keys(info.ls), cookieNames: cookies.map(c => c.name) }, null, 2));
await ctx.close();
