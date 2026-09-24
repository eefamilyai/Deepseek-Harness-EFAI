# @deepseek-ai/dsh-client-ui-settings-tools

The **Tools** settings section: the three switches upstream's presets cannot
express, rendered with the classic sliding-circle `Switch` primitive.

## What it renders

1. **Kernel** — the persistent Python namespace.
2. **RLM engine** — the recursive engine in place of the standalone kernel
   tool; disabled while the kernel is off, because the engine runs on it.
3. **Conventional tools** — the category master switch, which leaves the kernel
   as the only way to act.

All three are live fields of the `tool-roster` row (`kernel`, `rlm`,
`enabled`), read and written through that row's config form
(`ctx.configForms.get('tool-roster')`). The row keeps them off upstream's
generated settings pages, so this section is their one surface.

Choosing individual tools for an agent is upstream's preset editor's job, and
the section says so instead of listing tools: the kernel is a host-plane row
present in every preset, which is why it needs a switch of its own here.

## No restart, and why it says so

Toggles are live: `tool-roster` holds a change until the turn in flight ends
and applies it then. The section says that in place rather than offering a
restart, and it warns that the system prompt changes with the roster, which can
invalidate the prompt cache.

## Copy

Every string is registered through `ctx.locale.register('tools', { zh, en })`;
`zh` is the key-set source of truth and `en` is checked complete against it.

Fork-owned: `packages/client/ui-settings-tools` is Tier 1.
