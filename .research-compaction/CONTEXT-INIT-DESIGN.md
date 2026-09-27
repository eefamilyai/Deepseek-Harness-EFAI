# Context initialization after compaction — IMPLEMENTATION HANDOFF (rev 6)

> **This file is the only input you need.** It is written so a fresh context can
> implement the whole project **without reading a single other file**.
> Every seam, predicate, path, constant, and command below was verified by reading
> the named source in this repo. Section 12 is a recon log: those questions are
> **already answered — do not re-check them.** Section 13 lists hard constraints.
>
> If you are an AI: read §1–§9, then execute §10 in order. You do not need to
> explore. Only §11's "residual uncertainties" need a live look, and each names the
> exact one-line check.

---

## 1. Mission (one paragraph)

Implement **context initialization after compaction** in the DeepSeek Harness fork at
`D:\deepseek-kernel-harness`.

Today, when a session compacts, the transcript is dropped and the next turn resumes
with a summary that competes with a full system prompt and normal injections. The new
design gives the recovered record **its own dedicated initialization turn**:
compaction writes a markdown record to disk (by code, never an LLM); the *next* turn
carries **only** that record plus one instruction to absorb it and reply with nothing
but `OK`; the harness absorbs that `OK`; the real user prompt then proceeds with the
normal system prompt.

---

## 2. The request (verbatim intent, authoritative)

**During compaction — CODE only, never an LLM:**
- Build: `Summary` + (events **since the last turn-starting user request**, OR capped to
  the **latest 100 events**) **AND ALL** user prompts.
- "User prompts" = **instructional prompts that start a turn**, **NOT** steering prompts.
- Extract the session log into markdown named **`compaction-[id]-[session-id].md`**.

**On the next turn after compaction:**
- Send **NO system prompt and no other injections — just the context** — plus **ONE**
  instruction to process it and output nothing but `OK` (the harness absorbs it).
- After that `OK`, the real user prompt plus the normal initialization injections proceed.

This whole flow is called **context initialization after compaction**.

---

## 3. Confirmed decisions — do NOT re-ask the user

| # | Decision | Answer |
|---|---|---|
| 1 | **Selection** | Events after the most recent turn-starting user prompt, capped to the latest 100; then append ALL turn-starting prompts from the whole session. |
| 2 | **File location** | The session's own state directory (use `sessionDir(...)` from `src/log-path.ts`). |
| 3 | **Placement** | **Replace** the injection inside the existing fork-owned `packages/session/session-recovery-context`. Do **NOT** add a new package. |
| 4 | **Non-`OK` reply** | **Absorb whatever came back, log the mismatch, continue.** Do not fail the turn. |
| 5 | **System-prompt suppression** | Via the **`system-prompt/assemble`** waterfall. (An earlier round wrongly proposed `agent/request`; that is impossible — see §6.3.) |

---

## 4. Repo and overlay facts (verified)

| Fact | Value |
|---|---|
| Working directory | `D:\deepseek-kernel-harness` |
| Overlay base commit (`local-overlay/BASE`) | `c291e7961a515f6d7af9304e7fd1d257929aef26` (deepseek-harness 0.1.5-rc.2) |
| Tier-2 files / patches | **138** files in **23** patch(es) |
| `rebuild --check` state at handoff | passes: "local-overlay is current" |
| Overlay tooling | `local-overlay/rebuild.mjs`, `local-overlay/verify.mjs`, `local-overlay/apply.mjs`, `local-overlay/lib.mjs`, `local-overlay/rules.json`, `local-overlay/INVENTORY.md`, `local-overlay/BASE` |
| `rules.json` keys | `_comment`, `patchGroups` (list, ordered, **first-match-wins**), `generated`, `tier1Prefixes` |

**The 23 `patchGroup` names and their root paths (first-match-wins):**
`root-meta`, `tsconfig`, `build`, `apps`, `bundle`(`packages/bundle/`), `presets`,
`boot`, `core`(`packages/core/`), `llm`(`packages/llm/`), `compaction`(`packages/compaction/`),
`extensions`, `skill`, `client-locale`, `client-chat`, `client-input-trigger`,
`client-model-selection`, `client-primitives`, `client-settings`, `client-brand`,
`client-shell`, `session-format-migration`(`packages/session/session-format-v0-to-v1/`),
`docs`(`docs/`), `agent-skills`(`.agents/skills/dsh-code-review/`, `.agents/skills/dsh-pre-push-checks/`).

