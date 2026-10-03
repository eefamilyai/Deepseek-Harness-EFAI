# Continuation prompt — model dropdown: account bubbles + accordion

Copy everything below the line into a fresh session.

---

## Your task

Finish the model dropdown in the DeepSeek Harness fork at `D:\deepseek-kernel-harness`. Two parts, one already shipped:

1. **Done and committed:** provider groups in the model dropdown contract, with everything closed except the provider holding the current model, click/keyboard toggles with chevrons, and a bounded scroll box for a provider with many routes. Commit `cd493e289a`.
2. **The work left:** the account pool. Under the `DeepSeek (free web)` header the operator wants **one single-choice bubble row of the ten accounts** (bubbles wrap; the row scrolls if they overflow), followed by **only the four model rows** — `DeepSeek`, `DeepSeek · Thinking`, `DeepSeek · Search`, `DeepSeek · Thinking + Search`. Today those ten accounts render as their own list of rows with trailing chevrons, and the four models render separately.

## Hard constraints (the operator set these explicitly)

- **Never edit an upstream-owned file.** The whole point is that `git merge upstream` stays trivial. Fork-owned packages, fork bundle rows, and your own new packages are fair game.
- **UI work ships as an external plugin.** A seam patch on an upstream file (`local-overlay/patches/*.patch`, recorded in `local-overlay/SEAM.json`) was explicitly *rejected* for this work: the operator chose "plugin-only, no upstream file touched", then granted "**I give you permission to use the DOM**, but just make sure it's an external plugin". So: a plugin may read and manipulate the live DOM. Do not touch `packages/client/ui-model-selection/**`.
- **Quality, no bugs, no freezing.** Every change gets verified in a running app before you claim it works. An earlier attempt shipped a plugin whose client half had no `apply` and blanked the page; the operator has said this twice.
- Run builds and test suites **in the background** and keep working.
- Keep `.recon/desktop-asar-shadows-fork-packages.md` current — `AGENTS.local.md` requires job findings in `.recon`, appended to the relevant file.

## Where the code is

**Your plugin (fork-owned, edit freely):** `packages/client/ui-polish`

| File | Role |
|---|---|
| `src/client/polish.css` | The whole visual sheet: motion tokens, elevation, overlay entrances, dock corners, surface hierarchy, **and section `3d` — the provider-group rules** |
| `src/client/model-groups.ts` | DOM enhancer: wires each group title as a click/Enter/Space toggle with `aria-expanded`, intercepts arrow keys in the capture phase so focus skips hidden rows |
| `src/client/index.ts` | `apply(ctx)` — injects the CSS by importing it, then `ctx.effect(() => installModelGroups(), …)` |
| `tests/polish-sheet.client.spec.ts` | 12 tests over the sheet text (no hashed-class selectors, token discipline, the accordion contract, the corner-shape pairing, reduced motion) |
| `README.md` | Model Experience section; the allowlist entry is in `scripts/verify-package-readme-model-experience.ts` |

**The components you are adapting (read-only, upstream):**

- `packages/client/ui-model-selection/src/client/ModelSelect.tsx` (656 lines) — the dropdown. `state.groups` is the provider list; each group renders `<MenuGroup label={…}>{models.map(…)}</MenuGroup>` with `role="menuitemradio"` rows. The account group's label comes from `group.id === 'deepseek-account' ? t('provider.account') : group.name`.
- `packages/client/ui-primitives/src/MenuGroup.tsx` — publishes the contract you can rely on:

```html
<section role="group" data-menu-group aria-labelledby="…">
  <span data-menu-group-start aria-hidden="true"></span>
  <div data-menu-group-heading>Provider name</div>
  …rows…
</section>
```

- The menu's scrolling container is a `div[role="menu"]`; the pane that holds the provider groups also has `role="menu"` on its inner scroller. The root pane (two cells, "Model" and "Effort") is `role="menu"` as well, and those cells are `role="menuitem"` with a trailing chevron.
- `MenuSurface` and `Modal` portal to `document.body`. The dropdown unmounts when it closes, so DOM edits do not need to be undone.

## What is verified, and the one unknown

Verified in a live app (these are facts, not assumptions):

