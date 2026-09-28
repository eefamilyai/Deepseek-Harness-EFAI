// Feed the operator's exact malformed blocks through the BUILT llm-dsml reader.
const C = String.fromCharCode
const LT = C(60), GT = C(62), SL = C(47)
const open = (n) => LT + n + GT
const close = (n) => LT + SL + n + GT
const param = (attrs, value) => open('parameter ' + attrs) + value + close('parameter')
const invoke = (attrs) => open('invoke ' + attrs)

const T = (name, props, required) => [name, {
  name,
  description: name,
  parameters: { type: 'object', properties: props, required },
}]
const STR = { type: 'string' }
const NUM = { type: 'number' }
const BOOL = { type: 'boolean' }

const tools = new Map([
  T('read', { file_path: STR, offset: NUM, limit: NUM }, ['file_path']),
  T('edit', { file_path: STR, old_string: STR, new_string: STR }, ['file_path', 'old_string', 'new_string']),
  T('write', { file_path: STR, content: STR }, ['file_path', 'content']),
  T('glob', { pattern: STR }, ['pattern']),
  T('grep', { pattern: STR, path: STR, include: STR }, ['pattern']),
  T('browser', { action: STR, url: STR, ref: NUM, text: STR, key: STR }, ['action']),
  T('job_output', { job_id: STR, wait: BOOL, timeout_ms: NUM }, ['job_id']),
  T('kernel', { code: STR }, ['code']),
])

// A: bare parameters at block scope, no invoke anywhere (the wrapped orphan).
const A = [
  open('tool_calls'),
  param('name="file_path"', 'D:\\repo\\AccountsSection.tsx'),
  param('name="offset"', '630'),
  param('name="limit"', '70'),
  close('tool_calls'),
].join('\n') + '\n'

// B: the operator's mixed block -- bare params closed by </invoke>, then a REAL
// invoke, then a doubled closer.
const B = [
  open('tool_calls'),
  param('name="job_id"', 'pwsh-46'),
  param('name="timeout_ms"', '600000'),
  open('parameter name="wait"') + 'true' + close('invoke'),
  close('invoke'),
  invoke('name="browser"'),
  open('parameter name="action"') + 'read' + close('invoke'),
  close('invoke'),
  close('tool_calls'),
].join('\n') + '\n'

// C: an exploded value -- unrecoverable, must stay refused.
const C_ = [
  open('tool_calls'),
  invoke('name="pwsh"'),
  param('name="command"', "Set-Location 'D:\\repo'\nd\ne\nf\n"),
  invoke('name="glob"'),
  param('name="pattern"', 'src/*.tsx'),
  close('tool_calls'),
].join('\n') + '\n'

// D: shape B without the interleaved real invoke -- the pure closer-bounded run.
const D = [
  open('tool_calls'),
  param('name="job_id"', 'pwsh-46'),
  param('name="timeout_ms"', '600000'),
  open('parameter name="wait"') + 'true' + close('invoke'),
  close('invoke'),
  close('tool_calls'),
].join('\n') + '\n'

// E: control -- a clean two-invoke block.
const E = [
  open('tool_calls'),
  invoke('name="read"'),
  param('name="file_path"', 'a.txt'),
  close('invoke'),
  invoke('name="glob"'),
  param('name="pattern"', '*.ts'),
  close('invoke'),
  close('tool_calls'),
].join('\n') + '\n'

const mod = await import('../packages/llm/llm-dsml/lib/index.js')
const Translator = mod.DsmlTranslator
for (const [label, text] of Object.entries({ A, B, C: C_, D, E })) {
  const t = new Translator(tools)
  const events = [...t.push(text), ...t.end()]
  console.log('===', label)
  for (const event of events) {
    if (event.kind === 'tool-call') console.log('  CALL', event.name, event.arguments)
    else console.log('  TEXT', JSON.stringify(event.text))
  }
}
