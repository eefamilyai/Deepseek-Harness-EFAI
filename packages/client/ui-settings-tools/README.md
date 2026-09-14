# @deepseek-ai/dsh-client-ui-settings-tools

The **Tools** settings section: two independent category switches plus one
switch per registered tool, all rendered with the classic sliding-circle
`Switch` primitive.

## What it renders

1. **Kernel** — `kernel.enabled`, the persistent Python namespace.
2. **Conventional tools** — `tools.enabled`, the category master switch.
3. **Per-tool switches**, one per name in the `tools` namespace's composition
   layer, shown only while the category is on.

The tool list is read from the settings descriptor's `base.tools`, which
`@deepseek-ai/dsh-tool-roster` seeds from the tool registry. Nothing here
hardcodes a roster, so a tool added by another package appears on its own.

## No restart, and why it says so

Toggles are `live`: `tool-roster` holds a change until the turn in flight ends
and applies it then. The section says that in place rather than offering a
restart, and it warns that the system prompt changes with the roster, which can
invalidate the prompt cache.

## Copy

Every string is registered through `ctx.locale.register('tools', { zh, en })`;
`zh` is the key-set source of truth and `en` is checked complete against it.

Fork-owned: `packages/client/ui-settings-tools` is Tier 1.
