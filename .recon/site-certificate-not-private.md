# "Your connection is not private" on a published site (2026-10-21)

Reported with a Chrome screenshot: `ERR_CERT_COMMON_NAME_INVALID` for
`https://garden-slug-3d.dshai.reggilion.com`, "takes soo long for the
certificate".

## What was actually wrong

Not the site's content and not DNS. The pieces:

| Check | Result |
| --- | --- |
| DNS | `garden-slug-3d.dshai.reggilion.com` CNAME → `eefamilyai.github.io.` — correct |
| Repo `CNAME` file | `garden-slug-3d.dshai.reggilion.com` — correct |
| Pages API | `cname` set, `https_certificate.state: approved`, domains listed, `https_enforced: false` |
| TLS as served (at report time) | `CN=*.github.io` — GitHub's **default** certificate, which does not cover the custom domain |

So GitHub had issued the domain's certificate and reported it approved, while
its edge was still answering the name with the wildcard `*.github.io`
certificate. Every browser rejects that with `ERR_CERT_COMMON_NAME_INVALID`,
and because the name is under HSTS there is no silent http fallback.

The certificate itself is dated `valid_from Oct 21 12:12:53 2026`, i.e. issued
minutes before the report: the site was inside GitHub's certificate propagation
window, which is the "takes so long" part. Later probes on all reachable edges
returned `CN=garden-slug-3d.dshai.reggilion.com`.

## Fixed

1. **HTTPS enforcement** was off for the repository. Enabled it
   (`PUT /repos/.../pages` with `cname` + `https_enforced: true`), so http now
   redirects instead of serving an insecure copy of the page.
2. **`site status` lied about readiness** (fork-owned `packages/web/tool-sites`).
   It printed `HTTPS certificate: approved` straight from the API even while the
   probe beside it said `https no answer (ERR_TLS_CERT_ALTNAME_INVALID)`. It now
   states readiness from what a real request answered:
   `served: browsers load the https address`, or `NOT served by the edge yet …`
   with the note that the http address works meanwhile.
3. `tests/sites.spec.ts` pinned the old line verbatim; it now asserts the state
   *and* the verdict, since the verdict is the point.

## Verification

```
http  → 301 https://garden-slug-3d.dshai.reggilion.com/
https → 200 text/html; charset=utf-8
TLS   → CN=garden-slug-3d.dshai.reggilion.com, SAN=that name, expires Jan 19 2027
        (same answer from 185.199.108/.110/.111.153)
tests → 33 passed; package typecheck ok
```

## Why it will keep feeling slow, and what to expect

GitHub Pages issues a Let's Encrypt certificate only after the DNS name points
at Pages, its API flips to `approved` before the edge serves that certificate,
and enforcement is refused until the edge has it. The three steps are minutes to
hours apart and nothing in the previous status output distinguished them.

Practical guidance now that the tool reports it: if the status says NOT served,
the site is unusable over https no matter what the API says — wait, or share the
`http://` address. A browser that already showed the certificate error caches it
per host: a hard reload (Ctrl+Shift+R) or a Chrome restart is needed even after
propagation completes.

## Note on the running app

The status-text change is in the fork source; the operator's Desktop app loads a
packaged build, so that wording appears after a rebuild. The enforcement change
is GitHub-side and is live immediately.

## Follow-up: every site, including future ones

Fixing one site by hand is not a fix. The tool now has a sweep.

### Code

- `Sites.secureAll(name?)` — runs the existing per-site repair (`secure()`) across
  every live site with a DNS name, or just one, and returns one row per site:
  certificate state, whether HTTPS is enforced, and whether the host actually
  serves a certificate for itself.
- `site secure` action (`SITE_ACTIONS` now `publish, list, status, secure, remove`).
  Omitting `name` repairs all sites; the result line says how many are serving
  and how many are still waiting on GitHub to issue and propagate a certificate.
- Test: publishes two sites, one approved-but-unenforced and one `bad_authz`, and
  asserts the sweep enforces the first and re-requests the second rather than
  reporting it as fine.

Every publish already asked for the certificate and enforced HTTPS once approved,
so a future site takes this path on its own; `secure` is the sweep for sites that
predate the fix, and the repair path for one GitHub abandoned.

### Result across the ten live sites

Eight were repaired end to end — valid certificate for their own host and
`https_enforced: true`: `deepseek-v4-1-flash`, `garden-slug-3d`, `how-llms-work`,
`huawen-cidian`, `lighthouse`, `llm-atlas`, `lumen-reader`, `sites-intro`.

Two needed more than a sweep:

- **`deepseek-v4-1`** — `cert: new`, i.e. GitHub is issuing the certificate now.
  It converges without help; one more `site secure` (or `status`) enforces HTTPS
  when it lands.
- **`solar-system`** — `bad_authz` throughout. Root cause found: its Pages build
  was `errored` ("Page build failed.", duration 0), and the ACME challenge is
  served *by Pages*, so a broken build fails validation. Worse, the repair loop
  fed itself: re-requesting the certificate toggles the custom domain, which
  triggered another failed build. Resetting the Pages site (delete, recreate with
  `source: main /` and the cname) produced a clean `built` status, but GitHub kept
  the stuck authorization. Let's Encrypt allows five failed validations per
  hostname per hour and each retry refreshes that window, so this one needs to be
  left alone for about an hour and then swept once.

### What a stuck certificate means for the tool

A certificate cannot be issued while the site's build is failing. `secure()` now
has a recovery path for `bad_authz`/`errored`/`dns_changed`/missing state, but a
build error is the upstream cause and is reported separately by `status` as
`latest build errored (…)`.
