/**
 * The Tools settings section: the kernel, RLM, and conventional-tool switches.
 *
 * All three are live fields of the `tool-roster` row, read and written through
 * that row's config form. Choosing individual tools for an agent is the preset
 * editor's job, so this section only carries what a preset cannot express: the
 * kernel lives on the host plane in every preset, and the conventional-tools
 * switch withdraws a whole category at once.
 *
 * Nothing here needs the harness restarted: `tool-roster` applies a change at
 * the end of the turn in flight, which is why the section says so rather than
 * offering a restart.
 */
import { useCallback, useState, useSyncExternalStore } from 'react'
import { Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ToolsKey } from './locales.ts'
import css from './ToolsSection.module.css'

/** The `tool-roster` row's live fields as this section reads them. */
export interface RosterFields {
  /** Whether the kernel tool is available. */
  kernel?: boolean
  /** Whether the RLM engine replaces the standalone kernel tool. */
  rlm?: boolean
  /** Whether the conventional tool category is available. */
  enabled?: boolean
}

/** The copy each switch renders, keyed by the field it writes. */
const ROW_COPY = {
  kernel: { label: 'tools.kernel.label', hint: 'tools.kernel.hint' },
  rlm: { label: 'tools.rlm.label', hint: 'tools.rlm.hint' },
  enabled: { label: 'tools.category.label', hint: 'tools.category.hint' },
} as const satisfies Record<keyof RosterFields, { label: ToolsKey; hint: ToolsKey }>

/** Injected business face: the roster row's config form. */
export interface ToolsSectionInjected {
  /** Live form over the `tool-roster` row. */
  form: ConfigForm<RosterFields>
}

/** Full component props: runtime share + locale seat + injected face. */
export type ToolsSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'tools'> & ToolsSectionInjected

/**
 * Render the Tools section.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function ToolsSection({ t, form }: ToolsSectionComponentProps) {
  const snapshot = useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)

  const set = useCallback(async (field: keyof RosterFields, next: boolean): Promise<void> => {
    setPending(true)
    const saved = await form.set(field, next)
    setPending(false)
    setFailed(!saved)
  }, [form])

  const value = snapshot.value
  const ready = snapshot.status === 'ready' && value !== undefined
  const kernelOn = value?.kernel ?? true
  const rlmOn = value?.rlm ?? false
  const categoryOn = value?.enabled ?? true
  const busy = pending || !ready || !snapshot.writable

  const row = (field: keyof RosterFields, checked: boolean, disabled: boolean) => (
    <div className={css.row}>
      <span className={css.text}>
        <span className={css.label}>{t(ROW_COPY[field].label)}</span>
        <span className={css.hint}>{t(ROW_COPY[field].hint)}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        label={t(ROW_COPY[field].label)}
        onChange={(next) => { void set(field, next) }}
      />
    </div>
  )

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('tools.intro')}</p>
      {snapshot.status === 'unavailable' && <div className={css.error} role="alert">{t('tools.loadError')}</div>}
      {failed && <div className={css.error} role="alert">{t('tools.writeError')}</div>}
      {pending && <div className={css.notice} role="status">{t('tools.pending')}</div>}

      <div className={css.group}>
        {row('kernel', kernelOn, busy)}
        {row('rlm', rlmOn, busy || !kernelOn)}
        {row('enabled', categoryOn, busy)}
      </div>

      <p className={css.hint}>{t('tools.presets.hint')}</p>
    </div>
  )
}
