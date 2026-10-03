---
description: "Markdown fidelity for a model's text stream: a table's delimiter row goes back on its own line, on every provider route."
kind: "package-reference"
---

# @deepseek-ai/dsh-llm-markdown-fidelity

## Summary

A GFM table needs its header and its delimiter row on separate lines:

| Shape | What the renderer makes of it |
|---|---|
| `\| a \| b \|` then `\| --- \| --- \|` | a table |
| `\| a \| b \|---\|` on one line | a paragraph of pipes |

A model occasionally writes the second form, and nothing downstream can recover the first:
the renderer has only text, the session keeps the malformed text for replays and exports, and
the reader of a transcript sees punctuation. This row repairs it on `llm/stream` — the
waterfall every provider route passes through — so the answer that reaches the client, the
session log, and every later reader is the table that was written. It inserts the newline
markdown asks for and changes nothing else.

## Use this package

Composed by `packages/bundle/efai-base`, inside the text-toolcall reader:

```yaml
- id: llm-markdown-fidelity
  name: '@deepseek-ai/dsh-llm-markdown-fidelity'
```

## Why the stream and not the page

A repair applied to the rendered page would fix one view of one message: the recorded text
would stay malformed, so a replay, an export, a copy, or a second reader would still see
pipes. A stream pass repairs the answer itself, and it covers every route — an API provider
and a text channel alike — rather than the one adapter a session happened to use.

It sits inside the text-toolcall reader rather than outside it because that reader rebuilds a
block from the deltas below it: a repair applied to the block alone would be discarded on
exactly the routes it manages.

## What it repairs, and what it leaves alone

A candidate is a delimiter run that follows cells carrying text and describes the same number
of columns as that header. The pass then:

- repairs `| a | b |---|---|`, with alignment cells (`|:--|--:|`), with a space between the
  pair, with three columns or more, and inside a list item's indentation;
- repairs it however the stream split it, including one character at a time, because it
  withholds only the tail that could still turn out to be a delimiter row;
- leaves a table that arrived correctly, prose that mentions pipes and dashes, a fenced block
  that quotes a glued table, a run whose columns disagree, and a header with nothing under it
  exactly as they were.

## Model Experience

### What the model sees

Nothing. The pass inserts a newline inside text the model already wrote, and adds no words of
its own. A model that reads its own previous answer back sees the table it wrote.

### Token effect

None: no text is added, and no request changes shape.

### KV Cache effect

None on the request prefix. The repaired text is what a later turn replays as that assistant
message, so the prefix is the one a correctly written answer would have produced.

## Known Limitations and Deferred Work

- Only a glued delimiter row is repaired. A table whose *body rows* were glued into one line
  cannot be put back together, because the boundary between one row and the next is not in the
  text any more.
- The repair is applied to visible text, not to reasoning: a table in a reasoning block is
  left as the model wrote it.
- A block whose text the provider assembled other than from its own deltas is passed through
  untouched: the pass replaces a block only when the block equals the deltas it saw.
