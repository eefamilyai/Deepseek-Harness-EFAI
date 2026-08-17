# compaction.py — context-rot control for Kiln-Kernel.
#
# Ported from PrimeIntellect's prime-agent (`packages/coding-agent/src/core/
# compaction/`): the context window is not just a token budget — over a long
# session it rots, as early decisions, exact paths, and the state of the work
# get buried under tool output and repeated instructions. This module fights
# that the way prime-agent does:
#
#   1. Token-accurate trigger — compare the REAL context size (last provider
#      usage + estimates for anything newer) against the model's window minus
#      a reserve, instead of a character-count heuristic.
#   2. Smart cut point — keep the newest ~keep_recent_tokens verbatim, walk
#      back to a valid boundary (never breaking a code turn from its OUTPUT),
#      and if the cut lands mid-turn, summarize the turn's prefix separately
#      so the retained suffix still makes sense.
#   3. Structured, iterative summarization — the older turns are serialized to
#      plain text (so the model can't "continue" them) and compressed into a
#      fixed-format summary: Goal / Constraints / Progress / Key Decisions /
#      Next Steps / Critical Context, plus <read-files>/<modified-files> with
#      exact paths. When a previous summary exists it is UPDATE-merged, so no
#      old decision is lost by re-summarizing from scratch.
#   4. Kernel persistence note — the Python kernel keeps running after the
#      summary, so the model is told to record variable/import/helper names it
#      defined; the live namespace is the real memory, the summary is its index.
#
# Everything here is pure (no I/O except through the provider callback), so it
# is unit-testable without a server or a real model.
import re

from token_usage import estimate_tokens

# ---------------------------------------------------------------------------
# Settings
# ---------------------------------------------------------------------------

DEFAULT_COMPACTION_SETTINGS = {
    "enabled": True,
    "reserve_tokens": 16384,     # headroom left for the response + safety
    "keep_recent_tokens": 20000, # newest tokens kept verbatim after a compact
}

# ---------------------------------------------------------------------------
# Token accounting
# ---------------------------------------------------------------------------

_USAGE_CATEGORIES = ("input", "output", "cache_read", "cache_write", "uploads")


def calculate_context_tokens(usage):
    """Total context tokens from a provider usage dict.

    Uses the native `total` when the provider reports one; otherwise sums the
    categories. Includes output: the assistant's reply becomes part of the
    prompt on the next request, so it counts toward the next turn's context.
    """
    if not usage:
        return 0
    total = usage.get("total")
    if total:
        return int(total)
    return sum(int(usage.get(c, 0) or 0) for c in _USAGE_CATEGORIES)


def estimate_message_tokens(msg):
    """Chars/4 heuristic for one message (CJK-aware, via token_usage)."""
    content = msg.get("content", "") if isinstance(msg, dict) else ""
    if not content:
        return 8
    return estimate_tokens(content) + 8  # small per-message overhead


def estimate_context_tokens(messages):
    """(tokens, usage_tokens, trailing_tokens, last_usage_index).

    Uses the last assistant message that carries REAL provider usage (the
    exact size of that request), then adds estimates for anything newer.
    """
    last = None
    for i in range(len(messages) - 1, -1, -1):
        m = messages[i]
        if m.get("role") == "assistant" and m.get("usage"):
            last = (i, m["usage"])
            break
    if last is None:
        total = sum(estimate_message_tokens(m) for m in messages)
        return (total, 0, total, None)
    idx, usage = last
    usage_tokens = calculate_context_tokens(usage)
    trailing = sum(estimate_message_tokens(m) for m in messages[idx + 1:])
    return (usage_tokens + trailing, usage_tokens, trailing, idx)


def should_compact(context_tokens, context_window, settings):
    if not settings.get("enabled"):
        return False
    if not context_window or context_window <= 0:
        return False
    return context_tokens > context_window - int(settings.get("reserve_tokens", 0))


# ---------------------------------------------------------------------------
# Cut point detection
# ---------------------------------------------------------------------------

def _is_cut_point(msg):
    """Valid cut points: user and assistant messages.

    OUTPUT messages (the model's tool results, `kind == "output"` or content
    starting with "OUTPUT:") are never cut points — they must follow the code
    turn that produced them. Compaction summaries are boundaries, not cut
    points (the walk starts after them).
    """
    role = msg.get("role")
    if role == "assistant":
        return True
    if role == "user":
        kind = msg.get("kind")
        if kind in ("output", "compact"):
            return False
        if str(msg.get("content", "")).startswith("OUTPUT:"):
            return False
        return True
    return False


