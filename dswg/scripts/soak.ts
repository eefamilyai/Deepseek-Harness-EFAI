/**
 * Long-horizon soak test against a running gateway.
 *
 * Runs a mixed workload — plain turns, streaming, tool calls, and a tool-result
 * round trip — then reports latency percentiles, the failure classes that
 * appeared, and how the server's memory and handle count moved across the run.
 * A gateway that leaks a browser, a socket or a timer per turn shows here long
 * before it shows up as a failed request.
 *
 *   node scripts/soak.ts --turns 10 --concurrency 2
 *   node scripts/soak.ts --turns 50 --key sk-dswg-... --base http://127.0.0.1:8787
 *
 * @module dswg/scripts/soak
 */

const BASE = readFlag('base') ?? 'http://127.0.0.1:8787'
const ADMIN_TOKEN = readFlag('admin-token')
const TURNS = Number(readFlag('turns') ?? '10')
const CONCURRENCY = Math.max(1, Number(readFlag('concurrency') ?? '1'))
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
  if (!response.ok) throw new Error(`${path} -> ${response.status}: ${text.slice(0, 200)}`)
  return text.length === 0 ? {} : (JSON.parse(text) as Record<string, unknown>)
}

/** One request outcome. */
interface Outcome {
  kind: string
  ok: boolean
  status: number
  ms: number
  errorCode: string | null
  chars: number
}

const outcomes: Outcome[] = []
const chatHeaders = (): Record<string, string> => ({ 'content-type': 'application/json', authorization: `Bearer ${apiKey}` })

/**
 * Time one request.
 * @param kind - workload name.
 * @param run - the request.
 * @returns the outcome.
 */
async function timed(kind: string, run: () => Promise<{ status: number; text: string; code: string | null }>): Promise<void> {
  const started = Date.now()
  try {
    const result = await run()
    outcomes.push({ kind, ok: result.status === 200, status: result.status, ms: Date.now() - started, errorCode: result.code, chars: result.text.length })
  } catch (error) {
    outcomes.push({ kind, ok: false, status: 0, ms: Date.now() - started, errorCode: error instanceof Error ? error.message.slice(0, 60) : 'error', chars: 0 })
  }
}

/**
 * Run a non-streaming turn.
 * @param prompt - the user message.
 */
async function plainTurn(prompt: string): Promise<void> {
  await timed('plain', async () => {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ model: 'deepseek-chat', messages: [{ role: 'user', content: prompt }] }),
    })
    const body = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { code?: string } }
    return { status: response.status, text: body.choices?.[0]?.message?.content ?? '', code: body.error?.code ?? null }
  })
}

/**
 * Run a streaming turn.
 * @param prompt - the user message.
 */
async function streamTurn(prompt: string): Promise<void> {
  await timed('stream', async () => {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({ model: 'deepseek-chat', stream: true, messages: [{ role: 'user', content: prompt }] }),
    })
    const text = await response.text()
    const failed = !text.includes('[DONE]')
    return { status: failed ? 0 : response.status, text, code: failed ? 'no_done_frame' : null }
  })
}

/**
 * Run a turn that asks for a tool call.
 * @param prompt - the user message.
 */
async function toolTurn(prompt: string): Promise<void> {
  await timed('tool', async () => {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        model: 'deepseek-chat',
        messages: [{ role: 'user', content: prompt }],
        tools: [
          {
            type: 'function',
            function: {
              name: 'get_weather',
              description: 'Get the current weather for a city.',
              parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] },
            },
          },
        ],
      }),
    })
    const body = (await response.json().catch(() => ({}))) as {
      choices?: Array<{ finish_reason?: string; message?: { tool_calls?: unknown[] } }>
      error?: { code?: string }
    }
    const ok = body.choices?.[0]?.finish_reason === 'tool_calls'
    return { status: ok ? response.status : 0, text: JSON.stringify(body.choices?.[0] ?? {}), code: ok ? null : (body.error?.code ?? 'no_tool_call') }
  })
}

/**
 * Run a turn that replays a tool result back to the model.
 * @param prompt - the user message.
 */
