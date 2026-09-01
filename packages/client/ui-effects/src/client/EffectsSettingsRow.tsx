/**
 * Visual-effects Settings row: whale/focus toggles plus whale size, opacity,
 * and static placement.
 */
import type { PropsLocale, PropsRuntime, InjectFace } from '@deepseek-ai/dsh-client-ui-slots'
import type { SnapshotStore } from '@deepseek-ai/dsh-client-store'
import styles from './EffectsSettingsRow.module.css'

const css = (key: string): string => (styles as Record<string, string>)[key] ?? key

/** Injected business face handed to the row through the slot framework. */
export interface EffectsSettingsRowInjected {
  hooks: {
    whaleEnabled: SnapshotStore<boolean>
    focusEnabled: SnapshotStore<boolean>
    whaleOpacity: SnapshotStore<number>
    whaleSize: SnapshotStore<number>
    whaleStatic: SnapshotStore<boolean>
  }
  setWhaleEnabled: (value: boolean) => void
  setFocusEnabled: (value: boolean) => void
  setWhaleOpacity: (value: number) => void
  setWhaleSize: (value: number) => void
  setWhaleStatic: (value: boolean) => void
}

/** Full Settings-row props. */
export type EffectsSettingsRowProps =
  PropsRuntime<'settings.general.item'>
  & PropsLocale<'settings.effects'>
  & InjectFace<EffectsSettingsRowInjected>

/** One labelled toggle line. */
function Toggle({ label, desc, checked, onChange }: {
  label: string
  desc: string
  checked: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <button
      type="button"
      className={css('toggleRow')}
      role="switch"
      aria-checked={checked}
      onClick={() => { onChange(!checked) }}
    >
      <span className={css('toggleText')}>
        <span className={css('toggleTitle')}>{label}</span>
        <span className={css('toggleDesc')}>{desc}</span>
      </span>
      <span className={`${css('track')} ${checked ? css('trackOn') : ''}`}>
        <span className={`${css('thumb')} ${checked ? css('thumbOn') : ''}`} />
      </span>
    </button>
  )
}

/** One labelled slider line with a live value readout. */
function Slider({ label, value, min, max, step, onChange }: {
  label: string
  value: number
  min: number
  max: number
  step: number
  onChange: (next: number) => void
}) {
  return (
    <label className={css('sliderRow')}>
      <span className={css('sliderHead')}>
        <span className={css('sliderLabel')}>{label}</span>
        <span className={css('sliderValue')}>{Math.round(value)}</span>
      </span>
      <input
        className={css('slider')}
        type="range"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(event) => { onChange(Number(event.target.value)) }}
      />
    </label>
  )
}

/**
 * Render the Visual-effects settings row.
 * @param props - composed Settings slot props.
 */
export function EffectsSettingsRow({
  useWhaleEnabled, useFocusEnabled, useWhaleOpacity, useWhaleSize, useWhaleStatic,
  setWhaleEnabled, setFocusEnabled, setWhaleOpacity, setWhaleSize, setWhaleStatic,
  t,
}: EffectsSettingsRowProps) {
  const whale = useWhaleEnabled(value => value)
  const focus = useFocusEnabled(value => value)
  const opacity = useWhaleOpacity(value => value)
  const size = useWhaleSize(value => value)
  const staticWhale = useWhaleStatic(value => value)

  return (
    <div className={css('group')}>
      <div className={css('title')}>{t('effects.title')}</div>
      <Toggle
        label={t('effects.whale')}
        desc={t('effects.whale.desc')}
        checked={whale}
        onChange={setWhaleEnabled}
      />
      {whale
        ? (
          <>
            <Slider
              label={t('effects.whale.opacity')}
              value={Math.round(opacity * 100)}
              min={5}
              max={100}
              step={1}
              onChange={(next) => { setWhaleOpacity(next / 100) }}
            />
            <Slider
              label={t('effects.whale.size')}
              value={size}
              min={120}
              max={900}
              step={10}
              onChange={setWhaleSize}
            />
            <Toggle
              label={t('effects.whale.static')}
              desc={t('effects.whale.static.desc')}
              checked={staticWhale}
              onChange={setWhaleStatic}
            />
          </>
        )
        : null}
      <Toggle
        label={t('effects.focus')}
        desc={t('effects.focus.desc')}
        checked={focus}
        onChange={setFocusEnabled}
      />
    </div>
  )
}