- Provider-group titles render as toggles, only the in-use provider's rows are open, and the chevrons paint.
- The sheet hides rows **by exclusion** — `[data-menu-group] > :not([data-menu-group-heading], [data-menu-group-start])` — so it survives bare rows, wrappers, or a row element kind that does not exist yet. Keep it that way.
- The many-route box keys on row count: `[data-menu-group]:has(> :nth-child(n + 12))` with `max-height: 15rem; overflow-y: auto; overscroll-behavior: contain`.
- Two openers were tried and **removed as wrong**: `:hover` (the pointer crosses titles on its way down the list, so groups popped open unasked) and `:focus-within` (the heading is focusable, so the menu's initial focus opened the account pool on every visit). Only two things open a group: the checked row's group, and the heading's `aria-expanded="true"` that the enhancer writes.

**The unknown you must resolve first:** the ten account rows are **not children of a `[data-menu-group]` section**. In the live DOM they are plain `<button>`s with a trailing chevron (the accessibility snapshot labels them `button:`, while model rows are `menuitemradio button:`), rendered as their own list beside the provider groups. That is why the accordion's rules and the scroll box never touch them. Their container's attributes are unknown.

### How to probe it

**The browser tool cannot execute JavaScript** (no `eval` tool exists). A `<pre>` you inject is *not* visible through the tool's text projection either — that was tried. Channels that do work:

- `document.title` — the tool reports the page title in every caption (it shows `DSH Local Build` there today). About 200 characters, enough for a compact ancestry dump.
- Visible text inside an element the projection already reads (e.g. inside the menu itself).

Set the probe, build, boot a spare host, open the menu, read the caption, then **delete the probe** and revert the file to its committed state (`git checkout -- <file>`) before you do anything else. Do not leave debug code behind.

## The implementation, once the container is known

1. In `model-groups.ts`, find that container (and the `DeepSeek (free web)` group). Identify the ten account rows robustly — prefer a structural or attribute signal over localized label text.
2. Build a bubble row **owned by the plugin**: a `role="radiogroup"` element holding one button per account, `aria-checked="true"` on the selected one, injected after the provider header.
3. **Simplest correct mapping for a bubble click: call `.click()` on the matching original row** so upstream's own `choose()` runs and the same `ModelSelection` (`{ provider, model, reasoningEffort? }`) is submitted. Do not invent a selection call: the account and the model are two halves of one selection, and a bare account id is not a valid choice.
   Reparenting the existing buttons into your bubble container is the alternative (React's delegation is at the root, so events survive a move inside the same root) — but clicking through is less invasive.
4. Hide the original ten rows once their bubbles exist, keep the four model rows as they are, and style the bubbles in `polish.css`: wrapping flex row, small pill radii with `corner-shape: round` (the theme requires the pair for any uncapped radius — `ui-theme/tests/corner-shape-styles.client.spec.ts` enforces it across every client sheet), a scroll cap, and accent tint on the checked bubble via the design tokens (no literal colours anywhere in the sheet).
5. Extend `tests/polish-sheet.client.spec.ts` with the new contract. `ruleFor(css, selector)` in that spec only finds a rule whose selector is followed directly by ` {`, so assert grouped selector lists against the whole sheet instead.

## Verification workflow (this is the loop that works)

```powershell
# rebuild client bundles (~2–4 min, run in background)
pnpm exec tsdown --env.DSH_BUILD_FACE client

# boot a spare host from source (web profile; ~35 s)
$env:DSH_PROFILE='web'
node apps/cli/lib/bin.js web --no-open --port 50140    # then read the tokenised URL from the log
```

Then drive it with the browser tool: click the model chip (`Select model, current …`), click the `Model` cell, and screenshot. Refs go stale between calls — `read` again before each click, and note that a click can miss when the snapshot is older than the page.

Checks before every commit:

```powershell
pnpm exec vitest run packages/client/ui-polish
node --max-old-space-size=4096 ./node_modules/typescript/bin/tsc -b tsconfig.client.json
pnpm exec tsx scripts/run-oxlint.ts packages/client/ui-polish     # oxlint, max line length 140
pnpm exec tsdown --env.DSH_BUILD_FACE client
```

`pnpm run test:gui` reports 7 failures — all pre-existing or flaky (`connection/binary-rpc` ×2, `ui-deliverables/present-open`, `ui-deliverables/review-tab`, `ui-sidebar-documentpreview` licence bundle, `ui-sidebar-right/expand-button`, `ui-theme/radius-styles`, the last two flakes that pass in isolation). Do not try to fix those here.

## Other open items, in priority order

1. **The bubble selector** — the task above.
2. **`web-access.json` clobbering.** `packages/host/web-access` publishes the running host's authenticated URL to `$DSH_HOME/run/web-access.json`. Two hosts sharing one `DSH_HOME` overwrite each other — a spare host steals the operator's app URL. Fix by port-scoping the filename or refusing to overwrite a record whose pid is still alive. Read the current app URL with `node scripts/web-access.mjs`.
3. **`verify-client-ui-i18n` is red on `packages/client/ui-effects/src/client/Overlay.tsx`** — hardcoded English ("Enter passcode to unlock", "Focus lock passcode", "Unlock") in a fork-owned package. A real defect: route it through a locale dictionary like every other fork package.
4. **Tools settings section** (`packages/client/ui-settings-tools`, committed `d12f4e6f16`): groups for availability, the Python kernel, browser tools and the preset roster. Two gaps — the browser group is written but the deployment's `web-browser` entry is not a settings namespace, so it renders an explanatory line; and the preset group only *lists* because the `agentPresets` Remote publishes `list`/`read`/`select` and `select` is session-scoped. Per-preset editing needs a host-side write.
5. **A GIF of the panel toggle** was never recorded. The operator's original complaint was motion, and a still cannot show it. `record-browser-gif` documents the pipeline; Playwright 1.61.1 resolves from `apps/web/package.json`, and ffmpeg/python are on PATH. Store artefacts under gitignored `.playwright-mcp/`.

## Repo conventions that bite

- Fork packages need: a `tsconfig` aggregate entry, a bundle row in `packages/bundle/efai-web/cordis.patch.yml` **and** a dependency in that bundle's `package.json`, a profile junction under `C:\Users\eejar\.dsh\profiles\node_modules\@deepseek-ai`, a `README.md` with the Model Experience section plus an allowlist entry, `@param`/`@returns` on every export (enforced by `verify-export-jsdoc`), and locale-owned copy (no hardcoded UI strings).
- After changing a package: `pnpm install --no-frozen-lockfile`, `pnpm run gen-plugin-packages`, `gen-cordis-api`, `gen-doc-graphs`, `gen-config-catalog`, `gen-tsconfig-paths`, then `node local-overlay/rebuild.mjs` and `node local-overlay/verify-seam-frozen.mjs`.
- The pre-commit hook runs `oxlint` on staged files; a >140-column line will reject the commit. Commit messages via `git commit -F <file>` — PowerShell has no heredocs.
- Client spec naming decides which typecheck aggregate sees a file: anything touching a Client face must be `*.client.spec.ts(x)`.
