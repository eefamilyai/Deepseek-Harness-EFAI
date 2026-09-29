/**
 * A model that cannot take native tools still acts: its refused request goes
 * out again on the text channel, and the calls it writes run.
 *
 * The refusal this answers is OpenRouter's "No endpoints found that support
 * tool use", which failed the whole turn for any model whose endpoints lack
 * tool support — every request an agent sends carries tools.
 */

import { afterEach, describe, expect, it } from 'vitest'
import { Context } from '@deepseek-ai/cordis'
import LlmRuntime, {
  LlmAdapter,
  ToolCallId,
  createMessage,
  createSystemMessage,
  createToolResultMessage,
  createUserMessage,
} from '@deepseek-ai/dsh-llm'
import type { GenerateOptions, StreamChunk, ToolSchema } from '@deepseek-ai/dsh-llm'
import * as dsmlPlugin from '../src/index.ts'
import { refusesNativeTools, renderInvoke, textChannelRequest } from '../src/index.ts'

const READ: ToolSchema = {
  name: 'read',
  description: 'Read a file.',
  parameters: { type: 'object', properties: { path: { type: 'string' } }, required: ['path'] },
}

/** OpenRouter's refusal, as the harness reported it. */
const OPENROUTER_REFUSAL = '404: {"message":"No endpoints found that support tool use. Try disabling \\"ask_user_question\\".","code":404}'

const CALL_TEXT = ['Reading it.', '<tool_calls>', '<invoke name="read">', '<parameter name="path">a.txt</parameter>', '</invoke>', '</tool_calls>', ''].join('\n')

/** A provider that refuses any request carrying tools, and answers the rest with a text call. */
class RefusesToolsAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    if (options.tools !== undefined && options.tools.length > 0) {
      yield { type: 'finish', reason: { kind: 'error', failure: { code: 'PROVIDER_ERROR', status: 404, message: OPENROUTER_REFUSAL } } }
      return
    }
    yield { type: 'block-start', index: 0, blockType: 'text' }
    yield { type: 'text-delta', index: 0, text: CALL_TEXT }
    yield { type: 'block-end', index: 0, block: { type: 'text', text: CALL_TEXT } }
    yield { type: 'finish', reason: { kind: 'stop' } }
  }
}

/** A provider that fails for an unrelated reason. */
class RateLimitedAdapter extends LlmAdapter {
  readonly requests: GenerateOptions[] = []
  async * stream(options: GenerateOptions): AsyncIterable<StreamChunk> {
    this.requests.push(options)
    yield { type: 'finish', reason: { kind: 'error', failure: { code: 'RATE_LIMITED', status: 429, message: 'Rate limit exceeded' } } }
  }
}

