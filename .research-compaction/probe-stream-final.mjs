
import { readDsmlStream, toolIndex } from 'file:///D:/deepseek-kernel-harness/packages/llm/llm-dsml/lib/types/stream.js'
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const NL = String.fromCharCode(10)
const PC = LT + SL + 'parameter' + GT, IC = LT + SL + 'invoke' + GT, TC = LT + SL + 'tool_calls' + GT

const tools = toolIndex([
  { name: 'kernel', description: 'k', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
])
const env = (b) => LT + 'tool_calls' + GT + NL + b + NL + TC
const inv = (n, s, v) => LT + 'invoke name="' + n + '"' + GT + LT + 'parameter name="' + s + '"' + GT + v + PC + IC

// The real streaming path: block-start, text-delta..., block-end, finish
async function stream(text, chunkSize) {
  const parts = []
  for (let i = 0; i < text.length; i += chunkSize) parts.push(text.slice(i, i + chunkSize))
  async function* src() {
    yield { type: 'block-start', index: 0, blockType: 'text' }
    for (const p of parts) yield { type: 'text-delta', index: 0, text: p }
    yield { type: 'block-end', index: 0, block: { type: 'text', text } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
  const calls = [], text2 = []
  for await (const c of readDsmlStream(src(), tools, {})) {
    if (c.type === 'tool-call-delta' || c.type === 'tool-call') calls.push({ n: c.name, a: c.argumentsDelta ?? c.arguments })
    if (c.type === 'text-delta') text2.push(c.text)
  }
  return { calls, text: text2.join('') }
}

const cases = [
  ['taught envelope', env(inv('kernel', 'code', 'print(1)'))],
  ['bare invoke', inv('kernel', 'code', 'print(1)')],
  ['JSON', '{"tool": "kernel", "arguments": {"code": "print(1)"}}'],
  ['python call', 'kernel(code="print(1)")'],
  ['hostile quotes', 'kernel(code="say \"hi\" twice")'],
  ['prose about a tool', 'I will use the kernel tool with code later.'],
  ['fenced example', '```' + NL + 'kernel(code="print(1)")' + NL + '```'],
  ['truncated invoke', LT + 'invoke name="kernel"' + GT + LT + 'parameter name="code"' + GT + 'print(1)'],
]
const out = []
for (const [label, text] of cases) {
  const sizes = label.includes('prose') || label.includes('fenced') || label.includes('truncated') ? [1, 3, 9999] : [1, 2, 3, 7, 9999]
  for (const s of sizes) {
    const r = await stream(text, s)
    out.push({ label, chunk: s, calls: r.calls.length, args: r.calls.map(c => c.a), leaked: r.text.includes('invoke name') })
  }
}
console.log(JSON.stringify(out))
