"""Regression checks for the proof-of-work request when AWS WAF intercepts it.

`_pow` read only the response body. AWS WAF answers `/chat/create_pow_challenge`
with HTTP 202, an `x-amzn-waf-action` header, and a challenge page instead of
JSON — so the body had no `challenge` field and the code blamed the credential.
That surfaced to the user as "DeepSeek auth failed during upload" on a perfectly
valid token, and it hit every completion turn for the same reason.

These checks fail on the old behaviour: the WAF case asserted below raised
`_AuthExpired`, which is exactly the lie being fixed.
"""

from __future__ import annotations

import importlib.util
import sys
from pathlib import Path


def _load():
    """Import ds_direct.py directly; it is a script, not an installed module."""
    path = Path(__file__).with_name("ds_direct.py")
    spec = importlib.util.spec_from_file_location("ds_direct_pow_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


ds = _load()

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    if condition:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}")
        FAILURES.append(label)


class FakeResponse:
    def __init__(self, status_code, headers=None, body=None, text=""):
        self.status_code = status_code
        self.headers = headers or {}
        self._body = body
        self.text = text

    def json(self):
        if self._body is None:
            raise ValueError("not json")
        return self._body


class FakeSession:
    """Records posts and replays a scripted response per call."""

    def __init__(self, responses):
        self._responses = list(responses)
        self.calls = 0
        self.cookies = FakeCookies()

    def post(self, *args, **kwargs):
        self.calls += 1
        if not self._responses:
            raise AssertionError("more posts than scripted responses")
        return self._responses.pop(0)


class FakeCookies:
    def __init__(self):
        self.set_values = {}

    def set(self, name, value, **kwargs):
        self.set_values[name] = value

    def get_dict(self):
        # `_persist_cookies` reads the jar through this. A fake without it makes
        # `cookie_string()` return "" and silently skips the save, which would
        # hide whether the refreshed token actually reached the account.
        return dict(self.set_values)


class FakeAccount:
    headers = {}

    def __init__(self):
        self._last_saved_cookie = None
        self.saved = []

    def save(self, **kwargs):
        self.saved.append(kwargs)


def client_with(responses, account=None):
    """A `_Client` with a scripted session, built without touching cURL."""
    client = object.__new__(ds._Client)
    client.sess = FakeSession(responses)
    client.account = account
    client.token = "test-token"
    client.last_login_error = None
    client.creds_mtime = 0.0
    # Shadow the method so the fake session needs no account plumbing.
    client._extra_headers = lambda: {}
    return client


WAF = dict(status_code=202, headers={"x-amzn-waf-action": "challenge"},
           body=None, text="<html>challenge</html>")


# ── the detector itself ──────────────────────────────────────────────────────

check("a 202 with the WAF action header is an interception",
      ds._waf_intercepted(FakeResponse(**WAF)))
check("a 200 is never an interception",
      not ds._waf_intercepted(FakeResponse(200, body={"data": {}})))
check("a 202 without the header is not an interception",
      not ds._waf_intercepted(FakeResponse(202, body={"data": {}})))
check("a 401 is not an interception",
      not ds._waf_intercepted(FakeResponse(401, text="unauthorized")))


# ── WAF is not an auth failure ───────────────────────────────────────────────

saved_waf = ds.ds_waf
try:
    ds.ds_waf = None                      # cannot solve — must still not blame auth
    client = client_with([FakeResponse(**WAF)])
    try:
        client._pow("/api/v0/file/upload_file")
        check("a WAF interception raises rather than returning", False)
    except ds._AuthExpired as e:
        check("a WAF interception is NOT reported as an auth failure", False)
        print(f"      (it raised _AuthExpired: {e})")
    except RuntimeError as e:
        check("a WAF interception is NOT reported as an auth failure",
              not isinstance(e, ds._AuthExpired))
        check("the WAF failure names the real cause and status",
              "no challenge" in str(e) and "202" in str(e))

    # ── and it is solved and retried when the solver is available ────────────

    class FakeWaf:
        def __init__(self):
            self.solved = 0

        def solve_waf(self, session):
            self.solved += 1
            return "solved-waf-token"

    fake_waf = FakeWaf()
    ds.ds_waf = fake_waf
    account = FakeAccount()
    client = client_with(
        [FakeResponse(**WAF),
         FakeResponse(200, body={"data": {"biz_data": {"challenge": {"salt": "s"}}}})],
        account=account,
    )
    challenge = client._pow("/api/v0/file/upload_file")

    check("a WAF interception is solved and the request retried",
          challenge == {"salt": "s"} and fake_waf.solved == 1)
    check("the retry carried the freshly solved token",
          client.sess.cookies.set_values.get("aws-waf-token") == "solved-waf-token")
    check("the new token was persisted to the account",
          any("cookie" in kw for kw in account.saved))
    check("exactly one retry was needed", client.sess.calls == 2)

    # ── a real refusal is still an auth failure ──────────────────────────────

    ds.ds_waf = None
    client = client_with([FakeResponse(401, text="unauthorized")])
    try:
        client._pow()
        check("a 401 still raises _AuthExpired", False)
    except ds._AuthExpired:
        check("a 401 still raises _AuthExpired", True)

    # ── an unrecognized 200 is transient, not auth ───────────────────────────

    client = client_with([FakeResponse(200, body={"data": {}})])
    try:
        client._pow()
        check("an unrecognized 200 raises RuntimeError", False)
    except ds._AuthExpired:
        check("an unrecognized 200 is not mistaken for an auth failure", False)
    except RuntimeError as e:
        check("an unrecognized 200 is not mistaken for an auth failure",
              not isinstance(e, ds._AuthExpired) and "no challenge" in str(e))

    # ── a server error is transient, not auth ────────────────────────────────

    client = client_with([FakeResponse(502, text="bad gateway")])
    try:
        client._pow()
        check("a 502 raises RuntimeError, not auth", False)
    except RuntimeError as e:
        check("a 502 raises RuntimeError, not auth",
              not isinstance(e, ds._AuthExpired))
finally:
    ds.ds_waf = saved_waf


print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) failed:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all proof-of-work WAF checks passed")
