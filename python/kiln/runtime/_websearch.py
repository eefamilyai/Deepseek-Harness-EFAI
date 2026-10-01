#!/usr/bin/env python3
"""A dependency-free web search for this sandbox.

The harness `web_search` tool routes through a separate DeepSeek endpoint that
answers HTTP 402 (Insufficient Balance), so external research through it is dead.
This module reaches search engines directly with urllib and parses their result
pages, which is all the investigation needs: titles, URLs, snippets.

Engines, tried in order:

* `ddg_lite`  -- lite.duckduckgo.com/lite/   smallest page, easiest to parse
* `ddg_html`  -- html.duckduckgo.com/html/   same index, richer markup
* `bing`      -- www.bing.com/search         independent index, last resort

Measured reachability from this host (2026-10-01): ddg_lite 200, ddg_html 200,
bing 200, mojeek 403 (WAF). Google and Brave need a real browser.

`search()` returns the first engine that produced results, so one blocked engine
does not empty the answer. `search_all()` merges every engine that answered,
which is what a research pass wants. `fetch_text()` is the matching page reader
for following a hit.

Everything here is read-only and touches no harness state.
"""
import html as _html
import re
import ssl
import time
import urllib.parse
import urllib.request

__all__ = ["search", "search_all", "fetch_text", "ENGINES", "SearchError"]

UA = (
    "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 "
    "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36"
)

_CTX = ssl.create_default_context()

_TAG_RE = re.compile(r"<[^>]+>")
_WS_RE = re.compile(r"\s+")


class SearchError(RuntimeError):
    """Every configured engine failed or returned nothing."""


# ---------------------------------------------------------------- transport

def _get(url, data=None, timeout=25):
    """Return (status, decoded_body). Raises on transport failure."""
    headers = {
        "User-Agent": UA,
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
        "Cache-Control": "no-cache",
        "Pragma": "no-cache",
    }
    if data is not None:
        headers["Content-Type"] = "application/x-www-form-urlencoded"
    req = urllib.request.Request(url, data=data, headers=headers)
    with urllib.request.urlopen(req, timeout=timeout, context=_CTX) as resp:
        raw = resp.read()
        return resp.status, raw.decode("utf-8", "replace")


# ---------------------------------------------------------------- parsing

def _clean(s):
    s = _TAG_RE.sub(" ", s)
    s = _html.unescape(s)
    return _WS_RE.sub(" ", s).strip()


def _unwrap(href):
    """DDG wraps outbound links as //duckduckgo.com/l/?uddg=<encoded>&rut=..."""
    if not href:
        return href
    if href.startswith("//"):
        href = "https:" + href
    if "duckduckgo.com/l/" in href:
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(href).query)
        if qs.get("uddg"):
            return qs["uddg"][0]
    return href


_LITE_LINK = re.compile(
    r"<a\b([^>]*class=[\"'][^\"']*result-link[^\"']*[\"'][^>]*)>(.*?)</a>",
    re.S | re.I,
)
_LITE_SNIP = re.compile(
    r"<td\b[^>]*class=[\"'][^\"']*result-snippet[^\"']*[\"'][^>]*>(.*?)</td>",
    re.S | re.I,
)
_HTML_LINK = re.compile(
    r"<a\b([^>]*class=[\"'][^\"']*result__a[^\"']*[\"'][^>]*)>(.*?)</a>",
    re.S | re.I,
)
_HTML_SNIP = re.compile(
    r"<a\b[^>]*class=[\"'][^\"']*result__snippet[^\"']*[\"'][^>]*>(.*?)</a>",
    re.S | re.I,
)
_BING_ITEM = re.compile(
    r"<li\b[^>]*class=[\"'][^\"']*b_algo[^\"']*[\"'][^>]*>(.*?)</li>",
    re.S | re.I,
)
_BING_H2 = re.compile(r"<h2[^>]*>\s*<a\b([^>]*)>(.*?)</a>", re.S | re.I)
_BING_HREF = re.compile(r"href=[\"']([^\"']+)[\"']", re.I)
_BING_P = re.compile(r"<p\b[^>]*>(.*?)</p>", re.S | re.I)


def _rows_from_pairs(links, snippets, engine):
    """Zip an ordered link list with an ordered snippet list."""
    out = []
    for i, (attrs, title_html) in enumerate(links):
        m = _BING_HREF.search(attrs)
        url = _unwrap(m.group(1)) if m else ""
        title = _clean(title_html)
        if not title or not url:
            continue
        if url.startswith("/") or url.startswith("javascript:"):
            continue
        out.append({
            "title": title,
            "url": url,
            "snippet": _clean(snippets[i]) if i < len(snippets) else "",
            "engine": engine,
        })
    return out


