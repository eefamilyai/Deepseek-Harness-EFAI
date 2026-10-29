/**
 * The tool-call format the gateway teaches.
 *
 * A web chat has no `tools` field, so the schemas travel as text and the call
 * comes back as text. The statement has to be short, unambiguous, and close to
 * what the model already does: measured against the current web model, an
 * untutored prompt already answers with `<tool_call>{"name":…,"arguments":…}</tool_call>`,
 * so that is the shape taught here. The reader accepts several others (see
 * `envelope.ts`) because a long, rotated context degrades formatting first.
 *
 * @module dswg/tools/protocol
 */

/** One tool as the client declared it. */
export interface ToolDefinition {
  name: string
  description?: string
  /** JSON Schema for the arguments object. */
  parameters?: Record<string, unknown>
}

const FORMAT = `# Calling tools

You have no native tool-call channel. To call a tool, write a \`<tool_call>\` block
containing one JSON object:

<tool_call>
{"name": "TOOL_NAME", "arguments": {"PARAMETER": "value"}}
</tool_call>

Rules:
- One JSON object per block. Put the tool name in "name" and every argument inside "arguments".
- Arguments must be valid JSON. Use numbers for numbers and booleans for booleans, not strings.
- To call several tools at once, write several <tool_call> blocks, one after another.
- A <tool_call> block is the only thing that runs. Everything else is prose shown to the user,
  including fenced code blocks.
- Do not invent parameters, and do not omit required ones.
- After a block, stop and wait: the result arrives in the next turn as a "Tool result" message.
- Never write a "Tool result:" line yourself, and never paste a tool's output back into your
  reply. You do not have the result until it is given to you.
- Always close the block with </tool_call> on its own line, even if the arguments are long.
  An unclosed block does not run.
- Do not repeat a call or a result twice in one reply. One block per call.
- If you have no tool to call, answer in prose and do not write a <tool_call> block.`

/**
 * Render one tool's entry in the catalog.
 * @param tool - the declaration.
 * @returns the catalog entry.
 */
function toolEntry(tool: ToolDefinition): string {
  const required = requiredNames(tool)
  const schema = tool.parameters ?? { type: 'object', properties: {} }
  const lines = [
    `## ${tool.name}`,
    '',
    (tool.description ?? '').trim() || '(no description)',
    '',
    required.length > 0
      ? `Required arguments (every call must include all of these): ${required.map((name) => `\`${name}\``).join(', ')}`
      : 'Required arguments: none.',
    '',
    'Arguments (JSON Schema):',
    '```json',
    JSON.stringify(schema, undefined, 2),
    '```',
  ]
  return lines.join('\n')
}

/**
 * Required argument names declared by a tool.
 * @param tool - the declaration.
 * @returns the names, in schema order.
 */
export function requiredNames(tool: ToolDefinition): string[] {
  const required = (tool.parameters as { required?: unknown } | undefined)?.required
  return Array.isArray(required) ? required.filter((name): name is string => typeof name === 'string') : []
}

/**
 * Argument names declared by a tool, in schema order.
 * @param tool - the declaration.
 * @returns the names.
 */
export function parameterNames(tool: ToolDefinition): string[] {
  const properties = (tool.parameters as { properties?: unknown } | undefined)?.properties
  if (properties === null || typeof properties !== 'object') return []
  return Object.keys(properties as Record<string, unknown>)
}

/**
 * Build the system-slot text that teaches the format and lists the tools.
 * @param tools - the request's tools.
 * @returns the block to append to the system prompt, or the empty string.
 */
export function toolProtocolPrompt(tools: readonly ToolDefinition[] | undefined): string {
  if (!tools || tools.length === 0) return ''
  const catalog = tools.map(toolEntry).join('\n\n')
  return `${FORMAT}\n\n# Tools available to you\n\n${catalog}`
}

/** Why a turn is being sent a second time. */
export type RepairReason = 'malformed' | 'roleplay'

/**
 * The corrective note appended when a turn's tool markup could not be read, or
 * when the model answered in the tool's voice instead of calling it.
 * @param tools - the tools the request declared.
 * @param reason - which failure the note is correcting.
 * @returns the instruction.
 */
export function repairInstruction(tools: readonly ToolDefinition[], reason: RepairReason = 'malformed'): string {
  const names = tools.map((tool) => tool.name)
  if (reason === 'roleplay') {
    return [
      '# Format correction',
      '',
      'Your previous message wrote a tool result yourself. You cannot see tool results: they are only produced',
      'by the client, after you emit a call and it runs. Anything you wrote as a result was invented.',
      `To act, emit exactly one \`<tool_call>\` block holding a single JSON object, using only these tool names: ${names.join(', ')}.`,
      'Do not write "Tool result", do not answer your own call, and do not repeat any output back. Emit the call and stop.',
    ].join('\n')
  }
  return [
    '# Format correction',
    '',
    'Your previous message contained tool-call markup that could not be read, so nothing ran.',
    `Use exactly one \`<tool_call>\` block per call, with a single valid JSON object inside it, and only these tool names: ${names.join(', ')}.`,
    'Emit the call again now, with complete JSON and no surrounding prose.',
  ].join('\n')
}