def find_turn_start_index(messages, entry_index, start):
    """Nearest user message (not an OUTPUT) at or before `entry_index`."""
    for i in range(entry_index, start - 1, -1):
        if messages[i].get("role") == "user" and _is_cut_point(messages[i]):
            return i
    return -1


def find_cut_point(messages, start, end, keep_recent_tokens):
    """Walk backwards from the newest message accumulating estimated sizes and
    cut where we've kept ~`keep_recent_tokens`. Returns a dict:

        first_kept_index  - index the retained context starts at
        turn_start_index  - user message starting the turn being split, or -1
        is_split_turn     - True when the cut is mid-turn (prefix summarized)
    """
    cut_points = [i for i in range(start, end) if _is_cut_point(messages[i])]
    if not cut_points:
        return {"first_kept_index": start, "turn_start_index": -1, "is_split_turn": False}

    accumulated = 0
    cut_index = cut_points[0]  # default: keep from the first valid message
    for i in range(end - 1, start - 1, -1):
        accumulated += estimate_message_tokens(messages[i])
        if accumulated >= keep_recent_tokens:
            chosen = None
            for c in cut_points:
                if c >= i:
                    chosen = c
                    break
            if chosen is not None:
                cut_index = chosen
            else:
                # Threshold crossed at a trailing non-cut message (e.g. a big
                # OUTPUT that follows the last assistant turn). Fall back to the
                # LAST valid cut point so the trailing tool results stay with
                # their turn instead of keeping the whole conversation.
                cut_index = cut_points[-1]
            break

    cut_msg = messages[cut_index]
    is_user = cut_msg.get("role") == "user"
    turn_start = -1 if is_user else find_turn_start_index(messages, cut_index, start)
    return {
        "first_kept_index": cut_index,
        "turn_start_index": turn_start,
        "is_split_turn": (not is_user) and turn_start != -1,
    }


# ---------------------------------------------------------------------------
# Serialization for summarization
# ---------------------------------------------------------------------------

TOOL_RESULT_MAX_CHARS = 2000


def _truncate_for_summary(text, max_chars=TOOL_RESULT_MAX_CHARS):
    if len(text) <= max_chars:
        return text
    return "%s\n\n[... %d more characters truncated]" % (text[:max_chars], len(text) - max_chars)


def serialize_conversation(messages):
    """Render messages as plain text so the summarizer reads a transcript
    rather than a conversation it could try to continue."""
    parts = []
    for m in messages:
        role = m.get("role")
        kind = m.get("kind")
        content = str(m.get("content", "")) or ""
        if role == "user":
            if kind == "output" or content.startswith("OUTPUT:"):
                if content.strip():
                    parts.append("[Tool result]: " + _truncate_for_summary(content))
            elif kind == "compact":
                summary = m.get("summary") or content
                parts.append("[Compaction summary of earlier conversation]:\n" + summary)
            else:
                if content.strip():
                    parts.append("[User]: " + content)
        elif role == "assistant":
            parts.append("[Assistant]: " + content)
    return "\n\n".join(parts)


# ---------------------------------------------------------------------------
# File operation tracking (exact paths survive the compact)
# ---------------------------------------------------------------------------

_FILE_CALL_RE = re.compile(
    r"\b(read_file|write_file|append_file|edit_file|delete_file)\s*\(\s*['\"]([^'\"]+)['\"]")


def extract_file_ops(messages):
    """Scan code turns for the file helpers and return
    (read_files:set, modified_files:set). Written/edited/deleted count as
    modified; read_file counts as read.
    """
    reads, modified = set(), set()
    for m in messages:
        if m.get("role") != "assistant":
            continue
        # the code the model ran is stored on the message (the prose content
        # has code blocks stripped), so scan both
        blob = str(m.get("content", "")) + "\n" + str(m.get("code", ""))
        for op, path in _FILE_CALL_RE.findall(blob):
            if not path or path.startswith(("http://", "https://")):
                continue
            if op == "read_file":
                reads.add(path)
            else:
                modified.add(path)
    return reads, modified


def format_file_operations(read_files, modified_files):
    """XML-ish sections appended to the summary so exact paths survive."""
    sections = []
    if read_files:
        sections.append("<read-files>\n%s\n</read-files>" % "\n".join(sorted(read_files)))
    if modified_files:
        sections.append("<modified-files>\n%s\n</modified-files>" % "\n".join(sorted(modified_files)))
    if not sections:
        return ""
    return "\n\n" + "\n\n".join(sections)


# ---------------------------------------------------------------------------
# Summarization prompts (prime-agent's structured format)
# ---------------------------------------------------------------------------

