/**
 * Replies that narrate a tool result instead of making a call.
 *
 * A long context rotates a model into playing both sides of the transcript: it
 * writes `Tool result: …` and then answers its own invention, or it pastes the
 * result it was given back as if it had produced it. Nothing runs, the client
 * sees an answer built on invented output, and the loop the agent was in stops
 * without saying so.
 *
 * The signal has to be structural, because the same words appear in ordinary
 * explanations. Two tests qualify a reply: it uses the transcript's own
 * result label, or it reproduces a long run of the result it was handed. Prose
 * about a tool result — "the grep returned three files" — matches neither.
 *
 * @module dswg/tools/roleplay
 */

/**
 * Markup that only ever means the model is writing a tool result itself.
 *
 * These carry no meaning in prose, so they count wherever they appear.
 */
const RESULT_MARKUP = ['<tool_result>', '</tool_result>', '<tool_response>', '<|tool_result|>', '<｜tool_result｜>']

/**
 * Labels a transcript puts at the start of a line.
 *
 * The model that takes over the tool's voice writes `Tool result:` the way this
 * gateway labels one, as a line of its own. The same words inside a sentence are
 * an answer about a tool, which is what a working turn looks like.
 */
const RESULT_LINES = /(?:^|\n)[ \t>*-]*(?:tool result|tool output|tool response|observation)\b\s*[:(]/i

/** How much of the handed-in result must reappear, in characters. */
const ECHO_CHARS = 240

/**
 * Collapse whitespace so a result compared with itself is not defeated by
 * re-indentation.
 * @param text - the text to collapse.
 * @returns the normalised text.
 */
function normalise(text: string): string {
  return text.replace(/\s+/g, ' ').trim()
}

/**
 * Whether a reply is narrating a tool result rather than asking for one.
 * @param text - the model's reply, as the client would see it.
 * @param lastToolResult - the most recent tool result in the request, if any.
 * @returns true when the reply has taken over the tool's voice.
 */
export function looksLikeRoleplay(text: string, lastToolResult: string | null): boolean {
  if (text.trim().length === 0) return false
  const lower = text.toLowerCase()
  if (RESULT_MARKUP.some((marker) => lower.includes(marker))) return true
  if (RESULT_LINES.test(text)) return true
  if (lastToolResult === null) return false

  const result = normalise(lastToolResult)
  if (result.length < ECHO_CHARS) return false
  const reply = normalise(text)
  // A model that answers with the result it was given has nothing new to say;
  // one that cites a line of it from inside a sentence does.
  const head = result.slice(0, ECHO_CHARS)
  if (reply.includes(head)) return true
  return false
}
