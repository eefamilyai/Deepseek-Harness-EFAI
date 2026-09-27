
const { createRequire } = require('node:module')
const req = createRequire(process.argv[1])
const { DsmlTranslator, toolIndex } = req(String.raw`D:\deepseek-kernel-harness\packages\llm\llm-dsml\lib\index.js`)

const KERNEL = { name: 'kernel', description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }
const READ = { name: 'read', description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const OTHER = { name: 'other', description: 'Also takes code.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }

const CASES = req(process.argv[2])

function run(text, tools) {
  const r = new DsmlTranslator(toolIndex(tools))
  const events = [...r.push(text), ...r.end()]
  return {
    calls: events.filter(e => e.kind === 'tool-call').map(e => ({ name: e.name, args: JSON.parse(e.arguments) })),
    shapes: [...r.repairedShapes()],
    text: events.filter(e => e.kind === 'text').map(e => e.text).join(''),
  }
}

const out = {}
for (const [label, text] of Object.entries(CASES)) out[label] = run(text, [KERNEL, READ])
out.negative_two_candidates = run(CASES.positive_wrapped_orphan, [KERNEL, OTHER])

const first = out.positive_wrapped_orphan.calls[0]
out.positive_payload_ok = Boolean(first)
  && String(first.args.code).includes('import os')
  && String(first.args.code).includes('print(1)')

console.log(JSON.stringify(out, null, 2))
