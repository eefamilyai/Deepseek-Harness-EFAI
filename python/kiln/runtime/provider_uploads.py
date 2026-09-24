"""Per-provider file uploads, so an oversized tool result can be delivered as a file.

Every provider that can store a file exposes it under the SAME base URL the chat
call already uses, which is the same assumption the model catalogue already makes
when it asks `{base}/models`. That is the whole shape of this module:

    openai     POST {base}/files                      -> {"id": "file-…"}
    anthropic  POST {base}/v1/files                    -> {"id": "file_…"}
    gemini     POST {base}/upload/v1beta/files         -> {"file": {"uri": …}}
    deepseek   (ds_direct owns its own PoW-gated upload; not handled here)

A provider that has no such endpoint, whose endpoint 404s, or whose reply is not
the shape we expect returns `None`. `None` is not an error — it selects the text
fallback in `tool_result_files`, which is exactly what every provider did before
this existed. An upload must never be able to fail a turn.

## Credentials

Keys are passed in by the caller, which reads them from `os.environ` at request
time. Nothing here stores, logs, or returns a key — the same rule the provider
registry states. `_dbg` deliberately prints only status codes and file sizes.

`python/kiln/runtime/` is Tier 1 (fork-owned) per HARNESS-EDITS.md, so this file
carries no overlay/patch obligation.
"""

from __future__ import annotations

import json
import os
import mimetypes
import re
from typing import Optional

__all__ = [
    "SCHEMA_ENDPOINTS",
    "endpoint_candidates",
    "endpoint_for",
    "multipart_body",
    "parse_file_id",
    "upload_text",
    "deliver_tool_results",
    "file_reference",
]

#: Candidate upload paths appended to a provider's configured base URL, tried in
#: order until one answers with a usable file id. The base URL's shape differs
#: per schema (openai presets already include `/v1`, anthropic's is the root), so
#: these are written to produce a correct absolute path in each case.
#:
#: `/files/upload` rides alongside `/files` because OpenAI-compatible gateways
#: commonly expose the upload action as a verb under the collection rather than
#: as a POST to the collection itself. Trying both costs one wasted request only
#: on a provider that rejects the first, and that provider has no working upload
#: either way.
SCHEMA_ENDPOINTS = {
    "openai": ("/files", "/files/upload"),
    "anthropic": ("/v1/files",),
}

#: Purpose field OpenAI requires on an upload; harmless elsewhere because only
#: the openai branch sends it.
_OPENAI_PURPOSE = "assistants"

#: Anthropic requires a dated API version header on every request.
_ANTHROPIC_VERSION = "2023-06-01"

#: A Gemini API version segment: `v` plus digits plus an optional stability
#: suffix — `v1`, `v2`, `v1beta`, `v1alpha`. Matched (not `isdigit`-ed) so the
#: suffix forms are recognised instead of silently doubling the version in the
#: upload path.
_GEMINI_VERSION = re.compile(r"^v\d+[a-z]*$")

#: Uploads are bounded: a tool result is text, and a provider that cannot take
#: it in this long is not a provider we should be streaming 50 MB at.
_MAX_UPLOAD_BYTES = 24 * 1024 * 1024

_UPLOAD_TIMEOUT = 90


def _dbg(fmt: str, *args: object) -> None:
    """Debug-log through the runtime's config module when it is importable.

    Imported lazily and guarded: this module is also exercised by tests and by
    tooling that has no `config` module on its path, and a logging failure must
    never be the reason an upload path breaks.
    """
    try:
        from config import dbg  # type: ignore
        dbg(fmt, *args)
    except Exception:
        pass


def endpoint_for(schema: str, base_url: str) -> Optional[str]:
    """The first upload URL to try for one provider schema, or None.

    Convenience wrapper over `endpoint_candidates` for callers that only want
    the primary endpoint (tests, diagnostics). `upload_text` walks the whole
    candidate list.

    @param schema - provider schema id (`openai`, `anthropic`, `gemini`, …).
    @param base_url - the provider's configured base URL.
    @returns the primary upload URL, or None when this schema has none.
    """
    urls = endpoint_candidates(schema, base_url)
    return urls[0] if urls else None


