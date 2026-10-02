/**
 * ui-skill-mention browser half: the `@` skill source against the real
 * `TestSessions`/`TestRemote` runtime. This spec owns the source's own contract
 * — registration and its (trigger, name) seat, dictionary namespace, the
 * session-keyed single-flight catalog cache, the scope-birth prewarm, the
 * synchronous lexicon reads and their listeners, prefix filtering with the
 * user-only marker, addressed-child suppression, and the plain-text pick.
 */
import { Context } from '@deepseek-ai/cordis'
import { describe, expect, it, onTestFinished, vi } from 'vitest'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { InputTriggerService } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import { TestRemote, TestSessions } from '@deepseek-ai/dsh-client-test-runtime'
import type { ClientSessionContext, InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
import type { RemoteFailure } from '@deepseek-ai/dsh-api-remotes/client'
import { apply, inject } from '../src/client/index.ts'
import { en, NS, zh } from '../src/client/locales.ts'

type SkillRow = { name: string; description: string; whenToUse?: string; path?: string; modelInvocable?: boolean }
type ListResult =
  | { ok: true; value: { skills: SkillRow[] } }
  | { ok: false; error: RemoteFailure }
type ListFn = (payload: object, signal?: AbortSignal) => Promise<ListResult>

const CATALOG: SkillRow[] = [
  { name: 'code-review', description: 'review flow', modelInvocable: true },
  { name: 'commit-helper', description: 'commit flow', modelInvocable: true },
  { name: 'notes', description: 'private notes', modelInvocable: false },
]

const listOk = (skills: SkillRow[]): ListFn => () => Promise.resolve({ ok: true as const, value: { skills } })

const sid = (id: string) => id as SessionId
const proj = (id: string): ClientSessionContext => ({ sessionId: sid(id) })
const req = (query: string, signal?: AbortSignal) =>
  ({ query, position: 'leading' as const, drilled: false, signal: signal ?? new AbortController().signal })

/** Boot the plugin over fake trigger/locale faces; returns the captured source. */
async function bench(list: ListFn, addressed?: SessionId) {
  const ctx = new Context()
  let captured: InputTriggerSource | undefined
  const dictionaries: Array<{ namespace: string; dictionaries: unknown }> = []
  ctx.provide('inputTriggers', {
    registerSource: (source: InputTriggerSource) => {
      captured = source
      return () => { captured = undefined }
    },
  })
  ctx.provide('locale', {
    register(namespace: string, dicts: unknown) {
      dictionaries.push({ namespace, dictionaries: dicts })
      return () => {}
    },
    bind: () => (key: string) => key === 'menu.userOnly' ? 'user-only' : key,
  })
  const sessions = new TestSessions(async (action) => { await action() }, ctx)
  ctx.provide('sessions', sessions)
  onTestFinished(async () => {
    await sessions.disposeScopes()
    await ctx.fiber.dispose()
  })
  for (const id of ['s1', 's2', 'child']) {
    await sessions.add({ id })
    sessions.retainFor(ctx, id === addressed
      ? { parentSessionId: sid('parent'), childSessionId: addressed, mode: 'continuable' }
      : sid(id))
  }
  const remote = new TestRemote(ctx, { skills: { list } })
  const fiber = ctx.plugin({ inject: [...inject], apply })
  onTestFinished(async () => { await fiber.dispose() })
  await fiber.await()
  return { ctx, source: captured!, remote, fiber, dictionaries, sessions }
}

describe('apply', () => {
  it('declares the services it binds', () => {
    expect(inject).toEqual(['inputTriggers', 'sessions', 'locale', 'remote', 'remote.skills'])
  })

  it('registers the "@" skill source and its dictionary', async () => {
    const b = await bench(listOk(CATALOG))
    expect(b.source.trigger).toBe('@')
    expect(b.source.name).toBe('skills')
    expect(b.source.order).toBe(3)
    expect(b.dictionaries).toEqual([{ namespace: NS, dictionaries: { zh, en } }])
    expect(en['menu.userOnly']).toBe('user-only')
    expect(zh['menu.userOnly']).toBe('仅用户')
  })

  it('holds the (trigger, name) seat while mounted and frees it on teardown', async () => {
    const ctx = new Context()
    // InputTriggerService itself injects 'sessions', so the real test runtime is
    // provided first and unblocks its fiber; provide() takes one value per name.
    const sessions = new TestSessions(async (action) => { await action() }, ctx)
    ctx.provide('sessions', sessions)
    await ctx.plugin(InputTriggerService).await()
    ctx.provide('locale', { register: () => () => {}, bind: () => (key: string) => key })
    new TestRemote(ctx, { skills: { list: listOk(CATALOG) } })
    onTestFinished(async () => { await sessions.disposeScopes(); await ctx.fiber.dispose() })
    const fiber = ctx.plugin({ inject: [...inject], apply })
    await fiber.await()
    const inputTriggers = ctx.get('inputTriggers') as InputTriggerService
    const rival = {
      trigger: '@' as const,
      name: 'skills',
      candidates: () => Promise.resolve([]),
      onPick: () => undefined,
    }
    expect(() => inputTriggers.registerSource(rival)).toThrow(/already registered/)
    await fiber.dispose()
    expect(() => inputTriggers.registerSource(rival)).not.toThrow()
  })
})

describe('@skill candidates', () => {
  it('lists the catalog for the addressed session and marks user-only skills', async () => {
    const payloads: object[] = []
    const b = await bench((payload) => { payloads.push(payload); return listOk(CATALOG)(payload) })
    const candidates = await b.source.candidates(proj('s1'), req('skill '))
    expect(candidates.map(candidate => candidate.name)).toEqual(['code-review', 'commit-helper', 'notes'])
    expect(candidates[0]?.description).toBe('review flow')
    expect(candidates[2]?.description).toBe('user-only · private notes')
    expect(payloads).toEqual([{ sessionId: 's1' }])
  })

  it('filters on the remainder after `@skill `, and on a bare query too', async () => {
    const b = await bench(listOk(CATALOG))
    expect((await b.source.candidates(proj('s1'), req('skill com'))).map(c => c.name)).toEqual(['commit-helper'])
    expect((await b.source.candidates(proj('s1'), req('comm'))).map(c => c.name)).toEqual(['commit-helper'])
    expect(await b.source.candidates(proj('s1'), req('skill nothing-matches'))).toEqual([])
  })

  it('costs one RPC per session however many keystrokes filter it', async () => {
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list)
    await b.source.candidates(proj('s1'), req('skill '))
    await b.source.candidates(proj('s1'), req('skill co'))
    await b.source.candidates(proj('s1'), req('skill com'))
    expect(list).toHaveBeenCalledOnce()
  })

  it('reads no catalog for an addressed child, which has its own Agent skills', async () => {
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list, sid('child'))
    expect(await b.source.candidates(proj('child'), req('skill '))).toEqual([])
    expect(list).not.toHaveBeenCalled()
  })

  it('yields without failing when the keystroke is superseded', async () => {
    const b = await bench(listOk(CATALOG))
    const aborted = new AbortController()
    aborted.abort()
    expect(await b.source.candidates(proj('s1'), req('skill ', aborted.signal))).toEqual([])
  })
})

