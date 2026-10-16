# Task brief: Skills tab, peak-hour send gate, plugin/provider sync, provider toggles

Written 2026-10-09 19:xx SGT, session `session-13ec2904-7c85-4a85-bcb9-3ba937f49160` (cwd
`C:\Users\eejar\Documents\deepseek-harness\default-workspace`). This file is the **single source of truth for
this batch of work**. Read it first after any compaction, resume, or new session.

The session that started this work (`session-acd47678-ff54-4ef8-89bf-0f10d466aa33`, 2026-10-08/09) **no longer
exists on disk** — `session-read.mjs` reports "no such session". What survives is its recon:
`.recon/shared-profiles-provider-visibility-transparency-peak-send-skills-tab.md` (tasks 1, 1b, 2, 3) and
`.recon/deepseek-peak-hour-warning-and-table-parser-fixes.md` (the peak-hour pill, table repair, plugin tidy).

---

## 1. Operator request (2026-10-09, this session — restated faithfully)

1. **Skills tab.** Add a *Skills* tab to the left sidebar next to *Plugins*, *Profiles*, *Automation tasks*. Lets
   the user write their own skills. Optionally a built-in AI agent / chat specialised in authoring skills, inside
   that tab.
2. **Peak-hour send gate.** During DeepSeek peak hours (2× price), pressing Enter/Send must be **stopped before
   sending** with a warning dialog that has three options:
   1. **Send anyway** — continue sending now.
   2. **Schedule** — send automatically when the peak hour ends.
   3. **Keep editing** — don't send; the message stays in the prompt box.

   **Smart queueing:** if a message is *already* scheduled for after the peak and the user schedules a second one,
   offer: **(a) send together with the first** (same time), or **(b) send after the first one's run has fully
   settled** (message queueing). The original request also suggested using the official **Automation tasks**
   (schedule) plugin for the deferred send.
3. **Plugins standardised across profiles.** Enabling/disabling a plugin in one profile applies to all profiles.
4. **Providers standardised across profiles.** Deleting or changing a provider in one profile applies to all.
   Plus a **per-provider on/off switch** (beside each provider) that hides/shows it in the model picker, to declutter.
5. **Deferred — NOT in this run:** after everything is complete, the operator will separately ask for my opinions on
   this harness's tools for improvement. Do not volunteer it until asked.

Earlier-session wording of the same asks (from the surviving recon): "an actual warning pop up box after I press
send during a deepseek peak hour to ask if I want to proceed, or schedule a send when the peak hour ends, or just not
send and keep the message in the prompt box … if theres a message scheduled before the next, ofc add options to
either schedule the second message after the full run of the first message is settled or both at the same time."

### Standing operator constraints (learned from history — violating these has angered the operator before)

- **The target is the Desktop app** (`D:\Deepseek-Desktop`), not the web build. Verify in a real Desktop window
  (`desktop_test_instance`), with **screenshots**. Do not start a web server to "check" things.
- Test it yourself and find your own bugs; do not hand the operator bugs to find.
- Fork changes ship as fork-owned packages + bundle rows (see `dsh-harness-edit` skill); upstream files are frozen.
  Upstream client packages (e.g. `ui-conversation`, `ui-primitives`) are compiled into the Desktop web shell inside
  `app.asar` — see `.recon/desktop-asar-shadows-fork-packages.md`. Fork client plugins load fine via slots
  (the peak pill proves this).
- Don't stop early; work through to verified completion.

---

## 2. Status audit (verified 2026-10-09 in this session, not taken on trust)

