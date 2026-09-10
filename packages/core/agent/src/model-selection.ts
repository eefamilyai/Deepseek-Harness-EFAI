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
  // DSH-FORK(fix): fork edit on an upstream-owned file. EXIT: upstream lands the accessor re-entrancy guard (upstream PR).
  // Declaring an accessor twice on one scope is a hard cordis error, and a
  // resume or reconnect can re-enter setup on the SAME agent context before the
  // previous attempt's fiber has unwound its accessor — which crashed the whole
  // resume with `property "modelSelection" is already declared as accessor`. A
  // scope that already exposes `modelSelection` is already wired (accessor and
  // both listeners came in together and unwind together), so adopt it rather
  // than redeclare. The check reads the same per-scope prop table `accessor`
  // writes to, so it is true only for a genuine same-scope re-entry.
  if ('modelSelection' in agentCtx) return () => {}
  agentCtx.accessor('modelSelection', {
    get: () => selection.current,
  })
  const disposeAssembly = agentCtx.on('system-prompt/assemble', async (_assembly, _context, next) => {
    const selected = selection.current
    const assembled = await next()
    selection.assembled = selected
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
      const selected = selection.assembled
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