**`rules.json.generated`** (regenerate, never hand-merge): `pnpm-lock.yaml`,
`tsconfig.base.json`, `docs/config-catalog.md`, `docs/tool-catalog.md`, …

**`rules.json.tier1Prefixes`** (upstream does not own these; carried from fork history):
`.agents/`, `.merge-port/`, `local-overlay/`, `desktop/`, `python/kiln/`,
`packages/kernel/`, `packages/llm/llm-dsml/`, `packages/llm/llm-kiln/`,
`packages/web/web-browser/`, `packages/host/sidebar-bridge/`,
`packages/client/ui-sidebar-terminal/`, `packages/client/ui-effects/`,
`packages/session/command-session-info/`, `packages/agent-memory/`, `packages/rlm/`,
`packages/fs/tool-notebook-edit/`, `start.cmd`, `start.sh`, `install.sh`,
`install.ps1`, `upload_to_git.py`, `HARNESS-EDITS.md`, `AI_BIG_PROJECT_DESIGN.md`.

### 4.1 Ownership of the package you are editing — THE RULE THAT MATTERS

`packages/session/session-recovery-context/` appears in **`INVENTORY.md` under the
heading `## Fork-owned, no patch needed`** (that heading is at INVENTORY line 244).

It is therefore:
- **fork-owned** — a change here needs **no `DSH-FORK` marker** and **no patch regeneration**;
- **not** in `tier1Prefixes` and **not** in any `patchGroup`, which is *expected* —
  `tier1Prefixes` lists carried prefixes, while fork-owned packages are enumerated
  file-by-file in INVENTORY's fork-owned section;
- **not** under `packages/core/`, so it is **not** Tier-2.

> **Consequence:** you can freely edit and add files inside
> `packages/session/session-recovery-context/` **without touching `local-overlay/patches/`.**
> The only overlay obligation is that a **new file** in that package changes the
> fork-owned file list, so run `node local-overlay/rebuild.mjs` at the end so
> `INVENTORY.md` is regenerated. (`rebuild --check` already passes with the new
> `src/compaction-log.ts` present, so this is a hygiene step, not a blocker.)

### 4.2 The 9 fork-owned files INVENTORY currently lists for this package

```
packages/session/session-recovery-context/README.i18n.yaml
packages/session/session-recovery-context/README.md
packages/session/session-recovery-context/README.zh.md
packages/session/session-recovery-context/package.json
packages/session/session-recovery-context/src/index.ts
packages/session/session-recovery-context/src/log-path.ts
packages/session/session-recovery-context/tests/log-path-oracle.spec.ts
packages/session/session-recovery-context/tests/session-recovery-context.spec.ts
packages/session/session-recovery-context/tsconfig.json
```
Plus the **new, still-untracked** `src/compaction-log.ts` (see §7.1) — which is why
INVENTORY needs regenerating after this work.

---

## 5. Current work-in-progress state (what already exists on disk)

`git status --porcelain` at handoff:

```
 M packages/llm/llm-dsml/src/dsml.ts
 M packages/llm/llm-dsml/tests/llm-dsml.spec.ts
 M packages/session/session-recovery-context/src/index.ts
 M packages/session/session-recovery-context/tests/session-recovery-context.spec.ts
?? .research-compaction/
?? packages/session/session-recovery-context/src/compaction-log.ts
```

So **the previous session already started this work**. In particular:

- **`src/compaction-log.ts` exists and is essentially complete** (§7.1) — the
  Phase-A renderer and filename policy. **REUSE it; do not rewrite it.**
- **`src/index.ts` is modified** and already registers the two hooks this design
  needs (`agent/pre-step` and `system-prompt/assemble`) and an extended `Config`
  (§7.2). **Read it, then finish it.**
- The `llm-dsml` modifications are a *separate, unrelated* line of work. **Do not
  revert them and do not let them block you** — but note they are in the worktree,
  so `git diff` at the end will include them.

**Your job is to finish Phase A/B/C, add the tests, and keep the overlay honest.**

---

## 6. Seams — all VERIFIED by reading source

### 6.1 `agent/pre-step` — replace the step's messages ✅

