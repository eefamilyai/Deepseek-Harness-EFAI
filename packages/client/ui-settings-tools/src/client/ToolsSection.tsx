/**
 * The Tools settings section: two independent category switches plus one switch
 * per registered tool.
 *
 * The tool list is not written down here. `tool-roster` seeds the `tools`
 * namespace's composition layer with one entry per tool it found in the
 * registry, so the names arrive with the settings descriptor and a tool added
 * by another package appears without a change to this file.
 *
 * Nothing here needs the harness restarted: `tool-roster` applies a change at
 * the end of the turn in flight, which is why the section says so rather than
 * offering a restart.
 */
import { useCallback, useEffect, useState } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type {} from '@deepseek-ai/dsh-client-ui-settings/client'
import css from './ToolsSection.module.css'

/** The `tools` namespace section as this component reads it. */
export interface ToolsNamespaceValue {
  /** Whether the conventional tool category is available. */
  enabled?: boolean
  /** Per-tool overrides; a name absent here is enabled. */
  tools?: Record<string, boolean>
}

/** The `kernel` namespace section as this component reads it. */
export interface KernelNamespaceValue {
  /** Whether the kernel tool is available. */
  enabled?: boolean
}

/** One namespace snapshot plus the revision fencing the next write. */
export interface NamespaceSnapshot<T> {
  /** The resolved section, or undefined before the first read. */
  value: T | undefined
  /** The composition layer, which is where the per-tool name list lives. */
  base: unknown
  /** Optimistic-concurrency fence for the next write. */
  revision: number
}

/** Injected business face: the settings reads and writes this section needs. */
export interface ToolsSectionInjected {
  /**
   * Read one settings namespace.
   * @param ns - settings namespace name.
   * @returns its snapshot, or undefined when the read failed.
   */
  read: <T>(ns: string) => Promise<NamespaceSnapshot<T> | undefined>
  /**
   * Write one settings namespace section.
   * @param ns - settings namespace name.
   * @param section - the section to store.
   * @param revision - the fence the read observed.
   * @returns a failure message, or undefined on success.
   */
  write: (ns: string, section: Record<string, unknown>, revision: number) => Promise<string | undefined>
}

/** Full component props: runtime share + locale seat + injected face. */
export type ToolsSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'tools'> & ToolsSectionInjected

/** Normalize a tool name the same way the Host roster does. */
function normalize(toolName: string): string {
  return toolName.replace(/-/g, '_')
}

/** Collect the tool names the composition layer and the user layer together name. */
function toolNames(base: unknown, value: ToolsNamespaceValue | undefined): string[] {
  const names = new Set<string>()
  const baseTools = (base as { tools?: Record<string, boolean> } | undefined)?.tools
  for (const name of Object.keys(baseTools ?? {})) names.add(name)
  for (const name of Object.keys(value?.tools ?? {})) names.add(name)
  names.delete('kernel')
  return [...names].sort((a, b) => a.localeCompare(b))
}

/**
 * Render the Tools section.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function ToolsSection({ t, read, write }: ToolsSectionComponentProps) {
  const [tools, setTools] = useState<NamespaceSnapshot<ToolsNamespaceValue>>()
  const [kernel, setKernel] = useState<NamespaceSnapshot<KernelNamespaceValue>>()
  const [error, setError] = useState<string>()
  const [pending, setPending] = useState(false)

  const load = useCallback(async (): Promise<void> => {
    const [nextTools, nextKernel] = await Promise.all([
      read<ToolsNamespaceValue>('tools'),
      read<KernelNamespaceValue>('kernel'),
    ])
    if (nextTools === undefined || nextKernel === undefined) {
      setError(t('tools.loadError'))
      return
    }
    setError(undefined)
    setTools(nextTools)
    setKernel(nextKernel)
  }, [read, t])

  useEffect(() => { void load() }, [load])

  const commit = useCallback(
    async (ns: string, section: Record<string, unknown>, revision: number): Promise<void> => {
      setPending(true)
      const failure = await write(ns, section, revision)
      setPending(false)
      if (failure !== undefined) {
        setError(failure)
        await load()
        return
      }
      setError(undefined)
      await load()
    },
    [write, load],
  )

  const toolsValue = tools?.value
  const categoryOn = toolsValue?.enabled ?? true
  const kernelOn = kernel?.value?.enabled ?? true
  const names = toolNames(tools?.base, toolsValue)

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('tools.intro')}</p>
      {error !== undefined && <div className={css.error} role="alert">{error}</div>}
      {pending && <div className={css.notice} role="status">{t('tools.pending')}</div>}

      <div className={css.group}>
        <span className={css.groupLabel}>{t('tools.group.categories')}</span>

        <div className={css.row}>
          <span className={css.text}>
            <span className={css.label}>{t('tools.kernel.label')}</span>
            <span className={css.hint}>{t('tools.kernel.hint')}</span>
          </span>
          <Switch
            checked={kernelOn}
            disabled={pending || kernel === undefined}
            label={t('tools.kernel.label')}
            onChange={(next) => {
              if (kernel === undefined) return
              void commit('kernel', { ...kernel.value, enabled: next }, kernel.revision)
            }}
          />
        </div>

        <div className={css.row}>
          <span className={css.text}>
            <span className={css.label}>{t('tools.category.label')}</span>
            <span className={css.hint}>{t('tools.category.hint')}</span>
          </span>
          <Switch
            checked={categoryOn}
            disabled={pending || tools === undefined}
            label={t('tools.category.label')}
            onChange={(next) => {
              if (tools === undefined) return
              void commit('tools', { ...tools.value, enabled: next }, tools.revision)
            }}
          />
        </div>
      </div>

      {categoryOn && names.length > 0 && (
        <div className={css.group}>
          <span className={css.groupLabel}>{t('tools.group.tools')}</span>
          <span className={css.hint}>{t('tools.perTool.hint')}</span>
          <div className={css.subList}>
            {names.map((name) => {
              const on = toolsValue?.tools?.[normalize(name)] !== false
              return (
                <div key={name} className={css.row}>
                  <span className={css.text}>
                    <span className={`${css.label} ${css.toolName}`}>{name}</span>
                  </span>
                  <Switch
                    checked={on}
                    disabled={pending || tools === undefined}
                    label={name}
                    onChange={(next) => {
                      if (tools === undefined) return
                      const overrides = { ...toolsValue?.tools, [normalize(name)]: next }
                      void commit('tools', { ...toolsValue, tools: overrides }, tools.revision)
                    }}
                  />
                </div>
              )
            })}
          </div>
        </div>
      )}

      {categoryOn && names.length === 0 && <p className={css.hint}>{t('tools.empty')}</p>}
    </div>
  )
}
