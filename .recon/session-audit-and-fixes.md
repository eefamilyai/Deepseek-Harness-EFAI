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

## 2. Model dropdown — the account pool still is not folded

`packages/client/ui-polish` folds a pool whose accounts arrive as *sibling sections*
(`DeepSeek (free web)` beside `DeepSeek (free web) (…+hunt@…)`). Live today, in the
`Qwen-3.8-27B` workspace, the same provider renders **one** section holding eleven account
rows (`Auto`, `hunt`, `v`, `f`, `j1`, `t1`, `t2`, `d1`, `claude1`, `claude2`, `merge`)
followed by the four model rows — so nothing folds, and the operator's original ask (one row
of account bubbles, then only the models) is still unmet in this shape. This is also the
question they asked mid-session: "what if there isnt a + tag? and its a base account?"

**The work**: fold account *rows* as well as account *sections*, keyed on something the row
carries rather than on the `+tag@` title shape, and prove it live in that workspace.

## 3. Fork-owned CSS that fails the upstream style gates

`pnpm run test:gui` is red on 10 specs. Four are in packages the fork owns or patches, and
are therefore ours to fix:

- `ui-theme/tests/radius-styles.client.spec.ts` flags radii off the shared scale in
  `ui-effects` (`.gate: 20px`, `.codeInput: 10px`, `.unlockButton: 10px`),
  `ui-settings-accounts` (nine rules) and `ui-settings-tools` (two) — all fork-owned
  packages per `local-overlay/INVENTORY.md`.
- `ui-theme/tests/elevation-styles.client.spec.ts` flagged `ui-polish`'s account picker
  border at 1px; fixed this session (now 0.5px, spec green).

**The work**: put the fork's own radii back on the shared scale, or record the exception the
way upstream's spec expects, and confirm both gates green.

## 4. Failures that are not the fork's

The other six red specs are in packages the fork does not own and does not patch
(`local-overlay/INVENTORY.md` has no line for them): `client/connection` binary RPC ×2,
`ui-deliverables` native open, `ui-primitives` json-tree copy actions, `ui-schedule` ×2,
`ui-sidebar-documentpreview` license bundle. Upstream-owned, pre-existing, and to be
reported rather than silently "fixed".

## 5. Recorded-table repair — finish the job

`local-overlay/tools/repair-recorded-tables.mjs` repairs tables in sessions recorded before
the stream pass existed. Working and verified, but:

- it is documented only in `.recon`; the repository has no README or command reference for
  it, so the next person to need it has to read a recon file;
- it ran as a detached watcher with a `--held` session; the run that landed is recorded in
  `.recon/_repair-run.log` and should be reported in the recon note with its result;
- backups (`*.bak-<stamp>`) accumulate beside repaired logs with no pruning rule.

**The work**: a short README beside the tool, a note on pruning backups, and the run result
recorded.

## 6. Loose ends from earlier in the session

- **"add a preset editor in the tools section"** (operator, seq 6344): the pane's duplicate
  row was removed and the gap documented, but the editor itself was not added. Either build
  it or put the decision in writing.
- **`.recon` scratch**: dozens of untracked `_*` files (dump helpers, commit messages,
  soaks). Keep the two the recon notes name as the playbook; delete the rest.
- **Kernel docs**: `packages/kernel/kernel-python/README.md` and the Kiln README describe the
  seam ops; both need the new table.
