/**
 * The Tools settings section: availability, the Python kernel, and the browser tools.
 *
 * Every control is a live field of a composed host row — `tool-roster`,
 * `kernel-python`, `web-browser` — read and written through that row's config
 * form, so nothing here duplicates configuration the composition already owns.
 *
 * Timing is the reason the groups are worded differently. `tool-roster` applies a
 * change at the end of the turn in flight; the kernel reads its own fields when
 * the process starts. A group whose row a deployment does not compose has no form
 * (`unavailable`) and is omitted with a line saying so, rather than rendered
 * empty or disabled: the section is the same code in every profile.
 *
 * Numeric fields commit on blur or Enter. Writing on each keystroke would queue a
 * host write per character, and a half-typed number is not a value anyone chose.
 */
import { useCallback, useEffect, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
import { Input, Switch } from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { ConfigForm, ConfigFormSnapshot } from '@deepseek-ai/dsh-client-ui-settings/client'
import type { ToolsKey } from './locales.ts'
import css from './ToolsSection.module.css'

/** The `tool-roster` row's live fields as this section reads them. */
export interface RosterFields {
  /** Whether the kernel tool is available. */
  kernel?: boolean
  /** Whether the conventional tool category is available. */
  enabled?: boolean
}

/** The `kernel-python` row's live fields as this section reads them. */
export interface KernelFields {
  /** Whether the kernel's browser window stays visible. */
  browserWindow?: boolean
}

/** The `web-browser` row's live fields as this section reads them. */
export interface BrowserFields {
  /** Whether browsing runs without a visible window. */
  headless?: boolean
  /** Whether the fetch tool may retrieve a page without a browser. */
  fetchProvider?: boolean
  /** Milliseconds allowed for one navigation. */
  navigationTimeoutMs?: number
  /** Milliseconds allowed for one click or keystroke. */
  actionTimeoutMs?: number
  /** Characters one page read may return. */
  maxTextChars?: number
  /** Characters one tool result may carry. */
  maxOutputChars?: number
  /** Identity string browser requests use. */
  userAgent?: string
}

/** One composed preset, as the registry reports it. */
export interface PresetRow {
  /** Stable preset identity. */
  id: string
  /** Display name, when the preset declares one. */
  name?: string
  /** One-line purpose, when the preset declares one. */
  description?: string
  /** Whether new sessions start from this preset. */
  isDefault?: boolean
}

/** Injected business face: one live config form per row this section edits. */
export interface ToolsSectionInjected {
  /** Live form over the `tool-roster` row. */
  roster: ConfigForm<RosterFields>
  /** Live form over the `kernel-python` row. */
  kernel: ConfigForm<KernelFields>
  /** Live form over the `web-browser` row. */
  browser: ConfigForm<BrowserFields>
  /** The composed preset roster, read once when the section opens. */
  listPresets: () => Promise<readonly PresetRow[]>
}

/** Full component props: runtime share + locale seat + injected face. */
export type ToolsSectionComponentProps =
  PropsRuntime<'settings.section'> & PropsLocale<'tools'> & ToolsSectionInjected

/** One form's snapshot, subscribed. */
function useForm<T extends object>(form: ConfigForm<T>): ConfigFormSnapshot<T> {
  return useSyncExternalStore(form.subscribe.bind(form), form.getSnapshot.bind(form))
}

/** The copy one switch or field renders, as locale keys. */
interface FieldCopy {
  label: ToolsKey
  hint: ToolsKey
}

/** Write state shared by every field of one row. */
interface Writer {
  failed: boolean
  pending: boolean
  write: (field: string, next: unknown) => void
}

/** One row's write pump: reports failure instead of throwing, and serialises. */
function useWriter<T extends object>(form: ConfigForm<T>): Writer {
  const [failed, setFailed] = useState(false)
  const [pending, setPending] = useState(false)
  const write = useCallback((field: string, next: unknown): void => {
    setPending(true)
    void form.set(field, next).then((saved) => {
      setPending(false)
      setFailed(!saved)
    })
  }, [form])
  return { failed, pending, write }
}

/** Whether a form's controls should refuse input right now. */
function locked(status: string, writable: boolean, writer: Writer): boolean {
  return writer.pending || status !== 'ready' || !writable
}

/** A titled group of rows. */
function Group({ title, hint, children }: { title: string; hint: string; children: ReactNode }) {
  return (
    <div className={css.group}>
      <span className={css.groupLabel}>{title}</span>
      <span className={css.hint}>{hint}</span>
      <div className={css.rows}>{children}</div>
    </div>
  )
}

/** One row with a switch on the right. */
function ToggleRow({ copy, checked, disabled, t, onChange }: {
  copy: FieldCopy
  checked: boolean
  disabled: boolean
  t: (key: ToolsKey) => string
  onChange: (next: boolean) => void
}) {
  return (
    <div className={css.row}>
      <span className={css.text}>
        <span className={css.label}>{t(copy.label)}</span>
        <span className={css.hint}>{t(copy.hint)}</span>
      </span>
      <Switch
        checked={checked}
        disabled={disabled}
        label={t(copy.label)}
        onChange={onChange}
      />
    </div>
  )
}

/**
 * One row with a numeric field on the right.
 *
 * The field is uncontrolled and commits on blur or Enter; an unparsable or
 * non-positive entry restores the last accepted value, so the field never claims a
 * number the host did not accept.
 */
function NumberRow({ copy, value, unit, disabled, t, onCommit }: {
  copy: FieldCopy
  value: number | undefined
  unit?: string
  disabled: boolean
  t: (key: ToolsKey) => string
  onCommit: (next: number) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const commit = (): void => {
    const next = Number.parseInt(ref.current?.value ?? '', 10)
    if (!Number.isFinite(next) || next <= 0) {
      if (ref.current) ref.current.value = value === undefined ? '' : String(value)
      return
    }
    if (next !== value) onCommit(next)
  }
  return (
    <div className={css.row}>
      <span className={css.text}>
        <span className={css.label}>{t(copy.label)}</span>
        <span className={css.hint}>{t(copy.hint)}</span>
      </span>
      <span className={css.control}>
        <Input
          ref={ref}
          className={css.number ?? ''}
          type="number"
          min={1}
          defaultValue={value ?? ''}
          disabled={disabled}
          aria-label={t(copy.label)}
          onBlur={commit}
          onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
        />
        {unit !== undefined && <span className={css.unit}>{unit}</span>}
      </span>
    </div>
  )
}

/** One row with a text field on the right. */
function TextRow({ copy, value, disabled, t, onCommit }: {
  copy: FieldCopy
  value: string | undefined
  disabled: boolean
  t: (key: ToolsKey) => string
  onCommit: (next: string) => void
}) {
  const ref = useRef<HTMLInputElement>(null)
  const commit = (): void => {
    const next = (ref.current?.value ?? '').trim()
    if (next === '' || next === value) return
    onCommit(next)
  }
  return (
    <div className={css.row}>
      <span className={css.text}>
        <span className={css.label}>{t(copy.label)}</span>
        <span className={css.hint}>{t(copy.hint)}</span>
      </span>
      <Input
        ref={ref}
        className={css.wide ?? ''}
        defaultValue={value ?? ''}
        disabled={disabled}
        aria-label={t(copy.label)}
        onBlur={commit}
        onKeyDown={(event) => { if (event.key === 'Enter') event.currentTarget.blur() }}
      />
    </div>
  )
}

/** The copy each row renders. */
const COPY = {
  kernel: { label: 'tools.kernel.label', hint: 'tools.kernel.hint' },
  enabled: { label: 'tools.category.label', hint: 'tools.category.hint' },
  browserWindow: { label: 'tools.python.window.label', hint: 'tools.python.window.hint' },
  headless: { label: 'tools.browser.headless.label', hint: 'tools.browser.headless.hint' },
  fetchProvider: { label: 'tools.browser.fetch.label', hint: 'tools.browser.fetch.hint' },
  navigationTimeoutMs: { label: 'tools.browser.navigation.label', hint: 'tools.browser.navigation.hint' },
  actionTimeoutMs: { label: 'tools.browser.action.label', hint: 'tools.browser.action.hint' },
  maxTextChars: { label: 'tools.browser.text.label', hint: 'tools.browser.text.hint' },
  maxOutputChars: { label: 'tools.browser.output.label', hint: 'tools.browser.output.hint' },
  userAgent: { label: 'tools.browser.userAgent.label', hint: 'tools.browser.userAgent.hint' },
} as const satisfies Record<string, FieldCopy>

/**
 * Render the Tools section.
 * @param props - composed slot props.
 * @returns the section element tree.
 */
export function ToolsSection({ t, roster, kernel, browser, listPresets }: ToolsSectionComponentProps) {
  // Presets are read once per mount: the roster changes when a preset file does,
  // which is a reload, and this section already treats composition changes that way.
  const [presets, setPresets] = useState<readonly PresetRow[] | undefined>(undefined)
  const [presetsFailed, setPresetsFailed] = useState(false)
  useEffect(() => {
    let live = true
    void listPresets()
      .then((rows) => { if (live) setPresets(rows) })
      .catch(() => { if (live) { setPresets([]); setPresetsFailed(true) } })
    return () => { live = false }
  }, [listPresets])

  const rosterState = useForm(roster)
  const kernelState = useForm(kernel)
  const browserState = useForm(browser)
  const rosterWriter = useWriter(roster)
  const kernelWriter = useWriter(kernel)
  const browserWriter = useWriter(browser)

  const rosterLocked = locked(rosterState.status, rosterState.writable, rosterWriter)
  const kernelLocked = locked(kernelState.status, kernelState.writable, kernelWriter)
  const browserLocked = locked(browserState.status, browserState.writable, browserWriter)
  const failed = rosterWriter.failed || kernelWriter.failed || browserWriter.failed
  const pending = rosterWriter.pending || kernelWriter.pending || browserWriter.pending
  const unit = t('tools.seconds')
  const kernelComposed = kernelState.status === 'ready'
  const browserComposed = browserState.status === 'ready'

  return (
    <div className={css.section}>
      <p className={css.intro}>{t('tools.intro')}</p>
      {failed && <div className={css.error} role="alert">{t('tools.writeError')}</div>}
      {pending && <div className={css.notice} role="status">{t('tools.pending')}</div>}

      <Group title={t('tools.availability.title')} hint={t('tools.availability.hint')}>
        <ToggleRow
          copy={COPY.enabled}
          t={t}
          checked={rosterState.value?.enabled ?? true}
          disabled={rosterLocked}
          onChange={(next) => { rosterWriter.write('enabled', next) }}
        />
        <ToggleRow
          copy={COPY.kernel}
          t={t}
          checked={rosterState.value?.kernel ?? true}
          disabled={rosterLocked}
          onChange={(next) => { rosterWriter.write('kernel', next) }}
        />
      </Group>

      {kernelComposed && (
        <Group title={t('tools.python.title')} hint={t('tools.python.hint')}>
          <ToggleRow
            copy={COPY.browserWindow}
            t={t}
            checked={kernelState.value?.browserWindow ?? false}
            disabled={kernelLocked}
            onChange={(next) => { kernelWriter.write('browserWindow', next) }}
          />
        </Group>
      )}
      {!kernelComposed && <p className={css.hint}>{t('tools.python.missing')}</p>}

      {browserComposed && (
        <Group title={t('tools.browser.title')} hint={t('tools.browser.hint')}>
          <ToggleRow
            copy={COPY.headless}
            t={t}
            checked={browserState.value?.headless ?? true}
            disabled={browserLocked}
            onChange={(next) => { browserWriter.write('headless', next) }}
          />
          <ToggleRow
            copy={COPY.fetchProvider}
            t={t}
            checked={browserState.value?.fetchProvider ?? true}
            disabled={browserLocked}
            onChange={(next) => { browserWriter.write('fetchProvider', next) }}
          />
          <NumberRow
            copy={COPY.navigationTimeoutMs}
            t={t}
            unit={unit}
            value={browserState.value?.navigationTimeoutMs}
            disabled={browserLocked}
            onCommit={(next) => { browserWriter.write('navigationTimeoutMs', next) }}
          />
          <NumberRow
            copy={COPY.actionTimeoutMs}
            t={t}
            unit={unit}
            value={browserState.value?.actionTimeoutMs}
            disabled={browserLocked}
            onCommit={(next) => { browserWriter.write('actionTimeoutMs', next) }}
          />
          <NumberRow
            copy={COPY.maxTextChars}
            t={t}
            value={browserState.value?.maxTextChars}
            disabled={browserLocked}
            onCommit={(next) => { browserWriter.write('maxTextChars', next) }}
          />
          <NumberRow
            copy={COPY.maxOutputChars}
            t={t}
            value={browserState.value?.maxOutputChars}
            disabled={browserLocked}
            onCommit={(next) => { browserWriter.write('maxOutputChars', next) }}
          />
          <TextRow
            copy={COPY.userAgent}
            t={t}
            value={browserState.value?.userAgent}
            disabled={browserLocked}
            onCommit={(next) => { browserWriter.write('userAgent', next) }}
          />
        </Group>
      )}
      {!browserComposed && <p className={css.hint}>{t('tools.browser.missing')}</p>}

      <Group title={t('tools.presets.title')} hint={t('tools.presets.hint')}>
        {presets === undefined && <p className={css.hint}>{t('tools.presets.loading')}</p>}
        {presetsFailed && <p className={css.hint}>{t('tools.presets.failed')}</p>}
        {!presetsFailed && presets?.length === 0 && <p className={css.hint}>{t('tools.presets.empty')}</p>}
        {presets?.map((preset) => {
          const title = preset.name ?? preset.id
          // The registry answers with the preset's id as its description when the
          // preset declares none, so the row would otherwise print the same word
          // twice for every composed preset.
          const described = preset.description === title ? undefined : preset.description
          return (
            <div className={css.row} key={preset.id}>
              <span className={css.text}>
                <span className={css.label}>
                  {title}
                  {preset.isDefault === true && <span className={css.tag}>{t('tools.presets.default')}</span>}
                </span>
                {described !== undefined && <span className={css.hint}>{described}</span>}
              </span>
            </div>
          )
        })}
      </Group>
    </div>
  )
}
