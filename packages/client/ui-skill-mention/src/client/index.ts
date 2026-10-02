/**
 * The `@skill` picker, browser half: registers the `@` skill source beside
 * `@file` and `@session`. A pick lands the literal `@skill <name> ` text, which
 * the `tool-skill` pre-step recognizes as a user-explicit load gesture — the
 * determinism lives host-side, exactly as it does for the `/name` form.
 *
 * This is upstream's `dsh-client-ui-skill` feature registered from a fork-owned
 * package. Upstream's own `@skills` source lives inside a package the official
 * Desktop also ships, so an edit there never renders there; a registry
 * contribution does, and `registerSource` is a public registry keyed by
 * (trigger, name).
 *
 * Catalog fetches are cached per session and single-flight, so one session costs
 * one RPC however many keystrokes filter it locally. The scope-birth warm hook
 * prewarms the key; a preset switch drops it (the catalog is the preset's, and a
 * blank session may switch after the warm); a connection reset clears everything,
 * because the host catalog may differ across generations.
 */
import type { Context as ClientContext } from '@deepseek-ai/cordis'
import type { SkillEntry } from '@deepseek-ai/dsh-api-remotes/client'
import type {} from '@deepseek-ai/dsh-api-session-controller/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import type { InputTriggerSource } from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the input-trigger Context merge (ctx.inputTriggers).
import type {} from '@deepseek-ai/dsh-client-ui-input-trigger/client'
// Type-only: pulls the locale plugin's Context merge (ctx.locale).
import type {} from '@deepseek-ai/dsh-client-locale/client'
import { en, NS, zh, type SkillMentionKey } from './locales.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** `@skill` picker copy: the user-only marker beside a skill description. */
    skillMention: SkillMentionKey
  }
}

declare module '@deepseek-ai/dsh-api-session-controller/client' {
  interface SessionReferenceSourceMap {
    /** A skill-mention catalog fetch waiting for initial history and its RPC result. */
    skillMentionCatalog: unknown
  }
}

/** One session's catalog fetch: the shared promise plus its own abort handle. */
interface CatalogFetch {
  readonly promise: Promise<readonly SkillEntry[]>
  readonly abort: AbortController
  /** Settled catalog for synchronous lexicon reads (unset while in flight or on failure). */
  settled?: readonly SkillEntry[]
}

/** Services required: the trigger registry, sessions, copy, and the skill catalog RPC. */
export const inject = ['inputTriggers', 'sessions', 'locale', 'remote', 'remote.skills']

/**
 * Register the `@` skill source and its dictionary.
 * @param ctx - Client root context.
 */
