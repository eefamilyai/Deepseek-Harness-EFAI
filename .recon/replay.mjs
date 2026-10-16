
import { DsmlTranslator, toolIndex } from '../packages/llm/llm-text-toolcalls/src/index.ts'
import { readFileSync } from 'node:fs'
const LT = String.fromCharCode(60), GT = String.fromCharCode(62)
const S = { type: 'string' }, B = { type: 'boolean' }, N = { type: 'number' }, A = { type: 'array', items: {} }
const sc = (name, props, req) => ({ name, description: name, parameters: { type: 'object', properties: props, required: req } })
const TOOLS = toolIndex([
  sc('kernel', { code: S, timeoutMs: N }, ['code']),
  sc('pwsh', { command: S, run_in_background: B, timeoutMs: N }, ['command']),
  sc('edit', { file_path: S, old_string: S, new_string: S }, ['file_path', 'old_string', 'new_string']),
  sc('write', { file_path: S, content: S }, ['file_path', 'content']),
  sc('read', { file_path: S, offset: N, limit: N }, ['file_path']),
  sc('job_output', { job_id: S, wait: B, timeout_ms: N }, ['job_id']),
  sc('job_kill', { job_id: S, reason: S }, ['job_id']),
  sc('todo_write', { todos: A }, ['todos']),
  sc('grep', { pattern: S, path: S, include: S }, ['pattern']),
  sc('glob', { pattern: S, path: S }, ['pattern']),
  sc('update_goal', { goal_id: S, revision: N, action: S }, ['goal_id', 'revision', 'action']),
  sc('ask_user_question', { questions: A }, ['questions']),
  sc('subagent', { description: S, prompt: S }, ['description', 'prompt']),
  sc('web_fetch', { url: S }, ['url']),
])
const cases = JSON.parse(readFileSync('.recon/spill_cases.json', 'utf8'))
const rows = []
for (const c of cases) {
  const t = c.text
  const cut = Math.min(...[t.indexOf('[unfinished tool call'), t.indexOf('[malformed tool call')].filter(i => i >= 0))
  const input = cut >= 0 ? t.slice(0, cut) : t
  const r = new DsmlTranslator(TOOLS)
  let ev = []
  try { ev = [...r.push(input), ...r.end()] } catch (e) { rows.push({ seq: c.seq, err: String(e).slice(0, 80) }); continue }
  const calls = ev.filter(e => e.kind === 'tool-call')
  const shown = ev.filter(e => e.kind === 'text').map(e => e.text).join('')
  rows.push({
    seq: c.seq,
    inputLen: input.length,
    calls: calls.length,
    names: calls.map(x => x.name).join(','),
    shapes: r.repairedShapes().join(','),
    outLen: shown.length,
    // the leak: visible text that is not just the model's own prose sentence
    leak: shown.length > 0,
    outHead: shown.slice(0, 70),
  })
}
console.log(JSON.stringify(rows))
