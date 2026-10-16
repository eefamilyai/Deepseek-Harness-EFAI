/**
 * Modal that creates one task from the Automation tasks page.
 *
 * The Host's create endpoint carries the Session binding inside the request, so
 * the form stages the binding, the name, the instruction, and one recurrence
 * rule, and submits them in a single call. A refused rule comes back as an input
 * code and is shown in the dialog's own hint slot, so a rejected submission
 * keeps every staged value rather than closing the form.
 *
 * The owner mounts this component while a creation is in progress; the dialog
 * itself is always open, and Escape belongs to whichever row menu is showing
 * before it belongs to the dialog.
 */
import { useId, useMemo, useRef, useState } from 'react'
import type { KeyboardEvent as ReactKeyboardEvent, ReactNode } from 'react'
import clsx from 'clsx'
import {
  Button, IconChevronDownOutlineRegular, Input, Modal, Pill,
} from '@deepseek-ai/dsh-client-ui-primitives'
import type { PropsLocale } from '@deepseek-ai/dsh-client-ui-slots'
import type { ScheduleCreateTaskRequest } from '@deepseek-ai/dsh-schedule/client'
import type { SessionId } from '@deepseek-ai/dsh-session/types'
import { ClockPicker } from './ClockPicker.tsx'
import { DatePicker } from './DatePicker.tsx'
import { TaskMenu } from './TaskMenu.tsx'
import type { TaskMenuEntry } from './TaskMenu.tsx'
import { slashDate, secondPrecision } from './task-timing.ts'
import { zoneChoices, zoneName } from './schedule-format.ts'
import { parseCronExpression } from './task-cron.ts'
import { loadRecentTimeZones, rememberTimeZone } from './recent-time-zones.ts'
import {
  CREATE_CHOICES, CREATE_INTERVAL_UNITS, CREATE_WEEKDAYS, intervalCountFor, initialCreateDraft,
  isClockChoice, isIntervalChoice, resolveCreate,
} from './create-task.ts'
import type { CreateChoice, CreateDraft, CreateIntervalChoice, CreateWeekday } from './create-task.ts'
import type { TaskManagerKey } from './task-manager-locales.ts'
import css from './NewTaskDialog.module.css'
import shared from './TaskManagerPage.module.css'

/** One Session the form can bind the new task to. */
export interface NewTaskSession {
  /** Session the task delivers into. */
  readonly id: SessionId
  /** Name the row shows, resolved from the Session catalog. */
  readonly label: string
}

/** Result of one submitted creation. */
export type NewTaskOutcome =
  | { readonly ok: true }
  | { readonly ok: false; readonly message: TaskManagerKey }

/** One row menu the dialog can have open; only one is open at a time. */
type MenuId = 'session' | 'repeat' | 'zone' | 'date' | 'clock'

/** Text of the Repeat row's own label per choice. */
const CHOICE_LABELS: Readonly<Record<CreateChoice, TaskManagerKey>> = {
  weekly: 'rule.weekly', weekdays: 'rule.weekdays', daily: 'rule.daily',
  'every-hour': 'rule.everyHours', 'every-minute': 'rule.everyMinutes', 'every-second': 'rule.everySeconds',
  once: 'rule.once', cron: 'rule.cron',
}

/** Localized name of each ISO weekday. */
const WEEKDAY_LABELS: Readonly<Record<CreateWeekday, TaskManagerKey>> = {
  1: 'frequency.weekday.1', 2: 'frequency.weekday.2', 3: 'frequency.weekday.3', 4: 'frequency.weekday.4',
  5: 'frequency.weekday.5', 6: 'frequency.weekday.6', 7: 'frequency.weekday.7',
}

