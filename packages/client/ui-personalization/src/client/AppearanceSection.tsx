/**
 * The Personalization settings section.
 *
 * Five groups of rows — typography, colour, layout, transparency, effects — over one
 * live record. The record arrives as a framework-bound selector hook over the
 * appearance policy's snapshot, and every control writes back through one injected
 * callback, so the component holds no subscription of its own and the page repaints
 * in the same step the control moves. The engine that turns the record into token
 * overrides is `appearance.ts`; this file is only the form over it.
 *
 * @module @deepseek-ai/dsh-client-ui-personalization/AppearanceSection
 */

import { useState, type ReactNode } from 'react'
import { Button, Input, Pill, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import type { InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import {
  APPEARANCE_RANGES, BACKDROPS, CONTENT_WIDTHS, SCROLLBAR_STYLES, SETTINGS_WIDTHS, SHADOW_STRENGTHS,
  type AppearanceField, type AppearanceValues, type Backdrop,
} from '../options.ts'
import { BACKDROP_GRADIENTS, usableImageUrl } from './appearance.ts'
import type { AppearanceRowStatus, AppearanceSaveState } from './appearance-store.ts'
import css from './AppearanceSection.module.css'
import type { AppearanceKey } from './locales.ts'

/** The row's live fields, as the client reads them. */
export type AppearanceFields = Partial<AppearanceValues>

/** Injected face: the appearance policy's snapshot and the writes that move it. */
export interface AppearanceSectionInjected {
  /** Live values, bound as `use<Name>` selector hooks. */
  hooks: {
    appearance: SnapshotStore<AppearanceValues>
    saveState: SnapshotStore<AppearanceSaveState>
    /** Whether this deployment composes the row the section edits; `loading` until the Host answers. */
    rowStatus: SnapshotStore<AppearanceRowStatus>
  }
  /** Write one field. */
  set: <K extends AppearanceField>(field: K, value: AppearanceValues[K]) => void
  /** Restore every field to the deployment default. */
  reset: () => void
}

/** Full component props: runtime share + locale seat + the injected policy face. */
export type AppearanceSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'appearance'> & InjectFace<AppearanceSectionInjected>

/** The translator this section renders with. */
type Translate = AppearanceSectionComponentProps['t']

/** A titled group of rows. */
function Group({ title, children }: { title: string; children: ReactNode }) {
  return (
    <section className={css.group} aria-label={title}>
      <h3 className={css.groupTitle}>{title}</h3>
      <div className={css.groupRows}>{children}</div>
    </section>
  )
}

/** A titled row: label and hint on the left, control on the right, choices underneath. */
function Row({ label, hint, control, presets }: {
  label: string
  hint: string
  control?: ReactNode
  presets?: ReactNode
}) {
  return (
    <div className={css.row}>
      <div className={css.rowHead}>
        <span className={css.text}>
          <span className={css.label}>{label}</span>
          <span className={css.hint}>{hint}</span>
        </span>
        {control === undefined ? null : <span className={css.control}>{control}</span>}
      </div>
      {presets === undefined ? null : <div className={css.presets}>{presets}</div>}
    </div>
  )
}

/** A number field that commits on blur or Enter, so a half-typed value is never written. */
function NumberField({ value, min, max, step, label, suffix, onCommit }: {
  value: number
  min: number
  max: number
  step: number
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
function TextField({ value, label, placeholder, invalid, onCommit }: {
  value: string
  label: string
  placeholder: string
  invalid?: string | undefined
  onCommit: (next: string) => void
}) {
  const [draft, setDraft] = useState(value)
  const [editing, setEditing] = useState(false)
  const commit = (): void => {
    setEditing(false)
    if (draft !== value) onCommit(draft)
  }
  return (
    <span className={css.textWrap}>
      <Input
        className={css.wide ?? ''}
        value={editing ? draft : value}
        aria-label={label}
        aria-invalid={invalid === undefined ? undefined : true}
        placeholder={placeholder}
        onChange={(event) => { setEditing(true); setDraft(event.target.value) }}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') commit() }}
      />
      {invalid === undefined ? null : <span className={css.invalid} role="alert">{invalid}</span>}
    </span>
  )
}

/** One choice a preset pill writes. */
interface Preset<V> { readonly key: AppearanceKey; readonly value: V }

/** A row of preset pills for one field. */
function Presets<V>({ presets, current, t, onPick }: {
  presets: readonly Preset<V>[]
  current: V
  t: Translate
  onPick: (value: V) => void
}) {
  return presets.map(preset => (
    <Pill
      key={preset.key}
      active={current === preset.value}
      aria-pressed={current === preset.value}
      onClick={() => { onPick(preset.value) }}
    >
      {t(preset.key)}
    </Pill>
  ))
}

/** Pills for every member of an option vocabulary, labelled `<prefix>.<member>`. */
function choices<V extends string>(members: readonly V[], prefix: string): readonly Preset<V>[] {
  return members.map(value => ({ key: `${prefix}.${value}` as AppearanceKey, value }))
}

/** The font stacks the interface-font pills write. */
const FONT_PRESETS: readonly Preset<string>[] = [
  { key: 'appearance.fontPreset.system', value: '' },
  { key: 'appearance.fontPreset.segoe', value: '"Segoe UI Variable Text", "Segoe UI", system-ui, sans-serif' },
  { key: 'appearance.fontPreset.inter', value: '"Inter", "Segoe UI", system-ui, sans-serif' },
  { key: 'appearance.fontPreset.rounded', value: '"Nunito", "Varela Round", "Quicksand", "Segoe UI", sans-serif' },
  { key: 'appearance.fontPreset.humanist', value: '"Gill Sans", "Calibri", "Trebuchet MS", sans-serif' },
  { key: 'appearance.fontPreset.condensed', value: '"Bahnschrift", "Roboto Condensed", "Arial Narrow", sans-serif' },
  { key: 'appearance.fontPreset.serif', value: '"Georgia", "Cambria", "Times New Roman", serif' },
  { key: 'appearance.fontPreset.mono', value: '"JetBrains Mono", "Cascadia Code", "Consolas", monospace' },
]

/** The font stacks the code-font pills write. */
const CODE_FONT_PRESETS: readonly Preset<string>[] = [
  { key: 'appearance.codeFontPreset.default', value: '' },
  { key: 'appearance.codeFontPreset.cascadia', value: '"Cascadia Code", "Cascadia Mono", "Consolas"' },
  { key: 'appearance.codeFontPreset.jetbrains', value: '"JetBrains Mono", "Cascadia Code", "Consolas"' },
  { key: 'appearance.codeFontPreset.consolas', value: '"Consolas", "Courier New"' },
  { key: 'appearance.codeFontPreset.fira', value: '"Fira Code", "Cascadia Code", "Consolas"' },
]

/** Root font size steps. */
const FONT_SCALE_PRESETS: readonly Preset<number>[] = [
  { key: 'appearance.fontScale.small', value: 90 },
  { key: 'appearance.fontScale.default', value: 100 },
  { key: 'appearance.fontScale.large', value: 110 },
  { key: 'appearance.fontScale.larger', value: 125 },
]

/** Line spacing steps. */
const LINE_HEIGHT_PRESETS: readonly Preset<number>[] = [
  { key: 'appearance.lineHeight.compact', value: 90 },
  { key: 'appearance.lineHeight.default', value: 100 },
  { key: 'appearance.lineHeight.relaxed', value: 120 },
  { key: 'appearance.lineHeight.airy', value: 145 },
]

/** The accents the swatches write; the DeepSeek swatch clears the field back to the theme's accent. */
const ACCENT_PRESETS: readonly { key: AppearanceKey; value: string; swatch: string }[] = [
  { key: 'appearance.accentPreset.deepseek', value: '', swatch: 'var(--dsw-static-deepseek-500)' },
  { key: 'appearance.accentPreset.blue', value: '#3b82f6', swatch: '#3b82f6' },
  { key: 'appearance.accentPreset.sky', value: '#0ea5e9', swatch: '#0ea5e9' },
  { key: 'appearance.accentPreset.cyan', value: '#06b6d4', swatch: '#06b6d4' },
  { key: 'appearance.accentPreset.teal', value: '#14b8a6', swatch: '#14b8a6' },
  { key: 'appearance.accentPreset.emerald', value: '#10b981', swatch: '#10b981' },
  { key: 'appearance.accentPreset.lime', value: '#84cc16', swatch: '#84cc16' },
  { key: 'appearance.accentPreset.amber', value: '#f59e0b', swatch: '#f59e0b' },
  { key: 'appearance.accentPreset.orange', value: '#f97316', swatch: '#f97316' },
  { key: 'appearance.accentPreset.rose', value: '#f43f5e', swatch: '#f43f5e' },
  { key: 'appearance.accentPreset.pink', value: '#ec4899', swatch: '#ec4899' },
  { key: 'appearance.accentPreset.violet', value: '#7c5cff', swatch: '#7c5cff' },
  { key: 'appearance.accentPreset.indigo', value: '#6366f1', swatch: '#6366f1' },
  { key: 'appearance.accentPreset.slate', value: '#64748b', swatch: '#64748b' },
]

/** Corner scale steps. */
const RADIUS_PRESETS: readonly Preset<number>[] = [
  { key: 'appearance.radius.square', value: 0 },
  { key: 'appearance.radius.subtle', value: 0.5 },
  { key: 'appearance.radius.default', value: 1 },
  { key: 'appearance.radius.round', value: 1.5 },
  { key: 'appearance.radius.pill', value: 2.5 },
]

/** The opacity presets every opacity row offers. */
const OPACITY_PRESETS: readonly Preset<number>[] = [
  { key: 'appearance.opacity.solid', value: 100 },
  { key: 'appearance.opacity.soft', value: 85 },
  { key: 'appearance.opacity.glass', value: 65 },
  { key: 'appearance.opacity.clear', value: 45 },
]

/** Glass blur steps. */
const BLUR_PRESETS: readonly Preset<number>[] = [
  { key: 'appearance.blur.none', value: 0 },
  { key: 'appearance.blur.light', value: 16 },
  { key: 'appearance.blur.default', value: 40 },
  { key: 'appearance.blur.heavy', value: 64 },
]

/** The swatch a backdrop tile paints: its gradient, or a neutral fill for the desktop and image choices. */
function backdropSwatch(backdrop: Backdrop): string {
  switch (backdrop) {
    case 'none': return 'var(--dsw-alias-bg-module-platform)'
    case 'image': return 'var(--dsw-alias-bg-layer-3)'
    default: return BACKDROP_GRADIENTS[backdrop]
  }
}

/** The `#rrggbb` a colour input can show for the current accent. */
function pickerValue(accent: string): string {
  return /^#[0-9a-f]{6}$/iu.test(accent.trim()) ? accent.trim() : '#5b8cff'
}

/**
 * Render the Personalization section.
 * @param props - the runtime share, the locale seat, and the injected form.
 * @returns the section.
 */
export function AppearanceSection({
  t, set, reset, useAppearance, useSaveState, useRowStatus,
}: AppearanceSectionComponentProps): ReactNode {
  const values = useAppearance(value => value)
  const saveState = useSaveState(value => value)
  const rowStatus = useRowStatus(value => value)

  if (rowStatus === 'unavailable') {
    return <p className={css.hint}>{t('appearance.unavailable')}</p>
  }

  const range = APPEARANCE_RANGES
  const opacityRow = (field: 'shellOpacity' | 'surfaceOpacity' | 'panelOpacity', key: 'shell' | 'surface' | 'panel') => (
    <Row
      label={t(`appearance.${key}.label`)}
      hint={t(`appearance.${key}.hint`)}
      control={(
        <NumberField
          value={values[field]}
          min={range.opacity.min}
          max={range.opacity.max}
          step={range.opacity.step}
          label={t(`appearance.${key}.label`)}
          suffix="%"
          onCommit={(next) => { set(field, next) }}
        />
      )}
      presets={<Presets presets={OPACITY_PRESETS} current={values[field]} t={t} onPick={(next) => { set(field, next) }} />}
    />
  )

  return (
    <div className={css.rows}>
      {saveState.refused.length === 0 ? null : <p className={css.notice} role="status">{t('appearance.refused')}</p>}

      <Group title={t('appearance.group.typography')}>
        <Row
          label={t('appearance.font.label')}
          hint={t('appearance.font.hint')}
          control={(
            <TextField
              value={values.fontFamily}
              label={t('appearance.font.label')}
              placeholder={t('appearance.font.placeholder')}
              onCommit={(next) => { set('fontFamily', next) }}
            />
          )}
          presets={<Presets presets={FONT_PRESETS} current={values.fontFamily} t={t} onPick={(next) => { set('fontFamily', next) }} />}
        />
        <Row
          label={t('appearance.codeFont.label')}
          hint={t('appearance.codeFont.hint')}
          control={(
            <TextField
              value={values.codeFontFamily}
              label={t('appearance.codeFont.label')}
              placeholder={t('appearance.codeFont.placeholder')}
              onCommit={(next) => { set('codeFontFamily', next) }}
            />
          )}
          presets={<Presets presets={CODE_FONT_PRESETS} current={values.codeFontFamily} t={t} onPick={(next) => { set('codeFontFamily', next) }} />}
        />
        <Row
          label={t('appearance.fontScale.label')}
          hint={t('appearance.fontScale.hint')}
          control={(
            <NumberField
              value={values.fontScale}
              min={range.fontScale.min}
              max={range.fontScale.max}
              step={range.fontScale.step}
              label={t('appearance.fontScale.label')}
              suffix="%"
              onCommit={(next) => { set('fontScale', next) }}
            />
          )}
          presets={<Presets presets={FONT_SCALE_PRESETS} current={values.fontScale} t={t} onPick={(next) => { set('fontScale', next) }} />}
        />
        <Row
          label={t('appearance.lineHeight.label')}
          hint={t('appearance.lineHeight.hint')}
          control={(
            <NumberField
              value={values.lineHeight}
              min={range.lineHeight.min}
              max={range.lineHeight.max}
              step={range.lineHeight.step}
              label={t('appearance.lineHeight.label')}
              suffix="%"
              onCommit={(next) => { set('lineHeight', next) }}
            />
          )}
          presets={<Presets presets={LINE_HEIGHT_PRESETS} current={values.lineHeight} t={t} onPick={(next) => { set('lineHeight', next) }} />}
        />
      </Group>

      <Group title={t('appearance.group.colour')}>
        <Row
          label={t('appearance.accent.label')}
          hint={t('appearance.accent.hint')}
          control={(
            <span className={css.accentControl}>
              <input
                type="color"
                className={css.picker}
                value={pickerValue(values.accent)}
                aria-label={t('appearance.accent.picker')}
                title={t('appearance.accent.picker')}
                onChange={(event) => { set('accent', event.target.value) }}
              />
              <TextField
                value={values.accent}
                label={t('appearance.accent.label')}
                placeholder={t('appearance.accent.placeholder')}
                onCommit={(next) => { set('accent', next) }}
              />
            </span>
          )}
          presets={ACCENT_PRESETS.map(preset => (
            <button
              key={preset.key}
              type="button"
              className={css.swatch}
              style={{ background: preset.swatch }}
              aria-label={t(preset.key)}
              title={t(preset.key)}
              aria-pressed={values.accent === preset.value}
              onClick={() => { set('accent', preset.value) }}
            />
          ))}
        />
        <Row
          label={t('appearance.accentEverywhere.label')}
          hint={t('appearance.accentEverywhere.hint')}
          control={(
            <Switch
              checked={values.accentEverywhere}
              label={t('appearance.accentEverywhere.label')}
              onChange={(next) => { set('accentEverywhere', next) }}
            />
          )}
        />
      </Group>

      <Group title={t('appearance.group.layout')}>
        <Row
          label={t('appearance.contentWidth.label')}
          hint={t('appearance.contentWidth.hint')}
          presets={<Presets presets={choices(CONTENT_WIDTHS, 'appearance.contentWidth')} current={values.contentWidth} t={t} onPick={(next) => { set('contentWidth', next) }} />}
        />
        <Row
          label={t('appearance.settingsWidth.label')}
          hint={t('appearance.settingsWidth.hint')}
          presets={<Presets presets={choices(SETTINGS_WIDTHS, 'appearance.settingsWidth')} current={values.settingsWidth} t={t} onPick={(next) => { set('settingsWidth', next) }} />}
        />
        <Row
          label={t('appearance.radius.label')}
          hint={t('appearance.radius.hint')}
          control={(
            <NumberField
              value={values.radiusScale}
              min={range.radiusScale.min}
              max={range.radiusScale.max}
              step={range.radiusScale.step}
              label={t('appearance.radius.label')}
              onCommit={(next) => { set('radiusScale', next) }}
            />
          )}
          presets={<Presets presets={RADIUS_PRESETS} current={values.radiusScale} t={t} onPick={(next) => { set('radiusScale', next) }} />}
        />
        <Row
          label={t('appearance.scrollbars.label')}
          hint={t('appearance.scrollbars.hint')}
          presets={<Presets presets={choices(SCROLLBAR_STYLES, 'appearance.scrollbars')} current={values.scrollbars} t={t} onPick={(next) => { set('scrollbars', next) }} />}
        />
      </Group>

      <Group title={t('appearance.group.opacity')}>
        {opacityRow('shellOpacity', 'shell')}
        {opacityRow('surfaceOpacity', 'surface')}
        {opacityRow('panelOpacity', 'panel')}
        <Row
          label={t('appearance.blur.label')}
          hint={t('appearance.blur.hint')}
          control={(
            <NumberField
              value={values.glassBlur}
              min={range.glassBlur.min}
              max={range.glassBlur.max}
              step={range.glassBlur.step}
              label={t('appearance.blur.label')}
              suffix="px"
              onCommit={(next) => { set('glassBlur', next) }}
            />
          )}
          presets={<Presets presets={BLUR_PRESETS} current={values.glassBlur} t={t} onPick={(next) => { set('glassBlur', next) }} />}
        />
      </Group>

      <Group title={t('appearance.group.effects')}>
        <Row
          label={t('appearance.backdrop.label')}
          hint={t('appearance.backdrop.hint')}
          presets={(
            <>
              <div className={css.tiles}>
                {BACKDROPS.map(backdrop => (
                  <button
                    key={backdrop}
                    type="button"
                    className={css.tile}
                    aria-pressed={values.backdrop === backdrop}
                    onClick={() => { set('backdrop', backdrop) }}
                  >
                    <span className={css.tileSwatch} style={{ background: backdropSwatch(backdrop) }} aria-hidden />
                    <span className={css.tileLabel}>{t(`appearance.backdrop.${backdrop}`)}</span>
                  </button>
                ))}
              </div>
              {values.backdrop === 'image'
                ? (
                  <TextField
                    value={values.backdropImage}
                    label={t('appearance.backdropImage.label')}
                    placeholder={t('appearance.backdropImage.placeholder')}
                    invalid={values.backdropImage.trim() === '' || usableImageUrl(values.backdropImage)
                      ? undefined : t('appearance.backdropImage.invalid')}
                    onCommit={(next) => { set('backdropImage', next.trim()) }}
                  />
                )
                : null}
            </>
          )}
        />
        <Row
          label={t('appearance.shadows.label')}
          hint={t('appearance.shadows.hint')}
          presets={<Presets presets={choices(SHADOW_STRENGTHS, 'appearance.shadows')} current={values.shadows} t={t} onPick={(next) => { set('shadows', next) }} />}
        />
        <Row
          label={t('appearance.reduceMotion.label')}
          hint={t('appearance.reduceMotion.hint')}
          control={(
            <Switch
              checked={values.reduceMotion}
              label={t('appearance.reduceMotion.label')}
              onChange={(next) => { set('reduceMotion', next) }}
            />
          )}
        />
      </Group>

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
