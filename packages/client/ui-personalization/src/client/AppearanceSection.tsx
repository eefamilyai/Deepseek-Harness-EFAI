/**
 * The Personalization settings section.
 *
 * One row per appearance field, each writing its own live field of this plugin's
 * row, so the page changes as the control moves and the profile remembers it. The
 * engine that turns those values into token overrides is `appearance.ts`; this file
 * is only the form over it.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/AppearanceSection
 */

import { useMemo, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConfigForm } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { APPEARANCE_DEFAULTS, opacityPercent, type AppearanceValues } from './appearance.ts'
import css from './AppearanceSection.module.css'
import type { AppearanceKey } from './locales.ts'

/** The row's live fields, as the client reads them. */
export type AppearanceFields = Partial<AppearanceValues>

/** Injected face: the live config form over this plugin's own row. */
export interface AppearanceSectionInjected {
  /** Live form over the personalization row. */
  appearance: ConfigForm<AppearanceFields>
}

/** Full component props: runtime share + locale seat + the injected form. */
export type AppearanceSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'appearance'> & AppearanceSectionInjected

/** One write pump: reports failure instead of throwing, and serialises. */
interface Writer {
  failed: boolean
  pending: boolean
  write: (fields: AppearanceFields) => void
}

/**
 * A write pump over one form.
 * @param form - the form to write through.
 * @returns its writer state and the write call.
 */
function useWriter(form: ConfigForm<AppearanceFields>): Writer {
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const { write } = useMemo(() => ({
    write: (fields: AppearanceFields): void => {
      setPending(true)
      void form.mutate(Object.entries(fields).map(([field, value]) => ({
        op: 'set' as const,
        path: [field],
        value: value as never,
      }))).then((saved) => {
        setPending(false)
        setFailed(!saved)
      })
    },
  }), [form])
  return { failed, pending, write }
}

/** A titled row: label and hint on the left, control on the right. */
function Row({ label, hint, control, presets }: {
  label: string
  hint: string
  control: ReactNode
  presets?: ReactNode
}) {
  return (
    <div className={css.row}>
      <span className={css.text}>
        <span className={css.label}>{label}</span>
        <span className={css.hint}>{hint}</span>
        {presets === undefined ? null : <span className={css.presets}>{presets}</span>}
      </span>
      <span className={css.control}>{control}</span>
    </div>
  )
}

