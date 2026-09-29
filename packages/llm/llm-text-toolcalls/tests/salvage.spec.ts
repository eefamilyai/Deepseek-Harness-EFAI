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
  {
    name: 'kernel',
    description: 'Run Python.',
    parameters: { type: 'object', properties: { code: { type: 'string' }, timeout_ms: { type: 'integer' } }, required: ['code'] },
  },
  {
    name: 'subagent',
    description: 'Delegate a task.',
    parameters: { type: 'object', properties: { description: { type: 'string' }, prompt: { type: 'string' } }, required: ['description', 'prompt'] },
  },
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

  // The pasted shape that carries TWO tools and a stray invoke closer between
  // them: kernel's own arguments first, then the closer, then subagent's. The
  // closer is read as the group boundary it plainly is, so the run splits where
  // the model meant it to rather than inside an argument.
  it('splits a two-tool span at the stray invoke closer between their arguments', () => {
    const block =
      open('tool_calls') + ' ' +
      open('parameter', 'name="code"') + '# Verify parser modules\nimport py_compile' + shut('parameter') + ' ' +
      open('parameter', 'name="timeout_ms"') + '120000' + shut('parameter') + ' ' +
      shut('invoke') + ' ' +
      open('parameter', 'name="description"') + 'Port DSML reader from TypeScript reference to Python' + shut('parameter') + ' ' +
      open('parameter', 'name="prompt"') + 'You are porting a TypeScript module to Python.' + shut('parameter')

    const calls = callsOf(block)
    expect(calls.map(call => call.name)).toEqual(['kernel', 'subagent'])
    expect(calls[0]?.args.code).toContain('py_compile')
    expect(calls[0]?.args.timeout_ms).toBe(120000)
    expect(calls[1]?.args.description).toContain('Port DSML reader')
    expect(calls[1]?.args.prompt).toContain('porting a TypeScript module')
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


// The three shapes the operator pasted, plus the pipe-frame leak. Each case is
// built from character codes: this file must never carry a literal closer in its
// own source, because the reader under test is what has to survive one.
describe('the operator\'s shapes and the pipe-frame leak', () => {
  const PIPE = String.fromCharCode(0xFF5C)
  const RUN = PIPE + PIPE

  // Three invokes back to back where every argument is closed by the INVOKE
  // closer rather than its own. Nothing in the text distinguishes one such call
  // from a truncation, so the evidence is the GROUP COUNT: three whole groups is
  // a sequence the model finished composing.
  it('runs three invokes whose arguments all end at the invoke closer', () => {
    const block =
      open('tool_calls') + '\n' +
      open('invoke', 'name="read"') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'D:/a.ts\n' +
                  shut('invoke') + '\n' +
      open('invoke', 'name="read"') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'D:/b.ts\n' +
                  shut('invoke') + '\n' +
      open('invoke', 'name="read"') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'D:/c.ts\n' +
      shut('invoke') + '\n' +
      shut('tool_calls')
    expect(callsOf(block).map(call => call.name)).toEqual(['read', 'read', 'read'])
  })

  // One invoke, its one argument never closed, and the block ends. Nothing says
  // whether the model finished or the stream stopped, so it is refused.
  it('refuses a single invoke whose only argument never closed', () => {
    const block =
      open('tool_calls') + '\n' +
      open('invoke', 'name="read"') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'D:/x.ts\n' +
      shut('invoke') + '\n' +
      shut('tool_calls')
    expect(callsOf(block)).toEqual([])
  })

  // An invented wrapper and invented tag names. Nothing in the roster declares
  // them, so nothing runs -- but they are shown as written, not as wire protocol.
  it('refuses invented tag vocabulary without leaking a pipe token', () => {
    const block =
      open('batch') + '\n' + open('op') + '\n' + open('slot') + '\n' + 'D:/x.ts\n' +
      shut('slot') + '\n' + shut('op') + '\n' + shut('batch')
    expect(callsOf(block)).toEqual([])
    expect(proseOf(block)).toContain('D:/x.ts')
  })

  // A pipe-wrapped frame with no angle brackets is wire protocol, not text the
  // model chose to write. It carries nothing, so it is dropped wherever it
  // appears -- in a sentence, and inside a fence.
  it('drops a bare pipe-wrapped frame in prose and inside a fence', () => {
    const block =
      'here is a token ' + RUN + 'DSML' + RUN + ' and a closer\n' +
      '```\n' + RUN + 'DSML' + RUN + '\n```\n'
    expect(callsOf(block)).toEqual([])
    expect(proseOf(block)).not.toContain(PIPE)
  })
})

// Every shape here reaches the refusal path, and the ONE thing that must hold on
// that path is that the user never sees wire protocol. The three refusals differ
// in WHY they refuse -- a truncation, a wrapper closer landing on the last
// argument, and an explanation between two calls -- and one shape dispatches.
// A refusal is not a licence to show tags: the note that follows names the
// mistake in words, and the framing is stripped before anything is displayed.
describe('a refused block never shows its framing', () => {
  // The wrapper closer lands straight on the last argument, so there is no
  // boundary after it. Byte for byte this is what a truncation looks like, and
  // nothing in the text says the model finished, so it is refused.
  it('refuses a wrapper closer that ends the last argument', () => {
    const block =
      open('tool_calls') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'a.py\n' +
                  shut('invoke') + '\n' +
      open('parameter', 'name="offset"') + '\n' + '370\n' +
                  shut('invoke') + '\n' +
      open('parameter', 'name="limit"') + '\n' + '40\n' +
      shut('tool_calls')
    expect(callsOf(block)).toEqual([])
    const prose = proseOf(block)
    expect(prose).not.toContain('tool_calls')
    expect(prose).not.toContain('parameter')
    expect(prose).not.toContain('invoke')
  })

  // The stream simply stopped mid-argument. Same reading, same refusal.
  it('refuses a block truncated mid-argument and shows none of its tags', () => {
    const block =
      open('tool_calls') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'a.py\n' +
                  shut('invoke') + '\n' +
      open('parameter', 'name="offset"') + '\n' + '3'
    expect(callsOf(block)).toEqual([])
    const prose = proseOf(block)
    expect(prose).not.toContain('tool_calls')
    expect(prose).not.toContain('parameter')
  })

  // An explanation between two calls. The span carries language, so it is an
  // explanation rather than a composition, and running the call it describes
  // would be the one outcome worse than refusing it. The sentence the model
  // wrote survives; the framing around it does not.
  it('refuses a span carrying an explanation, keeping the sentence and dropping the tags', () => {
    const block =
      open('tool_calls') + '\n' +
      open('parameter', 'name="file_path"') + '\n' + 'a.py\n' +
                  shut('invoke') + '\n' +
      'Edited files and verifying before continuing.' + '\n' +
      open('parameter', 'name="limit"') + '\n' + '40\n' +
      shut('tool_calls')
    expect(callsOf(block)).toEqual([])
    const prose = proseOf(block)
    expect(prose).toContain('Edited files and verifying before continuing.')
    expect(prose).not.toContain('tool_calls')
    expect(prose).not.toContain('parameter')
  })
})

// A wrapper word inside a sentence is a mention, not a delimiter. Reading it as
// one opened a block that never closed, swallowed the rest of the line, and
// handed the sentence back with the tag cut out of it -- the user's prose
// rewritten by the reader that exists to protect it.
describe('a wrapper mentioned inside a sentence is prose', () => {
  it('leaves a mid-line wrapper mention exactly as written', () => {
    const sentence = 'The harness reads a ' + open('tool_calls') + ' block. Nothing else runs.'
    expect(proseOf(sentence + '\n')).toBe(sentence + '\n')
    expect(callsOf(sentence + '\n')).toEqual([])
  })

  it('leaves any mid-line tag mention exactly as written', () => {
    const sentence = 'The harness reads a ' + open('widget') + ' block. Nothing else runs.'
    expect(proseOf(sentence + '\n')).toBe(sentence + '\n')
  })
})
