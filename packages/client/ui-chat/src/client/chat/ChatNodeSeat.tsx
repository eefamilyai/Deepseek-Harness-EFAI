import { memo, useCallback, useMemo } from 'react'
import { JsonBlock } from '@deepseek-ai/dsh-client-ui-primitives'
import type { ChatNodeOwnerProps, ChatViewSlotProps } from '../contract/slots.ts'
import type { ChatNode } from '../contract/chat-nodes.ts'
import type { ChatNodeStore } from '../contract/snapshot.ts'
import {
  decodeTurnProcess, TURN_PROCESS_INDEPENDENT_KINDS, turnProcessGeneration,
  type TurnProcessSpec,
} from '../contract/turn-process.ts'
// DSH-FORK(brand): derive what the Turn's tool calls did, for the folded row's
// label. EXIT: upstream gives the folded process row a content-derived label.
import { summarizeToolCalls, type TurnToolSummary } from '../contract/turn-tool-summary.ts'
import { storedTurnProcessEntry } from '../stores.ts'
import { useSearchableHidden } from './searchable-hidden.ts'
import css from './ChatView.module.css'

interface ChatNodeSeatProps extends ChatNodeOwnerProps {
  readonly nodeKey: string
  readonly historyIncomplete: boolean
  readonly compactTranscript: boolean
  readonly useChat: ChatViewSlotProps['useChat']
  readonly useStore: ChatViewSlotProps['useStore']
  readonly actions: ChatViewSlotProps['actions']
  readonly renderSlot: ChatViewSlotProps['renderSlot']
  readonly t: ChatViewSlotProps['t']
}

type RoutedChatNodeOwner = {
  [Kind in ChatNode['kind']]: ChatNodeOwnerProps & { readonly node: ChatNode<Kind> }
}[ChatNode['kind']]

const EMPTY_PROCESS_KEYS: readonly string[] = []

interface TurnProcessLayout {
  readonly hasExternalProcess: boolean
  readonly compactAnswer: boolean
}

function turnProcessOpeningHumanAnchor(
  keys: readonly string[],
  nodes: ChatNodeStore,
  spec: TurnProcessSpec,
): number | undefined {
  let anchor: number | undefined
  for (const key of keys) {
    const node = nodes.get(key) as ChatNode | undefined
    if ((node?.kind === 'user' || node?.kind === 'steering')
      && node.anchorSeq < spec.controlAnchorSeq) {
      anchor = Math.min(anchor ?? node.anchorSeq, node.anchorSeq)
    }
  }
  return anchor
}

/** Derive disclosure facts from one content-revisioned Turn index. */
function turnProcessLayout(
  keys: readonly string[],
  nodes: ChatNodeStore,
  spec: TurnProcessSpec,
): TurnProcessLayout {
  let hasExternalProcess = false
  let compactAnswer = true
  const openingHumanAnchor = turnProcessOpeningHumanAnchor(keys, nodes, spec)
  for (const key of keys) {
    const node = nodes.get(key) as ChatNode | undefined
    if (node === undefined || node.kind === 'turn-process') continue
    if ((node.kind === 'user' || node.kind === 'steering')
      && (openingHumanAnchor === undefined || node.anchorSeq > openingHumanAnchor)
      && (spec.answerAnchorSeq === null || node.anchorSeq < spec.answerAnchorSeq)) {
      compactAnswer = false
    }
    if (TURN_PROCESS_INDEPENDENT_KINDS.has(node.kind)
      || node.anchorSeq < spec.processStartSeq
      || (spec.answerAnchorSeq !== null && node.anchorSeq >= spec.answerAnchorSeq)) continue
    if (node.kind !== 'assistant-step' || spec.answerStep === null || node.data.step !== spec.answerStep) {
      hasExternalProcess = true
    }
  }
  return { hasExternalProcess, compactAnswer }
}