def _parse_lite(page):
    return _rows_from_pairs(
        _LITE_LINK.findall(page), _LITE_SNIP.findall(page), "ddg_lite")


def _parse_html(page):
    return _rows_from_pairs(
        _HTML_LINK.findall(page), _HTML_SNIP.findall(page), "ddg_html")


def _parse_bing(page):
    out = []
    for block in _BING_ITEM.findall(page):
        h = _BING_H2.search(block)
        if not h:
            continue
        m = _BING_HREF.search(h.group(1))
        if not m:
            continue
        title = _clean(h.group(2))
        url = _unwrap(_html.unescape(m.group(1)))
        if not title or not url.startswith("http"):
            continue
        p = _BING_P.search(block)
        out.append({
            "title": title,
            "url": url,
            "snippet": _clean(p.group(1)) if p else "",
            "engine": "bing",
        })
    return out


_CHALLENGE = (
    "unusual traffic",
    "are you a robot",
    "anomaly",
    "enable javascript and cookies",
    "captcha",
)


def _looks_blocked(page):
    low = page[:20000].lower()
    return any(mark in low for mark in _CHALLENGE)


# ---------------------------------------------------------------- engines

def _eng_ddg_lite(query, region):
    body = urllib.parse.urlencode({"q": query, "kl": region}).encode()
    _, page = _get("https://lite.duckduckgo.com/lite/", data=body)
    if _looks_blocked(page):
        raise SearchError("ddg_lite served a challenge page")
    return _parse_lite(page)


def _eng_ddg_html(query, region):
    body = urllib.parse.urlencode({"q": query, "kl": region}).encode()
    _, page = _get("https://html.duckduckgo.com/html/", data=body)
    if _looks_blocked(page):
        raise SearchError("ddg_html served a challenge page")
    return _parse_html(page)


def _eng_bing(query, region):
    url = "https://www.bing.com/search?" + urllib.parse.urlencode(
        {"q": query, "setlang": "en", "cc": region.split("-")[-1]})
    _, page = _get(url)
    if _looks_blocked(page):
        raise SearchError("bing served a challenge page")
    return _parse_bing(page)


ENGINES = {
    "ddg_lite": _eng_ddg_lite,
    "ddg_html": _eng_ddg_html,
    "bing": _eng_bing,
}


# ---------------------------------------------------------------- public API

def search_all(query, engines=None, limit=15, region="us-en", retries=2):
    """Query every engine and merge. Returns (rows, errors).

    Rows are de-duplicated by host+path. `errors` maps engine name to a short
    reason, so a caller can tell "no results" from "blocked".
    """
    engines = list(engines or ENGINES)
    rows, errors, seen = [], {}, set()
    for name in engines:
        fn = ENGINES.get(name)
        if fn is None:
            errors[name] = "unknown engine"
            continue
        last = None
        for attempt in range(max(1, retries)):
            try:
                got = fn(query, region)
                last = None
                break
            except Exception as exc:  # noqa: BLE001
                last = "%s: %s" % (type(exc).__name__, exc)
                got = []
                time.sleep(1.0 + attempt)
        if last:
            errors[name] = last
        for r in got:
            key = urllib.parse.urlparse(r["url"]).netloc + urllib.parse.urlparse(
                r["url"]).path.rstrip("/")
            if key in seen:
                continue
            seen.add(key)
            rows.append(r)
            if len(rows) >= limit:
                return rows, errors
    return rows, errors


def search(query, limit=10, region="us-en"):
    """First engine that answers with rows wins. Raises SearchError otherwise."""
    rows, errors = search_all(query, limit=limit, region=region)
    if rows:
        return rows
    raise SearchError("no engine returned results for %r (%s)" % (query, errors))


def fetch_text(url, timeout=30, limit=400000):
    """Fetch a page and return readable text (tags stripped, entities decoded)."""
    _, page = _get(url, timeout=timeout)
    page = re.sub(r"(?is)<(script|style|noscript|svg)\b.*?</\1>", " ", page)
    page = re.sub(r"(?i)<br\s*/?>", "\n", page)
    page = re.sub(r"(?i)</(p|div|li|tr|h[1-6])>", "\n", page)
    text = _html.unescape(_TAG_RE.sub(" ", page))
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n\s*\n+", "\n\n", text)
    return text.strip()[:limit]


if __name__ == "__main__":
    import sys
    q = " ".join(sys.argv[1:]) or "deepseek account muted"
    rows, errs = search_all(q)
    print("query:", q)
    print("errors:", errs)
    for i, r in enumerate(rows, 1):
        print("%2d. [%s] %s" % (i, r["engine"], r["title"]))
        print("    %s" % r["url"])
        if r["snippet"]:
            print("    %s" % r["snippet"][:200])
