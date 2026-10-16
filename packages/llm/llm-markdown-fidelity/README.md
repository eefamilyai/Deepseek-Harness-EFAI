---
description: "Markdown fidelity for a model's text stream: table lines a lost newline merged go back onto lines of their own, on every provider route."
kind: "package-reference"
---


# @deepseek-ai/dsh-llm-markdown-fidelity

## Summary

Markdown fidelity for a model's text stream: a table line that lost its newline goes back onto a line of its own, on every provider route. Two shapes are repaired as the text streams - a delimiter row glued to its header, and two rows merged into one - so the rendering is right while the answer arrives and the recorded text is right afterwards.


## Why a table breaks, and what the repair does

A GFM table needs its header, its delimiter row, and each of its rows on lines of their own. A model that drops the newline after a row's closing pipe writes two shapes, and both are broken:

| Shape | What the renderer makes of it |
|---|---|
| `\| a \| b \|---\|` on one line | a paragraph of pipes |
| `\| a \| b \| c \| d \|` where two rows were meant | one row of two cells — the rest are **discarded**, so the reader loses rows without being told |

The repair runs on `llm/stream`, the waterfall every provider route passes through, so the answer that reaches the client, the session log, and every later reader is the table that was written. It inserts the newlines markdown asks for and changes nothing else: no words of its own, and a table that arrived correctly is left exactly as it is.

## Use this package

Composed by `packages/bundle/efai-base`, inside the text-toolcall reader:

```yaml
- id: llm-markdown-fidelity
  name: '@deepseek-ai/dsh-llm-markdown-fidelity'
```

## Why the stream and not the page

A repair applied to the rendered page would fix one view of one message: the recorded text would stay malformed, so a replay, an export, a copy, or a second reader would still see pipes. A stream pass repairs the answer itself, and it covers every route — an API provider and a text channel alike — rather than the one adapter a session happened to use.

It sits inside the text-toolcall reader rather than outside it because that reader rebuilds a block from the deltas below it: a repair applied to the block alone would be discarded on exactly the routes it manages.

## What it repairs, and what it leaves alone

What makes the repair safe is the table's own column count. A delimiter row states it, and a cell that holds a pipe has to escape it, so a line whose cells divide by that count was two or more rows. The pass therefore:

- separates a delimiter row merged into its header, with alignment cells (`|:--|--:|`), with a space between the pair, with three columns or more, and inside a list item's indentation;
- splits rows a lost newline merged, including a row merged onto the delimiter row and a row that follows a pair this pass separated in the same line, which splits by the count the separated pair states;
- does it however the stream cut the text, because a line that looks like a table row is buffered until its own newline arrives while prose streams through untouched;
- leaves a table that arrived correctly, a short row (markdown pads those), a row whose cells do not divide by the column count, a table whose delimiter row is not in the text, prose that mentions pipes and dashes, and a fenced block that quotes a glued table exactly as they were.

No runtime invariant companion is published: the repair is a pure transform of each text stream and keeps no state beyond the line it is buffering.

## Model Experience

### The repair on the answer stream

#### What the model sees

Nothing. `repairTableLines` inserts newlines inside text the model already wrote and adds no words of its own, so a model that reads its own previous answer back sees the table it wrote.

#### Token effect

None: no text is added, and no request changes shape.

#### KV Cache effect

None on the request prefix. The repaired text is what a later turn replays as that assistant message, so the prefix is the one a correctly written answer would have produced.

## Known Limitations and Deferred Work

- Two rows merged into one line are repaired; a row merged with *prose* is not, because nothing in the text says where the prose was meant to begin.
- The repair is applied to visible text, not to reasoning: a table in a reasoning block is left as the model wrote it.
- A block whose text the provider assembled other than from its own deltas is passed through untouched: the pass replaces a block only when the block equals the deltas it saw.
- Text a session recorded before this pass was mounted stays malformed, because nothing streams it again and no supported mechanism shadows a recorded `assistant/message`: a surface `replace` must cite every node it shadows, which an assistant message may not carry, so the removal of the history that predates the pass is a fork-local file repair (`local-overlay/tools/repair-recorded-tables.mjs`) rather than a plugin contribution.