**Contract** — `packages/core/agent/src/runtime-types.ts:330`:
```ts
'agent/pre-step'(this: Scoped<Agent>,
  payload: { agent: Agent; messages: UserMessage[]; turn: number; step: number; signal: AbortSignal },
  next: () => Promise<PreStepDecision>): Promise<PreStepDecision>
```
```ts
// runtime-types.ts:112-119
export type PreStepDecision =
  | { kind: 'reject' }
  | { kind: 'enter'; messages: UserMessage[]; startsRequestSeries?: true }
```

**Consumption** — `packages/core/agent-loop/src/agent.ts:240-258` (`preStep`):
```ts
private async preStep(target: InboxTarget, position: { turn: number; step: number }): Promise<PreparedStep> {
  if (this.phase.kind !== 'running') throw new Error(`agent "${this.id}": pre-step outside running phase`)
  const signal = this.phase.abort.signal
  const claimed = this.inbox.claim(target, position.turn)
  const assembly = await this.loopCtx.systemPrompt.assemble(assembleContextFor(this, signal))
  signal.throwIfAborted()
  const sections = renderContextSections(assembly)
  const context = this.runtimeContext.project(joinContextSections(sections), sections)
  const decision = await this.dispatch.waterfall(
    'agent/pre-step', { messages: claimed, ...position, signal },
    (): Promise<PreStepDecision> => Promise.resolve<PreStepDecision>({
      kind: 'enter',
      messages: context === undefined ? claimed : [...claimed, context],
    }),
  )
  signal.throwIfAborted()
  if (decision.kind === 'reject') return decision
  return { ...decision, assembly }
}
```

**Use:** return `{ kind: 'enter', messages: [ctxMessage] }` **without calling `next()`**,
so the step carries ONLY the context message.

**Limitation (this is exactly why §6.2 is required):** `agent/pre-step` runs *after*
the system prompt is assembled (line 245) and **cannot change it**. The assembly is
returned at line 258 and used by `step()`.

### 6.2 `system-prompt/assemble` — blank the system prompt for one step ✅ CONFIRMED POSSIBLE

**Contract** — `packages/core/system-prompt/src/index.ts:31`:
```ts
'system-prompt/assemble'(this: Scoped<SystemPrompt>, assembly: PromptAssembly,
  context: AssembleContext, next: () => Promise<PromptAssembly>): Promise<PromptAssembly>
```
```ts
// index.ts:42-50
export interface AssembleContext {
  scope?: ScopeKey
  signal?: AbortSignal
}
```

**Implementation** — `index.ts:553-628` (`SystemPrompt.assemble`), abridged:
```ts
async assemble(context: AssembleContext = {}): Promise<PromptAssembly> {
  const scope = context.scope
  const scopeLayers = this.layers.chainLayers(scope)
  const runtimeContextSuppressed = !this.layers.global.runtimeContextSuppressors.isEmpty()
    || scopeLayers.some(layer => !layer.runtimeContextSuppressors.isEmpty())
  const variables: Record<string, string | undefined> = {}
  // ...build variables, sections, contexts, tools...
  const assembly: PromptAssembly = { sections, contexts, tools, variables }
  const transformed = await this.ctx.waterfall(
    scopeTarget(this, scope), 'system-prompt/assemble', assembly, context,
    () => Promise.resolve(assembly),
  )
  if (completeSection === undefined && !runtimeContextSuppressed) return transformed
  return {
    ...transformed,
    sections: completeSection === undefined ? transformed.sections : [completeSection],
    contexts: runtimeContextSuppressed ? [] : transformed.contexts,
  }
}
```

**Why blanking works (the critical verification):**
- `completeSection` is captured from the **pre-waterfall** assembly, and only from a
  section declaring `complete: true` (`index.ts:602`:
  `if (section.complete === true) completeSection = {...assembled}`).
- **`harness:identity` is registered WITHOUT `complete`** — `index.ts:419-426`.
  `HARNESS_IDENTITY: -1000` is declared at `index.ts:122`.
- The **only** `complete: true` registrations in the repo are in tests plus
  `packages/skill/tool-skill/src/index.ts:260`. **None is harness identity or the persona.**
