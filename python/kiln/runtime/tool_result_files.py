"""Deliver oversized tool results as files instead of inline prompt text.

A tool result is the single largest thing in most prompts: one `read`, `grep`,
or `bash` call can return far more text than everything else combined. When the
prompt budget cannot hold it, the runtime clips it — and the model silently
loses the middle of a result it asked for.

This module replaces that loss with a delivery: the full text is written to a
file under the session's spill directory and, when the active provider exposes
a file-upload endpoint, uploaded so the model can still reach it. The in-prompt
copy becomes a short stub that names the file.

An UPLOADED result carries no body text in the prompt at all. The provider holds
the file and the message carries a native file-reference part beside the stub, so
quoting the result would send the payload twice — once as the file the model can
read in full, once as prompt tokens it pays for. The stub names the file and
stops. Only a result that could NOT be uploaded keeps a short head of its body,
because there the local path is all the model has to go on.

## Provider-agnostic by construction

Nothing here knows about DeepSeek, OpenAI, Anthropic, or Gemini. A provider
participates by passing an `uploader`:

    uploader(filename, data) -> str | None

It returns the provider's file id on success, or `None` when the provider has no
upload endpoint, the upload failed, or the file was rejected. `None` is not an
error: it selects the text fallback, which is the behaviour every provider had
before this module existed. A provider that cannot store files therefore keeps
working unchanged, and a provider whose endpoint is down degrades to text rather
than failing the turn.

## Every result is delivered

There is no size floor. `max_inline_chars` defaults to 0, so a result of any
length is written out and offered to this provider's uploader, and the prompt
carries only the stub. A provider that cannot upload still gets the full text on
disk plus a short head of the body in the stub, so nothing is lost and no tool
output rides in the prompt.

`python/kiln/runtime/` is Tier 1 (fork-owned) per HARNESS-EDITS.md, so this file
carries no overlay/patch obligation.
"""

from __future__ import annotations

import hashlib
import os
import re
import time
from dataclasses import dataclass
from typing import Callable, Iterable, Optional

__all__ = [
    "DEFAULT_MAX_INLINE_CHARS",
    "TOOL_RESULT_PREFIX",
    "SpilledResult",
    "Uploader",
    "default_spill_dir",
    "is_tool_result",
    "process_messages",
    "safe_filename",
    "spill_text",
    "stub_text",
]

#: The runtime flattens every tool result to this prefix before it reaches a
#: provider (see `ds_direct._is_tool_result`). It is the one reliable marker
#: that a body message is machine output rather than something a human typed.
TOOL_RESULT_PREFIX = "OUTPUT:"

# Key under which `process_messages` records the spill on the model-facing
# message, so a provider can attach a native file reference instead of leaving
# the model with a stub that names a file it cannot open.
_SPILLED_KEY = "_spilled_result"

#: A result is delivered as a file from this size up. Zero means EVERY tool
#: result is delivered as a file: the prompt then carries no tool output at all,
#: and the model reads what it needs from the attachment — or, when the provider
#: has no uploader, from the stub and the disk path it names.
DEFAULT_MAX_INLINE_CHARS = 0

#: How much of an oversized result to keep inline next to the LOCAL-path stub.
#: Used only when no upload succeeded: there the message carries no provider file
#: reference, so the head of the result is the model's only look at the content.
#: An UPLOADED result keeps no body text at all — see `stub_text`.
_STUB_PREVIEW_CHARS = 600

#: A provider file id is a short opaque token; anything longer is a malformed
#: or hostile response and is treated as a failed upload.
_MAX_FILE_ID_CHARS = 256

#: `uploader(filename, data)` -> provider file id, or None when the provider
#: cannot store files or the upload did not succeed.
Uploader = Callable[[str, bytes], Optional[str]]

_UNSAFE = re.compile(r"[^A-Za-z0-9._-]+")