async function drain(stream: AsyncIterable<StreamChunk>): Promise<StreamChunk[]> {
  const chunks: StreamChunk[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const contexts: Context[] = []
afterEach(async () => {
  await Promise.all(contexts.splice(0).map(ctx => ctx.fiber.dispose()))
})

async function compose(config: dsmlPlugin.Config = {}): Promise<Context> {
  const ctx = new Context()
  contexts.push(ctx)
  await ctx.plugin(LlmRuntime)
  await ctx.plugin(dsmlPlugin, config)
  return ctx
}

/** A loop-built request: the system prompt leads the history, and one call already ran. */
function agentRequest(provider: string): GenerateOptions {
  const callId = ToolCallId('call-1')
  return {
    provider,
    model: 'free-model',
    tools: [READ],
    messages: [
      createSystemMessage('You are a coding agent.'),
      createUserMessage({ content: [{ type: 'text', text: 'read b.txt then a.txt' }], source: { kind: 'user' } }),
      createMessage({
        role: 'assistant',
        content: [{ type: 'tool-call', id: callId, name: 'read', arguments: '{"path":"b.txt"}' }],
        source: { kind: 'model', provider, model: 'free-model' },
      }),
      createToolResultMessage({ callId, content: [{ type: 'text', text: 'contents of b' }], isError: false }),
    ],
  }
}

describe('recognising a refusal', () => {
  it('knows the providers\' wording for "this model cannot take tools", and nothing else', () => {
    expect(refusesNativeTools({ code: 'X', message: OPENROUTER_REFUSAL })).toBe(true)
    expect(refusesNativeTools({ code: 'X', message: 'registry.ollama.ai/library/gemma:2b does not support tools' })).toBe(true)
    expect(refusesNativeTools({ code: 'X', message: 'This model does not support function calling' })).toBe(true)
    expect(refusesNativeTools({ code: 'X', message: 'Tool calling is not supported for this model' })).toBe(true)
    expect(refusesNativeTools({ code: 'X', message: 'Rate limit exceeded' })).toBe(false)
    expect(refusesNativeTools({ code: 'X', message: 'Invalid API key' })).toBe(false)
  })
})

describe('the text-channel request', () => {
  it('states the tools in the system prompt, renders history as text, and sends no tools field', () => {
    const request = textChannelRequest(agentRequest('openrouter'))
    expect(request.tools).toBeUndefined()
    const [system, user, assistant, result] = request.messages
    expect(system?.role).toBe('system')
    const systemText = system?.content.map(block => block.type === 'text' ? block.text : '').join('')
    expect(systemText).toContain('You are a coding agent.')
    expect(systemText).toContain('# Tools available to you')
    expect(systemText).toContain('read')
    expect(user?.role).toBe('user')
    expect(assistant?.content).toEqual([{ type: 'text', text: renderInvoke('read', '{"path":"b.txt"}') }])
    expect(result).toEqual({ role: 'user', content: [{ type: 'text', text: 'OUTPUT:\ncontents of b' }] })
  })

  it('puts the statement in `system` for a one-shot request without a system message', () => {
    const request = textChannelRequest({ provider: 'p', model: 'm', system: 'Be brief.', tools: [READ], messages: [] })
    expect(request.system).toContain('Be brief.')
    expect(request.system).toContain('# Tools available to you')
  })

  it('renders a prior call the way the model is taught to write one', () => {
    expect(renderInvoke('read', '{"path":"a<b.txt"}')).toBe(
      ['<tool_calls>', '<invoke name="read">', '<parameter name="path">a&lt;b.txt</parameter>', '</invoke>', '</tool_calls>'].join('\n'),
    )
    expect(renderInvoke('read', 'not json')).toBe('[tool call read] not json')
  })
})

describe('the fallback in the stream pass', () => {
  it('answers a refused request on the text channel and runs the call the model writes', async () => {
    const ctx = await compose()
    const adapter = new RefusesToolsAdapter()
    ctx.llm.registerAdapter(['openrouter'], adapter)

    const chunks = await drain(ctx.llm.stream(agentRequest('openrouter')))

    // The refusal never reaches the caller; a real tool call does.
    expect(chunks.some(chunk => chunk.type === 'finish' && chunk.reason.kind === 'error')).toBe(false)
    const call = chunks.find(chunk => chunk.type === 'block-end' && chunk.block.type === 'tool-call')
    expect(call?.type === 'block-end' && call.block.type === 'tool-call' && call.block.name).toBe('read')
    expect(call?.type === 'block-end' && call.block.type === 'tool-call' && JSON.parse(call.block.arguments)).toEqual({ path: 'a.txt' })
    expect(chunks.at(-1)).toEqual({ type: 'finish', reason: { kind: 'tool-calls' } })
    // One refused attempt, then one text-channel request with no tools field.
    expect(adapter.requests).toHaveLength(2)
    expect(adapter.requests[1]?.tools).toBeUndefined()
  })

  it('goes straight to the text channel for that model afterwards', async () => {
    const ctx = await compose()
    const adapter = new RefusesToolsAdapter()
    ctx.llm.registerAdapter(['openrouter'], adapter)
    await drain(ctx.llm.stream(agentRequest('openrouter')))
    await drain(ctx.llm.stream(agentRequest('openrouter')))
    expect(adapter.requests.map(request => request.tools === undefined)).toEqual([false, true, true])
  })

  it('leaves every other failure as the provider sent it', async () => {
    const ctx = await compose()
    const adapter = new RateLimitedAdapter()
    ctx.llm.registerAdapter(['limited'], adapter)
    const chunks = await drain(ctx.llm.stream(agentRequest('limited')))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error', failure: { status: 429 } } })
    expect(adapter.requests).toHaveLength(1)
  })

  it('can be switched off', async () => {
    const ctx = await compose({ textToolFallback: false })
    const adapter = new RefusesToolsAdapter()
    ctx.llm.registerAdapter(['openrouter'], adapter)
    const chunks = await drain(ctx.llm.stream(agentRequest('openrouter')))
    expect(chunks.at(-1)).toMatchObject({ type: 'finish', reason: { kind: 'error' } })
    expect(adapter.requests).toHaveLength(1)
  })
})
