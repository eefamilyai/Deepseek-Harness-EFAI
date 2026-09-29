
// Probe the BUILT reader lib against the operator's own pasted malformed blocks.
// Tag literals are assembled from char codes so this file never contains one.
import { DsmlTranslator, toolIndex } from 'file:///D:/deepseek-kernel-harness/packages/llm/llm-text-toolcalls/lib/index.js'

const LT = String.fromCharCode(60), GT = String.fromCharCode(62), SL = String.fromCharCode(47)
const P = 'parameter', I = 'invoke', TC = 'tool_calls'
const op = (n, a) => LT + n + (a ? ' ' + a : '') + GT
const cl = n => LT + SL + n + GT
const par = (name, value) => op(P, 'name="' + name + '"') + '\n' + value + '\n' + cl(P)
const inv = (name, body) => op(I, 'name="' + name + '"') + '\n' + body + '\n' + cl(I)

const T = (name, props, req) => ({ name, description: name, parameters: { type: 'object', properties: props, required: req } })
const TOOLS = [
  T('pwsh', { command: { type: 'string' }, description: { type: 'string' } }, ['command', 'description']),
  T('kernel', { code: { type: 'string' }, timeoutMs: { type: 'integer' } }, ['code']),
  T('subagent', { description: { type: 'string' }, prompt: { type: 'string' } }, ['description', 'prompt']),
  T('get_goal', {}, []),
  T('list_agents', { scope: { type: 'string' } }, []),
  T('read', { file_path: { type: 'string' } }, ['file_path']),
  T('web_search', { queries: { type: 'array' } }, ['queries']),
]

const CMD_A = 'Write-Host "=== parser ==="\nGet-ChildItem \'D:\\Vyntra\\vyntra\\parser\' -File | Select-Object Name,Length,LastWriteTime'
const CMD_B = 'Write-Host "=== parser dir ==="\nGet-ChildItem \'D:\\Vyntra\\vyntra\\parser\' -File'
const CODE_C = '# Verify parser modules\nimport py_compile\nfor f in ("protocol", "shapes", "catalog"):\n    print(f)'

const SHAPES = [
  ['A1 no-closer, tools-as-params (flush path)', [
    op(TC), par('command', CMD_A), par('description', 'Inspect actual workspace state'), '',
    op(P, 'name="get_goal"') + ' ' + op(P, 'name="list_agents"'),
  ].join('\n')],
  ['A2 same, envelope closed', [
    op(TC), par('command', CMD_A), par('description', 'Inspect actual workspace state'), '',
    op(P, 'name="get_goal"') + ' ' + op(P, 'name="list_agents"'), cl(TC),
  ].join('\n')],
  ['B stray invoke closers + bare scope param', [
    op(TC), par('command', CMD_B), par('description', 'Inspect current Vyntra workspace state'),
    cl(I), par('get_goal', ''), cl(I), op(P, 'name="list_agents"') + '\n' + par('scope', 'children'),
    cl(TC),
  ].join('\n')],
  ['C mixed kernel+subagent, stray closer', [
    op(TC), par('code', CODE_C), par('timeout_ms', '120000'), cl(I),
    par('description', 'Port DSML reader from TypeScript reference to Python'),
    par('prompt', 'You are porting a TypeScript module to Python for a project called Vyntra.'),
    cl(TC),
  ].join('\n')],
  ['D wrapped orphan, no invoke at all', [op(TC), par('code', CODE_C), cl(TC)].join('\n')],
  ['N1 single truncated invoke', [op(TC), op(I, 'name="read"'), op(P, 'name="file_path"'), 'a.txt'].join('\n')],
  ['N2 prose describing a call', 'You should call the read tool with a file_path argument of a.txt.'],
  ['N3 fenced example', 'Here is the format:\n\n```\n' + inv('read', par('file_path', 'a.txt')) + '\n```\n'],
  ['N4 canonical call (control)', [op(TC), inv('read', par('file_path', 'a.txt')), cl(TC)].join('\n')],
]

let dispatched = 0, refused = 0
for (const [label, text] of SHAPES) {
  const t = new DsmlTranslator(toolIndex(TOOLS))
  const events = [...t.push(text), ...t.end()]
  const calls = events.filter(e => e.kind === 'tool-call')
  const prose = events.filter(e => e.kind === 'text').map(e => e.text).join('')
  if (calls.length) dispatched++; else refused++
  console.log(`${calls.length ? 'DISPATCH' : 'REFUSE  '} ${label.padEnd(42)} n=${calls.length}`)
  for (const c of calls) console.log(`           -> ${c.name} ${JSON.stringify(c.arguments)}`)
  if (!calls.length && prose) console.log(`           PROSE: ${JSON.stringify(prose.slice(0, 160))}`)
}
console.log(`\nsummary: ${dispatched} dispatched, ${refused} refused, ${SHAPES.length} total`)
