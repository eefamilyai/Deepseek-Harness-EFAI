# @deepseek-ai/dsh-client-ui-settings-tools

## Summary

The **Tools** settings section: the kernel and conventional-tool switches, one switch per tool, and the browser and kernel rows they belong beside — rendered with the classic sliding-circle `Switch` primitive.

## What it renders

1. **Availability** — three things over the `tool-roster` row: the **kernel** switch, the **conventional tools** master switch, and **one switch per tool**.
2. **Python** — the kernel window (`kernel-python`).
3. **Browser** — timeouts and output caps (`web-browser`).

All three are live fields of composed host rows, read and written through each row's own config form (`ctx.configForms.get(...)`). The rows keep themselves off upstream's generated settings pages, so this section is their one surface.

## One switch per tool

The per-tool list is the `tools` map of the `tool-roster` row: its keys are the tools, its values the switches. `tool-roster` writes an entry (enabled) the first time it mounts a switchable tool, so the map is the deployment's actual roster rather than only the names someone already withdrew — a page that listed just the withdrawn names could never offer a switch for a tool nobody had touched. Two tools get no entry on purpose: `run_code`, whose visibility no switch controls, and `kernel`, which the category switch above already governs. A flip writes one nested field (`tools.<name>`), which is why the section carries a path write and not only the form's field write.

A filter narrows the list; it is view state and never reaches the Host.

## No restart, and why it says so

Toggles are live: `tool-roster` holds a change until the turn in flight ends and applies it then. The section says that in place rather than offering a restart, and it warns that the system prompt changes with the roster, which can invalidate the prompt cache.

## Copy

Every string is registered through `ctx.locale.register('tools', { zh, en })`; `zh` is the key-set source of truth and `en` is checked complete against it. Tool names are not copy: they are wire tokens, rendered verbatim.

Fork-owned: `packages/client/ui-settings-tools` is Tier 1.

## Known Limitations and Deferred Work

- The per-tool list is what the roster has learned, so a tool a plugin mounts after the last turn appears on the next one rather than immediately, and a deployment that refuses settings writes shows only the names someone already withdrew.