async function loopTurn(prompt: string): Promise<void> {
  await timed('tool-loop', async () => {
    const response = await fetch(`${BASE}/v1/chat/completions`, {
      method: 'POST',
      headers: chatHeaders(),
      body: JSON.stringify({
        model: 'deepseek-chat',
        tools: [
          {
            type: 'function',
            function: { name: 'get_weather', description: 'Weather.', parameters: { type: 'object', properties: { city: { type: 'string' } }, required: ['city'] } },
          },
        ],
        messages: [
          { role: 'user', content: prompt },
          { role: 'assistant', content: null, tool_calls: [{ id: 'call_1', type: 'function', function: { name: 'get_weather', arguments: '{"city":"Paris"}' } }] },
          { role: 'tool', tool_call_id: 'call_1', name: 'get_weather', content: '{"temp_c": 18, "sky": "clear"}' },
        ],
      }),
    })
    const body = (await response.json().catch(() => ({}))) as { choices?: Array<{ message?: { content?: string } }>; error?: { code?: string } }
    const text = body.choices?.[0]?.message?.content ?? ''
    return { status: text.length > 0 ? response.status : 0, text, code: text.length > 0 ? null : (body.error?.code ?? 'empty') }
  })
}

/**
 * A percentile of the latency series.
 * @param values - sorted samples.
 * @param fraction - 0..1.
 * @returns the value at that percentile.
 */
function percentile(values: number[], fraction: number): number {
  if (values.length === 0) return 0
  const index = Math.min(values.length - 1, Math.floor(values.length * fraction))
  return values[index] as number
}

/**
 * Run the soak.
 */
async function main(): Promise<void> {
  if (!apiKey) {
    const created = await admin('/admin/api/keys', { method: 'POST', body: JSON.stringify({ name: 'soak' }) })
    apiKey = String(created.secret)
    createdKeyId = String((created.key as { id: string }).id)
  }

  const before = (await (await fetch(`${BASE}/health`)).json()) as { memory?: { rssMb: number; heapMb: number; handles: number } }
  console.log(`soak: ${TURNS} turns, concurrency ${CONCURRENCY}, base ${BASE}`)
  console.log(`before: rss=${before.memory?.rssMb ?? '?'}MB heap=${before.memory?.heapMb ?? '?'}MB handles=${before.memory?.handles ?? '?'}`)

  const workload = [plainTurn, streamTurn, toolTurn, loopTurn]
  let issued = 0
  const workers = Array.from({ length: CONCURRENCY }, async (_unused, workerIndex) => {
    while (issued < TURNS) {
      const turn = issued
      issued += 1
      const run = workload[(turn + workerIndex) % workload.length] as (prompt: string) => Promise<void>
      await run(`Soak turn ${turn + 1}/${TURNS}. Reply with one short sentence about the number ${turn + 1}.`)
    }
  })
  await Promise.all(workers)

  const after = (await (await fetch(`${BASE}/health`)).json()) as { memory?: { rssMb: number; heapMb: number; handles: number } }
  const latencies = outcomes.map((outcome) => outcome.ms).sort((a, b) => a - b)
  const failures = outcomes.filter((outcome) => !outcome.ok)
  const byKind: Record<string, { ok: number; fail: number }> = {}
  for (const outcome of outcomes) {
    const entry = byKind[outcome.kind] ?? { ok: 0, fail: 0 }
    if (outcome.ok) entry.ok += 1
    else entry.fail += 1
    byKind[outcome.kind] = entry
  }

  console.log(`\nresults: ${outcomes.length - failures.length}/${outcomes.length} ok`)
  console.log(`latency: p50=${percentile(latencies, 0.5)}ms p95=${percentile(latencies, 0.95)}ms max=${latencies[latencies.length - 1] ?? 0}ms`)
  for (const [kind, entry] of Object.entries(byKind)) console.log(`  ${kind.padEnd(10)} ok=${entry.ok} fail=${entry.fail}`)
  if (failures.length > 0) {
    const reasons = new Map<string, number>()
    for (const failure of failures) reasons.set(`${failure.status}:${failure.errorCode ?? '?'}`, (reasons.get(`${failure.status}:${failure.errorCode ?? '?'}`) ?? 0) + 1)
    for (const [reason, count] of reasons) console.log(`  failure ${reason} ×${count}`)
  }
  console.log(`after:  rss=${after.memory?.rssMb ?? '?'}MB heap=${after.memory?.heapMb ?? '?'}MB handles=${after.memory?.handles ?? '?'}`)
  const rssDelta = (after.memory?.rssMb ?? 0) - (before.memory?.rssMb ?? 0)
  console.log(`delta:  rss=${rssDelta}MB handles=${(after.memory?.handles ?? 0) - (before.memory?.handles ?? 0)}`)

  if (createdKeyId) {
    await admin(`/admin/api/keys/${createdKeyId}`, { method: 'DELETE' })
    console.log('deleted the temporary key')
  }
  process.exit(failures.length === 0 ? 0 : 1)
}

void main()
