---
description: "The site tool: publish static web pages the agent builds at https://<name>.<zone> through GitHub Pages and deSEC DNS."
kind: "package-reference"
---

# @deepseek-ai/dsh-tool-sites

## Summary

Gives the agent a `site` tool that publishes a folder of HTML, CSS, and JavaScript at `https://<name>.dshai.reggilion.com` and returns the address. It suits whatever is better seen than read: illustrations and animations, slide decks, interactive explainers, charts, diagrams, reports, prototypes, and small games. The kernel has the same abilities as Python helpers (`site_publish`, `site_starter`, `site_status`, `site_list`, `site_remove`, `site_wait_https`), and the `dshai-sites` skill tells the agent when and how to use them.

## Table of Contents

- [Use this package](#use-this-package)
- [How a site is served](#how-a-site-is-served)
- [The `site` tool](#the-site-tool)
- [Kernel helpers](#kernel-helpers)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

`packages/bundle/efai-base` mounts it:

```yaml
- id: tool-sites
  name: '@deepseek-ai/dsh-tool-sites'
```

| Setting | Default | Meaning |
|---|---|---|
| `zone` | `dshai.reggilion.com` | The deSEC zone; each site is `<name>.<zone>`. |
| `tokenEnv` | `DESEC_TOKEN` | The environment variable holding the deSEC API token for the zone. |
| `owner` | empty | The GitHub account owning the site repositories; empty uses the signed-in account. |
| `repoPrefix` | `dshai-` | Prefix of every site repository name. |
| `ttl` | `900` | TTL of each CNAME record, in seconds (the zone's minimum). |
| `noindex` | `true` | Give a site without its own `robots.txt` one that keeps search engines out. |

Credentials are read at the first call, not at start-up. The deSEC token comes from the configured variable. On Windows the user's stored environment is also read, so a variable set after the Host started works. The GitHub token comes from `GITHUB_TOKEN`, `GH_TOKEN`, or `gh auth token`, and needs the `repo` scope.

<a id="how-a-site-is-served"></a>
## How a site is served

Each site is a public repository `<owner>/<repoPrefix><name>` served by GitHub Pages from `main`. A deSEC `CNAME` record points `<name>` at `<owner>.github.io.`, and GitHub issues the HTTPS certificate.

1. The DNS record is written first. GitHub requests a certificate only when the custom domain already resolves when it is set.
2. One commit replaces the branch's whole content with the site's files plus `CNAME`, `.nojekyll`, and, with `noindex`, a `robots.txt`.
3. Pages is turned on and the custom domain is set.
4. The publish waits for the Pages build of that commit (default 90 seconds).
5. If GitHub holds no certificate, the domain is set again, which asks again. Once the certificate is approved, HTTPS is enforced.

A new name serves over HTTP within about two minutes; HTTPS follows once the certificate is rolled out, usually minutes. An existing site updates within a minute. `remove` deletes the DNS record first, then turns Pages off, then archives the repository, so the name never points at a Pages host that no longer claims it. Publishing the name again restores the archived repository. The token has no `delete_repo` scope, so repositories are never deleted.

<a id="the-site-tool"></a>
## The `site` tool

| Action | Arguments | Result |
|---|---|---|
| `publish` | `name`; `files` (`[{path, content, base64?}]`) or `dir` (absolute folder); `title`; `wait_seconds` | The URL (https once it serves, http before), the build state, the source repository, and notes on DNS and HTTPS timing. |
| `list` | — | Every site with its URL and title; sites taken down or without a DNS name are marked. |
| `status` | `name` | Repository, DNS record, Pages build, certificate, and what http and https answer. It also retries a missing certificate. |
| `remove` | `name` | The steps taken. |

A site needs `index.html` at its root. Paths must be relative and stay inside the site, and `.git` is refused. A publish allows at most 1000 files, 25 MB per file, and 75 MB in total. Names are DNS labels of 1-40 lowercase letters, digits, and inner hyphens; `www`, `mail`, `api`, `ns`, `ns1`, and `ns2` are reserved.

<a id="kernel-helpers"></a>
## Kernel helpers

`python/kiln/runtime/sites_tools.py` binds to the kernel's `call_tool`, so the helpers drive this tool and hold no credentials of their own.

| Helper | Use |
|---|---|
| `site_publish(name, source, title=None, wait_seconds=90)` | `source` is a folder, a dict `{path: str \| bytes \| Path}`, or one HTML string. |
| `site_starter(kind, title, folder=None)` | Writes a starter to edit: `page`, `slides` (reveal.js), `illustration` (canvas animation), or `chart` (Chart.js). |
| `site_status(name)`, `site_list()`, `site_remove(name)` | The tool's other actions. |
| `site_wait_https(name, timeout=1800, every=60)` | Polls until the site answers over https. |

## Model Experience

### `site`

#### What the model sees

The tool's description lists the uses (illustrations, slide decks, explainers, charts, diagrams, reports, prototypes, games), the four actions, that each site is a public repository and must never carry secrets, and the timing for a new name. The parameters are `action`, `name`, `files`, `dir`, `title`, and `wait_seconds`.

#### Token effect

The schema adds about 450 tokens to every request while the row is enabled. A result is a few lines of text.

#### KV Cache effect

The schema is fixed text, so it stays inside the cached tool prefix; enabling or disabling the row changes that prefix once.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- Static hosting only: no server code, and every site is a public repository and a public page.
- A new name waits on GitHub for HTTPS. Instant HTTPS would need a Cloudflare token with Custom Hostnames permission, so sites could be served through the existing tunnel instead.
- The account's other repositories are listed only to find site repositories; sites live under one account.
