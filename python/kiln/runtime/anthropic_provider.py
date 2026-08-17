# anthropic_provider.py — Anthropic Messages API adapter (Claude).
#
# Implements the provider contract from providers.py:
#   stream(model, messages, opts, cancelled, cfg) -> events
# using Anthropic's real wire format: POST {base}/v1/messages with
# x-api-key + anthropic-version headers, SSE events (message_start /
# content_block_delta / message_delta / message_stop). The API key is read at
# request time from the .env variable named by cfg["api_key_env"] — the key
# itself is never stored, logged, or returned.
import os

import sse_client
from provider_errors import friendly_error

PROVIDER_ID = "anthropic"
DISPLAY_NAME = "Anthropic (Claude)"
SCHEMA = "anthropic"
DEFAULT_BASE = "https://api.anthropic.com/v1"
DEFAULT_ENV = "ANTHROPIC_API_KEY"
ANTHROPIC_VERSION = "2023-06-01"

# Pre-fetch fallback only — providers.refresh_models() replaces this with the
# live catalogue from GET {base}/models (Settings › Refresh, and on enable).
MODELS = [
    ("claude-sonnet-4-20250514", "Claude Sonnet 4"),
    ("claude-opus-4-20250514", "Claude Opus 4"),
    ("claude-3-7-sonnet-20250219", "Claude 3.7 Sonnet"),
    ("claude-3-5-sonnet-20241022", "Claude 3.5 Sonnet"),
    ("claude-3-5-haiku-20241022", "Claude 3.5 Haiku"),
]


def models(cfg=None):
    cfg = cfg or {}
    if cfg.get("models"):           # live catalogue wins over the fallback
        return list(cfg["models"])
    return [m for m, _ in MODELS]


def model_labels(cfg=None):
    cfg = cfg or {}
    base = dict(MODELS)
    base.update(cfg.get("model_labels") or {})
    for m in (cfg.get("models") or []):
        base.setdefault(m, m)
    return base


def default_model(cfg=None):
    ms = models(cfg)
    return ms[0] if ms else ""


def _resolve(cfg):
    cfg = cfg or {}
    base = (cfg.get("base_url") or DEFAULT_BASE).rstrip("/")
    env = cfg.get("api_key_env") or DEFAULT_ENV
    return base, env, os.environ.get(env, "")


def check_config(cfg):
    """(ok, message). Messages name the env var only — never the key."""
    _, env, key = _resolve(cfg)
    if not env:
        return False, "no .env variable name configured (api_key_env)"
    if not key:
        return False, "%s is not set — add it to .env" % env
    if len(key) < 12:
        return False, "%s looks too short for an API key" % env
    return True, "ok"


def _norm_usage(u):
    """Map Anthropic usage to our categories."""
    out = {}
    if u.get("input_tokens") is not None:
        out["input"] = u.get("input_tokens")
    if u.get("output_tokens") is not None:
        out["output"] = u.get("output_tokens")
    if u.get("cache_read_input_tokens"):
        out["cache_read"] = u.get("cache_read_input_tokens")
    if u.get("cache_creation_input_tokens"):
        out["cache_write"] = u.get("cache_creation_input_tokens")
    return out


_CACHE_CONTROL = {"type": "ephemeral"}
# Anthropic accepts at most 4 breakpoints per request; the loop asks for 2
# (system, and the last stable message). Anything past the cap is dropped
# rather than sent, because an over-limit request is rejected outright.
_MAX_BREAKPOINTS = 4


def _blocks(text, cache):
    """One text block, optionally carrying a cache breakpoint.

    Caching keys on the literal prefix up to and including the marked block,
    so a breakpoint is only worth anything when everything before it is
    byte-identical to the previous request — which is exactly what
    agent_loop.build_messages guarantees.
    """
    b = {"type": "text", "text": text}
    if cache:
        b["cache_control"] = dict(_CACHE_CONTROL)
    return [b]


def stream(model, messages, opts, cancelled, cfg):
    opts = opts or {}
    base, env, key = _resolve(cfg)
    if not key:
        yield {"type": "content",
               "text": "\n[anthropic] %s is not set in .env — add the key to use this provider." % env}
        yield {"type": "meta", "finish": "error"}
        return
    sys_msgs = [m for m in messages if m.get("role") == "system"]
    system = "\n\n".join(m.get("content", "") for m in sys_msgs) or None
    # honour the loop's breakpoints, newest first, up to the API's limit
    wanted = [m for m in messages
              if m.get("cache") and m.get("role") in ("user", "assistant")]
    budget = _MAX_BREAKPOINTS - (1 if system and any(m.get("cache") for m in sys_msgs) else 0)
    marked = {id(m) for m in wanted[-budget:]} if budget > 0 else set()
    msgs = [{"role": m.get("role") if m.get("role") in ("user", "assistant") else "user",
             "content": _blocks(m.get("content", ""), id(m) in marked)}
            for m in messages if m.get("role") in ("user", "assistant")]
    payload = {
        "model": model,
        "max_tokens": opts.get("max_tokens") or 8192,
        "stream": True,
        "messages": msgs,
    }
    if system:
        # a string here would be uncacheable — the breakpoint has to hang off
        # a block, so the system prompt is always sent in block form
        payload["system"] = _blocks(system, any(m.get("cache") for m in sys_msgs))
    if opts.get("temperature") is not None:
        payload["temperature"] = opts["temperature"]
    headers = {
        "x-api-key": key,
        "anthropic-version": ANTHROPIC_VERSION,
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    usage = {}  # Anthropic reports usage in pieces: input/cache at start,
    #             final cumulative output in the last message_delta. Accumulate
    #             and emit ONE snapshot so the loop doesn't double-count.
    try:
        for ev, data in sse_client.post_sse(base + "/messages", headers, payload, cancelled):
            if ev == "content_block_delta":
                d = data.get("delta", {}) if isinstance(data, dict) else {}
                if d.get("type") == "text_delta" and d.get("text"):
                    yield {"type": "content", "text": d["text"]}
                elif d.get("type") == "thinking_delta" and d.get("thinking"):
                    yield {"type": "reasoning", "text": d["thinking"]}
            elif ev == "message_start":
                u = (data.get("message") or {}).get("usage") if isinstance(data, dict) else None
                if u:
                    usage.update(_norm_usage(u))
            elif ev == "message_delta":
                u = data.get("usage") if isinstance(data, dict) else None
                if u:
                    usage.update(_norm_usage(u))
            elif ev == "error":
                # real API error frame (e.g. overloaded_error, rate_limit) —
                # must NOT fall through to the normal-completion path
                err = data.get("error", {}) if isinstance(data, dict) else {}
                if isinstance(err, dict):
                    msg = err.get("message") or err.get("type") or "unknown error"
                else:
                    msg = str(err)
                raise RuntimeError("anthropic API error: %s" % msg)
            elif ev == "message_stop":
                break
        if usage:
            yield {"type": "meta", "usage": usage}
        yield {"type": "meta", "finish": "stop"}
    except Exception as e:
        yield {"type": "content", "text": "\n[anthropic error] %s" % friendly_error(e)}
        yield {"type": "meta", "finish": "error"}