SUMMARIZATION_SYSTEM_PROMPT = (
    "You are a context summarization assistant. Your task is to read a conversation "
    "between a user and an AI coding assistant, then produce a structured summary "
    "following the exact format specified.\n\n"
    "Do NOT continue the conversation. Do NOT respond to any questions in the "
    "conversation. ONLY output the structured summary."
)

SUMMARIZATION_PROMPT = (
    "The messages above are a conversation to summarize. Create a structured "
    "context checkpoint summary that another LLM will use to continue the work.\n\n"
    "Use this EXACT format:\n\n"
    "## Goal\n"
    "[What is the user trying to accomplish? Can be multiple items if the session "
    "covers different tasks.]\n\n"
    "## Constraints & Preferences\n"
    "- [Any constraints, preferences, or requirements mentioned by user]\n"
    '- [Or "(none)" if none were mentioned]\n\n'
    "## Progress\n"
    "### Done\n"
    "- [x] [Completed tasks/changes]\n\n"
    "### In Progress\n"
    "- [ ] [Current work]\n\n"
    "### Blocked\n"
    "- [Issues preventing progress, if any]\n\n"
    "## Key Decisions\n"
    "- **[Decision]**: [Brief rationale]\n\n"
    "## Next Steps\n"
    "1. [Ordered list of what should happen next]\n\n"
    "## Critical Context\n"
    "- [Any data, examples, or references needed to continue]\n"
    '- [Or "(none)" if not applicable]\n\n'
    "Keep each section concise. Preserve exact file paths, function names, and "
    "error messages."
)

KERNEL_PERSIST_SUMMARY_NOTE = (
    "Note: the Python kernel keeps running after this summary — every Python variable, "
    "import, and helper you defined stays available. The cells that defined them won't "
    "appear above, so record in the summary any names worth remembering so you reuse "
    "them instead of redefining them."
)

UPDATE_SUMMARIZATION_PROMPT = (
    "The messages above are NEW conversation messages to incorporate into the "
    "existing summary provided in <previous-summary> tags.\n\n"
    "Update the existing structured summary with new information. RULES:\n"
    "- PRESERVE all existing information from the previous summary\n"
    "- ADD new progress, decisions, and context from the new messages\n"
    '- UPDATE the Progress section: move items from "In Progress" to "Done" when completed\n'
    '- UPDATE "Next Steps" based on what was accomplished\n'
    "- PRESERVE exact file paths, function names, and error messages\n"
    "- If something is no longer relevant, you may remove it\n\n"
    "Use this EXACT format:\n\n"
    "## Goal\n"
    "[Preserve existing goals, add new ones if the task expanded]\n\n"
    "## Constraints & Preferences\n"
    "- [Preserve existing, add new ones discovered]\n\n"
    "## Progress\n"
    "### Done\n"
    "- [x] [Include previously done items AND newly completed items]\n\n"
    "### In Progress\n"
    "- [ ] [Current work - update based on progress]\n\n"
    "### Blocked\n"
    "- [Current blockers - remove if resolved]\n\n"
    "## Key Decisions\n"
    "- **[Decision]**: [Brief rationale] (preserve all previous, add new)\n\n"
    "## Next Steps\n"
    "1. [Update based on current state]\n\n"
    "## Critical Context\n"
    "- [Preserve important context, add new if needed]\n\n"
    "Keep each section concise. Preserve exact file paths, function names, and "
    "error messages."
)

TURN_PREFIX_SUMMARIZATION_PROMPT = (
    "This is the PREFIX of a turn that was too large to keep. The SUFFIX "
    "(recent work) is retained.\n\n"
    "Summarize the prefix to provide context for the retained suffix:\n\n"
    "## Original Request\n"
    "[What did the user ask for in this turn?]\n\n"
    "## Early Progress\n"
    "- [Key decisions and work done in the prefix]\n\n"
    "## Context for Suffix\n"
    "- [Information needed to understand the retained recent work]\n\n"
    "Be concise. Focus on what's needed to understand the kept suffix."
)


def build_summarization_prompt(previous_summary=None):
    base = UPDATE_SUMMARIZATION_PROMPT if previous_summary else SUMMARIZATION_PROMPT
    return "%s\n\n%s" % (base, KERNEL_PERSIST_SUMMARY_NOTE)


# ---------------------------------------------------------------------------
# Preparation
# ---------------------------------------------------------------------------

