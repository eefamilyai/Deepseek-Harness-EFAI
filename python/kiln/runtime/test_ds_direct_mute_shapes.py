#!/usr/bin/env python
"""Regression tests for the SHAPES a mute verdict has been observed to arrive in.

Run:  python test_ds_direct_mute_shapes.py

A mute is the one refusal that must never be missed: its remedy (switch account,
or wait) is different from every neighbour's, and mistaking it for a transient
error means retrying an account DeepSeek has already refused to serve. So the
reader is pinned against every shape seen in the wild, not only the one the first
sample happened to carry.

Observed live, both on the upload route:

    {"code":0,"msg":"","data":{"biz_code":5, "biz_msg":"user is muted",
     "biz_data":{"is_muted":1,"mute_until":1790932407.459}}}

    {"code":0,"msg":"","data":{"biz_code":14,"biz_msg":"user is muted",
     "biz_data":{"is_muted":1,"mute_until":1790972380.757}}}

The code DIFFERS between them. A reader keyed on the code alone would have
missed the second and reported a mute as an unrecognised refusal -- which is why
the verdict is now recognised three independent ways: the code, the wording, and
the account's own `biz_data`.

Pinned here, in order:
  * both observed codes are recognised, and the expiry is reported as a time;
  * the STRUCTURAL signal alone suffices -- `is_muted`/`mute_until` with no
    usable code and an empty `biz_msg` still classifies as a mute;
  * the reader stays strict: model prose, a bare string, a null `data`, and a
    successful upload are all NOT mutes;
  * `is_muted: 0` is not a mute, and a `bool` is not mistaken for the integer 1.

No network and no credentials.
"""
import os
import sys

sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
import ds_direct as ds

FAILS = []


def check(name, cond, detail=""):
    if cond:
        print("PASS  %s" % name)
    else:
        print("FAIL  %s%s" % (name, ("  -- " + detail) if detail else ""))
        FAILS.append(name)


def envelope(biz_code, biz_msg, biz_data):
    import json as _json
    return [_json.dumps({"code": 0, "msg": "",
                         "data": {"biz_code": biz_code, "biz_msg": biz_msg,
                                  "biz_data": biz_data}})]


MUTE_BODY_5 = {"is_muted": 1, "mute_until": 1790932407.459}
MUTE_BODY_14 = {"is_muted": 1, "mute_until": 1790972380.757}

# ─── 1. both observed codes classify, and carry the expiry ───────────────────

v5 = ds._mute_verdict_in(envelope(5, "user is muted", MUTE_BODY_5))
check("biz_code 5 is a mute", bool(v5), "got %r" % (v5,))
check("biz_code 5 reports WHEN the mute lifts", v5 and "2026-10-02" in v5,
      "got %r" % (v5,))

v14 = ds._mute_verdict_in(envelope(14, "user is muted", MUTE_BODY_14))
check("biz_code 14 is a mute (the code is NOT stable)", bool(v14),
      "got %r" % (v14,))
check("biz_code 14 reports WHEN the mute lifts", v14 and "2026-10-02" in v14,
      "got %r" % (v14,))

# ─── 2. the structural signal ALONE is enough ────────────────────────────────

struct = ds._mute_verdict_in(envelope(999, "", MUTE_BODY_14))
check("an unknown code with is_muted/mute_until still classifies", bool(struct),
      "got %r" % (struct,))
check("...and it names the message it could not read",
      struct and "muted" in struct.lower(), "got %r" % (struct,))

# ─── 3. the reader stays strict ──────────────────────────────────────────────

ok_upload = envelope(0, "", {"id": "file-abc", "status": "SUCCESS"})
check("a successful upload is NOT a mute",
      ds._mute_verdict_in(ok_upload) is None)

prose = ["data: {\"code\":0,\"msg\":\"\",\"data\":{\"biz_code\":0,\"biz_data\":null}}",
         "data: the account is muted according to some text in the answer",
         "data: [DONE]"]
check("model prose mentioning a mute is NOT a mute",
      ds._mute_verdict_in(prose) is None)

check("a bare JSON string is not a mute", ds._mute_verdict_in(['"muted"']) is None)
check("a null data is not a mute",
      ds._mute_verdict_in(['{"code":0,"msg":"","data":null}']) is None)
check("an empty sink is not a mute", ds._mute_verdict_in([]) is None)
check("garbage is not a mute", ds._mute_verdict_in(["not json at all"]) is None)

# ─── 4. flag semantics ───────────────────────────────────────────────────────

check("is_muted: 0 is NOT a mute",
      ds._mute_verdict_in(envelope(0, "", {"is_muted": 0, "mute_until": 0})) is None)
check("is_muted: False is NOT a mute",
      ds._mute_verdict_in(envelope(0, "", {"is_muted": False})) is None)
check("is_muted: True IS a mute",
      bool(ds._mute_verdict_in(envelope(0, "", {"is_muted": True}))))
check("a future mute_until alone IS a mute",
      bool(ds._mute_verdict_in(envelope(0, "", {"mute_until": 1790972380.757}))))
check("a zero mute_until alone is NOT a mute",
      ds._mute_verdict_in(envelope(0, "", {"mute_until": 0})) is None)
check("no biz_data but the code 5 is still a mute",
      bool(ds._mute_verdict_in(envelope(5, "", None))))

# ─── 5. the structural helper itself ─────────────────────────────────────────

check("_is_muted_payload accepts the observed body",
      ds._is_muted_payload(MUTE_BODY_5) is True)
check("_is_muted_payload rejects a non-dict",
      ds._is_muted_payload(None) is False and ds._is_muted_payload("x") is False)
check("_is_muted_payload does not treat bool as int",
      ds._is_muted_payload({"is_muted": True}) is True
      and ds._is_muted_payload({"is_muted": False}) is False)

print()
if FAILS:
    print("FAILED (%d): %s" % (len(FAILS), ", ".join(FAILS)))
    sys.exit(1)
print("all mute-shape checks passed")
