
const lib = await import('file:///D:/deepseek-kernel-harness/packages/llm/llm-dsml/lib/index.js')
const { DsmlTranslator, toolIndex } = lib
const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const P_OPEN = LT + 'parameter', P_CLOSE = LT + SL + 'parameter' + GT
const I_OPEN = LT + 'invoke', I_CLOSE = LT + SL + 'invoke' + GT
const T_OPEN = LT + 'tool_calls' + GT, T_CLOSE = LT + SL + 'tool_calls' + GT

const tools = toolIndex([
  { name: 'kernel', description: 'Run Python.', parameters: { type: 'object', properties: { code: { type: 'string' } }, required: ['code'] } },
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] } },
])

const BODY = '# Trace instruction end-to-end: compactNow impl, lib freshness, host wiring\nprint(1)'

const cases = {
  'A  operator exact: wrapped orphan, type attr, flat, surplus closers':
    T_OPEN + ' ' + P_OPEN + ' name="code" string="true"' + GT + BODY + P_CLOSE + ' ' + I_CLOSE + ' ' + P_CLOSE + ' ' + I_CLOSE + ' ' + T_CLOSE,
  'B  wrapped orphan, type attr, multiline, own closers':
    T_OPEN + '\n' + P_OPEN + ' name="code" string="true"' + GT + BODY + P_CLOSE + '\n' + T_CLOSE,
  'C  wrapped orphan, NO type attr':
    T_OPEN + ' ' + P_OPEN + ' name="code"' + GT + BODY + P_CLOSE + ' ' + T_CLOSE,
  'D  wrapped orphan, two candidates (must refuse)':
    T_OPEN + ' ' + P_OPEN + ' name="path"' + GT + 'a.txt' + P_CLOSE + ' ' + T_CLOSE,
  'E  wrapped orphan, truncated arg (must refuse)':
    T_OPEN + ' ' + P_OPEN + ' name="code" string="true"' + GT + BODY + ' ' + T_CLOSE,
  'F  prose only (must refuse)':
    'I will run the kernel tool in a moment.',
  'G  well-formed invoke control':
    T_OPEN + I_OPEN + ' name="kernel"' + GT + P_OPEN + ' name="code"' + GT + 'print(1)' + P_CLOSE + I_CLOSE + T_CLOSE,
}

const out = []
for (const [label, text] of Object.entries(cases)) {
  const t = new DsmlTranslator(tools)
  const events = [...t.push(text), ...t.end()]
  const calls = events.filter(e => e.kind === 'tool-call')
  const visible = events.filter(e => e.kind === 'text').map(e => e.text).join('')
  out.push({
    label,
    calls: calls.length,
    name: calls[0]?.name ?? null,
    argsOk: calls[0] ? (() => { try { return JSON.parse(calls[0].arguments).code?.startsWith('# Trace') ?? false } catch { return false } })() : false,
    shapes: [...t.repairedShapes()],
    visible: visible.replace(/\s+/g, ' ').trim().slice(0, 120),
  })
}
console.log(JSON.stringify(out, null, 1))
