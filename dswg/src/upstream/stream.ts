/**
 * Decoding DeepSeek's completion stream.
 *
 * The web client does not stream tokens. It streams *patches* against a JSON
 * document: an initial snapshot carrying every fragment so far, then
 * `{p,o,v}` operations that append to one fragment's content. A later fragment
 * can flip an earlier pointer's target, and a bare `{v:"text"}` continues the
 * fragment that was last touched. Reading this as plain SSE text loses the
 * structure; reading it by position loses the stream.
 *
 * @module dswg/upstream/stream
 */

import { readVerdict, type Verdict } from './verdict.ts'

/** One decoded stream event. */
export type UpstreamEvent =
  | { type: 'ready'; requestId: number | null; responseId: number | null; modelType: string | null }
  | { type: 'title'; title: string }
  | { type: 'think'; text: string }
  | { type: 'text'; text: string }
  | { type: 'search'; queries: string[]; results: SearchResult[] }
  | { type: 'usage'; total: number }
  | { type: 'status'; status: string }
  | { type: 'error'; verdict: Verdict }
  | { type: 'close'; autoResume: boolean }

/** One web-search citation. */
export interface SearchResult {
  url: string
  title: string
  citeIndex: number | null
  siteName: string | null
  snippet: string | null
}

/** A fragment of the assistant message. */
interface Fragment {
  type: string
  content: string
}

/** Shape of a patch operation. */
interface Patch {
  p?: string
  o?: string
  v?: unknown
}

/**
 * Convert a raw search-results array from the stream.
 * @param value - the `v` of a results patch.
 * @returns the citations.
 */
function toResults(value: unknown): SearchResult[] {
  if (!Array.isArray(value)) return []
  const out: SearchResult[] = []
  for (const entry of value) {
    if (entry === null || typeof entry !== 'object') continue
    const record = entry as Record<string, unknown>
    const url = typeof record.url === 'string' ? record.url : null
    if (!url) continue
    out.push({
      url,
      title: typeof record.title === 'string' ? record.title : '',
      citeIndex: typeof record.cite_index === 'number' ? record.cite_index : null,
      siteName: typeof record.site_name === 'string' ? record.site_name : null,
      snippet: typeof record.snippet === 'string' ? record.snippet : null,
    })
  }
  return out
}

/**
 * Convert a raw queries array from the stream.
 * @param value - the `queries` of a SEARCH fragment.
 * @returns the query strings.
 */
function toQueries(value: unknown): string[] {
  if (!Array.isArray(value)) return []
  const out: string[] = []
  for (const entry of value) {
    if (entry !== null && typeof entry === 'object' && typeof (entry as { query?: unknown }).query === 'string') {
      out.push((entry as { query: string }).query)
    }
  }
  return out
}

/** Incremental decoder for one completion stream. */
export class StreamDecoder {
  #buffer = ''
  #fragments: Fragment[] = []
  #current = -1
  #eventName: string | null = null
  #finished = false
  /** Non-text events seen, for diagnostics. */
  readonly stats = { frames: 0, patches: 0, verdicts: 0 }