- **Therefore returning an emptied assembly genuinely yields an EMPTY system prompt.**
- Dispatch is through `scopeTarget(this, scope)`, so registering the listener on the
  **agent's scope** makes it per-agent — that is how the listener knows which agent
  has a pending init.

**Second lever (blunter, prefer the waterfall):** `suppressRuntimeContext()` at
`index.ts:501-505` appends to `runtimeContextSuppressors`; read at `index.ts:556-557`.
It empties `contexts` but is permanent until disposed, not per-step.

### 6.3 `agent/request` — NOT usable for this ❌

**Contract** — `runtime-types.ts:347`. **Why it fails:** `LlmCallConfig`
(`packages/llm/llm/src/call-config.ts:23-30`) contains **only** `provider`, `model`,
`reasoningEffort?`, and sampling scalars. Its doc says: "Provider, model, reasoning
effort, and sampling scalars of one conversation's requests." The system prompt is
**not** in it. **Do not try to blank the prompt here.**

### 6.4 How the prompt is actually committed

`packages/core/agent-loop/src/agent.ts:352-369` (`step`): `renderPrompt(assembly)` →
`this.prepareRequest(turn, step, signal)` → `this.systemPrompt.project(renderedPrompt, …)`
→ commits messages to the surface. `packages/core/agent-loop/src/runtime-context.ts`
(159 lines) holds the durable projection state for the two loop-owned surface messages,
and exports a `CLEARED` sentinel:
`'Current runtime context: none. Earlier runtime-context snapshots no longer apply.'`

---

## 7. What already exists to REUSE (read these two files, then extend)

### 7.1 `src/compaction-log.ts` — NEW, untracked, and essentially done ✅

This is Phase A's renderer. **Do not rewrite it.** Its verified exports:

```ts
/** Filename prefix for every compaction log this plugin writes. */
export const COMPACTION_LOG_PREFIX = 'compaction-'

/** Events the record carries when the window since the last prompt is longer. */
export const DEFAULT_COMPACTION_EVENTS = 100

/** One operator prompt as the record renders it. */
export interface CompactionLogPrompt {
  /** Sequence number of the `user/message` event. */
  seq: number
  /** The operator's text. */
  text: string
  // …plus whatever else the file already declares
}

export function selectCompactionEvents(/* … */): /* selected events, oldest first */
export function renderCompactionLog(input: CompactionLogInput): string
```

Its module doc states the design precisely: *"Compaction keeps a summary and drops the
transcript. … this module turns the folded projection back into one document: the
summary, every turn-starting operator prompt, and the event window since the newest of
those prompts. Rendering is pure and total. Selecting the event window is the only
decision it makes."*

