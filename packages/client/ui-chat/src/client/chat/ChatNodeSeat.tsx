import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ConversationLocationDataStore, ConversationTurnDataMap } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import { TURN_PROCESS_INDEPENDENT_KINDS } from '../contract/turn-process.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly useChatNode: ChatViewSlotProps['useChatNode']
  readonly useChatNodeProcess: ChatViewSlotProps['useChatNodeProcess']
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

function turnDataOf(node: ChatNode | undefined): ConversationLocationDataStore<ConversationTurnDataMap> | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.data : undefined
}

function turnOf(node: ChatNode | undefined): number | undefined {
  const location = node?.location
  return location?.kind === 'turn' || location?.kind === 'step' ? location.turn.turn : undefined
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, useChatNode, useChatNodeProcess, historyIncomplete, compactTranscript,
  cwd, openFile, openSkill, inspectCall, forkAt,
  loadImage, renderMessageImages, fileMentions, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChatNode(nodeKey)
  const routedNode = node as ChatNode | undefined
  const turn = turnOf(routedNode)
  const processPresentation = useChatNodeProcess(nodeKey)
  const processSpec = processPresentation?.spec
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  // DSH-FORK(brand): a stored entry applies to this Turn when it pins the
  // Turn's current answer step, or when it was recorded while the Turn was
  // still running (answer step null) and therefore describes no other
  // generation. Comparing the two answer steps alone dropped every explicit
  // choice the reader made mid-Turn the moment `turn/end` pinned a step.
  // EXIT: upstream renders the process row only after the Turn closes, so it
  // never has to carry a running choice across that boundary.
  const processEntry = storedEntry !== undefined
    && processSpec !== undefined
    && (storedEntry.answerStep === null || storedEntry.answerStep === processSpec.answerStep)
    ? storedEntry
    : undefined
  const setOpen = useCallback((open: boolean) => {
    // A running Turn has no answer step yet; it records null rather than
    // dropping the choice, so the reader's collapse survives the Turn finishing.
    if (processSpec !== undefined) {
      actions.setTurnProcessOpen(processSpec.turn, processSpec.answerStep, open)
    }
  }, [actions, processSpec])
  // DSH-FORK(brand): the row exists for a Turn that is still running, not only
  // after it closes. The folded window ends at the finalized answer when there
  // is one and is otherwise open-ended, so a running Turn's row summarizes the
  // work it has done so far rather than waiting for the Turn to finish.
  // EXIT: upstream gives the folded process row a content-derived label.
  const sameTurn = routedNode !== undefined
    && processSpec !== undefined
    && (routedNode.location.kind === 'turn' || routedNode.location.kind === 'step')
    && routedNode.location.turn.turn === processSpec.turn
  const turnLocation = sameTurn ? routedNode.location.turn : undefined
  const turnClosed = turnLocation?.status === 'closed'
  // A running Turn starts expanded so the reader watches the work land; a
  // finalized one starts folded. Either way the reader's own toggle wins.
  const processOpen = processEntry === undefined ? turnClosed === false : processEntry.open
  // DSH-FORK(brand): a partially paged history withholds only the one Turn whose
  // own `turn/start` is missing, instead of every Turn's process row. EXIT:
  // upstream gives the folded process row a content-derived label.
  const historyTruncatesTurn = historyIncomplete && turnLocation?.start === undefined
  const processEndSeq = processSpec === undefined
    ? null
    : processSpec.answerAnchorSeq ?? Number.POSITIVE_INFINITY
  const processWindowReady = processSpec !== undefined
    && processPresentation !== undefined
    && compactTranscript
    && processPresentation.turn === processSpec.turn
    && !historyTruncatesTurn
  // DSH-FORK(brand): the human message that opened the Turn is the Turn's input,
  // not its work, so it stays visible even though a mid-turn steer now folds
  // with the rest of the process. EXIT: upstream renders a mid-turn steer
  // outside the collapsed process row.
  const openingHumanAnchorSeq = processPresentation?.openingHumanAnchorSeq ?? null
  // DSH-FORK(brand): a steer the reader sends after the finalized answer still
  // belongs to the Turn it steered, so it folds with the rest of the process
  // instead of floating below the summary. Every other member stops at the
  // answer, which keeps the answer itself last. EXIT: upstream gives the folded
  // process row a content-derived label.
  const afterAnswerSteer = routedNode?.kind === 'steering'
  const processMember = routedNode !== undefined
    && sameTurn
    && processWindowReady
    && processEndSeq !== null
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && (routedNode.anchorSeq < processEndSeq || afterAnswerSteer)
    && routedNode.anchorSeq !== openingHumanAnchorSeq
  const processAnswer = routedNode !== undefined
    && sameTurn
    && processWindowReady
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  const foldable = processWindowReady
    && (processMember || (ownsDisclosure
      && (processPresentation.hasExternalProcess || processSpec.inlineReasoning)))
  const turnProcess = useMemo(() => processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      open: processOpen,
      setOpen,
    }, [
    foldable, processOpen, processSpec, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processPresentation.compactAnswer
    && !processOpen
  // `processOpen` already carries the default (open while running, folded once
  // finalized), so hiding follows the resolved state and no extra Turn-status
  // condition is needed: a reader who collapses a running Turn sees it close.
  const processHidden = controllerInactive || (foldable && processMember && !processOpen)
  const revealProcess = useCallback(() => {
    if (processMember) setOpen(true)
  }, [processMember, setOpen])
  const wrapperRef = useSearchableHidden(processHidden, revealProcess)
  const owner = useMemo<ChatNodeOwnerProps | null>(() => node === undefined
    ? null
    : {
      cwd,
      openFile,
      openSkill,
      inspectCall,
      forkAt,
      loadImage,
      renderMessageImages,
      fileMentions,
      turnProcess,
    }, [
    node, cwd, openFile, openSkill, inspectCall, forkAt,
    loadImage, renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  const turnData = turnDataOf(routedNode)
  // Runtime dispatch owns the correlation: every Node's discriminant is the
  // keyed-slot entry passed alongside that same Node. TypeScript does not
  // distribute an object containing a union into a union of objects itself.
  const routedOwner = { ...owner, node: routedNode } as RoutedChatNodeOwner
  return (
    <div
      ref={wrapperRef}
      className={css.flowItem}
      data-chat-anchor-key={routedNode.key}
      data-chat-flow-key={routedNode.key}
      data-chat-flow-kind={routedNode.kind}
      data-chat-turn={turn}
      data-turn-process-member={processMember || undefined}
      data-turn-process-hidden={processHidden || undefined}
      data-turn-process-answer={compactAnswer || undefined}
    >
      {renderSlot('conversation.chat.node', routedOwner, {
        entryKey: routedNode.kind,
        hookContext: turnData,
        fallback: (
          <JsonBlock
            label={t('message.unknownSurface', { type: routedNode.kind })}
            payload={routedNode.data}
            truncatedLabel={total => t('json.truncated', { total })}
          />
        ),
      })}
    </div>
  )
})
