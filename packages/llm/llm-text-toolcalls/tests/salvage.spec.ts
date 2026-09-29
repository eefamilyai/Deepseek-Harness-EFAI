import { describe, expect, it } from 'vitest'
import { DsmlTranslator } from '../src/index.ts'

// Tag literals are built from character codes, the same discipline the reader
// itself follows: a literal closer written here would corrupt whatever reads
// this file next.
const LT = String.fromCharCode(60)
const GT = String.fromCharCode(62)
const SL = String.fromCharCode(47)
const open = (name: string, attrs = ''): string => LT + name + (attrs ? ' ' + attrs : '') + GT
const shut = (name: string): string => LT + SL + name + GT

const TOOLS = [
  {
    name: 'pwsh',
    description: 'Run a PowerShell command.',
    parameters: {
      type: 'object',
      properties: { command: { type: 'string' }, description: { type: 'string' } },
      required: ['command', 'description'],
    },
  },
  { name: 'get_goal', description: 'Read the goal.', parameters: { type: 'object', properties: {}, required: [] } },
  { name: 'list_agents', description: 'List agents.', parameters: { type: 'object', properties: { scope: { type: 'string' } }, required: [] } },
  { name: 'read', description: 'Read a file.', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } },
]

const INDEX = new Map(TOOLS.map(tool => [tool.name, tool]))

function run(text: string) {
  const translator = new DsmlTranslator(INDEX as never)
  return [...translator.push(text), ...translator.end()]
}

function callsOf(text: string) {
  return run(text)
    .filter(event => event.kind === 'tool-call')
    .map((event) => {
      const call = event as { name: string; arguments: string }
      return { name: call.name, args: JSON.parse(call.arguments) as Record<string, unknown> }
    })
}

const proseOf = (text: string): string =>
  run(text).filter(event => event.kind === 'text').map(event => (event as { text: string }).text).join('')

describe('structural salvage', () => {
  // The operator's pasted block: a wrapper, bare parameters, no invoke anywhere,
  // and two parameters that name tools rather than slots.
  it('runs a wrapped block whose parameters never closed and whose tools are parameters', () => {
    const block =
      open('tool_calls') + '\n' +
      open('parameter', 'name="command"') + 'Write-Host "=== parser ==="' + '\n' +
      open('parameter', 'name="description"') + 'Inspect actual workspace state' + '\n' +
      open('parameter', 'name="get_goal"') + ' ' +
      open('parameter', 'name="list_agents"') +
      shut('tool_calls')

    const calls = callsOf(block)
    expect(calls.map(call => call.name)).toEqual(['pwsh', 'get_goal', 'list_agents'])
    expect(calls[0]?.args.command).toContain('Write-Host')
    expect(calls[0]?.args.description).toContain('Inspect actual workspace state')
    expect(proseOf(block)).toBe('')
  })

  // The second pasted shape: closers present, stray invoke closers between the
  // arguments, and a nameless bare parameter inside the last call.
  it('runs a block with stray invoke closers and a bare parameter name', () => {
    const block =
      open('tool_calls') + '\n' +
      open('parameter', 'name="command"') + 'Write-Host "x"' + shut('parameter') + ' ' + shut('invoke') +
      open('parameter', 'name="description"') + 'Inspect state' + shut('parameter') +
      open('parameter', 'name="get_goal"') + shut('invoke') + ' ' +
      open('parameter', 'name="list_agents"') + ' ' +
      open('parameter', 'scope') + 'children' + shut('parameter') + ' ' +
      shut('invoke') + ' ' + shut('tool_calls')

    const calls = callsOf(block)
    expect(calls.map(call => call.name)).toEqual(['pwsh', 'get_goal', 'list_agents'])
    expect(calls[0]?.args.command).toContain('Write-Host')
    expect(calls[2]?.args.scope).toBe('children')
  })

  // Safety: a call the model only DESCRIBED must not run. The words around it
  // are what separate an explanation from a call.
  it('refuses a span whose residue reads as language', () => {
    const block =
      open('tool_calls') + '\n' +
      'You should call the read tool with the file_path argument to see the file contents.' + '\n' +
      shut('tool_calls')
    expect(callsOf(block)).toEqual([])
    expect(proseOf(block)).toContain('You should call')
  })

  // Safety: two candidate tools owning the same argument names is a coin flip
  // that RUNS something, so the whole span is refused rather than guessed at.
  it('refuses an ambiguous orphan rather than picking a tool', () => {
    const ambiguous = new Map([
      ['alpha', { name: 'alpha', description: 'a', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
      ['beta', { name: 'beta', description: 'b', parameters: { type: 'object', properties: { file_path: { type: 'string' } }, required: ['file_path'] } }],
    ])
    const block = open('tool_calls') + '\n' + open('parameter', 'name="file_path"') + 'a.txt' + shut('tool_calls')
    const translator = new DsmlTranslator(ambiguous as never)
    expect([...translator.push(block), ...translator.end()].filter(e => e.kind === 'tool-call')).toEqual([])
  })

  // A well-formed call still takes the ordinary path; salvage never sees it.
  it('leaves a canonical call to the ordinary reader', () => {
    const block =
      open('tool_calls') + '\n' +
      open('invoke', 'name="read"') + '\n' +
      open('parameter', 'name="file_path"') + 'a.txt' + shut('parameter') + '\n' +
      shut('invoke') + '\n' + shut('tool_calls')
    expect(callsOf(block)).toEqual([{ name: 'read', args: { file_path: 'a.txt' } }])
  })
  // The truncation guard. A span that could still be ONE call being written is
  // refused, because completing it would invent an argument the model never
  // finished. This is the property the whole reader is built around, and the
  // stage that keeps salvage from running half-written blocks.
  it('refuses a single unclosed argument, which is a call still being written', () => {
    const block = open('tool_calls') + '\n' + open('parameter', 'name="file_path"') + 'a.txt' + shut('tool_calls')
    expect(callsOf(block)).toEqual([])
  })

  it('refuses two unclosed arguments of one named invoke', () => {
    const block =
      open('tool_calls') + '\n' + open('invoke', 'name="read"') + '\n' +
      open('parameter', 'name="file_path"') + 'a.txt\n' +
      open('parameter', 'name="limit"') + '20' + '\n' +
      shut('invoke') + shut('tool_calls')
    expect(callsOf(block)).toEqual([])
  })

  // Two groups is what makes a span a composition rather than a single call.
  it('runs a two-call span even though neither argument closed', () => {
    const block =
      open('tool_calls') + '\n' +
      open('parameter', 'name="get_goal"') + ' ' +
      open('parameter', 'name="list_agents"') + '\n' +
      shut('tool_calls')
    expect(callsOf(block).map(call => call.name)).toEqual(['get_goal', 'list_agents'])
  })
})
