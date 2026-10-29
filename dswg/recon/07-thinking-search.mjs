
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const profile = path.resolve('.recon/dsw-live/profile-account');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1200, height: 800 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3000);
const out = await page.evaluate(async (cfg) => {
  const ls = (k) => { try { const raw = localStorage.getItem(k); const v = JSON.parse(raw); return v && typeof v === 'object' && 'value' in v ? v.value : v; } catch { return null; } };
  const token = ls('userToken'), deviceId = ls('deepseek-device-id:chat');
  const tz = -new Date().getTimezoneOffset() * 60;
  const H = () => ({ 'accept': '*/*', 'authorization': 'Bearer ' + token, 'x-client-bundle-id': 'com.deepseek.chat', 'x-client-locale': 'en_US', 'x-client-platform': 'web', 'x-client-timezone-offset': String(tz), 'x-client-version': '2.7.0', 'x-device-id': deviceId, 'x-device-model': '', 'content-type': 'application/json' });
  const b64 = (s) => { const b = new TextEncoder().encode(s); let x = ''; for (const c of b) x += String.fromCharCode(c); return btoa(x); };
  let wasm = null;
  async function solvePow() {
    const pj = await (await fetch('/api/v0/chat/create_pow_challenge', { method: 'POST', headers: H(), body: JSON.stringify({ target_path: '/api/v0/chat/completion' }) })).json();
    const ch = pj.data.biz_data.challenge;
    if (!wasm) { const buf = await (await fetch('https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm')).arrayBuffer(); wasm = (await WebAssembly.instantiate(buf, {})).instance.exports; }
    const ex = wasm, mem = ex.memory;
    const w = (s) => { const e = new TextEncoder().encode(s); const ptr = ex.__wbindgen_export_0(e.length, 1); new Uint8Array(mem.buffer).set(e, ptr); return { ptr, length: e.length }; };
    const rp = ex.__wbindgen_add_to_stack_pointer(-16);
    const c = w(ch.challenge), p = w(ch.salt + '_' + ch.expire_at + '_');
    ex.wasm_solve(rp, c.ptr, c.length, p.ptr, p.length, ch.difficulty);
    const ans = Math.floor(new Float64Array(mem.buffer)[(rp + 8) / 8]);
    ex.__wbindgen_add_to_stack_pointer(16);
    return b64(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt, answer: ans, signature: ch.signature, target_path: '/api/v0/chat/completion' }));
  }
  const sj = await (await fetch('/api/v0/chat_session/create', { method: 'POST', headers: H(), body: JSON.stringify({ character_id: null }) })).json();
  const sid = sj.data.biz_data.chat_session.id;
  const events = [];
  async function turn(prompt, thinking, search, parent) {
    const pow = await solvePow();
    const res = await fetch('/api/v0/chat/completion', { method: 'POST', headers: { ...H(), 'x-ds-pow-response': pow }, body: JSON.stringify({ chat_session_id: sid, parent_message_id: parent, model_type: thinking ? 'expert' : 'default', prompt, ref_file_ids: [], thinking_enabled: thinking, search_enabled: search, action: null, preempt: false }) });
    const reader = res.body.getReader(); const dec = new TextDecoder(); let text = ''; const t0 = performance.now();
    while (true) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    return { ms: Math.round(performance.now() - t0), text };
  }
  const a = await turn('What is 17*23? Think it through.', true, false, null);
  events.push(['thinking', a.ms, a.text.length, a.text.slice(0, 2500)]);
  const m = /"response_message_id":(\d+)/.exec(a.text);
  const rid = m ? Number(m[1]) : null;
  const b = await turn('Latest news about the moon landing anniversary?', false, true, rid);
  events.push(['search', rid, b.ms, b.text.length, b.text.slice(0, 3500)]);
  const hist = await fetch('/api/v0/chat/history_messages?chat_session_id=' + sid, { headers: H() });
  const htxt = await hist.text();
  events.push(['history', hist.status, htxt.slice(0, 1500)]);
  return { sid, events };
}, {});
fs.writeFileSync('.recon/dsw-live/turns2.json', JSON.stringify(out, null, 2));
for (const e of out.events) { console.log("\n#####", e[0], e.slice(1,4)); console.log(String(e[4]).slice(0,2500)); }
await ctx.close();
