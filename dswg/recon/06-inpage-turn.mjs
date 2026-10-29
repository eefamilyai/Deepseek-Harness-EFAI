
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const profile = path.resolve('.recon/dsw-live/profile-account');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1200, height: 800 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(4000);
// page is authenticated if userToken present
const result = await page.evaluate(async () => {
  const out = { steps: [] };
  const ls = (k) => { try { const raw = localStorage.getItem(k); if (!raw) return null; const v = JSON.parse(raw); return v && typeof v === 'object' && 'value' in v ? v.value : v; } catch { return localStorage.getItem(k); } };
  const token = ls('userToken');
  const deviceId = ls('deepseek-device-id:chat');
  const did = ls('__ds_remote_feature_did');
  out.identity = { tokenLen: token ? token.length : 0, deviceId, did };
  if (!token) return out;

  const tz = -new Date().getTimezoneOffset() * 60;
  const baseHeaders = () => ({
    'accept': '*/*',
    'authorization': 'Bearer ' + token,
    'x-client-bundle-id': 'com.deepseek.chat',
    'x-client-locale': 'en_US',
    'x-client-platform': 'web',
    'x-client-timezone-offset': String(tz),
    'x-client-version': '2.7.0',
    'x-device-id': deviceId,
    'x-device-model': '',
  });
  const b64 = (str) => { const bytes = new TextEncoder().encode(str); let bin = ''; for (const b of bytes) bin += String.fromCharCode(b); return btoa(bin); };

  // 1. session
  const sres = await fetch('/api/v0/chat_session/create', { method: 'POST', headers: { ...baseHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ character_id: null }) });
  const sj = await sres.json();
  const sid = sj?.data?.biz_data?.chat_session?.id || sj?.data?.biz_data?.id;
  out.steps.push(['session', sres.status, sid || JSON.stringify(sj).slice(0,200)]);
  if (!sid) return out;

  // 2. pow challenge
  const pres = await fetch('/api/v0/chat/create_pow_challenge', { method: 'POST', headers: { ...baseHeaders(), 'content-type': 'application/json' }, body: JSON.stringify({ target_path: '/api/v0/chat/completion' }) });
  const pj = await pres.json();
  const ch = pj?.data?.biz_data?.challenge;
  out.steps.push(['powchallenge', pres.status, ch ? { algorithm: ch.algorithm, difficulty: ch.difficulty, hasSalt: !!ch.salt, keys: Object.keys(ch) } : JSON.stringify(pj).slice(0,300)]);
  if (!ch) return out;

  // 3. solve with wasm
  const t0 = performance.now();
  const wasmUrl = '/static/sha3_wasm_bg.7b9ca65ddd.wasm';
  const wres = await fetch('https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm');
  const buf = await wres.arrayBuffer();
  const { instance } = await WebAssembly.instantiate(buf, {});
  const ex = instance.exports; const mem = ex.memory;
  const writeStr = (s) => { const e = new TextEncoder().encode(s); const ptr = ex.__wbindgen_export_0(e.length, 1); new Uint8Array(mem.buffer).set(e, ptr); return { ptr, length: e.length }; };
  const retptr = ex.__wbindgen_add_to_stack_pointer(-16);
  const c = writeStr(ch.challenge); const p = writeStr(ch.salt + '_' + ch.expire_at + '_');
  ex.wasm_solve(retptr, c.ptr, c.length, p.ptr, p.length, ch.difficulty);
  const status = new Int32Array(mem.buffer)[retptr / 4];
  const answer = Math.floor(new Float64Array(mem.buffer)[(retptr + 8) / 8]);
  ex.__wbindgen_add_to_stack_pointer(16);
  const powResponse = b64(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt, answer, signature: ch.signature, target_path: '/api/v0/chat/completion' }));
  out.steps.push(['powSolved', status, { answer, ms: Math.round(performance.now() - t0), len: powResponse.length }]);

  // 4. completion (WITHOUT x-hif-leim first)
  const t1 = performance.now();
  const cres = await fetch('/api/v0/chat/completion', { method: 'POST', headers: { ...baseHeaders(), 'content-type': 'application/json', 'x-ds-pow-response': powResponse }, body: JSON.stringify({ chat_session_id: sid, parent_message_id: null, model_type: 'default', prompt: 'Reply with exactly: pong2', ref_file_ids: [], thinking_enabled: false, search_enabled: false, action: null, preempt: false }) });
  out.steps.push(['completionStatus', cres.status, cres.headers.get('content-type')]);
  const reader = cres.body.getReader(); const dec = new TextDecoder(); let text = '';
  while (true) { const { done, value } = await reader.read(); if (done) break; text += dec.decode(value, { stream: true }); }
  out.steps.push(['completionDone', Math.round(performance.now() - t1), text.length]);
  out.stream = text.slice(0, 4000);
  return out;
});
fs.writeFileSync('.recon/dsw-live/inpage.json', JSON.stringify(result, null, 2));
console.log(JSON.stringify(result, null, 1).slice(0, 6000));
await ctx.close();
