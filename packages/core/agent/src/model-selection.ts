/**
 * Agent-scoped model selection shared by runtime entry points.
 * @module @deepseek-ai/dsh-agent/model-selection
 */

import type { Context } from '@deepseek-ai/cordis'
import type { LlmCallConfig, ReasoningEffortId } from '@deepseek-ai/dsh-llm'

/** Complete provider, model, and optional reasoning effort selected for one live Agent. */
export interface ModelSelection {
  /** Registered provider route. */
  provider: string
  /** Provider-owned model id. */
  model: string
  /** Adapter-owned reasoning effort, or provider/default behavior when absent. */
  reasoningEffort?: ReasoningEffortId
}

/** Mutable model selection plus the value captured for the current step. */
export interface ModelSelectionRef {
  /** Model selected for the next step that enters prompt assembly. */
  current: ModelSelection | undefined
  /** Selection captured when the current step entered prompt assembly. */
  assembled: ModelSelection | undefined
}

/** The selection one wired scope currently reads through. */
interface WiredSelection {
  /** Ref the live accessor and both listeners resolve on every read. */
  ref: ModelSelectionRef
}

/**
 * Selections wired per Agent scope, so a re-entrant install rebinds the live
 * wiring instead of leaving the first ref in place. A resume or reconnect builds
 * a fresh ref for a scope that is already wired; without the rebind the picker
 * would show that ref while prompt assembly and request routing still read the
 * one before it, sending the request to a model the user did not choose.
 */
const wiredSelections = new WeakMap<Context, WiredSelection>()

/**
 * Couple one mutable selection to Agent-scoped prompt assembly and request routing.
 * Prompt assembly snapshots the selected model before delegating, then applies
 * its provider/model pair and effort to request config so a
 * concurrent switch takes effect on a later step instead of splitting the two
 * surfaces. An absent selected effort clears any inherited effort, restoring
 * the selected model's provider/default behavior.
 *
 * @param agentCtx - The selected Agent's scoped context.
 * @param selection - Mutable selection owned by the calling entry point.
 * @returns Disposer for both scoped waterfall listeners.
 */
export function installModelSelection(agentCtx: Context, selection: ModelSelectionRef): () => void {
  const wired = wiredSelections.get(agentCtx)
  if (wired !== undefined) {
    const previous = wired.ref
    // A step that already assembled captured its selection on the previous ref;
    // carry it so `agent/request` still routes that step to the model its own
    // prompt described.
    selection.assembled ??= previous.assembled
    wired.ref = selection
    return () => {
      if (wired.ref === selection) wired.ref = previous
    }
  }
  const holder: WiredSelection = { ref: selection }
  wiredSelections.set(agentCtx, holder)
  // Declaring an accessor twice on one scope is a hard cordis error, and the
  // accessor unwinds with the scope's fiber rather than with this disposer, so a
  // scope that still exposes `modelSelection` keeps the declaration it has. The
  // getter reads through the holder, so it follows a rebind and reports nothing
  // once the wiring is disposed.
  if (!('modelSelection' in agentCtx)) {
    agentCtx.accessor('modelSelection', {
      get: () => wiredSelections.get(agentCtx)?.ref.current,
    })
  }
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const active = holder.ref
    const selected = active.current
    const assembled = await next()
    active.assembled = selected
    if (selected === undefined) return assembled
    return {
      ...assembled,
      variables: {
        ...assembled.variables,
        provider: selected.provider,
        model: selected.model,
      },
    }
  })
  const disposeRequest = agentCtx.on(
    'agent/request',
    async (_payload, next): Promise<LlmCallConfig> => {
      const resolved = await next()
      const selected = holder.ref.assembled
      if (selected === undefined) return resolved
      const { reasoningEffort: _inheritedEffort, ...withoutInheritedEffort } = resolved
      return {
        ...withoutInheritedEffort,
        provider: selected.provider,
        model: selected.model,
        ...selected.reasoningEffort === undefined
          ? {}
          : { reasoningEffort: selected.reasoningEffort },
      }
    },
  )
  return () => {
    if (wiredSelections.get(agentCtx) === holder) wiredSelections.delete(agentCtx)
    disposeAssembly()
    disposeRequest()
  }
}


declare module '@deepseek-ai/cordis' {
  interface Context {
    /**
     * Live provider/model selection for the Agent owning this scoped context,
     * resolved through the entry point's precedence (picker switch, logged
     * request header, deployment default). Absent when no selection is
     * installed for this scope.
     */
    modelSelection?: ModelSelection | undefined
  }
}