| # | Task | Status | Evidence |
|---|------|--------|----------|
| 3 | Plugin enablement shared across profiles | **DONE, live** | `packages/boot/profile-sync` (untracked, fork). Row `profile-sync` phase `active` in the running deployment. Store `~/.dsh/profile-sync/state.json` has keys `providers, disabled, bundles, refs, baselines`; backup `backup-2026-10-09T10-14-39-292Z`. |
| 4a | Providers shared across profiles | **DONE, live** | Same package. `llm-pi-ai.config.providers` now identical in desktop/general/harness/school/web: anthropic, deepseekfree, google, nvidia, qwen3-8, tokenharbor (they had drifted before). Credential `refs` shared; logins (`records`) deliberately not. Excludes `headless`, `desktop-test-instance`. |
| 4b | Per-provider visibility switch | **DONE, live** | `packages/client/ui-model-visibility` (row `model-visibility`, active). Toggles in Settings → Models (footer slot `settings.models.footer`); stored as `model-visibility.config.hidden: [{id,name}]`; shared via profile-sync. Verified earlier in test instance (nvidia hidden from picker). No profile has anything hidden now. **To re-check:** the operator asked for the switch "beside each provider" — current UI is a separate list at the bottom of Settings → Models, not inline on each provider card. Confirm placement with a screenshot and move inline if needed. |
| 2a | Peak-hour indicator pill | **DONE, live** | `packages/client/ui-peak-hours` (row active), pill in `conversation.composer.dock`. Schedule: 01:00–04:00 & 06:00–10:00 UTC Mon–Fri (= 09:00–12:00, 14:00–18:00 SGT), Chinese 2026 holidays excluded. Pure schedule API: `peakState`, `msUntilChange` in `src/schedule.ts`. |
| 2b | **Peak-hour send gate dialog (3 options)** | **NOT STARTED** | No code anywhere (grep for send guard / interceptor / peak+schedule: nothing). |
| 2c | **Smart queueing of scheduled sends** | **NOT STARTED** | — |
| 1 | **Skills tab (+ optional skill-authoring agent)** | **NOT STARTED** | No package; no sidebar entry. |
| — | (prior batch) literal window transparency | **Built, NOT installed** | `.recon/build-desktop-archive.py` adds `transparent: true` to the Win32 main window. The installed `D:\Deepseek-Desktop\resources\app.asar` (installed 2026-10-08 16:02, table-repair only) has no `transparent: true` on the main window. Not in today's list; mention it to the operator, don't install without approval (needs the Desktop closed). |

---

## 3. Design anchors for the remaining work

### 3.1 Peak-hour send gate (2b, 2c)

- Extend the existing fork package `packages/client/ui-peak-hours` (it already owns schedule + config) rather than
  creating another.
