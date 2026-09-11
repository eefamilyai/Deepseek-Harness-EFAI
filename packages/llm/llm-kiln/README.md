# @deepseek-ai/dsh-llm-kiln

The **Kiln multi-provider LLM adapter**: every provider KilnKernel ships, registered as harness LLM routes.

Sixteen presets come across - Anthropic, OpenAI, Gemini, OpenRouter, the DeepSeek paid API, Groq, xAI, Mistral, Together, Fireworks, Perplexity, Cerebras, NVIDIA, Ollama, LM Studio, and the free DeepSeek web session (`ds_direct`) - plus any custom OpenAI-compatible provider the Kiln settings document adds. Routes are named `<prefix><kiln id>`, default `kiln-`, so they cannot collide with `deepseek-official` or the pi-ai catalog names.

Keys are never configuration here. Each preset names the environment variable holding its key, and the sidecar resolves that variable per request; the catalog reports only whether a key is present.

## The text tool channel

None of these providers has a `tools` field - `ds_direct` is a web chat session and physically cannot have one. The harness's tool schemas therefore reach the model only as text, and a tool call comes back only as text. Two translations happen here and nowhere else:

1. **Messages down.** Structured content blocks flatten to the plain `{role, content}` turns the registry's adapters expect. A prior tool call is re-rendered as the same block the model wrote, and its result as a labelled `OUTPUT:` block, so the transcript the model reads back is written in the one format it was taught.
2. **Calls up.** A tool_calls block in the reply becomes a real harness tool call for whatever tool it names. That is what makes a text-only route - `ds_direct` above all - a usable agent here.

The catalog is generated from the request's own `tools`, so the roster the harness composed is the roster the model is told about, and a tool that is switched off cannot linger in the prompt as an instruction to call something that no longer exists.

## Composition

```yaml
- id: llm-kiln
  name: '@deepseek-ai/dsh-llm-kiln'
  config:
    routePrefix: kiln-
    onlyConfigured: false   # true registers only routes that already have a key
```

## Layout

| File | Role |
|---|---|
| [`src/index.ts`](src/index.ts) | The Cordis plugin: registers every route, reads the settings document, launches the sidecar |
| [`src/adapter.ts`](src/adapter.ts) | `KilnAdapter`: the registry as a harness adapter, and the message flattening |
| [`src/protocol.ts`](src/protocol.ts) | The one tool-call format a Kiln route speaks, stated once |
| [`src/dsml.ts`](src/dsml.ts) | The streaming reader for exactly that format |
| [`src/bridge.ts`](src/bridge.ts) | The sidecar client over newline-delimited JSON |

## Model Experience

### Tool-call protocol in the system prompt

#### What the model sees

The harness's own prompt plus one format statement, and nothing else - no provider in the Python runtime adds text of its own. The statement teaches a single action channel, and the request's own tool schemas are appended after it as catalog entries.

##### Format statement verbatim

```markdown
# Calling tools

You have no native tool-call channel here, so a tool call is written into your reply as a tool_calls block, in exactly this shape:

<tool_calls>
<invoke name="TOOL_NAME">
<parameter name="PARAMETER_NAME">value</parameter>
</invoke>
</tool_calls>

- One parameter element per argument. Its value is the raw text between the tags.
- Arguments go in parameter elements, never as attributes on the invoke tag.
- A tool_calls block is the ONLY thing that executes. Everything else you write is prose.
- After emitting a block, stop and wait. Each result comes back as `OUTPUT:` in the next turn.
```


#### Token effect

The format statement and the generated catalog are appended to the system slot on every request, so they are billed as input tokens on every call. Each tool in the roster adds its name, description, required-parameter list, and schema.

#### KV Cache effect

The system slot is the first thing in the request, so a change there invalidates the whole cached prefix. Within one session the statement is stable, and the catalog changes only when the composed roster does.

### Prior-turn flattening

#### What the model sees

Reasoning blocks are dropped, because every one of these providers either regenerates its own thinking or rejects it on input. A prior tool call is re-rendered as the same block the model wrote, and its result as a labelled `OUTPUT:` block, so the transcript stays self-consistent.

An image does not travel as text. On `deepseek`, the free web session, its bytes are uploaded to the provider's file store and the returned ids ride the turn as `ref_file_ids`; the image block itself renders as a short notice naming which of those happened — delivered, partially uploaded, or refused. On every other route there is no file store to push bytes into, so the image renders as `[an image was attached, which this provider cannot receive]` and the model never sees it. The delivered and refused cases are deliberately distinct: an earlier revision let both fall through to the same notice, which made a delivered image read as a rejected one.

#### Token effect

Flattened tool calls and results stay in the transcript for the rest of the session, so a large result is billed again on every later request.

#### KV Cache effect

Append-only while the route and the flattened prefix stay unchanged.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **No native tool calling** - every Kiln route carries tools as text in the system prompt, so tool-selection quality depends on the model reading the format statement rather than on a provider-side decoder.
- **Image input on one route only** - `ds_direct` is the sole route with a file store, so it is the only one that can carry an attached image; every other route degrades the image to a placeholder line. Images also require a mounted attachment service to read the bytes from — without one, `ds_direct` falls back to the placeholder too.
- **The sidecar is a hard dependency** - the provider registry, including `ds_direct`'s proof-of-work auth and WAF cookie handling, stays Python; the adapter talks to it over one JSON object per line and cannot function without it.
- **Reasoning is never sent back** - a provider that expects its own prior thinking on input cannot receive it through this transport.
- **Keys live in the child's environment** - the catalog reports only `has_key`, so a missing key surfaces as a per-request failure naming the variable rather than as a configuration error.
- **No shared prefix across routes** - the harness composes nothing route-specific beyond the format statement, so two routes on one session do not share a cached prefix.

Fork-owned: `packages/llm/llm-kiln` is Tier 1, so it touches no upstream file.