  /**
   * Feed a raw chunk from the transport.
   * @param chunk - text decoded from the SSE stream.
   * @returns the events this chunk completed.
   */
  push(chunk: string): UpstreamEvent[] {
    if (this.#finished) return []
    this.#buffer += chunk
    const events: UpstreamEvent[] = []
    for (;;) {
      const newline = this.#buffer.indexOf('\n')
      if (newline === -1) break
      const line = this.#buffer.slice(0, newline).replace(/\r$/, '')
      this.#buffer = this.#buffer.slice(newline + 1)
      events.push(...this.#line(line))
    }
    return events
  }

  /**
   * Flush any trailing partial line.
   * @returns the final events.
   */
  end(): UpstreamEvent[] {
    if (this.#finished) return []
    this.#finished = true
    const events: UpstreamEvent[] = []
    const rest = this.#buffer
    this.#buffer = ''
    if (rest.trim().length > 0) events.push(...this.#line(rest))
    return events
  }

  /**
   * Decode one protocol line.
   * @param line - one line, without its terminator.
   * @returns the events.
   */
  #line(line: string): UpstreamEvent[] {
    const trimmed = line.trim()
    if (trimmed.length === 0) {
      this.#eventName = null
      return []
    }
    if (trimmed.startsWith('event:')) {
      this.#eventName = trimmed.slice(6).trim()
      return []
    }
    const payload = trimmed.startsWith('data:') ? trimmed.slice(5).trim() : trimmed
    if (payload.length === 0) return []
    if (payload === '[DONE]') {
      this.#finished = true
      return []
    }

    let parsed: unknown = null
    try {
      parsed = JSON.parse(payload)
    } catch {
      return []
    }
    this.stats.frames += 1

    const eventName = this.#eventName
    this.#eventName = null

    if (eventName === 'ready') {
      const record = (parsed ?? {}) as Record<string, unknown>
      return [
        {
          type: 'ready',
          requestId: typeof record.request_message_id === 'number' ? record.request_message_id : null,
          responseId: typeof record.response_message_id === 'number' ? record.response_message_id : null,
          modelType: typeof record.model_type === 'string' ? record.model_type : null,
        },
      ]
    }
    if (eventName === 'title') {
      const title = (parsed as { content?: unknown } | null)?.content
      return typeof title === 'string' ? [{ type: 'title', title }] : []
    }
    if (eventName === 'hint') {
      const hint = (parsed ?? {}) as Record<string, unknown>
      if (hint.type === 'error') {
        const verdict = readVerdict({ msg: hint.content, code: hint.finish_reason })
        return [{ type: 'error', verdict: verdict ?? { kind: 'upstream', message: String(hint.content ?? 'upstream error') } }]
      }
      return []
    }
    if (eventName === 'close') {
      const record = (parsed ?? {}) as Record<string, unknown>
      return [{ type: 'close', autoResume: record.auto_resume === true }]
    }
    if (eventName === 'update_session') return []

    if (parsed === null || typeof parsed !== 'object') return []
    const record = parsed as Record<string, unknown>

    // A refusal rides the stream as a bare envelope with no `v`/`p` field.
    if (!('v' in record) && !('p' in record)) {
      const verdict = readVerdict(record)
      if (verdict) {
        this.stats.verdicts += 1
        this.#finished = true
        return [{ type: 'error', verdict }]
      }
      return []
    }

    return this.#applyObject(record)
  }

  /**
   * Apply one decoded JSON object (a snapshot, a patch or a batch).
   * @param record - the parsed object.
   * @returns the events.
   */
  #applyObject(record: Record<string, unknown>): UpstreamEvent[] {
    const value = record.v
    const path = typeof record.p === 'string' ? record.p : null
    const op = typeof record.o === 'string' ? record.o : null

    if (value !== null && typeof value === 'object' && !Array.isArray(value) && 'response' in value) {
      return this.#snapshot((value as { response?: Record<string, unknown> }).response)
    }
    if (path === 'response' && op === 'BATCH' && Array.isArray(value)) {
      const events: UpstreamEvent[] = []
      for (const entry of value) {
        if (entry !== null && typeof entry === 'object') events.push(...this.#applyObject(entry as Record<string, unknown>))
      }
      return events
    }
    if (path === null && typeof value === 'string') {
      return this.#appendCurrent(value)
    }
    if (path === null && Array.isArray(value) && value.every((item) => typeof item === 'string')) {
      return this.#appendCurrent((value as string[]).join(''))
    }
    if (path === null) return []

    if (path.endsWith('fragments') && Array.isArray(value)) {
      return this.#appendFragments(value)
    }
    if (/fragments\/-?\d+\/content$/.test(path) && typeof value === 'string') {
      this.stats.patches += 1
      return this.#appendCurrent(value)
    }
    if (/fragments\/-?\d+\/results$/.test(path)) {
      return [{ type: 'search', queries: [], results: toResults(value) }]
    }
    if (/fragments\/-?\d+\/queries$/.test(path)) {
      return [{ type: 'search', queries: toQueries(value), results: [] }]
    }
    if (/fragments\/-?\d+\/type$/.test(path) && typeof value === 'string') {
      const index = this.#resolveIndex(path)
      const fragment = this.#fragments[index]
      if (fragment) fragment.type = value
      this.#current = index
      return []
    }
    if (path === 'response/status' && typeof value === 'string') {
      // The stream keeps going after FINISHED: the title and the close frame
      // arrive behind it. Only an explicit close or [DONE] ends decoding.
      return [{ type: 'status', status: value }]
    }
    if (path === 'accumulated_token_usage' && typeof value === 'number') {
      return [{ type: 'usage', total: value }]
    }
    if (path === 'response/quasi_status' && typeof value === 'string') {
      return []
    }
    return []
  }

  /**
   * Apply a full response snapshot, which arrives on the first frame and again
   * when the server resumes a stream.
   * @param response - the snapshot.
   * @returns the events.
   */
  #snapshot(response: Record<string, unknown> | undefined): UpstreamEvent[] {
    if (!response) return []
    const events: UpstreamEvent[] = []
    const usage = response.accumulated_token_usage
    if (typeof usage === 'number' && usage > 0) events.push({ type: 'usage', total: usage })
    const fragments = Array.isArray(response.fragments) ? response.fragments : []
    for (const entry of fragments) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type : 'RESPONSE'
      const content = typeof record.content === 'string' ? record.content : ''
      const results = toResults(record.results)
      const queries = toQueries(record.queries)
      this.#fragments.push({ type, content })
      this.#current = this.#fragments.length - 1
      if (queries.length > 0) events.push({ type: 'search', queries, results: [] })
      if (results.length > 0) events.push({ type: 'search', queries: [], results })
      if (content.length > 0) {
        const kind = this.#kindOf(type)
        if (kind === 'text') events.push({ type: 'text', text: content })
        else if (kind === 'think') events.push({ type: 'think', text: content })
      }
    }
    const status = response.status
    if (typeof status === 'string' && status !== 'WIP') events.push({ type: 'status', status })
    return events
  }

  /**
   * Append one or more fragments announced by a patch.
   * @param value - the fragments array.
   * @returns the events.
   */
  #appendFragments(value: unknown[]): UpstreamEvent[] {
    const events: UpstreamEvent[] = []
    for (const entry of value) {
      if (entry === null || typeof entry !== 'object') continue
      const record = entry as Record<string, unknown>
      const type = typeof record.type === 'string' ? record.type : 'RESPONSE'
      const fragment: Fragment = { type, content: typeof record.content === 'string' ? record.content : '' }
      this.#fragments.push(fragment)
      this.#current = this.#fragments.length - 1
      const results = toResults(record.results)
      if (results.length > 0) events.push({ type: 'search', queries: [], results })
      if (fragment.content.length > 0) {
        const kind = this.#kindOf(type)
        if (kind === 'text') events.push({ type: 'text', text: fragment.content })
        else if (kind === 'think') events.push({ type: 'think', text: fragment.content })
      }
    }
    return events
  }