def endpoint_candidates(schema: str, base_url: str) -> list:
    """Every upload URL worth trying for one provider schema, best first.

    Each provider hangs its uploads off a different point on the same base URL:

    - openai presets already include `/v1`, so the path appends directly. Two
      spellings are returned because OpenAI-compatible gateways disagree about
      whether the upload is a POST to the collection (`/files`) or a verb under
      it (`/files/upload`);
    - anthropic's base is the host root, so the path carries its own `/v1`;
    - gemini's base already ends in an API version (`/v1beta`), but its Files
      API lives under the HOST ROOT at `/upload/{version}/files`, not beneath
      the generateContent base — appending the whole path would produce a
      doubled `/v1beta`. The version is therefore recovered from the base and
      re-attached under `upload/`.

    @param schema - provider schema id (`openai`, `anthropic`, `gemini`, …).
    @param base_url - the provider's configured base URL.
    @returns a list of absolute URLs; empty when this schema has no upload path.
    """
    if not base_url:
        return []
    schema = (schema or "").lower()
    base = base_url.rstrip("/")

    if schema == "gemini":
        # Recover the API version from the base (falling back to the documented
        # default) and mount the Files API under the host root. The version is a
        # `v` followed by digits and an optional stability suffix — `v1`,
        # `v1beta`, `v1alpha`, `v2` — so a plain isdigit() on the tail would
        # reject `v1beta` and silently double the version in the path.
        root, _, last = base.rpartition("/")
        if _GEMINI_VERSION.match(last):
            version = last
        else:
            root, version = base, "v1beta"
        return [f"{root}/upload/{version}/files"]

    paths = SCHEMA_ENDPOINTS.get(schema)
    if not paths:
        return []
    return [base + p for p in paths]


def multipart_body(
    filename: str, data: bytes, *, fields: Optional[dict] = None,
    content_type: str = "text/plain",
) -> tuple[bytes, str]:
    """Encode one file as a `multipart/form-data` body.

    Hand-rolled rather than pulled from `requests`, because the same body has to
    be sendable through whichever client a provider adapter already uses (the
    DeepSeek path uses curl_cffi, which rejects the requests-style `files=`
    kwarg). One encoder keeps every provider's wire format identical.

    @param filename - the name the provider will show for the file.
    @param data - exact bytes to upload.
    @param fields - extra non-file form fields.
    @param content_type - declared type of the file part.
    @returns `(body, content_type_header)`.
    """
    # A boundary that cannot occur in the payload: the digest-free random suffix
    # plus a fixed prefix is plenty for text, and we verify below.
    boundary = "----dshformboundary" + os.urandom(16).hex()
    assert boundary.encode() not in data, "boundary collided with payload"

    out = bytearray()
    for name, value in (fields or {}).items():
        out += f"--{boundary}\r\n".encode()
        out += f'Content-Disposition: form-data; name="{name}"\r\n\r\n'.encode()
        out += f"{value}\r\n".encode()

    out += f"--{boundary}\r\n".encode()
    out += (
        f'Content-Disposition: form-data; name="file"; filename="{filename}"\r\n'
    ).encode()
    out += f"Content-Type: {content_type}\r\n\r\n".encode()
    out += data
    out += b"\r\n"
    out += f"--{boundary}--\r\n".encode()

    return bytes(out), f"multipart/form-data; boundary={boundary}"


def parse_file_id(schema: str, payload: object) -> Optional[str]:
    """Pull the provider's file id out of an upload reply.

    Kept separate from the request so it can be unit-tested against each
    provider's real response shape without a network call. Returns None when the
    reply is error-shaped or simply not what we expect — the caller then falls
    back to text.

    @param schema - provider schema id, which selects the reply shape.
    @param payload - the decoded JSON reply.
    @returns the file id, or None.
    """
    if not isinstance(payload, dict):
        return None
    # Any provider may answer with an error object and HTTP 200.
    if payload.get("error"):
        return None

    if schema == "gemini":
        # Gemini nests the upload under "file" and identifies it by uri/name.
        file_obj = payload.get("file")
        if isinstance(file_obj, dict):
            for key in ("name", "uri"):
                value = file_obj.get(key)
                if isinstance(value, str) and value:
                    return value
        return None

    file_id = payload.get("id")
    if isinstance(file_id, str) and file_id:
        return file_id
    return None


def _attempt(schema: str, url: str, api_key: str, filename: str,
             data: bytes) -> Optional[str]:
    """POST one multipart upload to `url`; return a file id or None.

    Never raises. A transport error, a non-2xx status, a non-JSON reply, or a
    reply without a usable id all return None, which lets `upload_text` try the
    next candidate endpoint or fall back to text.
    """
    headers = {"accept": "application/json"}
    fields: dict = {}

    if schema == "openai":
        if api_key:
            headers["authorization"] = "Bearer " + api_key
        fields["purpose"] = _OPENAI_PURPOSE
    elif schema == "anthropic":
        if api_key:
            headers["x-api-key"] = api_key
        headers["anthropic-version"] = _ANTHROPIC_VERSION
    elif schema == "gemini":
        # Gemini takes the key as a query parameter, not a header.
        if api_key:
            url = f"{url}?key={api_key}"
    else:
        return None

    body, content_type = multipart_body(filename, data, fields=fields)
    headers["content-type"] = content_type

    try:
        import requests  # declared in requirements.txt
        resp = requests.post(url, headers=headers, data=body, timeout=_UPLOAD_TIMEOUT)
    except Exception as e:
        # A dead endpoint must degrade to text, not fail the turn.
        _dbg("provider_uploads: %s POST failed: %s", schema, type(e).__name__)
        return None

    if resp.status_code >= 300:
        # Status only - never the body, which can echo request headers back.
        _dbg("provider_uploads: %s POST %s -> HTTP %s", schema, url, resp.status_code)
        return None

    try:
        payload = resp.json()
    except (ValueError, json.JSONDecodeError):
        _dbg("provider_uploads: %s reply was not JSON", schema)
        return None

    return parse_file_id(schema, payload)


