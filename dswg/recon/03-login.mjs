
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const creds = JSON.parse(fs.readFileSync('.recon/dsw-live/creds.json', 'utf8'));
const profile = path.resolve('.recon/dsw-live/profile-account');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1440, height: 900 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });

const reqs = [];
ctx.on('requestfinished', async (req) => {
  if (!req.url().includes('chat.deepseek.com/api/')) return;
  let h = {}; try { h = await req.allHeaders(); } catch {}
  let status = null, body = null;
  try { const r = await req.response(); if (r) { status = r.status(); body = (await r.text()).slice(0, 3000); } } catch {}
  reqs.push({ url: req.url(), method: req.method(), headers: h, postData: (req.postData()||'').slice(0,2000), status, body });
});

const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/sign_in', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
await page.fill('input[placeholder="Phone number / email address"]', creds.email);
await page.fill('input[type=password]', creds.password);
await page.waitForTimeout(600);
await page.getByText('Log in', { exact: true }).first().click();
await page.waitForTimeout(9000);
const state = await page.evaluate(() => {
  const ls = {}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i); ls[k]=String(localStorage.getItem(k)).slice(0,300);}
  return { url: location.href, ls };
});
const cookies = await ctx.cookies();
const dom = await page.evaluate(() => ({ textarea: [...document.querySelectorAll('textarea')].map(e=>({ph:e.placeholder, cls:e.className})), contenteditable: [...document.querySelectorAll('[contenteditable=true]')].map(e=>({cls:e.className?.toString().slice(0,80)})) }));
fs.writeFileSync('.recon/dsw-live/login.json', JSON.stringify({ state, cookies, reqs, dom }, null, 2));
await page.screenshot({ path: '.recon/dsw-live/after-login.png' });
console.log(JSON.stringify({ url: state.url, userTokenLen: (state.ls.userToken||'').length, appUserInfo: (state.ls.__appKit_userInfo||'').slice(0,200), reqs: reqs.map(r=>[r.status,r.method,r.url.slice(0,110)]), dom }, null, 1));
await ctx.close();
