#!/usr/bin/env python3
"""What does chat.deepseek.com/sign_in actually expose to Playwright?

capture_identity must drive a real login for the SDK to mint a device_id.
That needs real selectors, so dump the inputs/buttons and any storage the
page writes on load.
"""
import json
from playwright.sync_api import sync_playwright

with sync_playwright() as pw:
    b = pw.chromium.launch(headless=True)
    ctx = b.new_context(viewport={"width": 1920, "height": 1080}, locale="en-US")
    page = ctx.new_page()

    reqs = []
    page.on("request", lambda r: reqs.append(r.url))
    page.goto("https://chat.deepseek.com/sign_in",
              wait_until="domcontentloaded", timeout=45000)
    page.wait_for_timeout(8000)

    print("title:", page.title())
    print("url:", page.url)
    print()
    print("--- inputs ---")
    print(json.dumps(page.evaluate(
        "() => [...document.querySelectorAll('input')].map(e => ({"
        "  type: e.type, name: e.name, id: e.id,"
        "  placeholder: e.placeholder, aria: e.getAttribute('aria-label'),"
        "  cls: (e.className||'').slice(0,60)}))"), indent=2))
    print()
    print("--- buttons / [role=button] ---")
    print(json.dumps(page.evaluate(
        "() => [...document.querySelectorAll('button,[role=button],a[href]')]"
        ".slice(0,30).map(e => ({tag: e.tagName, text: (e.innerText||'').trim().slice(0,40),"
        "  cls: (e.className||'').slice(0,50), href: e.getAttribute('href')}))"), indent=2))
    print()
    print("--- localStorage keys on load ---")
    print(json.dumps(page.evaluate(
        "() => { const o={}; for (let i=0;i<localStorage.length;i++){const k=localStorage.key(i);"
        "  o[k]=(localStorage.getItem(k)||'').slice(0,60);} return o; }"), indent=2))
    print()
    print("--- cookies ---")
    print(json.dumps([{ "name": c["name"], "len": len(c["value"]) } for c in ctx.cookies()], indent=2))
    print()
    print("--- requests mentioning login/device/smid ---")
    for u in reqs:
        if any(s in u.lower() for s in ("login", "device", "smid", "hif", "settings")):
            print("  ", u[:140])

    b.close()