/** A number field that commits on blur or Enter, so a half-typed value is never written. */
function NumberField({ value, min, max, step, disabled, label, suffix, onCommit }: {
  value: number
  min: number
  max: number
  step: number
  disabled: boolean
  label: string
  suffix?: string
  onCommit: (next: number) => void
}) {
  const [draft, setDraft] = useState(String(value))
  const [editing, setEditing] = useState(false)
  const shown = editing ? draft : String(value)
  const commit = (): void => {
    setEditing(false)
    const parsed = Number(draft)
    if (!Number.isFinite(parsed)) return
    const clamped = Math.min(max, Math.max(min, parsed))
    if (clamped !== value) onCommit(clamped)
  }
  return (
    <span className={css.numberWrap}>
      <Input
        className={css.number ?? ''}
        type="number"
        min={min}
        max={max}
        step={step}
        value={shown}
        disabled={disabled}
        aria-label={label}
        onChange={(event) => { setEditing(true); setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
      {suffix === undefined ? null : <span className={css.suffix}>{suffix}</span>}
    </span>
  )
}

/** A text field that commits on blur or Enter. */
function TextField({ value, disabled, label, placeholder, onCommit }: {
  value: string
  disabled: boolean
  label: string
  placeholder: string
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const commit = (): void => {
    setEditing(false)
    if (draft !== value) onCommit(draft)
  }
  return (
    <Input
      className={css.wide ?? ''}
      value={editing ? draft : value}
      disabled={disabled}
      aria-label={label}
      placeholder={placeholder}
      onChange={(event) => { setEditing(true); setDraft(event.target.value) }}
      onBlur={commit}
      onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
    />
  )
}

/** The font stacks the preset pills write. */
const FONT_PRESETS: readonly { key: AppearanceKey; value: string }[] = [
  { key: 'appearance.fontPreset.system', value: '' },
  { key: 'appearance.fontPreset.sans', value: '"Inter", "Segoe UI", system-ui, sans-serif' },
  { key: 'appearance.fontPreset.serif', value: 'Georgia, "Times New Roman", serif' },
  { key: 'appearance.fontPreset.mono', value: '"JetBrains Mono", "Cascadia Code", ui-monospace, monospace' },
]

/** The opacity presets both opacity rows offer. */
const OPACITY_PRESETS: readonly { key: AppearanceKey; value: number }[] = [
  { key: 'appearance.opacity.solid', value: 100 },
  { key: 'appearance.opacity.soft', value: 85 },
  { key: 'appearance.opacity.glass', value: 65 },
  { key: 'appearance.opacity.clear', value: 45 },
]

/** The accents the preset pills write. */
const ACCENT_PRESETS: readonly { key: AppearanceKey; value: string }[] = [
  { key: 'appearance.accentPreset.deepseek', value: '' },
  { key: 'appearance.accentPreset.violet', value: '#7c5cff' },
  { key: 'appearance.accentPreset.emerald', value: '#10b981' },
  { key: 'appearance.accentPreset.amber', value: '#f59e0b' },
  { key: 'appearance.accentPreset.rose', value: '#f43f5e' },
]

/**
 * Render the Personalization section.
 * @param props - the runtime share, the locale seat, and the injected form.
 * @returns the section.
 */
export function AppearanceSection({ t, appearance }: AppearanceSectionComponentProps): ReactNode {
  const snapshot = useSyncExternalStore(appearance.subscribe.bind(appearance), appearance.getSnapshot.bind(appearance))
  const writer = useWriter(appearance)
  const values: AppearanceValues = { ...APPEARANCE_DEFAULTS, ...snapshot.value }
  const locked = writer.pending || snapshot.status === 'ready' ? false : true
  const write = (fields: AppearanceFields): void => { writer.write(fields) }

  if (snapshot.status !== 'ready') {
    return <p className={css.hint}>{t(snapshot.status === 'loading' ? 'appearance.loading' : 'appearance.unavailable')}</p>
  }

  return (
    <div className={css.rows}>
      <Row
        label={t('appearance.font.label')}
        hint={t('appearance.font.hint')}
        control={(
          <TextField
            value={values.fontFamily}
            disabled={locked}
            label={t('appearance.font.label')}
            placeholder={t('appearance.font.placeholder')}
            onCommit={(next) => { write({ fontFamily: next }) }}
          />
        )}
        presets={FONT_PRESETS.map(preset => (
          <Pill
            key={preset.key}
            active={values.fontFamily === preset.value}
            onClick={() => { write({ fontFamily: preset.value }) }}
          >
            {t(preset.key)}
          </Pill>
        ))}
      />
      <Row
        label={t('appearance.fontScale.label')}
        hint={t('appearance.fontScale.hint')}
        control={(
          <NumberField
            value={values.fontScale}
            min={80}
            max={150}
            step={5}
            disabled={locked}
            label={t('appearance.fontScale.label')}
            onCommit={(next) => { write({ fontScale: next }) }}
          />
        )}
      />
      <Row
        label={t('appearance.accent.label')}
        hint={t('appearance.accent.hint')}
        control={(
          <TextField
            value={values.accent}
            disabled={locked}
            label={t('appearance.accent.label')}
            placeholder={t('appearance.accent.placeholder')}
            onCommit={(next) => { write({ accent: next }) }}
          />
        )}
        presets={ACCENT_PRESETS.map(preset => (
          <Pill
            key={preset.key}
            active={values.accent === preset.value}
            onClick={() => { write({ accent: preset.value }) }}
          >
            {t(preset.key)}
          </Pill>
        ))}
      />
      <Row
        label={t('appearance.radius.label')}
        hint={t('appearance.radius.hint')}
        control={(
          <NumberField
            value={values.radiusScale}
            min={0}
            max={2.5}
            step={0.25}
            disabled={locked}
            label={t('appearance.radius.label')}
            onCommit={(next) => { write({ radiusScale: next }) }}
          />
        )}
      />
      <p className={css.groupLabel}>{t('appearance.opacity.title')}</p>
      <Row
        label={t('appearance.shell.label')}
        hint={t('appearance.shell.hint')}
        control={(
          <NumberField
            value={opacityPercent(values.shellOpacity)}
            min={35}
            max={100}
            step={5}
            disabled={locked}
            label={t('appearance.shell.label')}
            suffix="%"
            onCommit={(next) => { write({ shellOpacity: next }) }}
          />
        )}
        presets={OPACITY_PRESETS.map(preset => (
          <Pill
            key={preset.key}
            active={opacityPercent(values.shellOpacity) === preset.value}
            onClick={() => { write({ shellOpacity: preset.value }) }}
          >
            {t(preset.key)}
          </Pill>
        ))}
      />
      <Row
        label={t('appearance.surface.label')}
        hint={t('appearance.surface.hint')}
        control={(
          <NumberField
            value={opacityPercent(values.surfaceOpacity)}
            min={35}
            max={100}
            step={5}
            disabled={locked}
            label={t('appearance.surface.label')}
            suffix="%"
            onCommit={(next) => { write({ surfaceOpacity: next }) }}
          />
        )}
        presets={OPACITY_PRESETS.map(preset => (
          <Pill
            key={preset.key}
            active={opacityPercent(values.surfaceOpacity) === preset.value}
            onClick={() => { write({ surfaceOpacity: preset.value }) }}
          >
            {t(preset.key)}
          </Pill>
        ))}
      />
      <Row
        label={t('appearance.panel.label')}
        hint={t('appearance.panel.hint')}
        control={(
          <NumberField
            value={opacityPercent(values.panelOpacity)}
            min={35}
            max={100}
            step={5}
            disabled={locked}
            label={t('appearance.panel.label')}
            suffix="%"
            onCommit={(next) => { write({ panelOpacity: next }) }}
          />
        )}
        presets={OPACITY_PRESETS.map(preset => (
          <Pill
            key={preset.key}
            active={opacityPercent(values.panelOpacity) === preset.value}
            onClick={() => { write({ panelOpacity: preset.value }) }}
          >
            {t(preset.key)}
          </Pill>
        ))}
      />
      <Row
        label={t('appearance.reset')}
        hint={t('appearance.reset.hint')}
        control={(
          <Button variant="outline" onClick={() => { write(APPEARANCE_DEFAULTS) }}>
            {t('appearance.reset.action')}
          </Button>
        )}
      />
      {writer.failed ? <p className={css.failed}>{t('appearance.failed')}</p> : null}
    </div>
  )
}
