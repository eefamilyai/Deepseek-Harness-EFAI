# dshai sites tool — publish AI-made web pages on `<name>.dshai.reggilion.com`

Started 2026-10-10 12:13 SGT, session `session-13ec2904-7c85-4a85-bcb9-3ba937f49160`. Single source of truth for this
task; read first after compaction/resume.

## Operator request (verbatim intent)

> I want a new tool. `<deSEC token>` is the deSEC api token for managing dsh.regglion.com subdomain made just for this.
> Let the AI do various things, e.g. if I ask for illustrations it can make a subdomain like
> illustration.dsh.reggilion.com and put an html/js/css illustration into it to show the user. Or presentations using a
> subdomain. Endless possibilities — most of the ideas I want you to come up with. Should have a **normal tool and a
> kernel tool**. Go.

- **The token's zone is `dshai.reggilion.com`** (not `dsh.`). `GET /domains/` lists only that. Typo in request.
- Token must NOT be committed to the repo. Stored as user env var `DESEC_TOKEN` (HKCU\Environment).

## Findings (measured)

| Fact | Evidence |
|---|---|
| `reggilion.com` is on Cloudflare (NS kami/tim). `dshai` is delegated by NS to deSEC (ns1.desec.io, ns2.desec.org) | `nslookup -type=NS` via 8.8.8.8 |
| deSEC zone has only NS at apex; `minimum_ttl` 900; zone DNSSEC-signed (no DS at parent → insecure delegation, fine) | deSEC API |
| Cloudflare token (`Cloudflare-API-Token` user env) can edit the tunnel but **403 on custom_hostnames and pages** | probes |
| ⇒ Cloudflare edge/tunnel cannot serve names in the deSEC zone (needs Cloudflare-for-SaaS permission) | |
| Router 80/443 → NAS, not the server; only 25565 and 50120 reach JARYLS-SERVER | reggilion-home RECON §3 |
| `gh` signed in as `eefamilyai` (User), scopes gist, read:org, repo, workflow — **no delete_repo** | `gh auth token` + `/user` |

## Decision: hosting = GitHub Pages, one public repo per site

Only path needing no new credentials, no router change, no always-on home machine; automatic Let's Encrypt HTTPS.
Per site: repo `eefamilyai/dshai-<name>` (public; free Pages requires public), commit via Git Data REST API (no local
git), Pages from `main` `/`, cname `<name>.dshai.reggilion.com`, deSEC CNAME `<name>` → `eefamilyai.github.io.`.
Removal order matters (subdomain takeover): delete DNS first, then disable Pages, then archive repo (no delete scope).
Upgrade path if instant/self-hosted is wanted later: a Cloudflare token with SSL & Certificates (custom hostnames)
→ CNAME to a proxied fallback origin on the tunnel.

## Plan

1. Prototype by hand (site `probe`) — measure time to HTTP/HTTPS live. (in progress)
2. Fork package `packages/tools/tool-sites` (`@deepseek-ai/dsh-tool-sites`): tools `site_publish`, `site_list`,
   `site_status`, `site_remove`; config zone/owner/prefix/tokenEnv/noindex; row in efai-base.
3. Kernel module `python/kiln/runtime/sites_tools.py`: `site_publish(name, source=dir|dict|html)`, `site_wait`,
   `site_list`, `site_remove`, `site_shot` (screenshot), registered like vision_tools.
4. Skill `dshai-sites`: ideas/patterns (illustrations, slides, charts, diagrams, 3D, interactive explainers, reports,
   dashboards, games, docs), CDN libs, quality checklist.
5. Tests, build, verify live in Desktop test instance, docs/gates, update this file.

## Gotchas found while building (2026-10-10)

- **Kernel `read_file` truncates huge files** with an inline `…[N chars omitted — read a slice]…` marker. A
  `read_file` + `write` round trip on `kernel_child.py` (200 KB) silently deleted ~1.5 KB. Restored from HEAD and the
  edit re-applied with plain `open()`. For big files use `open()`/Edit tool, never `read_file`+`write`.
- **GitHub Pages only requests the HTTPS certificate if the name resolves when the custom domain is set.** Domain set
  before DNS → `https_certificate: null` forever. Fix: DNS first; re-save the domain (null then host) when no cert →
  approved in ~20 s, edge rollout a few minutes later. `Sites.secure()` does this on publish and on status.
- GitHub commits its own `CNAME` file ("Create/Delete CNAME") when the domain changes; harmless (publish replaces tree).
- Probing a brand-new name early makes Windows cache NXDOMAIN for minutes → publish skips the https probe when created.
- Measured: new name → build 50 s; DNS visible ~40 s; HTTP 200 ~2 min; HTTPS after cert nudge + a few minutes.
- `probe` site (dshai-probe) and `hello` site exist from testing; remove when done.

## Status: DONE (2026-10-10 ~13:05 SGT)

Built:
- `packages/web/tool-sites` (`@deepseek-ai/dsh-tool-sites`): tool `site` (publish/list/status/remove), row `tool-sites`
  in efai-base + dependency + profiles junction. 33 tests, 100% coverage, oxlint clean, README gates pass.
- `python/kiln/runtime/sites_tools.py` + registration in `kernel_child.py` (13 added lines, nothing else changed):
  `site_publish`, `site_starter` (page/slides/illustration/chart), `site_status`, `site_list`, `site_remove`,
  `site_wait_https`. `test_sites_tools.py` 28/28.
- Skill `.agents/skills/dshai-sites/SKILL.md` (= `~/.dsh/skills` via junction): when/how, ideas, quality bar, rules.
- Token: user env `DESEC_TOKEN` (read from HKCU\Environment if the Host predates it).

Certificate fix that made new names work first time: DNS put → wait until deSEC NS answer (authoritative lookup,
never a public resolver: zone negative TTL 3600 s) → commit → Pages + cname. Retry cname only for null/bad_authz/
errored/authorization_revoked/dns_changed, ≤ every 20 min; never for "new" (restarts the queue).

Verified in Desktop test copy: Claude Sonnet built + published `lighthouse` by itself via the tool (HTTPS on first
try), then used `site_list()`/`site_status()` from the kernel. Live demos: lighthouse, solar-system, sites-intro
(screenshots `.recon/evidence/site-*.png`). probe/hello removed (repos archived).

Needs a Desktop restart for the new row + kernel helpers in the operator's own app.
