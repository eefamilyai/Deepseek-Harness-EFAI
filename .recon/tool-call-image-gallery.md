# Image results in expanded tool calls (2026-11-03)

## Request

"then all the image tools, like read image, the user if expand the tool call they
can see the image."

## What was wrong

`imageCardModel` in `packages/client/ui-tool` accepted one tool:

```ts
if (call?.name !== 'read_image') return null
```

and then required the exact envelope `formatImageReadOutput` writes. A tool whose
result carries image blocks but is not `read_image` — the fork's
`desktop_test_instance` screenshot, a `browser` capture, anything added later —
expanded to text only. The gallery could not simply be handed to the generic row
either: `tool.call.images` was declared by the `read_image` toolview, and a child
slot has exactly one declaring entry, so no other row could render it.

## What changed

- **`image-card-model.ts`**: the card derives from the result content alone — at
  least one well-formed image block, and no block the card would hide. The path
  line is optional and appears only when the call recorded one (`read_image`
  keeps its resolved path, with the nested-call argument fallback).
- **Ownership moved to the Tool call tree**: `apply.ts` declares
  `tool.call.images` on the `conversation.chat.node`/`tool-call entry, and
  `ToolCallTree` builds `renderImages` once per call and puts it in the owner
  payload (`ToolCallCommonProps.renderImages`). `ToolRow` takes the renderer
  instead of the slot dispatcher plus loader; `read-image-row` and
  `GenericToolCard` both pass `imageCardModel(block)` and the renderer, so the
  keyed row and the fallback render the same gallery.

## Verification

- `npx vitest run packages/client/ui-tool`: 466 passed, including a new
  tree-level case where a settled `desktop_test_instance` result shows the
  gallery on expand and the owner receives exactly the result's references.
- `npx vitest run packages/client/ui-attachment packages/client/ui-chat`: 980
  passed (the gallery filler and the chat node owner are unaffected).
- `pnpm run build:check`: both aggregate checks pass; `ui-tool` client bundle
  rebuilt (202 kB).
- Overlay: new `client-tool` patch group, `client-tool.patch` (13 files), seam
  re-recorded at 83 upstream files; `pnpm run verify-fork-overlay` green with 18
  patches.

## How it reached the running app

Same shape as the flow-accent palette: the packaged `ui-tool` row is disabled and
the checkout's build is mounted beside it.

```yaml
- id: ui-tool
  disabled: true
- insert:
    - id: ui-tool-checkout
      name: 'D:/deepseek-kernel-harness/packages/client/ui-tool/lib/index.js'
```

Delete both entries to fall back to the packaged copy; a future installer build
carries the change natively.
