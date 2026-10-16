---
name: dshai-sites
description: Use when the user asks for an illustration, animation, slide deck or presentation, interactive explainer, simulation, chart, dashboard, diagram, visual report, landing page, prototype, mockup, or small game — or whenever an answer would be clearer seen than read. Builds it as a web page and publishes it at https://<name>.dshai.reggilion.com with the `site` tool (kernel helpers site_publish, site_starter, site_status).
---

# Publishing web pages at `<name>.dshai.reggilion.com`

The `site` tool turns a folder of HTML, CSS, and JavaScript into a live page at
`https://<name>.dshai.reggilion.com` and gives back the URL. Use it to *show*
things. A good page beats a paragraph whenever the answer is visual, spatial,
interactive, or something the user will present.

## When to reach for it

| The user asks for... | Build |
|---|---|
| an illustration, poster, or "draw me" | SVG or canvas art, animated if it helps; full-viewport |
| a presentation or slides | reveal.js deck (`site_starter("slides")`): speaker notes, fragments, overview |
| to understand a concept | an interactive explainer: sliders and step-through visuals beside short text |
| data, numbers, a comparison | Chart.js / D3 charts with labelled axes and a takeaway headline |
| a process, architecture, or timeline | an SVG or Mermaid diagram the user can zoom |
| a report or summary to share | a clean single-page document with sections, a TOC, and print styles |
| a UI idea or app mockup | a clickable prototype with realistic content |
| something playful | a small canvas game or generative art piece |
| a 3D object or scene | three.js with orbit controls |
| a map | Leaflet with OpenStreetMap tiles |

Offer it unprompted when the result would clearly be better as a page. Say so in
one line, and don't publish private material without asking.

## How

**From the kernel** (preferred for anything with more than one file):

```python
folder = site_starter("slides", "Quarterly Review")   # or page / illustration / chart
# ...write or edit files in `folder` with write() / edit_file()...
site_publish("q3-review", folder, title="Quarterly review deck")
```

`site_publish(name, source)` also takes a dict `{path: str | bytes}` or one
HTML string. `site_status(name)`, `site_list()`, `site_remove(name)`, and
`site_wait_https(name)` cover the rest.

**As a tool:** `site` with `action: "publish"`, `name`, and either `files`
(`[{path, content, base64?}]`) or `dir` (an absolute folder).

## Names

- Lowercase words and hyphens that say what it is: `solar-system`,
  `q3-review`, `sorting-visualised`. Each name is its own subdomain.
- Republishing a name **replaces the whole site**. Pick a new name for a new
  piece; reuse the name to revise the same piece.
- Run `site_list()` before naming something new, so you don't overwrite a site
  the user still wants.

## Timing (tell the user)

- **Updating an existing site**: live within about a minute.
- **A new name**: HTTP works within about 2 minutes, while GitHub issues the
  HTTPS certificate (usually 5–30 minutes). Give the user the URL the tool
  returns (it is `http://` until HTTPS serves), and offer `site_status` or
  `site_wait_https` later.
- If the user's own PC says the name does not exist, its DNS cache is stale
  for a few minutes; another network or `ipconfig /flushdns` fixes it.

## Quality bar

- **One self-contained folder**: relative links only (`style.css`, not
  `/style.css`), `index.html` at the root, no build step. Libraries load from a
  CDN (`https://cdn.jsdelivr.net/npm/...`) pinned to a major version.
- **Looks finished**: real content (never lorem ipsum), a clear title, deliberate
  colours and type, generous spacing, dark-mode friendly, responsive down to
  phone width (`<meta name="viewport" ...>`).
- **Works on its own**: no console errors; nothing needs a server, an API key,
  or a login; interactions have visible affordances; animations respect
  `prefers-reduced-motion`.
- **Check before handing over**: open the URL with the browser tool and look at
  it (screenshot), fix what is off, publish again.
- Images you generate or download go in the folder as files (bytes are fine).

## Never

- Publish secrets, tokens, personal data, or private documents: every site is
  a **public** GitHub repository (`eefamilyai/dshai-<name>`) as well as a public
  page. Search engines are kept out (`robots.txt`), but anyone with the link can see it.
- Use a site to run server code: it is static hosting only.
- Remove a site the user did not ask to remove. `site_remove` archives the
  repository; publishing the name again brings it back.