`renderCompactionLog` emits, in order: a header with `- Compaction: \`${input.compactionId}\``,
`- Operator prompts: ${input.prompts.length}`, `- Events in window: ${events.length}`,
then `## Summary`, `## Operator prompts` ("Every prompt that started a turn in this
session, oldest first."), and `## Events since the newest prompt` ("The tail of this
session's log, oldest first.").

**Note:** the file header comment says the window may be "capped" and
`DEFAULT_COMPACTION_EVENTS = 100` — consistent with decision #1's "latest 100".

### 7.2 `src/index.ts` — modified, already wired for this feature

Verified shape (line numbers from the current worktree):

- `apply(ctx: Context, config: Config = {}): void` at **line 343**.
- A `compaction/summary` handler at ~**line 367**.
- `ctx.on('agent/pre-step', async (…) => …)` at **line 394**.
- `ctx.on('system-prompt/assemble', async (assembly: PromptAssembly, context, next) => …)`
  at **line 434**.
- `ctx.inject(['systemPrompt'], (scope: Context) => { … })` at **line 444**, registering:
  - `scope.systemPrompt.variable('session_id', ctx => ctx.agent?.session.id)` (449)
  - `scope.systemPrompt.variable('session_log', ctx => logOf(ctx.agent?.session))` (450)
  - `scope.systemPrompt.variable('session_dir', ctx => …)` (451)
  - `scope.systemPrompt.context({ name, order: LOG_CONTEXT_ORDER, text })` (455-462)
- `async function readRecord(path: string): Promise<string>` at **line 467** — reads the
  written record and **tolerates a missing file** by returning
  `` `(the compaction record at ${path} could not be read)` ``.

**`Config` (schema at `index.ts:162-170`; interface ending `index.ts:160`):**
```ts
export const Config: z<Config> = z.object({
  root:            z.string().description('The session root directory.'),
  promptChars:     z.number().description('Per-prompt character budget.'),
  eventChars:      z.number().description('Per-event label budget.'),
  tailEvents:      z.number().description('Trailing events the fold keeps.'),
  compactionEvents:z.number().description('Events the written record carries.'),
  instruction:     z.string().description('The instruction the initialization step carries.'),
  logCompression:  z.union([z.const('zstd'), z.const('none')]).description('The artifact encoding the session writer uses.'),
})
```
`compactionEvents` and `instruction` already exist — **use them; do not add new config
keys unless you must.**

### 7.3 `src/log-path.ts` — the session state directory ✅

Exports (verified):
```ts
export type LogCompression = 'zstd' | 'none'
export function encodeSegment(raw: string): string            // :53
export function projectKey(cwd: string): string                // :82
export function projectDir(root: string, cwd: string | undefined): string  // :107
export function sessionDir(root: string, cwd: string | undefined, id: SessionId): string  // :118
export function sessionLogPath(...): string                    // :131
```
**This is decision #2's "session's own state directory".** Write the record to
`<sessionDir(root, cwd, sessionId)>/compaction-[compactionId]-[sessionId].md`
using `COMPACTION_LOG_PREFIX` from `compaction-log.ts`.

### 7.4 Other machinery the old package already has (REUSE)

- A **Session projection** folding "the prompts, the event tail, and the latest
  compaction as they commit" — exactly Phase A's selection input. **Find it in
  `src/index.ts` around lines 188-345 (the projection region) and reuse it.**
- **Idempotency through the log itself** — "this compaction has been answered" is a
  **logged event**, not in-memory state. **This survives session resume; keep the pattern.**
- `clip(text, budget)` — marks a clip rather than hiding it.

### 7.5 The composition row registering the plugin (Tier-2, `packages/bundle/`)

The plugin is registered by a YAML row under `packages/bundle/` (that path is the
`bundle` patchGroup). The documented row shape is:
```yaml
- id: session-recovery-context
  name: '@deepseek-ai/dsh-session-recovery-context'
  config:
    tailEvents: 50
```
If you change this row you are in **Tier-2** and must follow §4.1's Tier-2 rules
(marker + `bundle.patch` regeneration). **Prefer not to change it.**

---

## 8. THE TURN-vs-STEERING PREDICATE — resolved (old §7, now closed) ✅

Earlier revisions left this open. It is **answered**, verified in
`packages/core/agent/src/runtime-types.ts:47-69`:

```ts
/** Agent-owned access to pending work; concrete storage belongs to the driver. */
export interface Inbox {
  /** Prompts awaiting individual turns. */
  readonly nextTurn: readonly UserMessage[]
  /** Input awaiting the next step boundary. */
  readonly nextStep: readonly UserMessage[]
  …
  append(target: InboxTarget, message: UserMessage): void
  prepend(target: InboxTarget, message: UserMessage): void
  …
}
```

**The predicate is the inbox target itself.** A prompt that **starts a turn** is
appended with target `'next-turn'`; **steering** input is appended with target
`'next-step'`. The caller's choice of target **is** the taxonomy:

```ts
inbox.append('next-turn', queued)     // a turn-starting prompt  → INCLUDE
inbox.append('next-step', steering)   // steering input         → EXCLUDE
```

Corroborated by the repo's own tests, e.g.
`packages/api/session-controller/tests/control-queue.host.spec.ts:57` appends
`'next-turn'` for a queued turn, and `:58` appends `'next-step'` for `steering`;
`packages/goal/goal-round-driver/tests/goal-round-driver.spec.ts:511` appends
`'next-turn'` for `queuedTurnContext`.

**Action:** in the existing projection (≈`src/index.ts:188-345`), select prompts from
the **`next-turn` / turn-starting** stream, not the `next-step` stream. Also note the
`UserMessage.source` discriminated `kind` is available (`'plugin'` appears at
`runtime-context.ts:18` and `:155-156`) if you need to exclude harness-injected
messages from "operator prompts".

---

## 9. Compaction event names (verified)

`packages/compaction/compaction-basic/src/region.ts` appends:
- `session.append('compaction/start', { … })`
- `session.append('compaction/summary', { … })` — **line 476**
- `session.append('compaction/end', { … })` — **line 244** (carries `error` on failure)

**Trigger Phase A on `compaction/end`** (so a failed compaction does not leave a
pending init marker). `src/index.ts` currently handles `compaction/summary` (~line 367);
keep that, and add/adjust for `compaction/end` as needed.

---

## 10. THE PLAN — implement in this order

### Phase A — at compaction time, CODE ONLY (no LLM)

1. **Trigger** on `compaction/end`.
2. **Select** from the existing session projection:
   - events after the most recent **turn-starting** prompt, capped to the latest
     **100** (`DEFAULT_COMPACTION_EVENTS`); **plus**
   - **every** turn-starting prompt in the whole session (§8 predicate).
3. **Render** with `renderCompactionLog(...)` from `compaction-log.ts`.
4. **Write** to
   `<sessionDir(root, cwd, sessionId)>/compaction-[compactionId]-[sessionId].md`.
5. **Set a durable "pending context init" marker** for that compaction id —
   **log-based**, following the package's existing idempotency pattern (§7.4).
   It must survive resume.

### Phase B — the initialization turn

1. **`agent/pre-step`** (already registered at `src/index.ts:394`, on the agent):
   when a pending init exists for this session, return
   ```ts
   { kind: 'enter', messages: [contextMessage] }
   ```
   **without calling `next()`**. `contextMessage` = the rendered record **+** the single
   instruction (use `config.instruction`) to process it and reply with nothing but `OK`.
2. **`system-prompt/assemble`** (already registered at `src/index.ts:434`, on the agent
   scope): for **that same step**, return an empty assembly —
   `{ ...assembly, sections: [], contexts: [] }` — so the step carries the context and
   nothing else.
   - The two hooks must agree on **which step** is the init step. Carry the decision on
     the agent scope (or a per-step flag you set in `pre-step`), because `assemble`
     receives only `AssembleContext { scope?, signal? }` (§6.2) — **not** `turn`/`step`.
   - Beware ordering: `assemble` runs *before* `agent/pre-step` in the same step
     (`agent.ts:245` then `:250`). So decide "is this the init step?" from state that is
     already true when `assemble` runs, or make `pre-step` set a flag that `assemble`
     consumes on the **following** step — whichever the existing `index.ts` already
     half-implements. **Read `src/index.ts:394-462` first; the previous session's shape
     is the intended one.**

### Phase C — resume

1. **Absorb** the reply. If it is not a bare `OK`, **log the mismatch and continue**
   (decision #4). Do **not** fail the turn.
2. **Clear** the pending marker (log-based).
3. The real user prompt then proceeds with the normal system prompt and injections.

---

## 11. Tests to add (in `tests/session-recovery-context.spec.ts`, extend it)

Required coverage (the old handoff named these; they remain right):
1. **Selection + cap** — events after the last turn-starting prompt, capped at 100;
   all turn-starting prompts included; **steering (`next-step`) prompts excluded**.
2. **File naming** — exactly `compaction-[id]-[session-id].md` in the session dir.
3. **The init turn carries only the context** — no system prompt, no other injections.
4. **`OK` absorption**, including **the non-`OK` path** (logged, turn not failed).
5. **The resume turn** — the real prompt gets the normal system prompt back.

Add a **`log-path-oracle.spec.ts`-style oracle** only if you change path logic; the
existing oracle test must keep passing.

---

## 12. Verification — run exactly this, in order

```sh
# 1. The affected package's tests
pnpm vitest run packages/session/session-recovery-context

# 2. Types for the touched packages
pnpm -C packages/session/session-recovery-context run typecheck   # or the repo's equivalent

# 3. Overlay: regenerate INVENTORY (new fork-owned file), then prove the layer
node local-overlay/rebuild.mjs
node local-overlay/verify.mjs
node local-overlay/apply.mjs --check
```

**Interpreting results:**
- `verify.mjs` proves *base + the 23 patches reproduces the 138 Tier-2 files*. Because
  your edits are **fork-owned (§4.1)**, `verify.mjs` should be **unaffected** — if it
  fails, you accidentally edited a Tier-2 file; fix that instead of forcing the check.
- `apply.mjs --check` proves the committed patches still apply to a pristine base.
- `rebuild.mjs` regenerates `INVENTORY.md`; expect it to now list
  `src/compaction-log.ts` under *Fork-owned, no patch needed*.
- Before concluding, confirm no accidental Tier-2 edit:
  ```sh
  git diff --stat -- packages/core packages/compaction packages/bundle packages/llm
  ```
  (`packages/llm` will show the **pre-existing, unrelated** `llm-dsml` edits — that is
  expected; see §5.)

---

## 13. Deliverables expected at completion

1. Phase A/B/C implemented (§10).
2. Tests (§11) green.
3. Typecheck + package tests green.
4. Overlay correct: **no new Tier-2 edits** (or, if any, marked
   `// DSH-FORK(context-init): … EXIT: …` and folded into the right patch); INVENTORY
   regenerated.
5. Docs: update `packages/session/session-recovery-context/README.md` (and the
   `.zh.md` / `README.i18n.yaml` counterparts if the README changes), plus an Agent
   Note under `.agents/notes/implemented/**`.
6. **Update this file** with a short "what actually happened" section if the
   implementation diverges from §10 — the next reader trusts this file.

---

## 14. Recon log — ALREADY CHECKED, do NOT re-check

| Question | Answer | Where verified |
|---|---|---|
| Can `agent/pre-step` blank the system prompt? | **No.** It only adds/replaces messages; assembly happens before it and is returned alongside. | `agent-loop/src/agent.ts:240-258` |
| Which seam can blank it? | **`system-prompt/assemble`.** Returns the waterfall value verbatim when no `complete` section exists. | `core/system-prompt/src/index.ts:553-628` |
| Is `harness:identity` a protected "complete" section? | **No.** Registered as a plain section, no `complete`. | `core/system-prompt/src/index.ts:419-426` |
| Any `complete: true` anywhere that matters? | **No.** Only tests + `packages/skill/tool-skill/src/index.ts:260`. | repo-wide search |
| Does `LlmCallConfig` carry the system prompt? | **No.** provider/model/effort/sampling only. | `llm/llm/src/call-config.ts:23-30` |
| **Turn-starting vs steering prompt?** | **`Inbox.nextTurn` vs `Inbox.nextStep`; `inbox.append('next-turn'\|'next-step', …)` is the taxonomy.** | `core/agent/src/runtime-types.ts:47-69` + tests |
| Is `session-recovery-context` Tier-1 or Tier-2? | **Fork-owned** — INVENTORY's `## Fork-owned, no patch needed`; in **no** patchGroup and **not** in `tier1Prefixes`. **No marker, no patch.** | `INVENTORY.md` (heading at line 244), `rules.json` |
| What is `local-overlay/BASE`? | `c291e7961a515f6d7af9304e7fd1d257929aef26` (0.1.5-rc.2) | `local-overlay/BASE` |
| Where is the session state dir helper? | `sessionDir()` / `sessionLogPath()` in `session-recovery-context/src/log-path.ts` | that file |
| Compaction event names? | `compaction/start`, `compaction/summary`, `compaction/end` | `compaction-basic/src/region.ts:244,476` |
| Filename policy + renderer? | `COMPACTION_LOG_PREFIX='compaction-'`, `DEFAULT_COMPACTION_EVENTS=100`, `selectCompactionEvents`, `renderCompactionLog` | `src/compaction-log.ts` |
| Current `Config` keys? | `root, promptChars, eventChars, tailEvents, compactionEvents, instruction, logCompression` | `src/index.ts:150-170` |
| Existing hooks in the package? | `agent/pre-step` (394), `system-prompt/assemble` (434), `systemPrompt` injection (444) | `src/index.ts` |
| Does overlay tooling exist? | Yes — `rebuild.mjs`, `verify.mjs`, `apply.mjs`, `lib.mjs`, `rules.json`, `BASE`. | `local-overlay/` |

---

## 15. Constraints and hard rules

1. **Do NOT recurse through `D:\deepseek-kernel-harness`.** It is a large tree. Recursive
   `dir /s`, recursive `rg`, and `os.walk` were explicitly forbidden after being used.
   Use targeted `grep` / `glob` / `read` on exact paths. When searching, pass a subtree
   (e.g. `packages/session`) and an `include=` filter rather than the repo root.
2. **Kernel cells:** every argument must be
   `<parameter name="…">value
