/**
 * Page-side runtime.
 *
 * Evaluated inside a page that is already on https://chat.deepseek.com inside the
 * account's own persistent Chromium profile. It does exactly three things the
 * Node side cannot do with the same fidelity: read the identity the site minted
 * for that profile, solve the proof-of-work with DeepSeek's own wasm, and issue
 * the API requests with the browser's own network stack (TLS, HTTP/2, cookies,
 * client hints and header order are the real browser's, not a reconstruction).
 *
 * Raw SSE bytes are relayed to Node, which owns the parsing, so the web client's
 * framing rules live in one testable place instead of here.
 *
 * Exposed as `window.__dswg`. Injected on every page in the context.
 */
;((global) => {
  if (global.__dswg) return

  const WASM_URL = 'https://fe-static.deepseek.com/chat/static/sha3_wasm_bg.7b9ca65ddd.wasm'
  const CLIENT = {
    version: '2.7.0',
    bundleId: 'com.deepseek.chat',
    platform: 'web',
    locale: 'en_US',
  }

  const state = { wasm: null, wasmPromise: null, aborts: new Map(), inflight: 0 }

  /** Read a JSON-wrapped localStorage value (`{value, __version__}`). */
  const readStorage = (key) => {
    try {
      const raw = global.localStorage.getItem(key)
      if (raw === null) return null
      if (raw.length && (raw[0] === '{' || raw[0] === '[')) {
        const parsed = JSON.parse(raw)
        if (parsed && typeof parsed === 'object' && 'value' in parsed) return parsed.value
        return parsed
      }
      return raw
    } catch {
      return null
    }
  }

  const writeStorage = (key, value) => {
    global.localStorage.setItem(key, JSON.stringify({ value, __version: '0' }))
  }

  const b64 = (text) => {
    const bytes = new TextEncoder().encode(text)
    let binary = ''
    for (let i = 0; i < bytes.length; i += 1) binary += String.fromCharCode(bytes[i])
    return global.btoa(binary)
  }

  /** Identity the profile minted; the site is the only source of these. */
  const identity = () => ({
    token: readStorage('userToken') || null,
    deviceId: readStorage('deepseek-device-id:chat') || null,
    did: readStorage('__ds_remote_feature_did') || null,
    userId: (readStorage('__appKit_userInfo') || {}).id || null,
    smid: readStorage('smidV2') || null,
  })

  /** Headers the site's own client adds to every /api/v0 call. */
  const headers = (extra) => {
    const id = identity()
    const tz = -new Date().getTimezoneOffset() * 60
    const base = {
      accept: '*/*',
      'x-client-bundle-id': CLIENT.bundleId,
      'x-client-locale': CLIENT.locale,
      'x-client-platform': CLIENT.platform,
      'x-client-timezone-offset': String(tz),
      'x-client-version': CLIENT.version,
      'x-device-id': id.deviceId || '',
      'x-device-model': '',
    }
    if (id.token) base.authorization = 'Bearer ' + id.token
    return Object.assign(base, extra || {})
  }

  /** Load DeepSeek's own PoW wasm once per page. */
  const loadWasm = async () => {
    if (state.wasm) return state.wasm
    if (!state.wasmPromise) {
      state.wasmPromise = (async () => {
        const res = await fetch(WASM_URL)
        if (!res.ok) throw new Error('pow wasm fetch failed: HTTP ' + res.status)
        const buf = await res.arrayBuffer()
        const { instance } = await WebAssembly.instantiate(buf, {})
        state.wasm = instance.exports
        return state.wasm
      })().catch((error) => {
        state.wasmPromise = null
        throw error
      })
    }
    return state.wasmPromise
  }

  /** Solve one challenge exactly the way the site's client does. */
  const solvePow = async (challenge) => {
    const ex = await loadWasm()
    const mem = ex.memory
    const writeStr = (text) => {
      const bytes = new TextEncoder().encode(text)
      const ptr = ex.__wbindgen_export_0(bytes.length, 1)
      new Uint8Array(mem.buffer).set(bytes, ptr)
      return { ptr, length: bytes.length }
    }
    const retptr = ex.__wbindgen_add_to_stack_pointer(-16)
    try {
      const challengeArg = writeStr(challenge.challenge)
      const prefixArg = writeStr(challenge.salt + '_' + challenge.expire_at + '_')
      ex.wasm_solve(retptr, challengeArg.ptr, challengeArg.length, prefixArg.ptr, prefixArg.length, challenge.difficulty)
      const status = new Int32Array(mem.buffer)[retptr / 4]
      if (status === 0) throw new Error('pow solve reported failure')
      const answer = Math.floor(new Float64Array(mem.buffer)[(retptr + 8) / 8])
      return b64(
        JSON.stringify({
          algorithm: challenge.algorithm,
          challenge: challenge.challenge,
          salt: challenge.salt,
          answer,
          signature: challenge.signature,
          target_path: challenge.target_path,
        }),
      )
    } finally {
      ex.__wbindgen_add_to_stack_pointer(16)
    }
  }

  /**
   * Report one upstream call to the host.
   *
   * Everything a later investigation needs is here: the exact path, the header
   * set the browser actually sent, the status, the edge headers, and a bounded
   * body. The host redacts credentials before persisting.
   */
  const report = (id, entry) => {
    try {
      if (global.__dswgEmit) global.__dswgEmit(id, { t: 'http', entry })
    } catch (err) {
      void err
    }
  }

  /** Turn a Headers object into a plain map. */
  const headerMap = (source) => {
    const out = {}
    try {
      source.forEach((value, key) => {
        out[key] = value
      })
    } catch (err) {
      void err
    }
    return out
  }

  /** POST JSON and return the parsed envelope, recording the call. */
  const postJson = async (path, body, signal, turnId) => {
    const startedAt = performance.now()
    const requestHeaders = headers({ 'content-type': 'application/json' })
    const res = await fetch(path, {
      method: 'POST',
      headers: requestHeaders,
      body: JSON.stringify(body),
      signal,
    })
    const text = await res.text()
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    if (turnId) {
      report(turnId, {
        path,
        method: 'POST',
        status: res.status,
        ms: Math.round(performance.now() - startedAt),
        requestHeaders,
        responseHeaders: headerMap(res.headers),
        requestBytes: JSON.stringify(body).length,
        responseBytes: text.length,
        responseBody: text.slice(0, 8000),
      })
    }
    return { status: res.status, json, text, headers: res.headers }
  }

  /**
   * Run one completion turn, relaying raw SSE text to the host.
   * Resolves with a summary; never throws for an upstream refusal.
   */
  const turn = async (opts) => {
    const id = opts.id
    const emit = (event) => {
      try {
        global.__dswgEmit && global.__dswgEmit(id, event)
      } catch {
        /* the host went away; the reader loop below will notice */
      }
    }
    const controller = new AbortController()
    state.aborts.set(id, controller)
    state.inflight += 1
    const startedAt = performance.now()
    try {
      const who = identity()
      if (!who.token) return { ok: false, kind: 'auth', message: 'this profile has no logged-in session', status: 401 }

      // 1. chat session
      const session = await postJson('/api/v0/chat_session/create', { character_id: null }, controller.signal, id)
      const sid = session.json && session.json.data && session.json.data.biz_data
        ? (session.json.data.biz_data.chat_session && session.json.data.biz_data.chat_session.id) || session.json.data.biz_data.id
        : null
      if (!sid) return { ok: false, kind: 'session', status: session.status, body: session.text.slice(0, 4000), message: 'no chat session id' }
      emit({ t: 'session', sessionId: sid })

      // 2. proof of work for the completion path
      const powRes = await postJson('/api/v0/chat/create_pow_challenge', { target_path: '/api/v0/chat/completion' }, controller.signal, id)
      const challenge = powRes.json && powRes.json.data && powRes.json.data.biz_data ? powRes.json.data.biz_data.challenge : null
      if (!challenge) return { ok: false, kind: 'pow', status: powRes.status, body: powRes.text.slice(0, 4000), sessionId: sid, message: 'no pow challenge' }
      const powHeader = await solvePow(challenge)

      // 3. completion, streamed
      const completionHeaders = headers({
        'content-type': 'application/json',
        'x-ds-pow-response': powHeader,
      })
      const completionBody = JSON.stringify({
        chat_session_id: sid,
        parent_message_id: opts.parentMessageId == null ? null : opts.parentMessageId,
        model_type: opts.modelType || 'default',
        prompt: opts.prompt,
        ref_file_ids: opts.refFileIds || [],
        thinking_enabled: Boolean(opts.thinking),
        search_enabled: Boolean(opts.search),
        action: null,
        preempt: false,
      })
      const completionStarted = performance.now()
      const res = await fetch('/api/v0/chat/completion', {
        method: 'POST',
        headers: completionHeaders,
        body: completionBody,
        signal: controller.signal,
      })
      const contentType = res.headers.get('content-type') || ''
      if (res.status !== 200 || contentType.indexOf('event-stream') === -1) {
        const body = await res.text()
        report(id, {
          path: '/api/v0/chat/completion',
          method: 'POST',
          status: res.status,
          ms: Math.round(performance.now() - completionStarted),
          requestHeaders: completionHeaders,
          responseHeaders: headerMap(res.headers),
          requestBytes: completionBody.length,
          responseBytes: body.length,
          responseBody: body.slice(0, 8000),
          refused: true,
        })
        return { ok: false, kind: 'response', status: res.status, body: body.slice(0, 8000), sessionId: sid, message: 'completion refused' }
      }
      report(id, {
        path: '/api/v0/chat/completion',
        method: 'POST',
        status: res.status,
        ms: Math.round(performance.now() - completionStarted),
        requestHeaders: completionHeaders,
        responseHeaders: headerMap(res.headers),
        requestBytes: completionBody.length,
        streaming: true,
      })

      const reader = res.body.getReader()
      const decoder = new TextDecoder()
      let pending = ''
      let flushedAt = performance.now()
      const flush = () => {
        if (!pending) return
        emit({ t: 'chunk', v: pending })
        pending = ''
        flushedAt = performance.now()
      }
      let firstChunkAt = null
      let bytes = 0
      for (;;) {
        const { done, value } = await reader.read()
        if (done) break
        if (firstChunkAt === null) {
          firstChunkAt = Math.round(performance.now() - startedAt)
          emit({ t: 'ttfb', ms: firstChunkAt })
        }
        bytes += value.length
        pending += decoder.decode(value, { stream: true })
        if (pending.length > 4096 || performance.now() - flushedAt > 25) flush()
      }
      pending += decoder.decode()
      flush()
      return {
        ok: true,
        sessionId: sid,
        bytes,
        elapsedMs: Math.round(performance.now() - startedAt),
      }
    } catch (error) {
      const aborted = controller.signal.aborted
      return {
        ok: false,
        kind: aborted ? 'aborted' : 'network',
        message: aborted ? 'cancelled' : String((error && error.message) || error),
      }
    } finally {
      state.aborts.delete(id)
      state.inflight -= 1
    }
  }

  /** Cheap liveness probe: one authenticated settings read. */
  const probe = async () => {
    const who = identity()
    if (!who.token) return { ok: false, kind: 'auth', message: 'no token in this profile' }
    try {
      const did = who.did || ''
      const res = await fetch('/api/v0/client/settings?did=' + encodeURIComponent(did) + '&scope=provider', {
        headers: headers(),
      })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { ok: res.status === 200, status: res.status, json, text: text.slice(0, 4000) }
    } catch (error) {
      return { ok: false, kind: 'network', message: String((error && error.message) || error) }
    }
  }

  /** Read the current user record; also confirms the token still works. */
  const currentUser = async () => {
    try {
      const res = await fetch('/api/v0/users/current', { headers: headers() })
      const text = await res.text()
      let json = null
      try {
        json = JSON.parse(text)
      } catch {
        json = null
      }
      return { ok: res.status === 200, status: res.status, json, text: text.slice(0, 4000) }
    } catch (error) {
      return { ok: false, kind: 'network', message: String((error && error.message) || error) }
    }
  }

  /** Delete one upstream chat session (best effort). */
  const deleteSession = async (sessionId) => {
    try {
      const res = await postJson('/api/v0/chat_session/delete', { chat_session_id: sessionId })
      return { ok: res.status === 200, status: res.status, text: res.text.slice(0, 500) }
    } catch (error) {
      return { ok: false, kind: 'network', message: String((error && error.message) || error) }
    }
  }

  /** Seed a token into the profile (used when adopting a captured credential). */
  const seedToken = (token) => {
    writeStorage('userToken', token)
    return true
  }

  /** Cancel an in-flight turn. */
  const abort = (id) => {
    const controller = state.aborts.get(id)
    if (!controller) return false
    controller.abort()
    return true
  }

  global.__dswg = {
    version: 1,
    identity,
    turn,
    probe,
    currentUser,
    deleteSession,
    seedToken,
    abort,
    status: () => ({ inflight: state.inflight, wasm: state.wasm !== null }),
  }
})(window)