/** Subscribe, apply Turn-process visibility, and dispatch one stable Context key. */
export const ChatNodeSeat = memo(function ChatNodeSeat({
  nodeKey, historyIncomplete, compactTranscript,
  selectedCallId, cwd, openFile, inspectCall, forkAt,
  renderMessageImages, fileMentions, useChat, useStore, actions, renderSlot, t,
}: ChatNodeSeatProps) {
  const node = useChat(snapshot => snapshot.nodes.get(nodeKey))
  const processSignature = useChat((snapshot) => {
    const current = snapshot.nodes.get(nodeKey)
    const location = current?.location
    return location?.kind === 'turn' || location?.kind === 'step'
      ? location.turn.data.get('turn-process')
      : undefined
  })
  const processSpec = useMemo(
    () => processSignature === undefined ? undefined : decodeTurnProcess(processSignature),
    [processSignature],
  )
  const nodeStore = useChat(snapshot => snapshot.nodes)
  // DSH-FORK(brand): a Turn folds while it is still running, and a partially
  // paged history withholds only the one Turn whose own `turn/start` is missing.
  // Upstream required closed + finalized + fully-loaded at once, which left the
  // row absent for most of a live session. EXIT: upstream gives the folded
  // process row a content-derived label.
  const processLayoutKeys = useChat((snapshot) => {
    if (!compactTranscript || processSpec === undefined) return EMPTY_PROCESS_KEYS
    const current = snapshot.nodes.get(nodeKey) as ChatNode | undefined
    const location = current?.location
    if (current === undefined
      || (location?.kind !== 'turn' && location?.kind !== 'step')
      || location.turn.turn !== processSpec.turn) return EMPTY_PROCESS_KEYS
    if (historyIncomplete && location.turn.start === undefined) return EMPTY_PROCESS_KEYS
    const ownsLayout = current.kind === 'turn-process'
      || (current.kind === 'assistant-step' && current.data.step === processSpec.answerStep)
    return ownsLayout ? snapshot.locations.getTurn(processSpec.turn) : EMPTY_PROCESS_KEYS
  })
  const processLayout = useMemo(
    () => processSpec === undefined || processLayoutKeys.length === 0
      ? undefined
      : turnProcessLayout(processLayoutKeys, nodeStore, processSpec),
    [nodeStore, processLayoutKeys, processSpec],
  )
  // DSH-FORK(brand): the folded row names the Turn's work instead of counting
  // it, so it reads "Created a.mjs, ran a command +53 -0". Only root tool-call
  // nodes inside the process window contribute; a Turn with none keeps the
  // count-only label the renderer falls back to.
  const processSummary = useMemo<TurnToolSummary | undefined>(() => {
    if (processSpec === undefined || processLayoutKeys.length === 0) return undefined
    const roots = []
    for (const key of processLayoutKeys) {
      const candidate = nodeStore.get(key) as ChatNode | undefined
      if (candidate?.kind === 'tool-call') roots.push(candidate.data.root)
    }
    return roots.length === 0 ? undefined : summarizeToolCalls(roots)
  }, [nodeStore, processLayoutKeys, processSpec])
  const processGeneration = useMemo(
    () => processSpec === undefined ? undefined : turnProcessGeneration(processSpec),
    [processSpec],
  )
  const storedEntry = useStore(state => processSpec === undefined
    ? undefined
    : storedTurnProcessEntry(state, processSpec.turn))
  const processEntry = storedEntry?.generation === processGeneration ? storedEntry : undefined
  const setOpen = useCallback((open: boolean) => {
    if (processGeneration !== undefined && processSpec !== undefined) {
      actions.setTurnProcessOpen(processSpec.turn, processGeneration, open)
    }
  }, [actions, processGeneration, processSpec])
  const routedNode = node as ChatNode | undefined
  const sameTurn = routedNode !== undefined
    && processSpec !== undefined
    && (routedNode.location.kind === 'turn' || routedNode.location.kind === 'step')
    && routedNode.location.turn.turn === processSpec.turn
  // DSH-FORK(brand): the row exists for a Turn that is still running, not only
  // after it closes. The folded window ends at the finalized answer when there
  // is one and is otherwise open-ended, so a running Turn's row summarizes the
  // work it has done so far rather than waiting for the Turn to finish.
  // EXIT: upstream gives the folded process row a content-derived label.
  const turnLocation = sameTurn ? routedNode.location.turn : undefined
  const turnClosed = turnLocation?.status === 'closed'
  // A running Turn starts expanded so the reader watches the work land; a
  // finalized one starts folded. Either way the reader's own toggle wins.
  const processOpen = processEntry === undefined ? turnClosed === false : processEntry.open
  const historyTruncatesTurn = historyIncomplete && turnLocation?.start === undefined
  const processEndSeq = processSpec === undefined
    ? null
    : processSpec.answerAnchorSeq ?? Number.POSITIVE_INFINITY
  const processWindowReady = processSpec !== undefined
    && compactTranscript
    && !historyTruncatesTurn
  const processMember = sameTurn
    && processWindowReady
    && processEndSeq !== null
    && !TURN_PROCESS_INDEPENDENT_KINDS.has(routedNode.kind)
    && routedNode.anchorSeq >= processSpec.processStartSeq
    && routedNode.anchorSeq < processEndSeq
  const processAnswer = sameTurn
    && processWindowReady
    && routedNode.kind === 'assistant-step'
    && routedNode.data.step === processSpec.answerStep
  const ownsDisclosure = routedNode?.kind === 'turn-process' || processAnswer
  const foldable = processWindowReady
    && (processMember || (ownsDisclosure
      && ((processLayout?.hasExternalProcess ?? false) || processSpec.inlineReasoning)))
  const turnProcess = useMemo(() => processGeneration === undefined || processSpec === undefined
    ? undefined
    : {
      spec: processSpec,
      foldable,
      open: processOpen,
      setOpen,
      summary: processSummary,
    }, [
    foldable, processGeneration, processOpen, processSpec, processSummary, setOpen,
  ])
  const controllerInactive = routedNode?.kind === 'turn-process'
    && !foldable
  const compactAnswer = processAnswer
    && foldable
    && processLayout?.compactAnswer === true
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
      selectedCallId,
      cwd,
      openFile,
      inspectCall,
      forkAt,
      renderMessageImages,
      fileMentions,
      turnProcess,
    }, [
    node, selectedCallId, cwd, openFile, inspectCall, forkAt,
    renderMessageImages, fileMentions, turnProcess,
  ])
  if (routedNode === undefined || owner === null) return null
  const location = routedNode.location
  const turn = location.kind === 'turn' || location.kind === 'step'
    ? location.turn.turn
    : undefined
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
        hookContext: nodeKey,
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
