# DeepSeek peak-hour warning and table parser fixes

## Operator request (verbatim)

> I want a plugin to warn me or put a display somewhere in the plugin during deepseeks peak hours, so I know when
> deepseeks api pricing is 2x. Also, theres something wrong with the parser in general. Go find the plugin responsible
> for the bug in the photo, where the message is put into the table when it isnt supposed to. and also somethimes the
> tables dont get parsed and just end up looking like a garbled mess like fjasgio|daiufn|oijnf| like this where it is
> not a table but just words separated with pipes. Do this 1 at a time. dont need rush.

Follow-up: "also remember to add the excluding." (weekends and Chinese public holidays are off-peak).

Session `session-acd47678-ff54-4ef8-89bf-0f10d466aa33`, 2026-10-08. Three tasks, done in order.

## Task 1 — peak-hour indicator (done)

### Facts the schedule rests on

- [DeepSeek pricing](https://api-docs.deepseek.com/quick_start/pricing): "Off-peak rates are half of the peak rates. Peak
  hours are 01:00 - 04:00 and 06:00 - 10:00 UTC, Monday through Friday, excluding Chinese public holidays. All other
  hours are off-peak, including weekends and Chinese public holidays in full."
- 2026 holidays, State Council notice 国办发明电〔2025〕7号
  (<https://www.gov.cn/zhengce/zhengceku/202511/content_7047091.htm>): New Year Jan 1-3, Spring Festival Feb 15-23,
  Qingming Apr 4-6, Labour Day May 1-5, Dragon Boat Jun 19-21, Mid-Autumn Sep 25-27, National Day Oct 1-7.
  Weekend make-up working days are ignored: DeepSeek prices every weekend off-peak. 2027 breaks are not published yet
  (usually November) and must be appended to the `holidays` config field then.
- Peak windows in UTC+8 are 09:00-12:00 and 14:00-18:00, so the UTC date and the China date agree for every window;
  the code still dates weekdays/holidays in the configured calendar (`calendarUtcOffsetMinutes`, 480).

### Where it shows

`conversation.composer.dock` (list slot, session scope, rendered by upstream `ui-conversation` InputBar under the
composer card, beside ui-chat's `stats` pill at order 0). Registered at order 10. The Desktop's asar ships
ui-conversation, but only the slot declaration is used, so the fork package is not shadowed.

### New package `packages/client/ui-peak-hours` (`@deepseek-ai/dsh-client-ui-peak-hours`, fork-only, Tier 1)

- `src/schedule.ts` — pure: defaults, `parseTime`, `windowMinutes`, `isDate`, `scheduleProblems`, `peakState`,
  `msUntilChange`. Windows placed on each UTC day from yesterday to +31 days, filtered by weekday/holiday in the
  calendar, touching windows merged.
- `src/index.ts` — Host half: volatile `Config` (enabled, showOffPeak, warnBeforeMinutes=15, notify=true, windows,
  weekdays, holidays, calendarUtcOffsetMinutes); `apply` throws at load on an invalid schedule.
- `src/client/view.ts` — `peakView(settings, now)` → hidden | invalid | peak | soon | off-peak; `sameView` compares at
  minute resolution so the store only republishes visible changes.
- `src/client/index.ts` — reads `ctx.configForms.get('ui-peak-hours')`, `createSnapshotStore<PeakView>`, 15 s
  interval + settings subscription + visibilitychange refresh, desktop notifications on off→soon and →peak.
- `src/client/PeakPill.tsx` + `.module.css` — amber fill (peak), amber outline (soon/invalid), tertiary (off-peak);
  `Tooltip` with the period end/next start, holiday name, and windows in local time.
- `src/client/notify.ts`, `src/client/locales.ts` (zh/en, namespace `peakHours`).
- Tests: `tests/schedule.spec.ts` (12), `tests/browser-plugin.client.spec.tsx` (14); 100% statements/branches.

### Wiring

- `tsconfig.client.json` aggregate, `tsconfig.base.json` hand-written path alias.
- `packages/bundle/efai-web/cordis.patch.yml` row `ui-peak-hours`, `package.json` dependency, README summary.
- `scripts/verify-package-readme-model-experience.ts` allowlist entry (kind none).
- Junctions: `node_modules/@deepseek-ai/dsh-client-ui-peak-hours` and
  `C:\Users\eejar\.dsh\profiles\node_modules\@deepseek-ai\dsh-client-ui-peak-hours` -> the package directory.
- `pnpm install --offline`; `gen-plugin-packages`, `gen-config-catalog` regenerated; `local-overlay/rebuild.mjs`
  current.

### Verified

- `vitest` 26/26, coverage 100%; `tsc -b` + tsdown bundle ok; oxlint clean.
- Gates green for this package: verify-client-packages, verify-client-ui-i18n, verify-package-readme-summaries,
  verify-package-readme-model-experience (package), verify-package-readme-limitations, verify-export-jsdoc
  (no finding in this package), gen-config-catalog.
- Gates red for pre-existing reasons outside this package: verify-package-dependencies (profile-hub app-boot exports),
  gen-cordis-catalog / gen-doc-graphs (profile-hub `OpenProfileTarget`, web-browser-sidebar types), gen-client-catalog
  (ui-sidebar stray `slots.d.ts`), verify-package-invariants (tool-notebook-edit, token-usage-lifetime),
  verify-export-jsdoc (llm-kiln, llm-text-toolcalls), model-experience (profile-hub CRLF heading).
- Real Desktop test instance (`desktop_test_instance`, 2026-10-08 06:08 UTC, a Thursday after National Day): pill
  rendered `DeepSeek peak 2× · 3h 52m left`, tooltip "until 06:00 PM … 09:00 AM–12:00 PM, 02:00 PM–06:00 PM".
  The operator's own window loads it after a Desktop restart.

## Tasks 2 and 3 — tables: prose swallowed into a table, and tables rendered as pipe text (done)

### Root cause (measured, not inferred)

- The screenshot reply is `session-09bc5f9b…` (NeedleVoice), route `deepseek-account/deepseek-flash`. Its recorded
  wire chunks: `'| you said | instant? | why\n|---|---|---|\n'` (one chunk, header already missing its trailing ` |`),
  then all rows in one chunk ending `…not guessing |\n`, then the sentence token by token. Table lines arrive as
  whole-line chunks after a ~470 ms pause; prose streams per token. The DeepSeek service buffers and re-serializes
  tables, and that loses characters at row ends. No harness plugin deletes characters: `dsh-llm-deepseek-account`
  (asar-only, extracted to `.recon/asar-extract/…/dsh-llm-deepseek-account`) only adds auth to the shared
  `llm-deepseek` Messages transport.
- GFM (micromark-extension-gfm-table) then applies its rules strictly: a non-blank line after a table is one more
  row (bug 2); a header without its own delimiter line, rows fused onto one line, or blank lines between
  header/delimiter/body are no table (bug 3).
- The component that decides how the text renders is `packages/client/ui-primitives/src/markdown` (MarkdownText,
  parse.ts, plain-text.ts) — upstream, and baked into the Desktop web shell `dsh-web-frontend/dist/assets/index-*.js`.

### Corpus evidence (`.recon/probe-table-parse.ts`, every assistant text block in `~/.dsh` session logs)

    raw     : blocks 684  tables 281  swallowed 21  unparsed 47
    repaired: blocks 684  tables 301  swallowed  0  unparsed 25   (the 25 are kiln tool-markup, no pipe rows)

Per route before repair: deepseek-account 88 blocks / 14 swallowed / 21 unparsed (16 fused rows);
kiln-deepseek 581 / 6 / 26 (1 fused, 25 markup false positives); deepseek-official 6 / 1 / 0; anthropic 4 / 0 / 0.
`.recon/probe-table-repair-diff.ts`: the repair changed 45 blocks; 40 carry a known defect; the other 5 are
render-neutral (identical mdast without positions) — a separator before a heading/list/`---` that already ended
the table.

### Damaged shapes seen

| shape | example |
|---|---|
| prose under last row | `| … not guessing |⏎Let me check…` |
| header+delimiter(+row) fused | `| Package | Files | Mechanism available|---|---|---|`, `| || --- | ---| Repo | … |` |
| delimiter+row fused | `| --- | --- | ---| Carried PE image … | no |` |
| rows fused | `… | **1** | 0| self-copy … | **1** | 0| .lnk …` |
| blank lines inside | `| endpoint | what it is⏎⏎| --- | ---|⏎⏎| row…` |
| delimiter lost under emptied header | `| | || Assets | … |` |

### Fix — `packages/client/ui-primitives/src/markdown/table-repair.ts` (`repairMarkdownTables`)

Fence-aware lines with container prefixes; four passes: (1) close blank gaps around a delimiter row (not before
a pipe row that heads the next table); (2) rebuild a block with a fused delimiter (dash run of `---` cells gives N;
header = the N cells before it or the line above; remaining cells must be k×N) or a lost delimiter under an emptied
header; split k×N fused body rows; (3) regenerate a delimiter whose count differs from the header; (4) end a table
at the first pipe-less line (separator keeps the blockquote marker). Valid tables are never rewritten.
Wired into `MarkdownText.tsx` (both arms read the repaired source) and `plain-text.ts`. README paragraph added.
Spec: `tests/markdown-table-repair.client.spec.tsx` (22 tests, screenshot text verbatim, streaming chunk replay);
table-repair.ts 100% statements/branches; ui-primitives 1362/1362; oxlint clean; typecheck ok.
`test:gui`: 4 failures in 3 unrelated specs — `binary-rpc` HTTP-bridge timeouts (pass alone), `present-open`
symlink EPERM (no Windows symlink privilege), document-preview license bundle `spawnSync` — environmental.

### Desktop deployment

The Desktop's `ui-primitives` is compiled into the web shell, so the fix ships as a one-entry archive rewrite:
- `.recon/build-scratch/table-repair.iife.js` — esbuild IIFE of table-repair.ts (`__dshTableRepair`).
- `.recon/build-markdown-repair-archive.py <src.asar> <out.asar> <iife>` — inserts the IIFE before the minified
  MarkdownText (`const z8=j.memo(function({text:n,…`), renames its `text` prop and repairs it once; recomputes
  offsets, header pickle, and that entry's integrity; refuses unless the signature occurs exactly once and the
  marker is absent. Fuse `EnableEmbeddedAsarIntegrityValidation` is off on this exe.
- Verified in the Desktop test copy (patched its renamed archive in place): served bundle carries the marker; a real
  turn whose raw text was `| Uranus | 27 | An ice giant |⏎That is the whole list.` rendered 5 rows + paragraph.
  (That turn's DeepSeek Account request failed `ACCOUNT_QUOTA`; the profile fell over to google/gemini-2.5-flash.)
- Operator approved install. `.recon/install-markdown-repair.py` runs detached via WMI `Win32_Process.Create`
  (pythonw, pid 30552 at arming): waits for every `DeepSeek Harness.exe` to exit, rebuilds from the archive installed
  at that moment, then `install-archive.install` (backup to `.recon/install-backups`, atomic swap, Electron-reader
  validation, automatic restore). Receipt: `.recon/markdown-repair-install.json`. A Desktop update replaces the
  archive and drops the patch; rerun the script after one.

## Task 4 — tidy all fork-owned plugins (operator: "while you at it, tidy up the plugins"; scope chosen: all fork plugins)

Fork-owned set: the 34 package directories absent at upstream base 639ed01539 (`.recon/tidy/fork-packages.txt`).
Gate runner `.recon/tidy/run-gates.ps1`; final results `.recon/tidy/final-gates.txt`.

Before → after (fork findings): oxlint 54 errors → 0; verify-export-jsdoc 93 → 0; verify-package-invariants 38 → 0;
verify-package-dependencies 3 (+4 unmasked) → 0; model-experience 1 → 0; gen-cordis-catalog / gen-doc-graphs 5 (+3
unmasked) → 0; gen-client-catalog failing → passing. All 13 gates exit 0 repo-wide; 34/34 packages typecheck.

Behaviour fixes found by the pass:
- ui-personalization: "no personalization row" notice was dead (`form === undefined` never true; configForms.get
  always returns a form). Now `AppearancePolicy.rowStatus` follows the form snapshot's status, delivered through the
  inject `hooks` compartment (`useRowStatus`); spec covers loading → unavailable → ready.
- skill-injection: replaced the deprecated `session.ownEvents()` scan with an `invokedSkills` session projection
  (seq → skill name), registered in apply and read with `stateOf`; missing registration throws. inject now
  `['skills', 'sessionProjections']`; zod + session-projection/session edges added.
- profile-hub: typed `ResolvedConfig` replaces five `as Required<Config>` casts; env built without `delete`.
- llm-kiln bridge waiter rejects with `Error`; web-access and kernel-python import the Loader's Context merge
  (kernel-python's hand-written `loader?: unknown` merge removed).
Cleanup: 20 stray untracked build outputs deleted from `packages/client/ui-sidebar/src/client`; 9 empty invariant
companions removed (file, `./invariant` export, invariants deps, tsconfig ref, tsdown entry, path alias) with their
reason moved to README; 13 READMEs gained "No runtime invariant companion is published: …"; dead `?? ''`/`?? 0`
fallbacks and redundant optional chains removed; catalog/doc-graph entries for `agentBrowser`, type exemptions,
app-boot safe-export classification, manifest edges for profile-hub/ui-personalization.

Pre-existing failures left alone (fail identically with my edits stashed): llm-kiln `dsml.spec.ts` 4 tests;
session-recovery-context `compaction-stack` 1 test; document-preview license bundle, present-open symlink EPERM,
binary-rpc timeouts (environmental). Noted, not touched: ~100 untracked scratch files in `python/kiln/runtime`
(`_*.py`, soak logs, `*.fixNNbak`).