@dataclass(frozen=True)
class SpilledResult:
    """One oversized tool result that was written out (and maybe uploaded)."""

    path: str
    filename: str
    chars: int
    file_id: Optional[str]

    @property
    def uploaded(self) -> bool:
        """Whether a provider file id came back for this result."""
        return self.file_id is not None


def safe_filename(label: str, body: str, *, suffix: str = ".txt") -> str:
    """Build a stable, filesystem-safe name for one spilled result.

    The name has to survive being written on Windows, quoted in a shell, and
    pasted into a prompt, so everything outside `[A-Za-z0-9._-]` collapses to
    `_`. A short content digest keeps two different results from colliding when
    they share a label, and keeps the name stable across turns so a re-spill of
    identical text reuses one file instead of littering the directory.

    @param label - short human-meaningful hint, e.g. a tool name.
    @param body - the full result text; only its digest is used.
    @param suffix - extension to append, dot included.
    @returns a filename no longer than 120 characters.
    """
    stem = _UNSAFE.sub("_", (label or "tool_result").strip())[:48].strip("_") or "tool_result"
    digest = hashlib.sha256(body.encode("utf-8", "replace")).hexdigest()[:12]
    return f"{stem}-{digest}{suffix}"


def spill_text(text: str, *, directory: str, filename: str) -> str:
    """Write `text` under `directory` as `filename` and return the full path.

    The write is atomic-ish (temp file then replace) so a crashed or cancelled
    turn never leaves a half-written artifact that a later read would treat as
    a complete result. UTF-8 with `errors="replace"` is used because tool output
    can carry bytes that are not valid in the locale encoding, and dropping the
    turn over an undecodable byte would defeat the point.

    @param text - the full result body.
    @param directory - destination directory; created when missing.
    @param filename - name within `directory`.
    @returns absolute path to the written file.
    """
    os.makedirs(directory, exist_ok=True)
    final = os.path.join(directory, filename)
    tmp = f"{final}.{os.getpid()}.{int(time.time() * 1000)}.part"
    try:
        with open(tmp, "w", encoding="utf-8", errors="replace", newline="") as fh:
            fh.write(text)
            fh.flush()
            os.fsync(fh.fileno())
        os.replace(tmp, final)
    except Exception:
        # Never leave the partial artifact behind on failure.
        try:
            if os.path.exists(tmp):
                os.remove(tmp)
        except OSError:
            pass
        raise
    return final


def stub_text(result: SpilledResult, *, preview: str = "") -> str:
    """Render the short in-prompt replacement for one spilled result.

    An UPLOADED result is referenced, never quoted. The provider holds the file
    and the message carries a native file-reference part beside this stub, so any
    body text kept here would be the payload arriving twice — once as the file
    the model can read in full, once as prompt tokens it pays for. The stub
    therefore names the file and stops; `preview` is ignored on this path.

    A result that did NOT upload has no provider reference to lean on, so the
    head of the body is the model's only look at the content and is kept.
    """
    if result.uploaded:
        return (
            f"{TOOL_RESULT_PREFIX}\n"
            f"[tool result delivered as an uploaded file: {result.chars} characters, "
            f"provider file id {result.file_id}]\n"
            f"The full text is attached to this message as a file. "
            f"Read the attachment; the content is not repeated here."
        )
    return (
        f"{TOOL_RESULT_PREFIX}\n"
        f"[tool result truncated: {result.chars} characters, saved locally "
        f"(this provider has no file upload, so read it back through the "
        f"filesystem)]\n"
        f"Full text: {result.path}\n"
        f"Re-read it (in slices) to see the rest. "
        f"First {len(preview)} characters follow:\n\n{preview}"
    )


def is_tool_result(text: str) -> bool:
    """Whether a rendered body message is machine tool output, not human text.

    Only tool results are eligible for spilling: user turns are pinned by the
    clip logic and must never be replaced with a stub, and assistant text is
    the model's own words rather than a payload that can be re-read.
    """
    if not isinstance(text, str):
        return False
    return text.lstrip().startswith(TOOL_RESULT_PREFIX)