def prepare_compaction(messages, settings):
    """Decide what a compaction would summarize. Returns None when there is
    nothing to compact (small conversation, nothing new since the last
    compaction, or no previous summary to carry forward)."""
    if not messages:
        return None

    prev_idx = -1
    for i in range(len(messages) - 1, -1, -1):
        if messages[i].get("kind") == "compact":
            prev_idx = i
            break
    previous_summary = None
    boundary_start = 0
    if prev_idx >= 0:
        pm = messages[prev_idx]
        previous_summary = pm.get("summary") or pm.get("content", "")
        boundary_start = prev_idx + 1
    boundary_end = len(messages)

    tokens_before = estimate_context_tokens(messages)[0]

    keep_recent = int(settings.get("keep_recent_tokens", 0)) \
        or DEFAULT_COMPACTION_SETTINGS["keep_recent_tokens"]
    cut = find_cut_point(messages, boundary_start, boundary_end, keep_recent)
    first_kept_index = cut["first_kept_index"]
    history_end = cut["turn_start_index"] if cut["is_split_turn"] else first_kept_index

    messages_to_summarize = list(messages[boundary_start:history_end])
    turn_prefix = list(messages[cut["turn_start_index"]:first_kept_index]) if cut["is_split_turn"] else []

    if not messages_to_summarize and not turn_prefix and not previous_summary:
        return None

    read_files, modified_files = extract_file_ops(messages[boundary_start:history_end])
    if prev_idx >= 0:
        pm = messages[prev_idx]
        read_files |= set(pm.get("read_files") or [])
        modified_files |= set(pm.get("modified_files") or [])
    if cut["is_split_turn"]:
        pr, pm2 = extract_file_ops(turn_prefix)
        read_files |= pr
        modified_files |= pm2

    return {
        "first_kept_index": first_kept_index,
        "messages_to_summarize": messages_to_summarize,
        "turn_prefix": turn_prefix,
        "is_split_turn": cut["is_split_turn"],
        "tokens_before": tokens_before,
        "previous_summary": previous_summary,
        "read_files": sorted(read_files),
        "modified_files": sorted(modified_files),
    }


# ---------------------------------------------------------------------------
# Summary generation (via the provider)
# ---------------------------------------------------------------------------

def _summary_call(provider, model, system, prompt_text, opts, cancelled, max_tokens):
    """One streaming summarization request. Returns (text, input_tokens)."""
    sum_opts = dict(opts or {})
    sum_opts["max_tokens"] = max_tokens
    parts = []
    for ev in provider.stream(
            model,
            [{"role": "system", "content": system},
             {"role": "user", "content": prompt_text}],
            sum_opts, cancelled=cancelled):
        if cancelled and cancelled():
            break
        if ev.get("type") == "content":
            parts.append(ev.get("text", ""))
    text = "".join(parts).strip()
    return text, estimate_tokens(prompt_text)


def generate_summary(provider, model, messages, opts, settings,
                     previous_summary=None, cancelled=None):
    """Summarize `messages` into the structured checkpoint format. Returns
    (summary, input_tokens) — summary is "" when generation failed."""
    if not messages and not previous_summary:
        return "", 0
    reserve = int(settings.get("reserve_tokens", 0)) or DEFAULT_COMPACTION_SETTINGS["reserve_tokens"]
    max_tokens = max(2048, int(0.8 * reserve))
    conversation = serialize_conversation(messages)
    prompt_text = "<conversation>\n%s\n</conversation>\n\n" % conversation
    if previous_summary:
        prompt_text += "<previous-summary>\n%s\n</previous-summary>\n\n" % previous_summary
    prompt_text += build_summarization_prompt(previous_summary)
    try:
        text, in_toks = _summary_call(provider, model, SUMMARIZATION_SYSTEM_PROMPT,
                                      prompt_text, opts, cancelled, max_tokens)
    except Exception:
        return "", 0
    return text, in_toks


def generate_turn_prefix_summary(provider, model, messages, opts, settings, cancelled=None):
    """Summarize the prefix of a turn being split. Returns (summary, input_tokens)."""
    if not messages:
        return "", 0
    reserve = int(settings.get("reserve_tokens", 0)) or DEFAULT_COMPACTION_SETTINGS["reserve_tokens"]
    max_tokens = max(1024, int(0.5 * reserve))
    conversation = serialize_conversation(messages)
    prompt_text = ("<conversation>\n%s\n</conversation>\n\n%s"
                   % (conversation, TURN_PREFIX_SUMMARIZATION_PROMPT))
    try:
        text, in_toks = _summary_call(provider, model, SUMMARIZATION_SYSTEM_PROMPT,
                                      prompt_text, opts, cancelled, max_tokens)
    except Exception:
        return "", 0
    return text, in_toks
