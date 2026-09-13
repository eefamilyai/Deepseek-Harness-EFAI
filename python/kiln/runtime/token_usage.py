"""token_usage.py — token accounting for Kiln-Kernel.

The DeepSeek browser backend does not report token counts, so usage is
estimated from text using DeepSeek's engineering heuristics (CJK ~0.6 tokens
per char, other text ~3 chars per token) and, when a provider DOES report real
usage (meta events with a `usage` field), the real numbers win. Per-model
context limits let the UI show
"used / max" for the active chat.
"""

import re

# Approximate context windows for DeepSeek web models (tokens). The web chat
# serves a 1M-token context window (chat.deepseek.com); the paid API models
# below are separate entries and keep their own limits.
MODEL_LIMITS = {
    # The four live chat.deepseek.com modes.
    "deepseek-default": 1000000,
    "deepseek-reasoner": 1000000,
    "deepseek-search": 1000000,
    "deepseek-reasoner-search": 1000000,
    # Retired Expert/Vision ids kept so a saved conversation, an agent preset,
    # or a pinned route naming one still shows a context window instead of
    # falling through to DEFAULT_LIMIT. They RESOLVE onto the modes above
    # (ds_direct.LEGACY_ALIASES), which is why they carry the same window.
    "deepseek-expert": 1000000,
    "deepseek-expert-reasoner": 1000000,
    "deepseek-expert-offline": 1000000,
    "deepseek-expert-search": 1000000,
    "deepseek-vision": 1000000,
    "deepseek-vision-reasoner": 1000000,
    # Anthropic Messages API
    "claude-3-5-sonnet-20241022": 200000,
    "claude-3-5-haiku-20241022": 200000,
    "claude-3-7-sonnet-20250219": 200000,
    "claude-sonnet-4-20250514": 200000,
    "claude-opus-4-20250514": 200000,
    # OpenAI Chat Completions
    "gpt-4o": 128000,
    "gpt-4o-mini": 128000,
    "gpt-4.1": 1047576,
    "gpt-4.1-mini": 1047576,
    "gpt-4.1-nano": 1047576,
    "o3": 200000,
    "o3-mini": 200000,
    "o4-mini": 200000,
    "gpt-5": 400000,
    "gpt-5-mini": 400000,
    "gpt-5-nano": 400000,
    # DeepSeek paid API (OpenAI-compatible)
    "deepseek-chat": 128000,
    # OpenRouter (varies by model — fallback below unless listed)
    "auto": 200000,
}
DEFAULT_LIMIT = 64000

# Model ids can collide across providers (e.g. deepseek-reasoner exists on both
# the free web session and the paid API with different windows). Resolve those
# per provider; the flat table above wins otherwise.
PROVIDER_LIMIT_OVERRIDES = {
    ("deepseek-api", "deepseek-reasoner"): 128000,
    ("deepseek-api", "deepseek-chat"): 128000,
}


# Per-provider catalogues loaded from the provider's own /models response.
# provider_id -> {model_id: context_length} (or an int for a uniform window).
PROVIDER_LIMIT_CATALOGUES = {}

# Conservative family fallbacks for unknown / aliased ids. Every match is a
# substring START, so `google/gemini-3.1...` and `gemini-3.1...` both resolve.
# The provider catalogue always wins when present.
FAMILY_LIMITS = [
    ("gpt-5", 400000),
    ("gpt-4.1", 1047576),
    ("gpt-4o", 128000),
    ("o3", 200000),
    ("o4", 200000),
    ("gemini-3", 1048576),
    ("gemini-2.5", 1048576),
    ("gemini-2.0", 1048576),
    ("gemini-1.5", 2097152),
    # catch-all for Gemini aliases like gemini-flash-latest / gemini-pro-latest
    ("gemini-flash", 1048576),
    ("gemini-pro", 1048576),
    ("gemini", 1048576),
    ("gemma", 131072),
    ("claude", 200000),
    ("deepseek", 163840),
    ("grok", 131072),
    ("llama-3", 131072),
    ("llama-4", 1048576),
    ("mistral", 131072),
    ("qwen", 131072),
    ("codestral", 256000),
]


def _family_limit(model_key):
    m = (model_key or "").lower()
    for prefix, limit in FAMILY_LIMITS:
        if m.startswith(prefix):
            return limit
    return None


def context_limit(model_key, provider=None):
    # A per-provider catalogue pulled from its own model-listing endpoint is
    # the most accurate source we have.
    if provider:
        cat = PROVIDER_LIMIT_CATALOGUES.get(provider)
        if isinstance(cat, dict):
            v = cat.get(model_key)
            if v:
                return int(v)
        elif isinstance(cat, int) and cat:
            return int(cat)
    if provider:
        v = PROVIDER_LIMIT_OVERRIDES.get((provider, model_key))
        if v:
            return v
    if model_key in MODEL_LIMITS:
        return MODEL_LIMITS[model_key]
    fam = _family_limit(model_key)
    if fam:
        return fam
    return DEFAULT_LIMIT

# usage categories we track. `reasoning` (a model's hidden thinking tokens) is
# billed but NOT retained in the transcript, so it is tracked and shown on its
# own rather than lumped into `output` — and it is deliberately left out of the
# context-window total (see the meter / compaction, which sum the others).
CATEGORIES = ("input", "output", "reasoning", "cache_read", "cache_write", "uploads")


# CJK codepoints are priced at ~0.6 tokens/char by `estimate_tokens`; everything
# else at ~3 chars/token. Classifying them in a per-character Python loop made
# this the dominant cost of a turn: the reconstructed chat prompt is priced once
# per turn and runs to megabytes on a long conversation. A compiled character
# class performs the identical classification in C.
_CJK_CLASS = re.compile('[\u4e00-\u9fff\u3040-\u30ff\uac00-\ud7af]')


def estimate_tokens(text):
    """DeepSeek token estimate: CJK ~0.6 tokens/char, other ~3 chars/token."""
    if not text:
        return 0
    cjk = len(_CJK_CLASS.findall(text))
    n = len(text) - cjk
    est = cjk * 0.6 + (n / 3.0 if n else 0.0)
    if est <= 0:
        return 0
    return max(1, round(est))


def new_usage():
    return {c: 0 for c in CATEGORIES}


def add_usage(total, delta):
    """Merge a delta dict (only known categories) into the total."""
    for c in CATEGORIES:
        v = delta.get(c)
        if isinstance(v, (int, float)) and v > 0:
            total[c] = total.get(c, 0) + int(v)
    return total


def usage_total(u):
    return sum(int(u.get(c, 0)) for c in CATEGORIES)


def fmt_tokens(n):
    """1_234 -> '1.2k', 65_000 -> '65k'."""
    try:
        n = int(n)
    except (TypeError, ValueError):
        return "0"
    if n < 1000:
        return str(n)
    if n < 100_000:
        return f"{n / 1000:.1f}k"
    return f"{round(n / 1000)}k"
