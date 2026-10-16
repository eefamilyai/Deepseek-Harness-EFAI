/**
 * The peak-hour send dialog: shown when a message on a DeepSeek API route is
 * sent during peak pricing. It offers sending anyway, scheduling the message
 * for when peak ends, or returning it to the composer; when the Session already
 * holds a deferred message, scheduling offers merging into it or following it.
 */
import { Button, Modal } from '@deepseek-ai/dsh-client-ui-primitives'
import type { HostObservable, InjectFace, PropsLocale, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'
import type { GateChoice, GateQuestion, GateView } from './gate.ts'
import { formatClock, formatRemaining } from './PeakPill.tsx'
import css from './SendGateDialog.module.css'

/** Injected face: the question on screen and the answer action. */
export interface SendGateDialogInjected {
  hooks: {
    /** The open question, or null. */
    gate: HostObservable<GateView>
  }
  /** Answer the open question. */
  choose: (choice: GateChoice) => void
}

/** Full component props. */
export type SendGateDialogProps =
  PropsRuntime<'shell.overlay'> & PropsLocale<'peakHours'> & InjectFace<SendGateDialogInjected>

/** Characters of a waiting message shown in the dialog. */
const PREVIEW_CHARS = 140

/**
 * Render the dialog while a send is held.
 * @param props - composed slot props.
 * @returns the dialog, or nothing.
 */
export function SendGateDialog({ t, useGate, choose }: SendGateDialogProps) {
  const question = useGate(value => value)
  if (question === null) return null
  return <GateModal question={question} t={t} choose={choose} />
}

/**
 * The open dialog.
 * @param props - the question, translate, and the answer action.
 * @returns the modal.
 */
function GateModal({ question, t, choose }: { question: GateQuestion; t: SendGateDialogProps['t']; choose: (choice: GateChoice) => void }) {
  const now = Date.now()
  const time = formatClock(question.endsAt, now)
  // A new message follows, or joins, the last one in line.
  const earlier = question.pending.at(-1)
  const earlierTime = earlier === undefined ? time : formatClock(Date.parse(earlier.at), now)
  const canSchedule = question.blocked === null
  const edit = (): void => { choose({ kind: 'edit' }) }
  const body = question.blocked !== null || earlier !== undefined
  return (
    <Modal
      open
      onClose={edit}
      title={t('gate.title')}
      closeLabel={t('gate.close')}
      description={t('gate.body', { model: question.model, time, remaining: formatRemaining(question.endsAt - now, t) })}
      className={String(css.dialog)}
      footer={(
        <div className={css.footer}>
          <Button variant="ghost" onClick={edit} data-modal-autofocus={canSchedule ? undefined : ''}>{t('gate.edit')}</Button>
          <Button variant="outline" onClick={() => { choose({ kind: 'send' }) }}>{t('gate.send')}</Button>
          {canSchedule && earlier === undefined
            ? (
              <Button variant="primary" data-modal-autofocus="" onClick={() => { choose({ kind: 'schedule', placement: 'alone' }) }}>
                {t('gate.schedule', { time })}
              </Button>
            )
            : null}
        </div>
      )}
    >
      {body ? <GateBody question={question} t={t} choose={choose} earlier={earlier} time={earlierTime} /> : undefined}
    </Modal>
  )
}

/**
 * The dialog body: why a message cannot be scheduled, or the waiting messages and where this one goes.
 * @param props - the question, translate, the answer action, the last waiting message, and its send time.
 * @returns the body.
 */
function GateBody({ question, t, choose, earlier, time }: {
  question: GateQuestion
  t: SendGateDialogProps['t']
  choose: (choice: GateChoice) => void
  earlier: GateQuestion['pending'][number] | undefined
  time: string
}) {
  const canSchedule = question.blocked === null
  return (
    <>
      {question.blocked === 'attachments' ? <p className={css.note}>{t('gate.noAttachments')}</p> : null}
      {question.blocked === 'unavailable' ? <p className={css.note}>{t('gate.noSchedule')}</p> : null}
      {canSchedule && earlier !== undefined
        ? (
          <div className={css.pending}>
            <p className={css.label}>{t('gate.pending', { time })}</p>
            <ul className={css.list}>
              {question.pending.map(item => (
                <li key={item.id} className={css.item}>
                  {item.text.length > PREVIEW_CHARS ? `${item.text.slice(0, PREVIEW_CHARS)}…` : item.text}
                </li>
              ))}
            </ul>
            <button
              type="button"
              className={css.option}
              data-modal-autofocus=""
              onClick={() => { choose({ kind: 'schedule', placement: 'after', earlierId: earlier.id }) }}
            >
              <span className={css.optionTitle}>{t('gate.after')}</span>
              <span className={css.optionHint}>{t('gate.afterHint', { time })}</span>
            </button>
            <button
              type="button"
              className={css.option}
              onClick={() => { choose({ kind: 'schedule', placement: 'together', earlierId: earlier.id }) }}
            >
              <span className={css.optionTitle}>{t('gate.together')}</span>
              <span className={css.optionHint}>{t('gate.togetherHint', { time })}</span>
            </button>
          </div>
        )
        : null}
    </>
  )
}