/** Inputs of {@link NewTaskDialog}. */
export interface NewTaskDialogProps {
  /** Sessions the task can be bound to, newest intent first. */
  readonly sessions: readonly NewTaskSession[]
  /** Whether the Session catalog is still loading. */
  readonly sessionsLoading: boolean
  /** The host's current IANA zone, which every clock-time rule opens in. */
  readonly zone: string
  /** Submit one staged creation and report its settled outcome. */
  readonly onSubmit: (request: ScheduleCreateTaskRequest) => Promise<NewTaskOutcome>
  /** Close the dialog without creating anything. */
  readonly onClose: () => void
  /** Task manager copy. */
  readonly t: PropsLocale<'schedule.manager'>['t']
}

/**
 * Render the creation form: name, instruction, Session, and one recurrence rule.
 * @param props - Session choices, the create action, and locale.
 * @returns the modal form.
 */
export function NewTaskDialog({
  sessions, sessionsLoading, zone, onSubmit, onClose, t,
}: NewTaskDialogProps): ReactNode {
  const systemZone = useMemo(() => Intl.DateTimeFormat().resolvedOptions().timeZone, [])
  const [draft, setDraft] = useState<CreateDraft>(() => initialCreateDraft(sessions[0]?.id ?? '', zone))
  const [openMenu, setOpenMenu] = useState<MenuId | null>(null)
  const [sessionQuery, setSessionQuery] = useState('')
  const [zoneQuery, setZoneQuery] = useState('')
  const [recentZones, setRecentZones] = useState<readonly string[]>(() => loadRecentTimeZones(systemZone))
  const [pending, setPending] = useState(false)
  const [failure, setFailure] = useState<TaskManagerKey | undefined>(undefined)
  // The two pickers anchor their panel on the trigger itself, so they keep a
  // RefObject; every other row is registered through the shared map.
  const dateRef = useRef<HTMLButtonElement | null>(null)
  const clockRef = useRef<HTMLButtonElement | null>(null)
  const menuRefs = useRef<Partial<Record<MenuId, HTMLButtonElement | null>>>({})
  const dialogId = useId()
  const rowId = (name: string): string => `${dialogId}-${name}`

  /** Hand the keyboard back to the trigger of the row menu that just closed. */
  const focusAnchor = (menu: MenuId): void => {
    const element = menu === 'date' ? dateRef.current : menu === 'clock' ? clockRef.current : menuRefs.current[menu]
    element?.focus()
  }

  /** Close the open row menu and hand the keyboard back to its trigger. */
  const closeMenu = (): void => {
    const open = openMenu
    setOpenMenu(null)
    setSessionQuery('')
    setZoneQuery('')
    if (open !== null) focusAnchor(open)
  }

  const edit = (patch: Partial<CreateDraft>): void => {
    setDraft(current => ({ ...current, ...patch }))
    // Editing invalidates the refusal it caused, so the hint returns to the
    // rule's own description instead of describing a value that is gone.
    setFailure(undefined)
  }

  const chooseChoice = (choice: CreateChoice): void => {
    setFailure(undefined)
    setOpenMenu(null)
    setDraft(current => ({
      ...current,
      choice,
      count: isIntervalChoice(choice) ? intervalCountFor(choice) : current.count,
    }))
  }

  const chooseZone = (chosen: string): void => {
    setRecentZones(rememberTimeZone(recentZones, chosen))
    edit({ timeZone: chosen })
    setOpenMenu(null)
    setZoneQuery('')
  }

  const submit = (): void => {
    const resolution = resolveCreate(draft)
    if ('error' in resolution) {
      setFailure(resolution.error)
      return
    }
    setPending(true)
    setFailure(undefined)
    void onSubmit(resolution.request).then((outcome) => {
      setPending(false)
      if (outcome.ok) {
        onClose()
        return
      }
      setFailure(outcome.message)
    })
  }

  const sessionItems: readonly TaskMenuEntry[] = useMemo(() => {
    const query = sessionQuery.trim().toLowerCase()
    return sessions
      .filter(session => query === ''
        || session.label.toLowerCase().includes(query)
        || session.id.toLowerCase().includes(query))
      .map(session => ({ id: session.id, label: session.label }))
  }, [sessions, sessionQuery])

  const zoneItems: readonly TaskMenuEntry[] = useMemo(() => {
    // The inventory names several hundred zones and each label formats one, so
    // the list is built for the open menu and not for every keystroke in the form.
    if (openMenu !== 'zone') return []
    const query = zoneQuery.trim().toLowerCase()
    const matches = (candidate: string): boolean => query === ''
      || candidate.toLowerCase().includes(query)
      || zoneName(candidate, systemZone, t).toLowerCase().includes(query)
    // Recent zones lead, the way the detail's own picker orders them; every
    // other zone follows once, so a promoted zone never repeats in the list.
    const recent = recentZones.filter(matches)
    const shown = new Set(recent)
    const rest = zoneChoices(draft.timeZone, systemZone).filter(zone => !shown.has(zone) && matches(zone))
    return [
      ...recent.map(zone => ({ id: zone, label: zoneName(zone, systemZone, t) })),
      ...(recent.length > 0 && rest.length > 0 ? [{ type: 'separator' as const, id: '__recent' }] : []),
      ...rest.map(zone => ({ id: zone, label: zoneName(zone, systemZone, t) })),
    ]
  }, [draft.timeZone, openMenu, recentZones, systemZone, t, zoneQuery])

  const chosenSession = sessions.find(session => session.id === draft.sessionId)
  const sessionText = chosenSession?.label
    ?? (sessionsLoading ? t('create.sessionLoading') : t('create.sessionEmpty'))
  const noSessions = sessions.length === 0
  const intervalChoice = isIntervalChoice(draft.choice)
  const parsedCron = draft.choice === 'cron' ? parseCronExpression(draft.expression) : undefined

  /** One menu row: the label at the row's start and the value face at its end. */
  const menuRow = (options: {
    readonly menu: Exclude<MenuId, 'date' | 'clock'>
    readonly label: TaskManagerKey
    readonly value: ReactNode
    readonly disabled?: boolean
  }): ReactNode => <button
    ref={(node) => { menuRefs.current[options.menu] = node }}
    type="button"
    className={shared.ruleValue}
    disabled={pending || options.disabled === true}
    aria-haspopup="menu"
    aria-expanded={openMenu === options.menu}
    onClick={() => {
      setFailure(undefined)
      setOpenMenu(current => (current === options.menu ? null : options.menu))
    }}
  >
    <span className={shared.ruleLabel}>{t(options.label)}</span>
    <span className={clsx(shared.ruleValueFace, shared.ruleControl)}>
      <span className={clsx(shared.ruleCurrent, css.sessionValue)}>{options.value}</span>
      <IconChevronDownOutlineRegular />
    </span>
  </button>

  return <Modal
    open
    title={t('create.title')}
    closeLabel={t('create.close')}
    className={css.dialog as string}
    contentClassName={css.content as string}
    onClose={onClose}
    onKeyDownCapture={(event: ReactKeyboardEvent<HTMLDivElement>) => {
      // A row menu owns Escape while it is showing: closing it here, before the
      // document listeners see the key, keeps the dialog open the way the
      // detail keeps its panel open.
      if (event.key !== 'Escape' || openMenu === null) return
      event.preventDefault()
      event.stopPropagation()
      closeMenu()
    }}
    footer={<div className={css.actions}>
      <Button variant="outline" disabled={pending} onClick={onClose}>{t('rule.cancel')}</Button>
      <Button
        variant="primary"
        disabled={pending || noSessions}
        onClick={submit}
      >{t(pending ? 'create.creating' : 'create.confirm')}</Button>
    </div>}
  >
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={rowId('name')}>{t('detail.name')}</label>
      <Input
        id={rowId('name')}
        data-modal-autofocus=""
        maxLength={120}
        disabled={pending}
        value={draft.title}
        onChange={(event) => { edit({ title: event.target.value }) }}
      />
    </div>
    <div className={css.field}>
      <label className={css.fieldLabel} htmlFor={rowId('instruction')}>{t('detail.instruction')}</label>
      <textarea
        id={rowId('instruction')}
        className={shared.instruction}
        rows={3}
        disabled={pending}
        value={draft.prompt}
        onChange={(event) => { edit({ prompt: event.target.value }) }}
      />
    </div>
    <div className={shared.ruleRows}>
      <TaskMenu
        className={shared.ruleRowMenu}
        open={openMenu === 'session'}
        onClose={() => { setOpenMenu(null); setSessionQuery('') }}
        items={sessionItems.length > 0 ? sessionItems : [{
          id: '__empty',
          label: t(sessionsLoading ? 'create.sessionLoading' : 'create.sessionEmpty'),
          disabled: true,
        }]}
        listClassName={css.sessionMenu}
        header={sessions.length > 8 ? <input
          className={shared.zoneSearch}
          type="search"
          value={sessionQuery}
          placeholder={t('create.sessionSearch')}
          aria-label={t('create.sessionSearch')}
          data-menu-field=""
          onChange={(event) => { setSessionQuery(event.target.value) }}
        /> : undefined}
        selectedId={draft.sessionId === '' ? undefined : draft.sessionId}
        onSelect={(id) => { edit({ sessionId: id as SessionId }); setOpenMenu(null); setSessionQuery('') }}
        align="end"
        portal
        anchor={menuRow({
          menu: 'session', label: 'create.session', value: sessionText, disabled: noSessions,
        })}
      />
      <TaskMenu
        className={shared.ruleRowMenu}
        open={openMenu === 'repeat'}
        onClose={() => { setOpenMenu(null) }}
        items={CREATE_CHOICES.map(choice => ({ id: choice, label: t(CHOICE_LABELS[choice]) }))}
        selectedId={draft.choice}
        onSelect={(id) => { chooseChoice(id as CreateChoice) }}
        align="end"
        portal
        anchor={menuRow({
          menu: 'repeat', label: 'rule.repeat', value: t(CHOICE_LABELS[draft.choice]),
        })}
      />
      {intervalChoice && <div className={shared.ruleRow}>
        <label className={shared.ruleLabel} htmlFor={rowId('interval')}>{t('timing.interval')}</label>
        <span className={shared.ruleInterval}>
          <input
            id={rowId('interval')}
            className={clsx(shared.ruleInput, shared.ruleControl, shared.ruleIntervalInput)}
            type="number"
            min={1}
            step="any"
            disabled={pending}
            value={draft.count}
            aria-describedby={rowId('interval-hint')}
            onChange={(event) => { edit({ count: event.target.value }) }}
          />
          <span className={shared.ruleIntervalUnit}>{t(`timing.unit.${CREATE_INTERVAL_UNITS[draft.choice as CreateIntervalChoice]}`)}</span>
        </span>
      </div>}
      {draft.choice === 'weekly' && <div className={shared.ruleRow}>
        <span className={shared.ruleLabel} id={rowId('weekday')}>{t('rule.weekday')}</span>
        <div className={clsx(shared.ruleWeekdays, shared.ruleControl)} role="group" aria-labelledby={rowId('weekday')}>
          {CREATE_WEEKDAYS.map((weekday) => {
            const selected = draft.weekdays.includes(weekday)
            return <Pill
              key={weekday}
              className={shared.ruleControl}
              active={selected}
              disabled={pending}
              aria-pressed={selected}
              aria-label={t('rule.weekdayOption', { weekday: t(WEEKDAY_LABELS[weekday]) })}
              onClick={() => {
                edit({
                  weekdays: selected
                    ? draft.weekdays.filter(value => value !== weekday)
                    : [...draft.weekdays, weekday].sort((left, right) => left - right),
                })
              }}
            >{t(WEEKDAY_LABELS[weekday])}</Pill>
          })}
        </div>
      </div>}
      {draft.choice === 'once' && <div className={shared.ruleRow}>
        <label className={shared.ruleLabel} htmlFor={rowId('date')}>{t('timing.date')}</label>
        <button
          ref={dateRef}
          id={rowId('date')}
          type="button"
          className={clsx(shared.ruleInput, shared.ruleControl, shared.pickerTrigger)}
          disabled={pending}
          aria-label={t('timing.date')}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'date'}
          onClick={() => { setOpenMenu(current => (current === 'date' ? null : 'date')) }}
        >{draft.date === '' ? t('timing.date') : slashDate(draft.date)}</button>
      </div>}
      {draft.choice !== 'cron' && !intervalChoice && <div className={shared.ruleRow}>
        <label className={shared.ruleLabel} htmlFor={rowId('time')}>{t('timing.time')}</label>
        <button
          ref={clockRef}
          id={rowId('time')}
          type="button"
          className={clsx(shared.ruleInput, shared.ruleControl, shared.pickerTrigger)}
          disabled={pending}
          aria-label={t('timing.time')}
          aria-haspopup="dialog"
          aria-expanded={openMenu === 'clock'}
          onClick={() => { setOpenMenu(current => (current === 'clock' ? null : 'clock')) }}
        >{secondPrecision(draft.time)}</button>
      </div>}
      {draft.choice === 'cron' && <div className={shared.ruleRow}>
        <label className={shared.ruleLabel} htmlFor={rowId('expression')}>{t('rule.cronLabel')}</label>
        <input
          id={rowId('expression')}
          className={clsx(shared.ruleInput, shared.ruleControl)}
          disabled={pending}
          value={draft.expression}
          aria-describedby={rowId('expression-hint')}
          onChange={(event) => { edit({ expression: event.target.value }) }}
        />
      </div>}
      {isClockChoice(draft.choice) || draft.choice === 'cron' || draft.choice === 'once'
        ? <TaskMenu
          className={shared.ruleRowMenu}
          open={openMenu === 'zone'}
          onClose={() => { setOpenMenu(null); setZoneQuery('') }}
          items={zoneItems.length > 0 ? zoneItems : [{
            id: '__empty', label: t('timing.zoneNoResults'), disabled: true,
          }]}
          listClassName={shared.zoneMenu}
          header={<input
            className={shared.zoneSearch}
            type="search"
            value={zoneQuery}
            placeholder={t('timing.zoneSearch')}
            aria-label={t('timing.zoneSearch')}
            data-menu-field=""
            onChange={(event) => { setZoneQuery(event.target.value) }}
          />}
          selectedId={draft.timeZone}
          onSelect={(id) => { chooseZone(id) }}
          align="end"
          portal
          anchor={menuRow({
            menu: 'zone', label: 'timing.zone', value: zoneName(draft.timeZone, systemZone, t),
          })}
        />
        : null}
    </div>
    {/* One hint slot under the rows: the refusal that blocks a submission
        replaces the rule's own description, and it clears on the next edit. */}
    {failure !== undefined && <p className={clsx(shared.ruleHint, shared.ruleHintError)} role="alert">{t(failure)}</p>}
    {failure === undefined && intervalChoice && <p className={shared.ruleHint}>
      {t(`timing.intervalHint.${CREATE_INTERVAL_UNITS[draft.choice as CreateIntervalChoice]}`)}
    </p>}
    {failure === undefined && draft.choice === 'cron' && <p
      className={clsx(shared.ruleHint, parsedCron === undefined && shared.ruleHintError)}
      role={parsedCron === undefined ? 'alert' : undefined}
    >{t(parsedCron === undefined ? 'rule.cronInvalid' : 'timing.zoneNoStored')}</p>}
    <DatePicker
      open={openMenu === 'date'}
      anchorRef={dateRef}
      value={draft.date}
      onPick={(date) => { edit({ date }) }}
      onClose={() => { setOpenMenu(null); focusAnchor('date') }}
      t={t}
    />
    <ClockPicker
      open={openMenu === 'clock'}
      anchorRef={clockRef}
      value={draft.time}
      onPick={(time) => { edit({ time }) }}
      onClose={() => { setOpenMenu(null); focusAnchor('clock') }}
      t={t}
    />
  </Modal>
}
