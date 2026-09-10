import { Fragment, memo } from 'react'
import { IconChevronDownOutline14 } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeViewProps } from '../contract/slots.ts'
import type { TurnToolAction, TurnToolSummary } from '../contract/turn-tool-summary.ts'
import { fitLabelParts, MAX_SUMMARY_LABEL } from '../contract/turn-tool-summary.ts'
import css from './TurnProcessNodeView.module.css'

/**
 * Characters held back for the overflow marker when the row must drop phrases.
 *
 * The marker reports what the row did not print, so it needs room of its own;
 * without the reserve it would be the phrase the row elides.
 */
const OVERFLOW_RESERVE = 10

/**
 * Tool family a phrase's verb belongs to, as the accent it prints in.
 *
 * These are the same families the expanded rows colour through
 * `--dsw-alias-flow-*`, so a folded Turn reads as a miniature of the rows it
 * hides rather than as one undifferentiated grey line.
 */
type PhraseTone = 'mutate' | 'read' | 'shell' | 'search' | 'instruct' | 'generic'

/** One printable piece of the folded line. */
interface Phrase {
  /** The verb, printed in the family accent. */
  readonly text: string
  /**
   * A model-authored sentence the verb introduces, printed as neutral prose.
   *
   * A kernel cell's leading comment is the model's own words, so painting it in
   * the family hue would tint a sentence that is not the row's own copy.
   */
  readonly detail?: string | undefined
  readonly tone: PhraseTone
}

/** The folded line: its phrases, its overflow marker, and its line delta. */
interface SummaryLine {
  readonly phrases: readonly Phrase[]
  /** Rendered overflow marker, or an empty string when nothing was dropped. */
  readonly marker: string
  readonly added: number
  readonly removed: number
}

/** One action as a reader-facing phrase. */
function actionLabel(action: TurnToolAction, t: ChatNodeViewProps<'turn-process'>['t']): string {
  switch (action.kind) {
    case 'created':
      return t('message.turnProcess.created', { name: action.name })
    case 'edited':
      return t('message.turnProcess.edited', { name: action.name })
    case 'read':
      return t('message.turnProcess.read', { name: action.name })
    case 'command':
      return t('message.turnProcess.command')
    case 'script':
      return action.label === undefined
        ? t('message.turnProcess.script')
        : t('message.turnProcess.scriptNamed', { label: action.label })
    case 'search':
      return t('message.turnProcess.search')
    case 'web':
      return t('message.turnProcess.web')
    case 'fetch':
      return t('message.turnProcess.fetch')
    case 'plan':
      return t('message.turnProcess.plan')
    case 'delegated':
      return t('message.turnProcess.delegated', { name: action.name })
    case 'other':
      return t('message.turnProcess.other', { name: action.name })
  }
}

/**
 * Split a rendered phrase into its verb and the sentence that follows it.
 *
 * Both dictionaries separate the two with a colon, so the verb is everything up
 * to and including it. A phrase with no colon is all verb.
 * @param text - the rendered phrase.
 * @returns the verb and the trailing sentence, or undefined when there is none.
 */
function splitVerb(text: string): { verb: string; detail: string } | undefined {
  const match = /^([^:：]{1,24}[:：])([\s\S]*)$/.exec(text)
  if (match === null) return undefined
  const [, verb, detail] = match
  if (verb === undefined || detail === undefined || detail.trim() === '') return undefined
  return { verb, detail }
}

/** The accent an action's verb prints in. */
function actionTone(action: TurnToolAction): PhraseTone {
  switch (action.kind) {
    case 'created':
    case 'edited':
      return 'mutate'
    case 'read':
      return 'read'
    // A kernel cell and a shell command both name an execution, so they share
    // the shell family's hue rather than splitting hairs over the language run.
    case 'command':
    case 'script':
      return 'shell'
    case 'search':
    case 'web':
    case 'fetch':
      return 'search'
    case 'delegated':
      return 'instruct'
    case 'plan':
    case 'other':
      return 'generic'
  }
}

/** One action as a phrase the row can print. */
function actionPhrase(
  action: TurnToolAction,
  t: ChatNodeViewProps<'turn-process'>['t'],
): Phrase {
  const tone = actionTone(action)
  if (action.kind !== 'script' || action.label === undefined) {
    return { text: actionLabel(action, t), tone }
  }
  const rendered = t('message.turnProcess.scriptNamed', { label: action.label })
  const split = splitVerb(rendered)
  return split === undefined
    ? { text: rendered, tone }
    : { text: split.verb, detail: split.detail, tone }
}

// DSH-FORK(brand): the folded row's content-derived label, budgeted to the row
// so it is never elided mid-phrase. EXIT: upstream gives the folded process row
// a content-derived label.
/**
 * One line describing the Turn's tool activity: distinct actions in order, a
 * repeat count where the Turn did the same thing more than once, the aggregate
 * line delta of its file mutations, and an overflow marker.
 *
 * How many phrases to print is decided against the row's character budget here
 * rather than left to the row's own overflow rule, which would cut the last
 * phrase mid-word and hide how much was dropped.
 */
