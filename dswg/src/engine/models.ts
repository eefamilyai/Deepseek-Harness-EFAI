/**
 * Client-facing model ids and the upstream toggles they mean.
 *
 * The web product exposes one model with two switches (thinking, web search), so
 * a model id here is really a mode. The list is also what `/v1/models` reports,
 * which is why retired ids still resolve: a saved client keeps working when the
 * catalogue is trimmed.
 *
 * @module dswg/engine/models
 */

/** One advertised mode. */
export interface ModelMode {
  id: string
  label: string
  thinking: boolean
  search: boolean
  default: boolean
  /** Upstream `model_type` field. */
  modelType: string
}

/** The advertised catalogue, in display order. */
export const MODES: readonly ModelMode[] = [
  { id: 'deepseek-chat', label: 'DeepSeek Instant', thinking: false, search: false, default: true, modelType: 'default' },
  { id: 'deepseek-reasoner', label: 'DeepSeek Thinking', thinking: true, search: false, default: false, modelType: 'default' },
  { id: 'deepseek-search', label: 'DeepSeek Search', thinking: false, search: true, default: false, modelType: 'default' },
  {
    id: 'deepseek-reasoner-search',
    label: 'DeepSeek Thinking + Search',
    thinking: true,
    search: true,
    default: false,
    modelType: 'default',
  },
]

/** Aliases accepted for compatibility with older clients and other proxies. */
const ALIASES: Record<string, string> = {
  'deepseek': 'deepseek-chat',
  'deepseek-v3': 'deepseek-chat',
  'deepseek-v3.2': 'deepseek-chat',
  'deepseek-instant': 'deepseek-chat',
  'deepseek-default': 'deepseek-chat',
  'deepseek-thinking': 'deepseek-reasoner',
  'deepseek-r1': 'deepseek-reasoner',
  'deepseek-expert': 'deepseek-reasoner',
  'deepseek-online': 'deepseek-search',
  'deepseek-thinking-search': 'deepseek-reasoner-search',
  'deepseek-reasoner-online': 'deepseek-reasoner-search',
}

/**
 * Resolve a client model id to a mode.
 * @param model - the id the client asked for; null/undefined selects the default.
 * @returns the mode.
 */
export function resolveMode(model: string | null | undefined): ModelMode {
  const wanted = (model ?? '').trim().toLowerCase()
  if (wanted.length === 0) return MODES[0] as ModelMode
  const direct = MODES.find((mode) => mode.id === wanted)
  if (direct) return direct
  const alias = ALIASES[wanted]
  if (alias) return MODES.find((mode) => mode.id === alias) as ModelMode
  // `provider/model` prefixes are common in OpenAI-compatible clients.
  const tail = wanted.includes('/') ? (wanted.split('/').pop() as string) : wanted
  const tailHit = MODES.find((mode) => mode.id === tail) ?? (ALIASES[tail] ? MODES.find((mode) => mode.id === ALIASES[tail]) : undefined)
  if (tailHit) return tailHit
  return MODES[0] as ModelMode
}

/**
 * Every advertised model id, including the default.
 * @returns the ids.
 */
export function modelIds(): string[] {
  return MODES.map((mode) => mode.id)
}
