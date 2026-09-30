# A config entry marked `disabled` must stay out of every automatic account pick.
#
# Why this exists. `_next_account_id` round-robins over EVERY account in
# `_accounts`, so without an opt-out a brand-new conversation can land on an
# account the operator named off-limits. The flag has to be a HARD exclusion from
# the pool, while the account keeps its credentials and stays in the config.
#
# The distinction that matters: `disabled` keeps an account out of AUTOMATIC picks
# (the round-robin, the failover ring). It does not delete it and does not blank
# its token, so an operator can re-enable it by editing one field.
#
# Run:  .venv\Scripts\python.exe test_ds_direct_account_exclusion.py
import json
import os
import sys
import tempfile

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds  # noqa: E402

CHECKS = []


def check(name, cond, detail=""):
    ok = bool(cond)
    CHECKS.append((name, ok))
    line = "  %-4s %s" % ("PASS" if ok else "FAIL", name)
    if detail and not ok:
        line += "  -- " + detail
    print(line)


def build(tmp, accounts, top=None):
    """Point the module at one temp config and rebuild, returning the pool."""
    doc = {"accounts": accounts}
    doc.update(top or {})
    path = os.path.join(tmp, "ds_config.json")
    with open(path, "w", encoding="utf-8") as f:
        json.dump(doc, f)
    orig = ds._config_paths
    ds._config_paths = lambda: [path]
    try:
        return [a.id for a in ds._read_accounts_from_disk()], path
    finally:
        ds._config_paths = orig


def main():
    with tempfile.TemporaryDirectory() as tmp:
        print("=== a disabled entry is excluded from the pool ===")
        ids, _ = build(tmp, [
            {"id": "keep@x", "token": "t" * 40},
            {"id": "off@x", "token": "u" * 40, "disabled": True},
        ])
        check("the enabled account is pooled", "keep@x" in ids, repr(ids))
        check("the disabled account is NOT pooled", "off@x" not in ids, repr(ids))
        check("exactly one account remains", len(ids) == 1, repr(ids))

        print()
        print("=== the document-level flag applies to its entries ===")
        ids2, _ = build(
            tmp,
            [{"id": "a@x", "token": "t" * 40}, {"id": "b@x", "token": "u" * 40}],
            top={"disabled": True})
        check("a top-level disabled drops every entry", ids2 == [], repr(ids2))

        print()
        print("=== a per-account flag WINS over an enabled document ===")
        ids3, _ = build(
            tmp,
            [{"id": "on@x", "token": "t" * 40, "disabled": False},
             {"id": "off@x", "token": "u" * 40, "disabled": True}],
            top={"disabled": False})
        check("the opted-out entry is still excluded",
              "off@x" not in ids3, repr(ids3))
        check("the explicitly-enabled entry is pooled",
              "on@x" in ids3, repr(ids3))

        print()
        print("=== absence of the flag means ENABLED (back-compat) ===")
        ids4, _ = build(tmp, [
            {"id": "plain@x", "token": "t" * 40},
        ])
        check("a config with no flag at all still pools its account",
              ids4 == ["plain@x"], repr(ids4))

        print()
        print("=== falsy flag shapes do not disable ===")
        for val in (False, 0, "", None):
            ids5, _ = build(tmp, [{"id": "p@x", "token": "t" * 40, "disabled": val}])
            check("disabled=%r keeps the account pooled" % (val,),
                  "p@x" in ids5, repr(ids5))

        print()
        print("=== truthy flag shapes DO disable ===")
        for val in (True, 1, "yes", "true"):
            ids6, _ = build(tmp, [{"id": "q@x", "token": "t" * 40, "disabled": val}])
            check("disabled=%r excludes the account" % (val,),
                  "q@x" not in ids6, repr(ids6))

        print()
        print("=== the credentials survive exclusion ===")
        ids7, path7 = build(tmp, [
            {"id": "kept@x", "token": "T" * 40, "cookie": "c=1", "disabled": True},
        ])
        raw = json.load(open(path7, encoding="utf-8"))
        entry = raw["accounts"][0]
        check("the token is still in the config", entry.get("token") == "T" * 40)
        check("the cookie is still in the config", entry.get("cookie") == "c=1")
        check("the disabled marker is recorded", entry.get("disabled") is True)

    print()
    print("=== _Account carries and propagates the flag ===")
    a = ds._Account("x@y", token="t", disabled=True)
    check("__init__ records disabled=True", a.disabled is True, repr(a.disabled))
    b = ds._Account("x@y", token="t")
    check("__init__ defaults to disabled=False", b.disabled is False,
          repr(b.disabled))
    # `update_from` is how a live pooled object adopts a re-read config; if it did
    # not carry the flag, marking an account disabled would not take effect until
    # a restart.
    c = ds._Account("x@y", token="t")
    c.update_from(ds._Account("x@y", token="t", disabled=True))
    check("update_from propagates disabled=True", c.disabled is True,
          repr(c.disabled))
    d = ds._Account("x@y", token="t", disabled=True)
    d.update_from(ds._Account("x@y", token="t"))
    check("update_from propagates disabled=False (re-enable)", d.disabled is False,
          repr(d.disabled))

    print()
    failed = [n for n, ok in CHECKS if not ok]
    print("%d check(s), %d failed" % (len(CHECKS), len(failed)))
    for n in failed:
        print("  FAILED: %s" % n)
    if not failed:
        print("ALL GREEN")
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
