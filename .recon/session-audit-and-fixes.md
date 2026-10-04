# Session audit and fix list (2026-10-04)

Everything this session touched, what is wrong or unfinished about it, and what the fix is.
Operator request: "fix and add everything that is wrong with the tools and kernel and
everything … for the kernel, I wish to add a much much more functions to properly interact
with the harness."

Evidence for each line is in the section it names; nothing here is a guess.

## 1. Kernel — the headline work

The kernel is the fork's own tool (`python/kiln/runtime` + `packages/kernel/*`, all
fork-owned: absent at the upstream base `639ed01539`). Its deep bridge to the harness is
`packages/kernel/kernel-python/src/seam.ts`: `dispatchSeam` maps one `op` string per call
onto an agent-scoped `ctx`, and `python/kiln/runtime/kernel_child.py` exposes one documented
module-level helper per op (`tool_help()` reflects over the module's globals, so a helper is
just a function with a docstring).

**Defects found**

- **Seven seam ops have no Python helper**: `fs.editText`, `goals.edit`, `goals.pause`,
  `goals.resume`, `goals.complete`, `goals.block`, `goals.clear`. The dispatch side is
  written and tested; nothing in a cell can reach them. (Compare the 22 ops Python calls
  with the 29 the seam implements.)
- **No discovery for the seam itself**: a cell cannot ask what ops exist, and cannot call an
  op the helper layer does not wrap. A new seam ability is invisible until someone writes a
  wrapper, which is why the seven above sat unreachable.
- **The reachable surface is a fraction of the harness**: 29 ops cover fs, shell, web,
  subagents, goals, tools, sessions (list/get only), skills, and subprocess. Nothing exposes
  agents, the session's own events/messages/history, settings, the plugin inventory, models
  and providers, workspaces, background jobs, scheduled tasks, projections, token/context
  state, MCP servers, agent presets, or the title/feedback seams.

**The work**: a broad, tested expansion of the seam and its helpers — introspection first
(agents, sessions, settings, plugins, models, workspaces, jobs, schedules, context,
projections, skills, presets, MCP), plus a raw `seam(op, **args)` escape hatch and
`seam_ops()` so the whole table is discoverable from a cell. Every op returns `unavailable`
when its service is not mounted, and every helper falls back the way the existing ones do.

## 2. Model dropdown — the account pool is folded, and my first read of it was wrong

**Corrected after checking.** I first recorded this as "the pool is still not folded", because
the browser tool's accessibility snapshot lists the eleven account rows while the picker has
them hidden. That snapshot is a DOM projection, not a picture: it reports rows that are
`display: none`. A screenshot of the same open menu shows what a person sees — the pool's
eleven logins as one wrapping row of equal capsules (`Auto`, `hunt`, `v`, `f`, `j1`, `t1`,
`t2`, `d1`, `claude1`, `claude2`, `merge`) directly under the `DeepSeek (free web)` title,
with the four model rows below them and every other provider contracted.

The two shapes the operator asked about mid-session are handled and pinned by spec:
`loginName` keeps a tag (`…+hunt@gmail.com` → `hunt`), falls back to the whole address when
there is no tag (keeping the tail a narrow cell cannot hold), treats a leading `+` as a
dialling code rather than a tag, and labels a pool's unpinned base route `Auto`
(`account-picker.client.spec.ts`, 11 cases). `isLogin` refuses a nested title, so the free
web route is not mistaken for a login of the plain `DeepSeek` provider.

Lesson for the rest of this audit: judge anything visible from a screenshot, never from the
accessibility snapshot.

## 3. Fork-owned CSS that fails the upstream style gates — fixed

`pnpm run test:gui` was red on 10 specs. The four in packages the fork owns or patches are
fixed:

- `ui-theme/tests/radius-styles.client.spec.ts` flagged radii off the shared scale in
  `ui-effects` (`.gate: 20px`, `.codeInput: 10px`, `.unlockButton: 10px`),
  `ui-settings-accounts` (nine rules) and `ui-settings-tools` (two) — all fork-owned
  packages per `local-overlay/INVENTORY.md`. Each value now names the nearest
  `--dsw-radius-*` step, with a `calc` of at most 4px where the scale has no exact step, so
  the geometry is unchanged. Commit `db68fb2f04`.