describe('lexicon', () => {
  it('answers from the settled cache and notifies subscribers once it settles', async () => {
    const response = Promise.withResolvers<ListResult>()
    const b = await bench(() => response.promise)
    expect(b.source.lexicon?.(proj('s1'))).toBeUndefined()
    const listener = vi.fn()
    const unsubscribe = b.source.subscribeLexicon!(proj('s1'), listener)
    const pending = b.source.candidates(proj('s1'), req('skill '))
    response.resolve({ ok: true, value: { skills: CATALOG } })
    await pending
    expect(b.source.lexicon?.(proj('s1'))).toEqual(['code-review', 'commit-helper', 'notes'])
    expect(listener).toHaveBeenCalledOnce()
    unsubscribe()
    b.remote.emit('agent-preset/selected', [sid('s1'), 'minimal'] as never)
    expect(listener).toHaveBeenCalledOnce()
    expect(b.source.lexicon?.(proj('s1'))).toBeUndefined()
  })

  it('prewarms the session key at scope birth', async () => {
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list)
    b.source.warm?.(proj('s1'))
    await vi.waitFor(() => { expect(list).toHaveBeenCalledOnce() })
    expect(b.source.lexicon?.(proj('s1'))).toEqual(['code-review', 'commit-helper', 'notes'])
  })

  it('drops every cached session on a connection reset and refetches after it', async () => {
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list)
    await b.source.candidates(proj('s1'), req('skill '))
    await b.source.candidates(proj('s2'), req('skill '))
    expect(list).toHaveBeenCalledTimes(2)
    b.ctx.emit('connection/reset')
    expect(b.source.lexicon?.(proj('s1'))).toBeUndefined()
    await b.source.candidates(proj('s1'), req('skill '))
    expect(list).toHaveBeenCalledTimes(3)
  })

  it('does not poison the key when the RPC fails', async () => {
    const list = vi.fn<ListFn>()
      .mockResolvedValueOnce({ ok: false, error: { code: 'gateway/internal', message: 'listing unavailable' } as RemoteFailure })
      .mockImplementation(listOk(CATALOG))
    const b = await bench(list)
    await expect(b.source.candidates(proj('s1'), req('skill '))).rejects.toThrow('listing unavailable')
    await expect(b.source.candidates(proj('s1'), req('skill '))).resolves.toHaveLength(3)
    expect(list).toHaveBeenCalledTimes(2)
  })
})

describe('pick', () => {
  it('lands the literal `@skill <name>` text the host pre-step recognizes', async () => {
    const b = await bench(listOk(CATALOG))
    const [candidate] = await b.source.candidates(proj('s1'), req('skill '))
    expect(b.source.onPick({
      candidate: candidate!,
      session: proj('s1'),
      position: 'leading',
      via: 'menu',
      action: 'pick',
      span: { start: 0, end: 0, draftRev: 1 },
    })).toEqual({ text: '@skill code-review ' })
  })

  it('stops serving candidates after the fiber is disposed', async () => {
    const list = vi.fn(listOk(CATALOG))
    const b = await bench(list)
    const source = b.source
    await b.fiber.dispose()
    expect(source.lexicon?.(proj('s1'))).toBeUndefined()
  })
})
