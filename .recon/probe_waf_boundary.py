#!/usr/bin/env python3
"""Why can curl_cffi reach chat.deepseek.com but Playwright chromium cannot?

ds_direct's login does `sess.get("https://chat.deepseek.com/")` with
curl_cffi impersonate and proceeds to solve a WAF challenge. The Playwright
capture path gets the CloudFront error page instead. This isolates whether
the block is the TLS fingerprint, the header set, or headless detection.
"""
import json

URL = "https://chat.deepseek.com/sign_in"

def classify(text):
    t = (text or "").lower()
    if "could not be satisfied" in t or "cloudfront" in t:
        return "WAF/CloudFront BLOCK"
    if "<html" in t or "<!doctype" in t:
        return "real HTML page"
    return "other"

# 1. curl_cffi with the connector's own identity
try:
    from curl_cffi import requests as cffi
    import ds_identity
    r = cffi.get(URL, impersonate=ds_identity.IMPERSONATE, timeout=30,
                 headers={"user-agent": ds_identity.UA})
    print("curl_cffi  : HTTP %s  ->  %s  (%d bytes)"
          % (r.status_code, classify(r.text), len(r.text or "")))
except Exception as e:
    print("curl_cffi  : FAILED %s: %s" % (type(e).__name__, e))

# 2. Playwright chromium, headless, default context
try:
    from playwright.sync_api import sync_playwright
    with sync_playwright() as pw:
        b = pw.chromium.launch(headless=True)
        p = b.new_page()
        resp = p.goto(URL, wait_until="domcontentloaded", timeout=45000)
        body = p.content()
        print("pw headless: HTTP %s  ->  %s  (%d bytes)"
              % (resp.status if resp else "?", classify(body), len(body)))
        print("            title:", p.title()[:80])
        b.close()
except Exception as e:
    print("pw headless: FAILED %s: %s" % (type(e).__name__, e))

# 3. Playwright with a real-looking UA + automation flag suppressed
try:
    from playwright.sync_api import sync_playwright
    import ds_identity
    with sync_playwright() as pw:
        b = pw.chromium.launch(
            headless=True,
            args=["--disable-blink-features=AutomationControlled"])
        ctx = b.new_context(user_agent=ds_identity.UA, locale="en-US")
        p = ctx.new_page()
        resp = p.goto(URL, wait_until="domcontentloaded", timeout=45000)
        body = p.content()
        print("pw +UA     : HTTP %s  ->  %s  (%d bytes)"
              % (resp.status if resp else "?", classify(body), len(body)))
        b.close()
except Exception as e:
    print("pw +UA     : FAILED %s: %s" % (type(e).__name__, e))
