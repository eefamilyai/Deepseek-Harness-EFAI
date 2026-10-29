
import { chromium } from 'playwright';
import fs from 'node:fs';
import path from 'node:path';
const profile = path.resolve('.recon/dsw-live/profile-account');
const ctx = await chromium.launchPersistentContext(profile, { channel: 'chrome', headless: false, viewport: { width: 1200, height: 800 }, locale: 'en-US', args: ['--disable-blink-features=AutomationControlled'], chromiumSandbox: true, ignoreDefaultArgs: ['--enable-automation'] });
const page = ctx.pages()[0] || await ctx.newPage();
await page.goto('https://chat.deepseek.com/', { waitUntil: 'domcontentloaded', timeout: 60000 });
await page.waitForTimeout(3500);
const out = await page.evaluate(async () => {
  const ls = (k) => { try { const r = localStorage.getItem(k); const v = JSON.parse(r); return v && typeof v === 'object' && 'value' in v ? v.value : v; } catch { return null; } };
  const token = ls('userToken'), deviceId = ls('deepseek-device-id:chat'), did = ls('__ds_remote_feature_did');
  const tz = -new Date().getTimezoneOffset() * 60;
  const H = () => ({ accept: '*/*', authorization: 'Bearer ' + token, 'x-client-bundle-id': 'com.deepseek.chat', 'x-client-locale': 'en_US', 'x-client-platform': 'web', 'x-client-timezone-offset': String(tz), 'x-client-version': '2.7.0', 'x-device-id': deviceId, 'x-device-model': '', 'content-type': 'application/json' });
  const b64 = (s) => { const b = new TextEncoder().encode(s); let x=''; for (const c of b) x += String.fromCharCode(c); return btoa(x); };
  let wasm = null;
  const solve = async () => {
    const pj = await (await fetch('/api/v0/chat/create_pow_challenge', { method:'POST', headers:H(), body: JSON.stringify({ target_path: '/api/v0/chat/completion' }) })).json();
    const ch = pj.data.biz_data.challenge;
    if (!wasm) { const buf = await (await fetch('https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm')).arrayBuffer(); wasm = (await WebAssembly.instantiate(buf, {})).instance.exports; }
    const ex = wasm, mem = ex.memory;
    const w = (s) => { const e = new TextEncoder().encode(s); const p = ex.__wbindgen_export_0(e.length, 1); new Uint8Array(mem.buffer).set(e, p); return { p, l: e.length }; };
    const rp = ex.__wbindgen_add_to_stack_pointer(-16);
    const c = w(ch.challenge), pr = w(ch.salt + '_' + ch.expire_at + '_');
    ex.wasm_solve(rp, c.p, c.l, pr.p, pr.l, ch.difficulty);
    const ans = Math.floor(new Float64Array(mem.buffer)[(rp+8)/8]);
    ex.__wbindgen_add_to_stack_pointer(16);
    return b64(JSON.stringify({ algorithm: ch.algorithm, challenge: ch.challenge, salt: ch.salt, answer: ans, signature: ch.signature, target_path: '/api/v0/chat/completion' }));
  };
  // full model catalogue
  const settings = await (await fetch('/api/v0/client/settings?did=' + encodeURIComponent(did) + '&scope=model', { headers: H() })).json();
  const models = settings.data.biz_data.settings.model_configs.value.map(m => ({ model_type: m.model_type, name: m.name, desc: m.description, default: !!m.is_default, enabled: m.enabled, input_limit: m.input_character_limit, think: m.think_feature, search: m.search_feature }));
  // one turn helper
  async function runOne(system, user) {
    const sj = await (await fetch('/api/v0/chat_session/create', { method:'POST', headers:H(), body: JSON.stringify({ character_id: null }) })).json();
    const sid = sj.data.biz_data.chat_session.id;
    const pow = await solve();
    const res = await fetch('/api/v0/chat/completion', { method:'POST', headers:{ ...H(), 'x-ds-pow-response': pow }, body: JSON.stringify({ chat_session_id: sid, parent_message_id: null, model_type: 'default', prompt: system + '\n\nUser: ' + user, ref_file_ids: [], thinking_enabled: false, search_enabled: false, action: null, preempt: false }) });
    const rd = res.body.getReader(); const dec = new TextDecoder(); let text = '';
    while (true) { const { done, value } = await rd.read(); if (done) break; text += dec.decode(value, { stream: true }); }
    return { sid, text };
  }
  const toolsDoc = 'Available tools (JSON Schema):\n' + JSON.stringify([
    { name: 'get_weather', description: 'Get current weather for a city.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
    { name: 'read_file', description: 'Read a text file from disk.', parameters: { type: 'object', properties: { path: { type: 'string' }, max_bytes: { type: 'integer' } }, required: ['path'] } },
  ], null, 1);
  const ask = 'What is the weather in Paris right now? Use the tool.';
  const results = {};
  results.json_envelope = (await runOne(
    toolsDoc + '\n\nYou have no native tool channel. To call a tool, reply with ONLY a JSON object in a <tool_call> block, e.g.\n<tool_call>{"name":"get_weather","arguments":{"city":"Paris"}}</tool_call>\nCall the tool now and nothing else.',
    ask)).text;
  results.dsml = (await runOne(
    toolsDoc + '\n\nYou have no native tool channel. To call a tool, write a tool_calls block:\n<tool_calls>\n<invoke name="get_weather">\n<parameter name="city">Paris</parameter>\n</invoke>\n</tool_calls>\nCall the tool now and nothing else.',
    ask)).text;
  results.bare = (await runOne(toolsDoc, ask)).text;
  results.fenced = (await runOne(
    toolsDoc + '\n\nTo call a tool, reply with a fenced json block containing {"name":..., "arguments":{...}}.',
    ask)).text;
  return { models, results };
});
fs.writeFileSync('.recon/dsw-live/toolformats.json', JSON.stringify(out, null, 2));
console.log("MODELS:", JSON.stringify(out.models, null, 1));
for (const [k, v] of Object.entries(out.results)) {
  const text = v.split('\n').filter(l => l.startsWith('data:') && l.includes('"v"')).map(l => { try { const o = JSON.parse(l.slice(5)); return typeof o.v === 'string' ? o.v : ''; } catch { return ''; } }).join('');
  console.log('\n===== ' + k + ' =====');
  console.log(text.slice(-900));
}
await ctx.close();
