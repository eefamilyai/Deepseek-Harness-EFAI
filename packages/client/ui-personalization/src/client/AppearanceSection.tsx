/**
 * The Personalization settings section.
 *
 * One row per appearance field. Every value arrives as a framework-bound selector hook
 * over the appearance policy's stores, and every control writes back through an injected
 * callback, so the component holds no subscription of its own and the page repaints in
 * the same step the control moves. The engine that turns those values into token
 * overrides is `appearance.ts`; this file is only the form over it.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/AppearanceSection
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, Pill } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import { opacityPercent, type AppearanceValues } from './appearance.ts'
import css from './AppearanceSection.module.css'
import type { AppearanceKey } from './locales.ts'

/** The row's live fields, as the client reads them. */
export type AppearanceFields = Partial<AppearanceValues>

/** Injected face: the appearance policy's stores and the writes that move them. */
export interface AppearanceSectionInjected {
  /** Whether this deployment composes the row the section edits. */
  status: 'ready' | 'unavailable'
  /** Live values, one store per field, bound as `use<Name>` selector hooks. */
  hooks: {
    fontFamily: SnapshotStore<string>
    fontScale: SnapshotStore<number>
    accent: SnapshotStore<string>
    radiusScale: SnapshotStore<number>
    shellOpacity: SnapshotStore<number>
    surfaceOpacity: SnapshotStore<number>
    panelOpacity: SnapshotStore<number>
  }
  /** Set the interface font stack. */
  setFontFamily: (value: string) => void
  /** Set the root font size percentage. */
  setFontScale: (value: number) => void
  /** Set the accent colour. */
  setAccent: (value: string) => void
  /** Set the corner-radius multiplier. */
  setRadiusScale: (value: number) => void
  /** Set the window opacity percentage. */
  setShellOpacity: (value: number) => void
  /** Set the content-surface opacity percentage. */
  setSurfaceOpacity: (value: number) => void
  /** Set the settings-panel opacity percentage. */
  setPanelOpacity: (value: number) => void
  /** Restore every field to the deployment default. */
  reset: () => void
}

/** Full component props: runtime share + locale seat + the injected policy face. */
export type AppearanceSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'appearance'> & InjectFace<AppearanceSectionInjected>

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
export function AppearanceSection({
  t, status, reset,
  setFontFamily, setFontScale, setAccent, setRadiusScale, setShellOpacity, setSurfaceOpacity, setPanelOpacity,
  useFontFamily, useFontScale, useAccent, useRadiusScale, useShellOpacity, useSurfaceOpacity, usePanelOpacity,
}: AppearanceSectionComponentProps): ReactNode {
  const values: AppearanceValues = {
    fontFamily: useFontFamily(value => value),
    fontScale: useFontScale(value => value),
    accent: useAccent(value => value),
    radiusScale: useRadiusScale(value => value),
    shellOpacity: useShellOpacity(value => value),
    surfaceOpacity: useSurfaceOpacity(value => value),
    panelOpacity: usePanelOpacity(value => value),
  }
  const locked = status !== 'ready'
  const write = (fields: AppearanceFields): void => {
    if (fields.fontFamily !== undefined) setFontFamily(fields.fontFamily)
    if (fields.fontScale !== undefined) setFontScale(fields.fontScale)
    if (fields.accent !== undefined) setAccent(fields.accent)
    if (fields.radiusScale !== undefined) setRadiusScale(fields.radiusScale)
    if (fields.shellOpacity !== undefined) setShellOpacity(fields.shellOpacity)
    if (fields.surfaceOpacity !== undefined) setSurfaceOpacity(fields.surfaceOpacity)
    if (fields.panelOpacity !== undefined) setPanelOpacity(fields.panelOpacity)
  }

  if (status !== 'ready') {
    return <p className={css.hint}>{t('appearance.unavailable')}</p>
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
          <Button variant="outline" onClick={() => { reset() }}>
            {t('appearance.reset.action')}
          </Button>
        )}
      />
    </div>
  )
}
