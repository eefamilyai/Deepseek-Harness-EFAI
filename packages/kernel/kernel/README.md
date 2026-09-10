# @deepseek-ai/dsh-kernel

The **persistent-kernel capability seam** (`ctx.kernel`) for the DeepSeek Harness.

A seam, not an engine: it owns *policy* — which Python backend is selected and how one is registered — and delegates *transport* to providers. `kernel-python` is the provider the fork ships; any other backend that satisfies the same interface can replace it without this package changing.

Registered as `ctx.kernel`, one instance per context.

## Selection

Resolved at **execution time**, never at registration, so selection never depends on the order plugins happen to load in:

| Configured `provider` | Registered / usable | Outcome |
|---|---|---|
| set | registered and `available()` | that backend |
| set | not registered | `KERNEL_PROVIDER_CONFIGURED_MISSING` |
| set | registered but unavailable | `KERNEL_PROVIDER_CONFIGURED_UNAVAILABLE` |
| unset | exactly one usable | that backend |
| unset | several usable | `KERNEL_PROVIDER_AMBIGUOUS` |
| unset | none usable | `KERNEL_PROVIDER_UNAVAILABLE` |

Duplicate backend ids are rejected at registration.

## Config

- `provider` — pin which backend wins. Omitted means auto-select when exactly one is usable. An operational override feeds this same field; there is deliberately no hidden priority chain beside it.
- `defaultTimeoutMs` — wall-clock budget for a cell that carries none of its own. Defaults to `DEFAULT_CELL_TIMEOUT_MS` (180s).

## Why it mirrors `@deepseek-ai/dsh-web`

The same selection rules, the same effect-scoped registration, and the same split between a seam that owns policy and providers that own transport. Two seams that behave alike are one thing to learn, not two.

## Layering

- `src/index.ts` — the `KernelRuntime` service and its config schema.
- `src/types.ts` — `KernelProvider`, `KernelExecuteRequest`, `KernelExecuteResult`, `KernelError`, and the error-code union.
- `src/invariant.ts` — the invariant this package contributes.

## Model Experience

Indirectly, through `@deepseek-ai/dsh-tool-kernel`, which turns a cell's captured output into a model-facing tool result.

#### KV Cache effect

No direct invalidation; the model-facing tool owns any request-prefix changes.

## Known Limitations and Deferred Work

These limits define what this package does not provide. They are current package constraints, not a roadmap.

- **A seam, not an engine** - it selects and drives a backend; the namespace semantics, preloaded helpers, and expression echo belong to the provider.
- **Selection is resolved at execution time** - a configured backend that is missing or unusable fails the call rather than falling back, and several usable backends with no `provider` set are ambiguous.
- **One kernel per context** - the seam registers a single instance, so parallel cells share one namespace and one serialized queue.
- **Timeouts are cooperative** - `defaultTimeoutMs` is a budget the seam passes to the provider, not a guarantee the provider enforces.

Fork-owned: `packages/kernel/kernel` is Tier 1, so it touches no upstream file.