export function apply(ctx: ClientContext): void {
  ctx.effect(() => ctx.locale.register(NS, { zh, en }), 'ui-skill-mention: dictionaries')
  const t = ctx.locale.bind(NS)
  const skills = ctx.remote.skills
  const sessions = ctx.sessions

  // Session-keyed catalog cache; single-flight per key. Plugin-closure state:
  // the effect at the end of this function is its teardown boundary.
  const fetches = new Map<SessionId, CatalogFetch>()
  // Per-session lexicon invalidation listeners (subscribeLexicon consumers).
  const lexiconListeners = new Map<SessionId, Set<() => void>>()

  const notifyLexicon = (sessionId: SessionId): void => {
    for (const listener of [...(lexiconListeners.get(sessionId) ?? [])]) {
      try {
        listener()
      } catch (error) {
        // Contain listener failures: settlement notifies from an ignored promise
        // chain (a throw would surface as an unhandled rejection) and one faulty
        // consumer must not starve the others.
        console.error('[ui-skill-mention] lexicon listener failed:', error)
      }
    }
  }

  const fetchCatalog = (sessionId: SessionId): CatalogFetch => {
    const existing = fetches.get(sessionId)
    if (existing !== undefined) return existing
    const abort = new AbortController()
    const promise = (async () => {
      if (sessions.binding(sessionId) === undefined) {
        throw new Error(`skill catalog requires a retained session "${sessionId}"`)
      }
      return sessions.using(sessionId, { source: 'skillMentionCatalog', signal: abort.signal }, async (reference) => {
        abort.signal.throwIfAborted()
        const state = reference.binding.session.getSnapshot()
        if (state.openState !== 'open') {
          throw state.openError ?? new Error(`session "${sessionId}" is not open`)
        }
        const result = await skills.list({ sessionId }, abort.signal)
        abort.signal.throwIfAborted()
        if (!result.ok) throw new Error(`skills/list failed: ${result.error.code}: ${result.error.message}`)
        return result.value.skills
      })
    })()
    const entry: CatalogFetch = { promise, abort }
    fetches.set(sessionId, entry)
    promise.then(
      // Settled snapshot backs the synchronous lexicon reads.
      (catalog) => {
        entry.settled = catalog
        notifyLexicon(sessionId)
      },
      // A failed fetch must not poison the key: the next consumer retries.
      () => {
        if (fetches.get(sessionId) === entry) fetches.delete(sessionId)
      },
    )
    return entry
  }

  const invalidate = (key: SessionId): void => {
    const entry = fetches.get(key)
    if (entry === undefined) return
    fetches.delete(key)
    entry.abort.abort()
    notifyLexicon(key)
  }

  const clearAll = (): void => {
    for (const key of [...fetches.keys()]) invalidate(key)
  }

  const source: InputTriggerSource = {
    trigger: '@',
    name: 'skills',
    order: 3,
    async candidates(session, { query, signal }) {
      // An addressed child reads its own Agent's skills, not this Session's.
      if (sessions.subagentAddress(session.sessionId) !== undefined) return []
      const catalog = await fetchCatalog(session.sessionId).promise
      // Superseded keystroke: the shared fetch stays warm, this caller yields.
      if (signal.aborted) return []
      // `@skill <name>` is the gesture; a bare `@<name>` still lists skills,
      // because the source is one entry in the shared `@` menu.
      const remainder = query.replace(/^skill\s*/, '')
      return catalog
        .filter(skill => remainder === '' || skill.name.startsWith(remainder))
        .map(skill => ({
          name: skill.name,
          // The user-only marker rides the description (the menu's only
          // secondary text); `hint` is the claim-state ghost text, not a badge.
          description: skill.modelInvocable ? skill.description : `${t('menu.userOnly')} · ${skill.description}`,
        }))
    },
    warm(session) {
      // Fire-and-forget scope-birth prewarm; the shared fetch reports through
      // candidates.
      if (sessions.subagentAddress(session.sessionId) !== undefined) return
      fetchCatalog(session.sessionId).promise.catch(() => {})
    },
    lexicon(session) {
      return fetches.get(session.sessionId)?.settled?.map(skill => skill.name)
    },
    subscribeLexicon(session, listener) {
      const key = session.sessionId
      const listeners = lexiconListeners.get(key) ?? new Set()
      listeners.add(listener)
      lexiconListeners.set(key, listeners)
      return () => {
        listeners.delete(listener)
        if (listeners.size === 0) lexiconListeners.delete(key)
      }
    },
    onPick({ candidate }) {
      // Plain-text-reference decision, as for `/name`: the pick lands plain
      // text and the prompt ships the same literal. The host's pre-step
      // boundary recognizes the leading `@skill <name>` and injects the
      // rendered body for every entry point.
      return { text: `@skill ${candidate.name} ` }
    },
  }

  // A preset decides which skill providers an agent reads, so a switched
  // session's cached catalog belongs to the composition it no longer runs.
  ctx.remote.$on('agent-preset/selected', invalidate)
  ctx.on('connection/reset', clearAll)
  ctx.effect(() => {
    const unregister = ctx.inputTriggers.registerSource(source)
    return () => {
      unregister()
      clearAll()
    }
  }, 'ui-skill-mention: @skills source')
}
