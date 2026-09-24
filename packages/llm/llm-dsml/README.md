# @deepseek-ai/dsh-llm-dsml

The **text-channel tool-call reader**, for every provider and every model.

A model writes the tool-call markup it was trained on. Which markup that is comes from the **model**, not from the transport it is speaking through — so a request that filled a provider's native `tools` field correctly can still get the call back as text. Unread, that call reaches the user as raw markup and reads back to the model as an action that returned nothing: the turn is spent, and neither side is told why.

This package reads it. One `llm/stream` pass sits above whatever adapter answered, turns a complete text-channel call for a declared tool into the same chunks a native tool field would have produced, and leaves everything else exactly as the adapter wrote it.

## What it reads

| Shape | Example |
|---|---|
| The taught block | `<tool_calls><invoke name="read"><parameter name="path">a.txt</parameter></invoke></tool_calls>` |
| The same envelope, other word | `<function_calls>…</function_calls>` |
| DeepSeek special tokens | `<｜｜DSML｜｜ calls>`, `<｜DSML｜tool_calls>`, `<｜DSML｜ parameter name="path">`, with or without spaces, one pipe or two |
| A tool named as its own tag | `<read path="a.txt"/>` — only for tools this request declared |
| A JSON arguments body | `<invoke name="search_files">{ "query": "pool" }</invoke>` |
| Near-miss punctuation | `<invoke=read>`, `<parameter=path>`, a `<parameter>` with no name |
| An argument with its invoke lost | a line-leading `<parameter name="…">` whose name only one declared tool owns |

Everything else is prose. A block naming a tool this request never declared stays visible as written, and so does a call still being written — inventing the end of a half-written command is how that command wrongly runs.

## Read everywhere, taught in one place

Only a transport with no native tool channel states the format: [`@deepseek-ai/dsh-llm-kiln`](../llm-kiln/README.md) appends `toolProtocolPrompt()` to its system slot, because a web chat session has nowhere else to put the schemas. Every route is **read**.

That asymmetry is why this pass is silent. A provider that was handed real tool schemas was never told to write DSML, so a note correcting how it spelled DSML would be the harness inventing a protocol dispute; with `notes` off the reader converts what it can and forwards every other character untouched. Being silent is also what makes it safe above an adapter that already reads this format for itself: what reaches this pass from the Kiln adapter is text that produced no call, which — same tools, same rules — produces no call here either.

## When a model cannot take native tools

Some models refuse any request that carries a `tools` field. OpenRouter routes a model only to endpoints that support tool use, so a model with none fails the whole turn with "No endpoints found that support tool use"; Ollama and some OpenAI-compatible servers refuse the same way. An agent's every request carries tools, so such a model could not be used at all.

The pass answers that refusal instead of forwarding it. It sends the request again through the stream chain with the format statement and tool catalog appended to the system prompt, prior calls rendered as text, each tool result as a user turn labelled `OUTPUT:`, and no `tools` field — the channel the Kiln routes use — then reads the calls in the reply as real ones. It remembers the provider and model for the rest of the process, so later requests go to the text channel directly. Any other failure is forwarded exactly as before. `textToolFallback: false` turns this off.

## Composition

```yaml
- id: llm-dsml
  name: '@deepseek-ai/dsh-llm-dsml'
  config:
    reasoningRecovery: true   # run a call the model left at the end of its thinking
    excludeProviders: []      # route names to leave untouched
    textToolFallback: true    # resend on the text channel when a model refuses native tools
```

The listener is registered plainly rather than prepended, so it sits as close to the adapter as the composition allows: retry, replay, and checkpoint layers then see the stream a native-tool provider would have produced, and a recovered call is a real call to every one of them.

A request that declares no tools is returned untouched, so an auxiliary call — a title, a compaction summary — pays nothing and cannot have a quoted transcript read as a call.

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The Cordis plugin: one `llm/stream` listener, and the package's exports |
| [`src/stream.ts`](src/stream.ts) | The reader as a filter over an assembled chunk stream, including block-index bookkeeping |
| [`src/dsml.ts`](src/dsml.ts) | `DsmlTranslator`: the line-oriented reader, every dialect above, and the repair rules |
| [`src/protocol.ts`](src/protocol.ts) | The format statement a channel-less transport teaches, and the schema-typed parameter coercion |
| [`src/fallback.ts`](src/fallback.ts) | Recognising a native-tools refusal, and rewriting the refused request for the text channel |

## Model Experience

### Tool-call protocol in the system prompt

#### What the model sees

Nothing from this package, unless the model refused native tools. `toolProtocolPrompt()` is defined here and rendered by the adapter that has no native tool channel — see the [Kiln adapter's Model Experience](../llm-kiln/README.md#model-experience) for the verbatim statement and its catalog — and by this pass's fallback, which appends the same statement to the system prompt of a request whose model refused a `tools` field.

##### Appended to the system prompt after a refusal

```markdown
<the system prompt as the harness assembled it>

<the format statement, verbatim as in the Kiln adapter's Model Experience>

# Tools available to you

<one entry per tool the request declared>
```

#### Token effect

Zero for a route whose model takes native tools. After a refusal, the statement and catalog replace the provider's own `tools` field for that model, at a similar size; the refused attempt itself costs a round trip and no tokens.

#### KV Cache effect

Independent: the pass reads responses and never writes a request, so it cannot invalidate a cached prefix. A tool call it recovers enters the session log as an ordinary tool call and extends the next request append-only, exactly as a native one does.

### Recovered tool calls and their results

#### What the model sees

A call this pass recovers becomes a real `tool-call` block, so the next turn carries its `tool-result` the same way a native call's result arrives. The markup the model wrote is consumed by the call rather than echoed back as text.

#### Token effect

Conditional and usually a saving: the block's own markup stops being replayed as assistant text, and the result it earns is the result that turn was asking for.

#### KV Cache effect

Append-only. The recovered call and its result extend the transcript; no earlier request tokens are rewritten.

## Known Limitations and Deferred Work

- **A call inside a completed block dispatches before the stream's outcome is known** — only the end-of-stream flush is gated on the finish reason, so a whole block already read when a later chunk errors has produced its call. The loop discards a failed attempt wholesale, so the call does not reach a tool, but the chunks exist.
- **One JSON body shape is read, not every native envelope** — `{"arg": …}` as the whole invoke body, and only when every key is a declared parameter. A bare `{"name": "read", "arguments": {…}}` call envelope with no `<invoke>` around it is prose here.
- **Reasoning recovery reads only the tail** — a complete call in the middle of a longer thought is a mention, not the model's closing action, and is left alone; a truncated one is refused.
- **A refusal is recognised by its wording** — the fallback matches the messages OpenRouter, Ollama, and common OpenAI-compatible servers send. A provider that words the same refusal differently still fails the turn as before.
- **The memory of a refusal lasts one process** — a restart tries native tools again, which costs one refused round trip per model.
- **Interleaved text blocks are read independently** — a call split across two provider text blocks is not joined, because a block boundary is the adapter saying that text finished.
