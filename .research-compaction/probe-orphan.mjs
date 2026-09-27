
import { DsmlTranslator, toolIndex } from 'file:///D:/deepseek-kernel-harness/packages/llm/llm-dsml/lib/index.js'

const TOOLS = toolIndex([{ name: 'kernel', description: 'Run Python.',
  parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } }])

const OP = '<' + '/invoke>'
const P_OPEN = '<' + 'parameter '
const P_CLOSE = '<' + '/' + 'parameter>'

const cases = {
  'wrapped orphan, no type attr':
    '<tool_calls> ' + P_OPEN + 'name="code">print(1)' + P_CLOSE + ' </tool_calls>',
  'wrapped orphan, type attr string=true':
    '<tool_calls> ' + P_OPEN + 'name="code" string="true">print(1)' + P_CLOSE + ' </tool_calls>',
  'wrapped orphan, type attr, stray closers':
    '<tool_calls> ' + P_OPEN + 'name="code" string="true">print(1)' + P_CLOSE + ' ' + OP + ' ' + P_CLOSE + ' ' + OP + ' </tool_calls>',
  'wrapped orphan, no invoke, only one stray closer':
    '<tool_calls> ' + P_OPEN + 'name="code">print(1)' + P_CLOSE + ' ' + OP + ' </tool_calls>',
  'bare orphan line, type attr':
    P_OPEN + 'name="code" string="true">print(1)' + P_CLOSE,
  'well-formed invoke with type attr':
    '<tool_calls><invoke name="kernel">' + P_OPEN + 'name="code" string="true">print(1)' + P_CLOSE + OP + '</tool_calls>',
}

for (const [label, text] of Object.entries(cases)) {
  const reader = new DsmlTranslator(TOOLS)
  const events = [...reader.push(text), ...reader.end()]
  const calls = events.filter(e => e.kind === 'tool-call')
  const visible = events.filter(e => e.kind === 'text').map(e => e.text).join('')
  console.log(JSON.stringify({
    label,
    calls: calls.map(c => ({ name: c.name, arguments: c.arguments })),
    shapes: reader.repairedShapes(),
    visibleSample: visible.slice(0, 160),
  }))
}