  /**
   * Append text to the fragment the stream is currently writing.
   * @param text - the text to append.
   * @returns the events.
   */
  #appendCurrent(text: string): UpstreamEvent[] {
    if (this.#current < 0) {
      this.#fragments.push({ type: 'RESPONSE', content: '' })
      this.#current = 0
    }
    const fragment = this.#fragments[this.#current] as Fragment
    fragment.content += text
    const kind = this.#kindOf(fragment.type)
    if (kind === 'text') return [{ type: 'text', text }]
    if (kind === 'think') return [{ type: 'think', text }]
    return []
  }

  /**
   * Resolve a JSON-pointer style fragment index (`-1` means the last one).
   * @param path - the patch path.
   * @returns the resolved index.
   */
  #resolveIndex(path: string): number {
    const match = /fragments\/(-?\d+)\//.exec(path)
    if (!match) return this.#current
    const raw = Number(match[1])
    if (raw < 0) return this.#fragments.length - 1
    return raw
  }

  /**
   * Map an upstream fragment type onto the channel it feeds.
   * @param type - the fragment type.
   * @returns `text`, `think`, or `other`.
   */
  #kindOf(type: string): 'text' | 'think' | 'other' {
    if (type === 'THINK' || type === 'REASONING') return 'think'
    if (type === 'RESPONSE' || type === 'REQUEST') return 'text'
    return 'other'
  }

  /** Concatenated visible text received so far. */
  get text(): string {
    return this.#fragments
      .filter((fragment) => this.#kindOf(fragment.type) === 'text')
      .map((fragment) => fragment.content)
      .join('')
  }

  /** Concatenated thinking received so far. */
  get thinking(): string {
    return this.#fragments
      .filter((fragment) => this.#kindOf(fragment.type) === 'think')
      .map((fragment) => fragment.content)
      .join('')
  }
}