def default_spill_dir(root: Optional[str] = None) -> str:
    """Pick the session-scoped directory that holds spilled results.

    Prefers `DSH_SPILL_DIR` so an operator can point spills at a scratch volume,
    then a `tool-results` directory beside the runtime's own state, so the
    artifacts survive a restart long enough for the model to re-read them.
    """
    override = os.environ.get("DSH_SPILL_DIR")
    if override:
        return override
    base = root or os.path.dirname(os.path.abspath(__file__))
    return os.path.join(base, "tool-results")


def _normalize_id(raw: object) -> Optional[str]:
    """Accept a provider file id only when it is a plausible short token."""
    if not isinstance(raw, str):
        return None
    token = raw.strip()
    if not token or len(token) > _MAX_FILE_ID_CHARS:
        return None
    return token


def process_messages(
    messages: Iterable[dict],
    *,
    uploader: Optional[Uploader],
    directory: str,
    max_inline_chars: int = DEFAULT_MAX_INLINE_CHARS,
    label_of: Optional[Callable[[dict], str]] = None,
) -> tuple[list[dict], list[SpilledResult]]:
    """Replace oversized tool results with file-backed stubs.

    Returns a NEW message list; the caller's objects are not mutated, because
    the same message list is also the durable transcript and the UI renders it
    as it was produced — only the model-facing copy is allowed to shrink.

    A message is eligible when its text starts with `OUTPUT:` (the runtime's own
    tool-result marker) and is longer than `max_inline_chars`, which defaults to
    0 so that every tool result qualifies. For each one the full body is written
    to `directory`, optionally handed to `uploader`, and the message's content
    becomes `stub_text(...)` — which quotes no body text when the upload
    succeeded, since the file itself now carries the payload.

    Failure of the write or the upload is deliberately non-fatal: the original
    message is kept, so the turn proceeds with inline text exactly as it did
    before this module existed.

    @param messages - rendered body messages.
    @param uploader - provider upload hook, or None when the provider has none.
    @param directory - where spilled artifacts are written.
    @param max_inline_chars - size above which a result is spilled.
    @param label_of - optional per-message label hint for the filename.
    @returns `(messages, spilled)` — the model-facing list and what was spilled.
    """
    out: list[dict] = []
    spilled: list[SpilledResult] = []

    for msg in messages:
        content = msg.get("content")
        if not isinstance(content, str) or len(content) <= max_inline_chars or not is_tool_result(content):
            out.append(msg)
            continue

        label = "tool_result"
        if label_of is not None:
            try:
                label = label_of(msg) or label
            except Exception:
                label = "tool_result"

        filename = safe_filename(label, content)
        try:
            path = spill_text(content, directory=directory, filename=filename)
        except Exception:
            # Storage is unavailable — keep the inline text rather than
            # dropping the result entirely.
            out.append(msg)
            continue

        file_id: Optional[str] = None
        if uploader is not None:
            try:
                file_id = _normalize_id(uploader(filename, content.encode("utf-8", "replace")))
            except Exception:
                # An upload endpoint that is down or rejects the file must
                # degrade to the local artifact, never fail the turn.
                file_id = None

        record = SpilledResult(
            path=path, filename=filename, chars=len(content), file_id=file_id,
        )
        spilled.append(record)
        replaced = dict(msg)
        # The preview is handed over unconditionally; `stub_text` decides whether
        # to use it, and drops it whenever the provider already holds the file.
        replaced["content"] = stub_text(record, preview=content[:_STUB_PREVIEW_CHARS])
        # A provider that can attach files reads this to add its own native
        # reference part, so the stub names a file the model can actually open.
        # It is private to the wire copy and never reaches the transcript.
        replaced[_SPILLED_KEY] = record
        out.append(replaced)

    return out, spilled