- `ui-theme/tests/elevation-styles.client.spec.ts` flagged `ui-polish`'s account picker
  border at 1px; fixed earlier this session (now 0.5px).

`pnpm run test:gui` after both: **5 failures in 9607 tests, every one in a package the fork
does not own or patch** — `client/connection` binary RPC ×2, `ui-deliverables` native open,
`ui-sidebar-documentpreview` license bundle, `ui-sidebar-right` expand binding. Upstream's to
fix; editing them would mean new seam patches for no fork benefit.

## 4. The Tools pane: the preset group is gone, every tool has its own switch

The operator's clarification (2026-10-04): *"remove the preset section. I want more control
over what tools are under each section. Like conventional tools. Now it's just conventional
tools, i want to be able to flip flop individual ones. EACH AND EVERY ONE TOOL."*

That is what the package description claimed all along — `ui-settings-tools` was registered as
"independent kernel and conventional-tool switches **plus one switch per registered tool**" —
and only the two category switches ever shipped. Both halves are now in place:

- **The roster learns itself.** `tool-roster` writes an entry (enabled) into its own `tools`
  map the first time it mounts a switchable tool, at mount and at each turn boundary. Without
  that, the map — which is what a settings page can render — would hold only the names someone
  already withdrew, and the page could never offer a switch for a tool nobody had touched. The
  writes are additive by construction (one `set` per unseen name, never an update), so a write
  cannot race the operator's own flip. `run_code` (no switch controls it) and `kernel` (its own
  category switch governs it) get no entry, so the list cannot offer a switch that does nothing.
- **The section lists them.** The availability group renders one switch per entry of that map,
  by tool name, with a filter; a flip writes the nested path `tools.<name>` through the row's
  config form. The preset group, its `listPresets` injection, its locale keys, and its state
  are gone.

The Remote alternative (a `toolRoster` namespace over the Remote/typert generator, the
`ai-accounts` pattern) was rejected for cost, not for principle: it needs a client half, new
package exports, generator output, and a second bundle row for one read-only list, while the
map is already the exact shape the page renders and the write path already exists.


## 5. Recorded-table repair — finished, waiting on one restart

`local-overlay/tools/repair-recorded-tables.mjs` repairs tables in sessions recorded before
the stream pass existed. Now documented and hardened:

- `local-overlay/tools/README.md` — why the tool exists (no append can shadow a recorded
  `assistant/message`), what it verifies, when it must not run, every flag;
- `--prune-backups [days]` removes the backup copies once the repaired sessions have been
  looked at;
- the host-free wait polls every second rather than backing off to five, because an ordinary
  restart's gap is exactly what it is waiting for;
- a failure is printed instead of ending the process silently — a watcher that dies quietly
  looks like a watcher that is still waiting;
- `.recon/.gitignore` keeps this job's scratch out of `git status` (85 files, 231MB, cleared).

**State**: seven session logs across the corpus are repaired and verified (a dry run finds
nothing left in them). One session remains — this one — because the running host holds its log
open, and the window with no host has not happened since the watcher was armed. A watcher
(pid 31200) is polling for that window. It lands on an ordinary restart, which the next
section also needs.

## 6. Loose ends from earlier in the session — all closed

- **"add a preset editor in the tools section"** (operator, seq 6344): see section 4 — the
  editor cannot live in a section; the decision on a host write path is the operator's.
- **`.recon` scratch**: cleared, with a `.gitignore` for the `_*` pattern this job produces.
  The two files the recon notes name as the playbook (`_dump.mjs`, `_fidelity-probe.yml`)
  stay.
- **Kernel docs**: `packages/kernel/kernel-python/README.md` documents the observation family
  and its two rules; the kernel prompt gains a `tool:kernel-harness` section naming the
  helpers, so the model reaches for `session_window(seq)` instead of guessing at a payload.
