/**
 * The Skill Builder's conversation inside the Skills page: the shared
 * Conversation content, in its embedded variant, fixed to the chat view, for
 * the Session the page provides.
 */
import type { ConversationViewsProps } from '@deepseek-ai/dsh-client-ui-conversation/client'
import type { PropsRenderFactories, PropsRuntime } from '@deepseek-ai/dsh-client-ui-slots'

/**
 * The chat view only: the embedded panel has no room for the trajectory tab.
 * @param props - the views seat.
 * @returns the chat session view.
 */
export function ChatOnlyView(props: ConversationViewsProps) {
  return <>{props.renderSlot('conversation.session', { view: 'chat' })}</>
}

/** Props of the session-scoped seat the page renders inside its Session provider. */
export type BuilderConversationProps = PropsRuntime<'skillsStudio.builder.conversation'> & PropsRenderFactories

/**
 * Render the Conversation for the provided Session, with the welcome shown until its first turn.
 * @param props - the Session hooks and the factory renderer.
 * @returns the Conversation content.
 */
export function BuilderConversation({ sessionId, useSession, useConversation, useSessions, renderFactorySlot }: BuilderConversationProps) {
  const session = useSession(value => value)
  const conversation = useConversation(value => value)
  const active = conversation.activeTargets.size > 0 || (!session.blank && !session.awaitingFirstTurn) || session.running
  const phase = active ? 'active' : session.promptAttempted ? 'engaging' : 'blank'
  const summaryBlank = useSessions(state => state.byId[sessionId]?.blank)
  const settling = phase === 'blank' && session.openState === 'loading' && summaryBlank !== true
  const hero = phase === 'blank' && (session.openState === 'open' || summaryBlank === true)
  return renderFactorySlot('conversation.content', { variant: 'embedded', phase: settling ? 'settling' : hero ? 'hero' : 'active', hero }, {
    slots: { views: ChatOnlyView },
  })
}
