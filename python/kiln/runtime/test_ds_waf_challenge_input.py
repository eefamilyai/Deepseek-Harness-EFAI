"""Regression checks for a WAF challenge payload that is not JSON text.

`challenge.input` is base64, and what it carries is not stable: AWS WAF serves
the challenge metadata sometimes as a JSON document and sometimes as an
encrypted blob. `solve_waf` used to `json.loads(base64.b64decode(...))` it
unconditionally, so the encrypted form -- which is the common one -- raised

    'utf-8' codec can't decode byte 0xef in position 0

straight out of `json.loads`. That replaced "the challenge had an unexpected
shape" with a codec traceback, and it surfaced as a login blocked by the WAF
solver on a credential that was never the problem.

These checks fail on the old behaviour: every opaque-payload case below raised
`UnicodeDecodeError`.
"""

from __future__ import annotations

import base64
import importlib.util
import json
import sys
from pathlib import Path


def _load():
    """Import ds_waf.py directly; it is a script, not an installed module."""
    path = Path(__file__).with_name("ds_waf.py")
    spec = importlib.util.spec_from_file_location("ds_waf_under_test", path)
    module = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = module
    spec.loader.exec_module(module)
    return module


waf = _load()

FAILURES: list[str] = []


def check(label: str, condition: bool) -> None:
    if condition:
        print(f"PASS  {label}")
    else:
        print(f"FAIL  {label}")
        FAILURES.append(label)


# The encrypted payload AWS WAF serves in place of a JSON document, captured
# verbatim from /inputs. Byte 0 is 0xef -- the byte in the reported error.
OPAQUE = bytes.fromhex(
    "ef5dfbe5f6f5d38e7be3b79af3cf3b77bdb4ef67b8d9b738060a007a73933677"
    "c2120000b151ae7a6cdd9db12011277769457afd2c2a"
)
OPAQUE_B64 = base64.b64encode(OPAQUE).decode("ascii")


# -- decoding the payload -----------------------------------------------------

try:
    OPAQUE.decode("utf-8")
    check("the opaque blob is not valid UTF-8 text", False)
except UnicodeDecodeError:
    check("the opaque blob is not valid UTF-8 text", True)

check("an opaque payload decodes to None instead of raising",
      waf._decode_challenge_input(OPAQUE_B64) is None)

_doc = {"challenge_type": "ProofOfWork", "difficulty": 7, "memory": 256}
check("a JSON object payload decodes to that object",
      waf._decode_challenge_input(
          base64.b64encode(json.dumps(_doc).encode()).decode()) == _doc)

check("a JSON payload that is not an object decodes to None",
      waf._decode_challenge_input(base64.b64encode(b"[1, 2]").decode()) is None)

check("a payload that is not base64 decodes to None",
      waf._decode_challenge_input("not base64 !!") is None)

check("a missing payload decodes to None",
      waf._decode_challenge_input(None) is None)


# -- reading a response body that is not text ---------------------------------

class UndecodableBody:
    """A response whose body is bytes that are not UTF-8, like the WAF blob."""

    content = OPAQUE

    @property
    def text(self) -> str:
        raise UnicodeDecodeError("utf-8", OPAQUE, 0, 1, "invalid start byte")


class TextBody:
    text = "plain body"
    content = b"plain body"


_preview = waf._safe_text(UndecodableBody())
check("an undecodable body yields a hex preview, not a codec error",
      _preview.startswith("0x") and OPAQUE[:8].hex() in _preview)
check("a decodable body yields its text",
      waf._safe_text(TextBody()) == "plain body")


# -- the whole solve, driven through a scripted session -----------------------

class _Resp:
    def __init__(self, payload):
        self._payload = payload

    def json(self):
        return self._payload


class FakeSession:
    """Serves one /inputs document and one verify response, and records both."""

    def __init__(self, inputs, verify):
        self._inputs = inputs
        self._verify = verify
        self.gets: list[str] = []
        self.posts: list[tuple] = []

    def get(self, url, **kwargs):
        self.gets.append(url)
        return _Resp(self._inputs)

    def post(self, url, **kwargs):
        self.posts.append((url, kwargs))
        return _Resp(self._verify)


saved = (waf._discover_challenge, waf._solve_bandwidth, waf._solve_pow)
try:
    waf._discover_challenge = lambda session: ("https://waf.example/abc", True, None)
    waf._solve_bandwidth = lambda difficulty: "bandwidth-solution"
    waf._solve_pow = lambda *a, **k: "pow-solution"

    check("the opaque fallback type has an endpoint",
          waf._OPAQUE_TYPE in waf._ENDPOINT)

    # The regression: this raised UnicodeDecodeError before the fix.
    session = FakeSession(
        {"difficulty": 144000, "challenge": {"input": OPAQUE_B64}},
        {"token": "waf-token-opaque"},
    )
    token = waf.solve_waf(session)
    check("an opaque payload solves and returns the token",
          token == "waf-token-opaque")

    posted_url, posted = session.posts[0]
    check("the opaque payload posts to the fallback type's endpoint",
          posted_url.endswith("/" + waf._ENDPOINT[waf._OPAQUE_TYPE]))
    check("the opaque payload is answered as multipart form data",
          "multipart/form-data" in posted["headers"]["content-type"])
    check("the multipart body carries the solution and its metadata",
          "name=\"solution_data\"" in posted["data"]
          and "name=\"solution_metadata\"" in posted["data"])

    # The plain-text form must keep working unchanged.
    plain = base64.b64encode(json.dumps(
        {"challenge_type": "ProofOfWork", "difficulty": 144000, "memory": 128}
    ).encode()).decode("ascii")
    session = FakeSession(
        {"difficulty": 144000, "challenge": {"input": plain}},
        {"token": "waf-token-plain"},
    )
    check("a JSON payload still solves",
          waf.solve_waf(session) == "waf-token-plain")
    check("a JSON payload uses the type named inside it",
          session.posts[0][0].endswith(
              "/" + waf._ENDPOINT.get("ProofOfWork", "verify")))

    # A response with no challenge at all is still an error, not a crash.
    session = FakeSession({"difficulty": 1}, {"token": "unused"})
    try:
        waf.solve_waf(session)
        check("a response with no challenge raises WafError", False)
    except waf.WafError as e:
        check("a response with no challenge raises WafError",
              "missing challenge" in str(e))
finally:
    (waf._discover_challenge, waf._solve_bandwidth, waf._solve_pow) = saved


print()
if FAILURES:
    print(f"{len(FAILURES)} check(s) failed:")
    for f in FAILURES:
        print(f"  - {f}")
    sys.exit(1)
print("all WAF challenge-input checks passed")