- **Interception point:** upstream `ui-conversation` submit plane —
  `src/client/input/facade.ts` (submit → adjudicate via the session's `InputTriggerController` → `claim.submit` →
  default sink), contracts in `src/client/contract/input.ts` (`InputState.phase`: plain | adjudicating | claimed |
  submitting; `submit(mode, source: 'click'|'enter')`). Find the seam a fork plugin can use to claim/veto a plain
  text submit (input-trigger pipeline, `packages/client/ui-input-trigger`) **without editing upstream**. If no veto
  seam exists, record it and choose the least-invasive route (it must work inside the Desktop's compiled shell).
- **Gate condition:** peak now (`peakState(...).kind === 'peak'`). Open question: only when the session's selected
  route is a DeepSeek API route (official / deepseek-account / kiln-deepseek?) since 2× applies only there — default
  proposal: gate only DeepSeek routes, configurable.
- **Dialog:** three actions — Send anyway / Schedule for <local time peak ends> / Keep editing (Esc = keep editing;
  draft and attachments untouched). Follow `dsh-client-ui-ux` (reuse primitives' Dialog, tokens, i18n zh/en).
  Config option "don't ask again for this peak window" is a possible extra, not requested.
- **Schedule:** use the official schedule plugin (`packages/schedule/schedule`, row `schedule` active; UI row
  `ui-schedule` = the *Automation tasks* page). One-shot at the peak-end instant, delivering the prompt into the same
  session. Check the schedule service API the client can call (the model tool is `schedule_create`; find the client
  /remote API). Attachments: check whether a scheduled prompt can carry them; if not, say so in the dialog.
- **Smart queueing (2c):** when this session already has a pending peak-deferred send, the Schedule choice expands
  to: (a) **Together** — same fire time (deliver as one combined message, or two messages at the same instant — pick
  the one the session handles cleanly, probably combined), (b) **After the first settles** — fire only after the
  first deferred message's turn has completed (needs a "run after turn idle" mechanism: e.g. schedule at the same
  time and rely on the session's own queue, which holds messages that arrive mid-turn until the turn ends — verify
  that is the session's behaviour vs steering-into-the-running-turn).
- Show pending deferred sends somewhere visible (the peak pill tooltip or the Automation tasks list) and allow
  cancel.

### 3.2 Skills tab (1)

- Sidebar tab slot: `sidebar.panellist` + a `main` page — exactly how `ui-schedule` registers *Automation tasks*
  (`packages/client/ui-schedule/src/client/index.ts` lines ~168–190). Profiles tab comes from fork
  `packages/boot/profile-hub`; Plugins from `ui-plugin-manager`.
- New fork package (proposal `packages/client/ui-skills-studio`) with Host half for file I/O:
  - List skills with source (user `~/.dsh/skills`, workspace `.agents/skills`, bundled read-only).
  - Create / edit / rename / delete `SKILL.md` (YAML frontmatter `name`, `description`, body) with validation
    matching what the skill loader accepts (`packages/skill/skill`, `skill-filesystem`).
  - Note: row `skill-filesystem` is **disabled** in this deployment while `skill`, `skill-injection`, `ui-skill`,
    `ui-skill-mention` are active — find out which provider actually serves the catalog before deciding where new
    skills are written, so they show up immediately.
- Optional skill-authoring assistant: a button that opens a new session (or embedded chat panel) seeded with a
  skill-writing system prompt / preset and the skills folder as context. Decide with the operator: embedded chat in
  the tab vs. "New session with Skill Builder".

### 3.3 Re-checks on finished work

- Provider switch placement (inline beside each provider vs bottom list) — screenshot Settings → Models in the
  Desktop test instance.
- Delete-a-provider in one profile → gone in the others (the operator said "delete" explicitly; confirm deletion,
  not only edits/additions, propagates — `fillMissing` on first pass is additive, so check deletion after seeding).
- Plugin disable in one profile → disabled in others, live.

---

## 3.4 Operator decisions (2026-10-09, answered)

- Peak gate applies **only to DeepSeek API routes** (2× pricing). Not Claude/other providers, and **not the DeepSeek
  web route** (`deepseek-account` — the account/web chat login is not API-priced). Verify which routes are real
  API: `llm-deepseek` official yes; check what `kiln-deepseek` talks to before including it.
- Skills tab authoring assistant: **both** — an embedded chat panel in the Skills tab AND a "New session with Skill
  Builder" option.

## 3.5 Progress log (session 13ec2904, 2026-10-09)

### Done + verified in the Desktop test instance

- **Sync re-check:** deletion propagates (whole provider config is shared). New spec "carries a provider deleted in one
  profile and a plugin re-enabled there" — profile-sync 22/22.
- **Provider switch inline (4b):** `ui-model-visibility` now registers `ProviderCardSwitch` on the keyed slot
  `settings.models.provider-card` for every namespace from `llm.listConfigurableProviders()` + key `''`, priority 100.
  Footer list only shows providers with no mounted card (pool logins, hidden undeclared ones). 17 tests, 100%.
  Evidence: `.recon/evidence/provider-switch-cards.png`, `provider-hidden-from-picker.png` (nvidia gone from picker).
- **Peak send gate (2b) + smart queue (2c):**
  - New package `packages/schedule/peak-send` (`@deepseek-ai/dsh-peak-send`, dual face, Remote ns `peakSend`:
    `pending(sessionId)`, `defer({sessionId,text,at,placement:'alone'|'after'|'together',earlierId?})`), uses
    `ctx.schedule.create/list/update` → tasks titled `Off-peak send: …` appear in Automation tasks. Row `peak-send` in
    efai-base (+ dependency), junction `~/.dsh/profiles/node_modules/@deepseek-ai/dsh-peak-send`. 8 tests, 100%.
  - `ui-peak-hours`: Config `sendGate` (true), `gatedRoutes` (['deepseek-official','kiln-deepseek-api']).
    `send-gate.ts` wraps `conversation.sendSession` (the composer default sink, resolved per send — same in the asar).
    Keep editing = resolve `{kind:'error'}` (facade restores draft/chips/attachments, no notice). Schedule = success
    with notice text. New sessions: route from `modelCatalog().default`. Dialog `SendGateDialog` in `shell.overlay`.
    "After"/"together" target the LAST waiting message. 46 tests, 100%.
  - E2E (test profile with a fake peak window + anthropic gated): dialog → Schedule → task in Automation tasks;
    2nd msg "after"; 3rd "together" merged into task 1. At 19:52 delivery: turn 1 replied "ONE THREE", then turn 2
    "TWO" (sequential). Send anyway sends; Keep editing restores. Evidence `.recon/evidence/peak-gate-*.png`.
- Build helper: `node .recon/build-one.mjs <pkg>...` (typecheck + typert + bundle via harness-dev-tools lib).
- GOTCHA: kernel `write()` turns `\n` into `\r\n` on CRLF content → `\r\r\n`. Profile YAML files are CRLF: edit them
  with binary-safe Python (`open(p,'rb')`), never `read_file`+`write`.
- Test profile `desktop-test-instance` patch: temporary TEST-PEAK block removed; it still hides nvidia (test only).

- **Skills tab (1)** — new fork package `packages/skill/skills-studio` (`@deepseek-ai/dsh-skills-studio`, dual face,
  row `skills-studio` in efai-base, junction in `~/.dsh/profiles/node_modules`). Remote ns `skillsStudio`:
  `listSkills(projects)`, `readSkill(file)`, `saveSkill(req)`, `trashSkill(file)`, `startBuilder()`.
  GOTCHA: a Remote method named `remove` collides with the client namespace service ("conflicts with its namespace
  service") → web boot fails with "entry did not activate … failed". Avoid `remove`/generic names.
  - Sidebar entry "Skills" (order 15), page: grouped list (project .dsh/.agents, ~/.dsh/skills, ~/.agents/skills,
    bundled read-only), broken-file reasons (mirrors skill-filesystem rules), overridden tag, editor (name,
    description, whenToUse, user-invocable, disable-model-invocation, body), create/rename/save, delete → trash
    `~/.dsh/skills-trash`, copy bundled → mine. Unknown frontmatter keys + comments preserved.
  - GOTCHA: `~/.dsh/skills` is a JUNCTION to `D:\deepseek-kernel-harness\.agents\skills` (other volume) → rename gave
    EXDEV; `move()` falls back to copy+rm. Skills made in the tab land in the repo's `.agents/skills`.
  - Skill Builder: installs `skill-builder` skill (owner/version metadata; user-edited copy kept). Embedded chat
    column (own session-scope slot `skillsStudio.builder.conversation` rendering `conversation.content` embedded)
    + "Open Skill Builder in a new session". Sessions are created inside a Workspace for the skills folder
    (`workspaces.create({path})`) — a session outside any workspace has a locked composer. Draft
    `@skill skill-builder ` via `conversation.input.for(binding.ctx).setDraft`. Verified: builder wrote a valid
    `haiku-reply` skill in ~30 s, loader picked it up live (test artifacts removed afterwards).
  - 45 tests, 100% coverage. Evidence: `.recon/evidence/skills-*.png`.
- Gates run on all touched packages: oxlint clean; README model-experience/summaries/limitations, md-wrap,
  client-ui-i18n, client-packages, package-meta, export-jsdoc, tsconfig-paths pass; no new `as unknown` casts.
  `verify-seam-frozen` fails on 5 upstream files modified 2026-10-08 by an EARLIER session
  (docs/subsystems/boot*.md, browser-use*.md, scripts/package-dependency-policy.ts) — not this batch; untouched.
- Peak gate hardening: `senderOf()` — if a future upstream drops `conversation.sendSession` (not on the public
  IConversation face) the gate disables itself instead of breaking sends.
- Totals: profile-sync 22, model-visibility 17, ui-peak-hours 48, peak-send 8, skills-studio 45 tests — all 100%.

### To go live in the operator's Desktop

The real Desktop (profile `general`) resolves the same efai-base/efai-web bundles through
`~/.dsh/profiles/node_modules` junctions, so a **Desktop restart** loads everything (new Host rows `peak-send`,
`skills-studio` need it; client bundles alone would need a window reload). Not restarted by the agent.

### Literal transparency (2026-10-10)

Candidate `.recon/install-staging/app.asar.transparent-candidate`, built from the INSTALLED archive with
`build-desktop-archive.py --only transparent` (table-repair kept: 2 markers; validator OK). Booted in the test copy
(needs the test-copy manifest rename `dsh-desktop`->`dsh-desktox` re-applied after swapping, or the copy exits on the
single-instance lock); all plugins incl. Skills loaded; operator confirmed the test window is see-through.
Installer started detached with `--wait` at 11:09 (`install-archive.py`, receipt `.recon/transparent-install.json`,
log `.recon/transparent-install.log`): it swaps the archive once the operator closes the Desktop, validates, and
restores the backup (`.recon/install-backups/`) on failure. Trade-off: Windows draws the window square, no shadow.

### Status: ALL TASKS COMPLETE (2026-10-09 ~20:50 SGT). Next: operator asks for tool-improvement opinions.

## 4. Plan / order

1. Re-verify 3, 4a (incl. deletion), 4b placement in the Desktop test instance; fix gaps.
2. Peak-hour send gate (2b) → smart queueing (2c). Tests + Desktop screenshots.
3. Skills tab (1) → optional authoring assistant.
4. Build, wire bundle rows, gates, verify in Desktop test instance, tell operator what needs a restart.
5. Update this file's status table as each item lands.
6. Then STOP; tool feedback only when the operator asks.


## Harness tool fixes (fork-owned), 2026-10-11..14

| # | Fix | Where | Tests |
|---|---|---|---|
| 1 | read_file returns the whole file unless max_chars is given; write/append refuse text with the omission marker | kernel_child.py | test_file_roundtrip.py 19/19 |
| 2 | write/append normalize CRLF then keep the file's own line endings (no more \r\r\n); seam writes too | kernel_child.py | same |
| 3 | pollBackground/stopBackground called on the provider, not detached (`this` was undefined → 'control' error) | packages/kernel/kernel (index.ts, types.ts) | kernel tests/background.spec.ts |
| 4 | plugins.failures iterates Entry objects from loader.entries() | kernel-python/src/seam-harness.ts | seam-harness.spec 34 |
| 5 | build_workspace_package: `root` arg, live (volatile) repoRoot, fallback to the checkout the package is installed from | harness-dev-tools tools.ts/index.ts | tools.spec |
| 6 | test instance: keeps operator focus (keepFocus), retries a start that exits with a fresh copy, re-renames a swapped archive, copies window console + exceptions into the log, eval takes timeoutMs | harness-dev-tools desktop-instance.ts, focus.ts, cdp.ts, app-copy.ts | 41 tests; live-verified |
| 7 | kernel window_click / window_type / window_key (SendInput, Unicode incl. emoji, ambiguous titles refused, restore_focus) | vision_tools.py + kernel_child registration | test_window_input.py 19/19; live in Notepad |
| 8 | AI Browser screenshot: staged capture with repaint nudges; collapsed panel / hidden window named | web-browser-sidebar pages.ts `capture()` | capture.client.spec |
| 9 | output masking: turn in progress keeps newest 24 results (keepRecentInTurn); stub shows 3 head + 3 tail lines and the session_window(seq) to read the full output | compaction/output-masking | 12 tests |
| 10 | verify-seam-frozen passes (earlier files were recorded). NOTE: a stray checkout during testing reverted docs/subsystems/boot.md's fork hunk; restored from local-overlay/patches/docs.patch; gate passes | — | gate exit 0 |
| 11 | model-experience gate: fork lines are only allowlist entries; the false positive was in the upstream limitations gate → reclassified upstream | — | — |

Live changes need: Desktop restart (Host packages: kernel, kernel-python, harness-dev-tools, output-masking, web-browser-sidebar) and a kernel restart for kernel_child/vision_tools.
