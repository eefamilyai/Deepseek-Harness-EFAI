
const fs = require('fs'), path = require('path');
async function main() {
  const config = JSON.parse(process.argv[2]);
  let wasmPath = process.argv[3];
  if (!wasmPath) { for (const f of fs.readdirSync(__dirname)) if (f.endsWith('.wasm')) { wasmPath = path.join(__dirname, f); break; } }
  const buf = fs.readFileSync(wasmPath);
  const mod = await WebAssembly.compile(buf);
  const inst = await WebAssembly.instantiate(mod, {});
  const mem = inst.exports.memory;
  const prefix = `${config.salt}_${config.expire_at}_`;
  function w(str){ const e=Buffer.from(str,'utf-8'); const ptr=inst.exports.__wbindgen_export_0(e.length,1); const v=new Uint8Array(mem.buffer); for(let i=0;i<e.length;i++) v[ptr+i]=e[i]; return {ptr,length:e.length}; }
  const retptr = inst.exports.__wbindgen_add_to_stack_pointer(-16);
  try {
    const c = w(config.challenge), p = w(prefix);
    inst.exports.wasm_solve(retptr, c.ptr, c.length, p.ptr, p.length, config.difficulty);
    const status = new Int32Array(mem.buffer)[retptr/4];
    if (status === 0) process.exit(1);
    const answer = Math.floor(new Float64Array(mem.buffer)[(retptr+8)/8]);
    const result = { algorithm: config.algorithm, challenge: config.challenge, salt: config.salt, answer, signature: config.signature, target_path: config.target_path };
    process.stdout.write(Buffer.from(JSON.stringify(result)).toString('base64'));
  } finally { inst.exports.__wbindgen_add_to_stack_pointer(16); }
}
main().catch(e => { console.error(e.message); process.exit(1); });
