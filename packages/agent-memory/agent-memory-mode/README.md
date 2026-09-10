# @deepseek-ai/dsh-agent-memory-mode

The on/off switch for the first-party durable memory engine
([`@deepseek-ai/dsh-agent-memory`](../agent-memory)).

This package owns exactly one thing: the `agent-memory.enabled` setting. It
mounts the engine when the setting is true and nothing when it is false; the
gating itself is composition, in
`packages/bundle/base/cordis.patch.yml`.

It mirrors `@deepseek-ai/dsh-kernel-mode` and `@deepseek-ai/dsh-rlm-mode`
deliberately:

- the switch plugin is **not** gated by its own setting, because a switch that
  vanished when switched off could never be switched back on, and
- the setting declares `applies: 'restart'`, because the `disabled` expression
  that reads it is evaluated once at boot.

Mounting is a Loader fact, and Loader facts are decided at boot. Hiding a tool
at runtime is not the same as not mounting it: a mounted plugin has already
contributed its system-prompt section, so a merely-hidden engine would leave the
model reading instructions for tools it cannot call. Not mounting takes both.

```yaml
- id: agent-memory-mode
  name: '@deepseek-ai/dsh-agent-memory-mode'
  config:
    enabled: true
```

It is a fork-owned package (`packages/agent-memory/agent-memory-mode`), so it
touches no upstream file. See `HARNESS-EDITS.md` for the fork's tier rules; this
package is Tier 1.
