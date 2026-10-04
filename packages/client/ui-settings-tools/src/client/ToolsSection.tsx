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
 *
 * The availability group lists one switch per tool. `tool-roster` records an entry
 * for every switchable tool it mounts, so that map IS the deployment's roster
 * rather than only the names someone already withdrew, and a switch here writes one
 * nested entry (`tools.<name>`). A tool the roster only reports — the run-code alias,
 * whose visibility no switch controls — never gets an entry, so the list cannot
 * offer a switch that would do nothing.
 */
import { useCallback, useRef, useState, useSyncExternalStore, type ReactNode } from 'react'
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
  /**
   * Per-tool switches, one entry per switchable tool the roster has seen. The list
   * is the map's keys and each switch is its value, so an entry written here is a
   * tool the operator can turn off and a missing entry is a tool that stays on.
   */
  tools?: Record<string, boolean>
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

/** Injected business face: one live config form per row this section edits. */
export interface ToolsSectionInjected {
  /** Live form over the `tool-roster` row. */
  roster: ConfigForm<RosterFields>
  /** Live form over the `kernel-python` row. */
  kernel: ConfigForm<KernelFields>
  /** Live form over the `web-browser` row. */
  browser: ConfigForm<BrowserFields>
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
  /** Write one nested field, for a map whose keys are data (a tool name). */
  setAt: (path: readonly string[], next: unknown) => void
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
  const setAt = useCallback((path: readonly string[], next: unknown): void => {
    setPending(true)
    void form.mutate([{ op: 'set', path: [...path], value: next as never }]).then((saved) => {
      setPending(false)
      setFailed(!saved)
    })
  }, [form])
  return { failed, pending, write, setAt }
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
/**
 * One per-tool switch.
 *
 * The tool's own name is the label, verbatim: it is a wire token the model and the
 * operator both read, and translating or prettifying it would break the one thing
 * this row has to say. The availability group's hint carries the timing warning, so
 * forty rows do not repeat it forty times.
 */
function ToolRow({ name, checked, disabled, onChange }: {
  name: string
  checked: boolean
  disabled: boolean
  onChange: (next: boolean) => void
}) {
  return (
    <div className={css.row}>
      <span className={css.text}>
        <span className={css.toolName}>{name}</span>
      </span>
      <Switch checked={checked} disabled={disabled} label={name} onChange={onChange} />
    </div>
  )
}

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
export function ToolsSection({ t, roster, kernel, browser }: ToolsSectionComponentProps) {
  // The filter is view state, not configuration: it never reaches the Host.
  const [toolFilter, setToolFilter] = useState('')

  const rosterState = useForm(roster)
  const kernelState = useForm(kernel)
  const browserState = useForm(browser)
  const rosterWriter = useWriter(roster)
  const kernelWriter = useWriter(kernel)
  const browserWriter = useWriter(browser)

  const needle = toolFilter.trim().toLowerCase()
  const rosterTools = Object.keys(rosterState.value?.tools ?? {}).sort((left, right) => left.localeCompare(right))
  const shownTools = needle === '' ? rosterTools : rosterTools.filter(name => name.toLowerCase().includes(needle))

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
        <div className={css.row}>
          <span className={css.text}>
            <span className={css.label}>{t('tools.roster.title')}</span>
            <span className={css.hint}>{t('tools.roster.hint')}</span>
          </span>
          <Input
            className={css.wide ?? ''}
            value={toolFilter}
            disabled={rosterState.status !== 'ready'}
            aria-label={t('tools.roster.filter')}
            placeholder={t('tools.roster.filter')}
            onChange={(event) => { setToolFilter(event.target.value) }}
          />
        </div>
        <div className={css.subList}>
          {rosterState.status === 'ready' && shownTools.length === 0 && (
            <p className={css.hint}>{t('tools.roster.empty')}</p>
          )}
          {shownTools.map(name => (
            <ToolRow
              key={name}
              name={name}
              checked={rosterState.value?.tools?.[name] !== false}
              disabled={rosterLocked}
              onChange={(next) => { rosterWriter.setAt(['tools', name], next) }}
            />
          ))}
        </div>
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

    </div>
  )
}