def upload_text(
    schema: str,
    base_url: str,
    api_key: str,
    filename: str,
    data: bytes,
) -> Optional[str]:
    """Upload one text artifact and return the provider's file id.

    Walks the candidate endpoints for this schema in order and returns the first
    usable file id. Never raises: a provider without an endpoint, an unreachable
    host, a rejected upload, an oversized body, or a malformed reply all return
    None so the caller keeps the inline text and the turn proceeds.

    Providers inside one schema disagree about the upload path (an OpenAI-style
    gateway may take a POST to `/files` or to `/files/upload`), so a 404 from the
    first candidate is expected and simply moves on to the next.

    @param schema - provider schema id.
    @param base_url - provider base URL.
    @param api_key - credential, or '' for keyless local runtimes.
    @param filename - name for the uploaded file.
    @param data - exact bytes.
    @returns the file id, or None.
    """
    if not data or len(data) > _MAX_UPLOAD_BYTES:
        _dbg("provider_uploads: skipped (%s bytes) for %s", len(data), schema)
        return None

    for url in endpoint_candidates(schema, base_url):
        file_id = _attempt(schema, url, api_key, filename, data)
        if file_id:
            _dbg("provider_uploads: %s upload ok via %s", schema, url)
            return file_id

    _dbg("provider_uploads: %s upload found no usable endpoint", schema)
    return None


def file_reference(schema, file_id, filename):
    """The provider-native content part that references one uploaded file.

    A file id the prompt never references is a file the model cannot open, so
    the upload and the reference are one step: this is what makes the delivery
    real rather than a stub naming an unreachable object. Returns None for a
    schema whose reference shape is unknown, which keeps the stub (with its
    local path) as the fallback.
    """
    if not file_id:
        return None
    if schema == "openai":
        return {"type": "file", "file": {"file_id": file_id}}
    if schema == "anthropic":
        return {"type": "document",
                "source": {"type": "file", "file_id": file_id},
                "title": filename}
    if schema == "gemini":
        return {"file_data": {"file_uri": file_id,
                              "mime_type": mimetypes.guess_type(filename)[0]
                                           or "text/plain"}}
    return None


def deliver_tool_results(
    messages,
    schema: str,
    base_url: str,
    api_key: str,
    *,
    max_inline_chars: int = None,
):
    """Spill oversized tool results to files, uploading them when possible.

    The one call every provider adapter makes, so the delivery policy lives in a
    single place: every tool result is written to disk and offered to this
    provider's upload endpoint; whatever the upload answers, the model-facing
    copy becomes a short stub naming the file. When the upload returned an id,
    the stub carries no body text and the message gains this provider's native
    file-reference part, so the model reads the attachment rather than paying
    for the payload twice; a result that did not upload keeps the head of its
    body, because the local path is then all the model has to go on. There is
    no size floor, so this runs for every tool result and a turn that produced
    one pays a single upload for it.

    Never raises. A failure anywhere here must not cost the turn.

    @param messages - the rendered body messages about to be sent.
    @param schema - this provider's schema id, which selects the upload path.
    @param base_url - the provider's base URL.
    @param api_key - credential, or '' for keyless local runtimes.
    @param max_inline_chars - override the spill threshold.
    @returns the message list to actually send.
    """
    try:
        import tool_result_files as trf
        kwargs = {}
        if max_inline_chars is not None:
            kwargs["max_inline_chars"] = max_inline_chars
        out, spilled = trf.process_messages(
            messages,
            uploader=lambda name, data: upload_text(schema, base_url, api_key, name, data),
            directory=trf.default_spill_dir(),
            label_of=lambda m: str(m.get("name") or m.get("tool") or "tool_result"),
            **kwargs,
        )
    except Exception:
        return messages
    if not spilled:
        return messages
    return [_with_reference(m, schema) for m in out]


def _with_reference(msg, schema):
    """Attach this provider's file part to a spilled message, dropping the tag.

    The content becomes a list of parts because every one of these schemas takes
    a file reference as a sibling of text, never as the text itself. A schema
    with no known reference shape keeps its plain stub.
    """
    try:
        import tool_result_files as trf
        key = trf._SPILLED_KEY
    except Exception:
        return msg
    record = msg.get(key)
    if record is None:
        return msg
    out = {k: v for k, v in msg.items() if k != key}
    part = file_reference(schema, getattr(record, "file_id", None),
                          getattr(record, "filename", "tool_result.txt"))
    if part is None:
        return out
    text = out.get("content", "")
    if isinstance(text, str) and text:
        out["content"] = [{"type": "text", "text": text}, part]
    else:
        out["content"] = [part]
    return out
