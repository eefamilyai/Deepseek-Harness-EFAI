/**
 * End-to-end smoke test against a running gateway.
 *
 * Exercises the four paths a client actually uses — non-streaming, streaming,
 * an OpenAI tool call, and an Anthropic tool call — and prints what came back.
 *
 *   node scripts/smoke.ts --base http://127.0.0.1:8787 --key sk-dswg-...
 *
 * With no `--key`, one is created through the admin API (loopback only) and
 * revoked at the end.
 *
 * @module dswg/scripts/smoke
 */

const BASE = readFlag('base') ?? 'http://127.0.0.1:8787'
const ADMIN_TOKEN = readFlag('admin-token')
let apiKey = readFlag('key')
let createdKeyId: string | null = null

/**
 * Read one `--flag value` argument.
 * @param name - flag without dashes.
 * @returns the value, or null.
 */
function readFlag(name: string): string | null {
  const index = process.argv.indexOf(`--${name}`)
  return index === -1 ? null : (process.argv[index + 1] ?? null)
}

/**
 * Call the admin API.
 * @param path - path under /admin/api.
 * @param init - fetch options.
 * @returns the parsed body.
 */
async function admin(path: string, init: RequestInit = {}): Promise<Record<string, unknown>> {
  const headers: Record<string, string> = { 'content-type': 'application/json' }
  if (ADMIN_TOKEN) headers['x-admin-token'] = ADMIN_TOKEN
  const response = await fetch(`${BASE}${path}`, { ...init, headers: { ...headers, ...(init.headers ?? {}) } })
  const text = await response.text()
  if (!response.ok) throw new Error(`admin ${path} -> ${response.status}: ${text.slice(0, 300)}`)
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
}

/**
 * Format a duration.
 * @param ms - milliseconds.
 * @returns the text.
 */
function ms(value: number): string {
  return `${value} ms`
}

/**
 * Run one step, printing its outcome.
 * @param name - step name.
 * @param fn - the work.
 */
async function step(name: string, fn: () => Promise<string>): Promise<void> {
  const started = Date.now()
  try {
    const detail = await fn()
    console.log(`  ok   ${name.padEnd(26)} ${ms(Date.now() - started).padStart(9)}  ${detail}`)
  } catch (error) {
    console.log(`  FAIL ${name.padEnd(26)} ${ms(Date.now() - started).padStart(9)}  ${error instanceof Error ? error.message : String(error)}`)
    process.exitCode = 1
  }
}

if (!apiKey) {
  const created = await admin('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: 'smoke' }) })
  apiKey = String(created.secret)
  createdKeyId = String((created.key as { id: string }).id)
  console.log(`created a temporary key ${apiKey.slice(0, 16)}…`)
}

const auth = { authorization: `Bearer ${apiKey}`, 'content-type': 'application/json' }
const tools = [
  {
    type: 'function',
    function: {
      name: 'get_weather',
      description: 'Get the current weather for a city.',
      parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
    },
  },
]

console.log(`smoke against ${BASE}`)

await step('chat completion', async () => {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'Reply with exactly: gateway-ok' }] }),
  })
  const body = (await response.json()) as { choices?: Array<{ message?: { content?: string } }> }
  if (response.status !== 200) throw new Error(`HTTP ${response.status}: ${JSON.stringify(body).slice(0, 200)}`)
  return JSON.stringify(body.choices?.[0]?.message?.content ?? '')
})

await step('streaming completion', async () => {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: 'Count 1 to 3.' }] }),
  })
  const text = await response.text()
  if (!text.includes('[DONE]')) throw new Error('stream did not end with [DONE]')
  const content = text
    .split('\n')
    .filter((line) => line.startsWith('data: ') && !line.includes('[DONE]'))
    .map((line) => {
      try {
        const parsed = JSON.parse(line.slice(6)) as { choices?: Array<{ delta?: { content?: string } }> }
        return parsed.choices?.[0]?.delta?.content ?? ''
      } catch {
        return ''
      }
    })
    .join('')
  return JSON.stringify(content.slice(0, 60))
})

await step('openai tool call', async () => {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: auth,
    body: JSON.stringify({ model: 'deepseek-chat', tools, messages: [{ role: 'user', content: 'Weather in Paris? Use the tool.' }] }),
  })
  const body = (await response.json()) as { choices?: Array<{ finish_reason?: string; message?: { tool_calls?: Array<{ function?: { name?: string; arguments?: string } }> } }> }
  const call = body.choices?.[0]?.message?.tool_calls?.[0]
  if (!call) throw new Error(`no tool call (finish_reason=${body.choices?.[0]?.finish_reason})`)
  return `${call.function?.name} ${call.function?.arguments}`
})

await step('anthropic tool call', async () => {
  const response = await fetch(`${BASE}/v1/messages`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-api-key': apiKey as string },
    body: JSON.stringify({
      model: 'deepseek-chat',
      max_tokens: 256,
      messages: [{ role: 'user', content: 'Weather in Tokyo? Use the tool.' }],
      tools: [{ name: 'get_weather', description: 'Current weather.', input_schema: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } }],
    }),
  })
  const body = (await response.json()) as { content?: Array<{ type: string; name?: string; input?: unknown }>; stop_reason?: string }
  const block = body.content?.find((entry) => entry.type === 'tool_use')
  if (!block) throw new Error(`no tool_use block (stop_reason=${body.stop_reason})`)
  return `${block.name} ${JSON.stringify(block.input)}`
})

await step('rejects a bad key', async () => {
  const response = await fetch(`${BASE}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: 'Bearer sk-dswg-invalid' },
    body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: 'hi' }] }),
  })
  if (response.status !== 401) throw new Error(`expected 401, got ${response.status}`)
  return '401 authentication_error'
})

if (createdKeyId) {
  await admin(`/admin/api/keys/${createdKeyId}/revoke`, { method: 'POST' })
  console.log('revoked the temporary key')
}