function summaryLine(
  summary: TurnToolSummary,
  t: ChatNodeViewProps<'turn-process'>['t'],
): SummaryLine {
  const separator = t('message.turnProcess.separator')
  const phrases: Phrase[] = summary.actions.map(({ action, count }) => {
    const phrase = actionPhrase(action, t)
    if (count === 1) return phrase
    return {
      text: t('message.turnProcess.repeat', {
        text: `${phrase.text}${phrase.detail ?? ''}`,
        count,
      }),
      tone: phrase.tone,
    }
  })
  const delta = summary.added === 0 && summary.removed === 0
    ? 0
    : ` +${String(summary.added)} -${String(summary.removed)}`.length
  const available = MAX_SUMMARY_LABEL - delta
  const texts = phrases.map(phrase => `${phrase.text}${phrase.detail ?? ''}`)
  let fitted = fitLabelParts(texts, separator, available)
  if (fitted.omitted + summary.omitted > 0) {
    fitted = fitLabelParts(texts, separator, available - OVERFLOW_RESERVE)
  }
  const dropped = fitted.omitted + summary.omitted
  return {
    phrases: phrases.slice(0, fitted.parts.length),
    marker: dropped === 0 ? '' : t('message.turnProcess.more', { count: dropped }),
    added: summary.added,
    removed: summary.removed,
  }
}

/** Turn-level process disclosure controller. */
export const TurnProcessNodeView = memo(function TurnProcessNodeView({
  node, turnProcess, t,
}: ChatNodeViewProps<'turn-process'>) {
  if (turnProcess === undefined) throw new Error('turn-process node requires Turn process owner state')
  if (!turnProcess.foldable) return null
  const open = turnProcess.open
  // DSH-FORK(brand): name the Turn's work when it is known, and fall back to the
  // count-only label for a Turn whose tool calls were not all loaded. EXIT:
  // upstream gives the folded process row a content-derived label.
  const summary = turnProcess.summary
  const separator = t('message.turnProcess.separator')
  let line: SummaryLine
  if (summary !== undefined && summary.actions.length > 0) {
    line = summaryLine(summary, t)
  } else {
    const counted: string[] = []
    if (node.data.toolCallCount > 0) {
      counted.push(t(
        node.data.toolCallCount === 1
          ? 'message.turnProcess.toolCalls.one'
          : 'message.turnProcess.toolCalls.other',
        { count: node.data.toolCallCount },
      ))
    }
    if (node.data.messageCount > 0) {
      counted.push(t(
        node.data.messageCount === 1
          ? 'message.turnProcess.messages.one'
          : 'message.turnProcess.messages.other',
        { count: node.data.messageCount },
      ))
    }
    if (node.data.subagentCount > 0) {
      counted.push(t(
        node.data.subagentCount === 1
          ? 'message.turnProcess.subagents.one'
          : 'message.turnProcess.subagents.other',
        { count: node.data.subagentCount },
      ))
    }
    line = {
      phrases: (counted.length === 0 ? [t('message.turnProcess.thoughtForAWhile')] : counted)
        .map(text => ({ text, tone: 'generic' as const })),
      marker: '',
      added: 0,
      removed: 0,
    }
  }
  return (
    <button
      type="button"
      className={css.root}
      data-open={open || undefined}
      data-turn-process={node.data.turn}
      data-turn-process-messages={node.data.messageCount}
      data-turn-process-tool-calls={node.data.toolCallCount}
      data-turn-process-subagents={node.data.subagentCount}
      aria-expanded={open}
      onClick={(event) => {
        event.currentTarget.focus()
        turnProcess.setOpen(!open)
      }}
    >
      <span className={css.label}>
        {line.phrases.map((phrase, index) => (
          <Fragment key={`${String(index)}:${phrase.text}`}>
            {index > 0 ? separator : null}
            <span className={css.phrase} data-tone={phrase.tone}>{phrase.text}</span>
            {phrase.detail === undefined ? null : <span className={css.detail}>{phrase.detail}</span>}
          </Fragment>
        ))}
        {line.marker === ''
          ? null
          : (
            <>
              {line.phrases.length > 0 ? separator : null}
              <span className={css.more}>{line.marker}</span>
            </>
          )}
        {line.added === 0 && line.removed === 0
          ? null
          : (
            <>
              {' '}
              <span className={css.added}>{`+${String(line.added)}`}</span>
              {' '}
              <span className={css.removed}>{`-${String(line.removed)}`}</span>
            </>
          )}
      </span>
      <IconChevronDownOutline14 className={css.chevron} />
    </button>
  )
})
