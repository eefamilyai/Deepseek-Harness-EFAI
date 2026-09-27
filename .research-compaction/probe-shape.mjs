
const lib = await import('file:///D:/deepseek-kernel-harness/packages/llm/llm-dsml/lib/index.js')
const { DsmlTranslator, toolIndex } = lib
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const OP = LT + 'parameter', PC = LT + SL + 'parameter' + GT
const OI = LT + 'invoke', IC = LT + SL + 'invoke' + GT
const OTC = LT + 'tool_calls' + GT, CTC = LT + SL + 'tool_calls' + GT

const KERNEL = { name: 'kernel', description: 'Run Python',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }
const READ = { name: 'read', description: 'Read a file',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } }
const tools = toolIndex([KERNEL, READ])

const cases = {
  'A flattened: tool_calls + bare parameter + surplus closers':
    OTC + ' ' + OP + ' name="code" string="true"' + GT + '# a script' + ' ' + PC + ' ' + IC + ' ' + PC + ' ' + IC + ' ' + CTC,
  'B two bare parameters, each followed by a stray invoke closer':
    OTC + '\n' + OP + ' name="code" string="true"' + GT + '# one' + PC + IC + '\n'
      + OP + ' name="code" string="true"' + GT + '# two' + PC + IC + '\n' + CTC,
  'C bare parameter, no wrapper (orphan-parameter)':
    OP + ' name="path"' + GT + 'a.txt' + PC,
  'D proper invoke (control)':
    OI + ' name="read"' + GT + OP + ' name="path"' + GT + 'a.txt' + PC + IC,
  'E bare parameter, NO closer at all, one line':
    OP + ' name="code"' + GT + '# body',
}
for (const [label, text] of Object.entries(cases)) {
  const t = new DsmlTranslator(tools)
  const events = [...t.push(text + '\n'), ...t.end()]
  const calls = events.filter(e => e.kind === 'tool-call').map(e => [e.name, e.arguments])
  const texts = events.filter(e => e.kind === 'text').map(e => e.text.slice(0, 200))
  console.log('--- ' + label)
  console.log('    calls:', JSON.stringify(calls))
  console.log('    shapes:', JSON.stringify([...t.repairedShapes()]))
  if (texts.length) console.log('    text:', JSON.stringify(texts))
}
