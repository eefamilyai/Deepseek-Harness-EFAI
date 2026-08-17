# openai_provider.py — OpenAI Chat Completions adapter (GPT).
#
# Implements the provider contract from providers.py. Also serves the
# OpenAI-compatible presets (OpenRouter, DeepSeek paid API) and any custom
# provider the user adds with schema "openai" — they all speak the same wire
# format, so one adapter covers them with a different base_url / api_key_env /
# model list. The key is read at request time from the .env variable named by
# cfg["api_key_env"] — never stored, logged, or returned.
import os
import re

import sse_client
from provider_errors import friendly_error

PROVIDER_ID = "openai"
DISPLAY_NAME = "OpenAI (GPT)"
SCHEMA = "openai"
DEFAULT_BASE = "https://api.openai.com/v1"
DEFAULT_ENV = "OPENAI_API_KEY"

MODELS = [
    ("gpt-5", "GPT-5"),
    ("gpt-5-mini", "GPT-5 mini"),
    ("gpt-4o", "GPT-4o"),
    ("gpt-4o-mini", "GPT-4o mini"),
    ("gpt-4.1", "GPT-4.1"),
    ("o4-mini", "o4-mini"),
    ("o3-mini", "o3-mini"),
]

# Seed model lists for the OpenAI-compatible presets. These are only a
# fallback shown before the first live fetch — refresh_models() (Settings ›
# Refresh, and automatically on enable) replaces them with the provider's real
# catalogue, so they don't need to stay exhaustive or perfectly current.
PRESETS = {
    "openrouter": {
        "models": [("openrouter/auto", "Auto (route by cost/quality)")],
    },
    "deepseek-api": {
        "models": [("deepseek-chat", "DeepSeek Chat (V3)"),
                   ("deepseek-reasoner", "DeepSeek Reasoner (R1)")],
    },
    "groq": {
        "models": [("llama-3.3-70b-versatile", "Llama 3.3 70B"),
                   ("llama-3.1-8b-instant", "Llama 3.1 8B (instant)")],
    },
    "xai": {
        "models": [("grok-2-latest", "Grok 2"), ("grok-beta", "Grok beta")],
    },
    "mistral": {
        "models": [("mistral-large-latest", "Mistral Large"),
                   ("mistral-small-latest", "Mistral Small"),
                   ("codestral-latest", "Codestral")],
    },
    "together": {
        "models": [("meta-llama/Llama-3.3-70B-Instruct-Turbo", "Llama 3.3 70B Turbo")],
    },
    "fireworks": {
        "models": [("accounts/fireworks/models/llama-v3p3-70b-instruct", "Llama 3.3 70B")],
    },
    "perplexity": {
        "models": [("sonar", "Sonar"), ("sonar-pro", "Sonar Pro"),
                   ("sonar-reasoning", "Sonar Reasoning")],
    },
    "cerebras": {
        "models": [("llama-3.3-70b", "Llama 3.3 70B"), ("llama3.1-8b", "Llama 3.1 8B")],
    },
    "nvidia": {
        "models": [("meta/llama-3.3-70b-instruct", "Llama 3.3 70B"),
                   ("nvidia/llama-3.1-nemotron-70b-instruct", "Nemotron 70B"),
                   ("deepseek-ai/deepseek-r1", "DeepSeek R1")],
    },
    # local runtimes have no fixed catalogue — whatever the user has pulled
    "ollama": {"models": [], "local": True},
    "lmstudio": {"models": [], "local": True},
}


def _preset(cfg):
    return PRESETS.get((cfg or {}).get("id")) or {}


def _is_local(cfg):
    # a local runtime (Ollama / LM Studio) needs no key
    return bool((cfg or {}).get("local") or _preset(cfg).get("local"))


def models(cfg=None):
    cfg = cfg or {}
    # a live-fetched list (refresh_models) always wins over the seed/fallback
    if cfg.get("models"):
        return list(cfg["models"])
    p = _preset(cfg)
    if "models" in p:
        return [m for m, _ in p["models"]]   # preset seed (empty for local)
    # no preset: the OpenAI builtin (and any OpenAI-schema custom that hasn't
    # fetched yet) falls back to the built-in GPT list
    return [m for m, _ in MODELS]


def model_labels(cfg=None):
    cfg = cfg or {}
    p = _preset(cfg)
    base = dict(p["models"]) if "models" in p else dict(MODELS)
    # display names captured from the live catalogue (id -> pretty name)
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
    env = cfg.get("api_key_env")
    if env is None:
        env = DEFAULT_ENV
    return base, env, (os.environ.get(env, "") if env else "")


def check_config(cfg):
    cfg = cfg or {}
    _, env, key = _resolve(cfg)
    if _is_local(cfg) or not env:
        return True, "ok"   # local runtime: no key required
    if not key:
        return False, "%s is not set — add it to .env" % env
    if len(key) < 12:
        return False, "%s looks too short for an API key" % env
    return True, "ok"


def _norm_usage(u):
    out = {}
    if u.get("prompt_tokens") is not None:
        out["input"] = u.get("prompt_tokens")
    if u.get("completion_tokens") is not None:
        out["output"] = u.get("completion_tokens")
    # o-series / reasoning models report hidden thinking tokens inside
    # completion_tokens; split them into their own category so `output` is just
    # the visible answer (matches the Gemini adapter and the meter's Thinking row)
    det = u.get("completion_tokens_details") or {}
    rt = det.get("reasoning_tokens")
    if rt:
        out["reasoning"] = rt
        if out.get("output") is not None:
            out["output"] = max(0, out["output"] - rt)
    if u.get("prompt_tokens_details"):
        d = u["prompt_tokens_details"]
        if d.get("cached_tokens"):
            out["cache_read"] = d.get("cached_tokens")
    # DeepSeek's paid API reports context-cache hits under its own names —
    # without this the meter showed a 90%-discounted call as full-price input
    if u.get("prompt_cache_hit_tokens"):
        out["cache_read"] = u.get("prompt_cache_hit_tokens")
    return out


def stream(model, messages, opts, cancelled, cfg):
    opts = opts or {}
    base, env, key = _resolve(cfg)
    local = _is_local(cfg)
    if not key and not local:
        yield {"type": "content",
               "text": "\n[%s] %s is not set — add the key in Settings › Providers "
                       "or in .env to use this provider." % ((cfg or {}).get("id") or "openai", env)}
        yield {"type": "meta", "finish": "error"}
        return
    # system/developer messages are real roles in the OpenAI schema — never
    # collapse them into ordinary user turns (matches the Anthropic adapter)
    msgs = []
    for m in messages:
        role = m.get("role")
        if role in ("system", "developer", "user", "assistant"):
            msgs.append({"role": role, "content": m.get("content", "")})
        else:
            msgs.append({"role": "user", "content": m.get("content", "")})
    payload = {"model": model, "messages": msgs, "stream": True,
               "stream_options": {"include_usage": True}}
    # Prompt caching here is automatic and prefix-based — nothing to mark up.
    # prompt_cache_key just keeps one conversation's requests on the machine
    # that already holds its prefix, which is what makes the hit rate hold up.
    # OpenAI-compatible endpoints reject unknown fields, so only send it to
    # OpenAI itself.
    if opts.get("provider") == "openai" and opts.get("conv_id"):
        payload["prompt_cache_key"] = str(opts["conv_id"])[:64]
    # o-series models reject temperature/top_p and want max_completion_tokens;
    # sending max_tokens to them hard-fails the whole stream
    o_series = bool(re.match(r"^o[1-4](?:-|$)", model or ""))
    if not o_series:
        if opts.get("temperature") is not None:
            payload["temperature"] = opts["temperature"]
        if opts.get("top_p") is not None:
            payload["top_p"] = opts["top_p"]
    if opts.get("max_tokens") is not None:
        payload["max_completion_tokens" if o_series else "max_tokens"] = opts["max_tokens"]
    # reasoning effort: only meaningful on reasoning models; sending it to a
    # non-reasoning model makes some endpoints 400, so gate on the model name.
    effort = opts.get("reasoning_effort") or "auto"
    if effort in ("low", "medium", "high") and (
            o_series or re.search(r"reason|think|o[1-4]", model or "", re.I)):
        payload["reasoning_effort"] = effort
    headers = {
        "content-type": "application/json",
        "accept": "text/event-stream",
    }
    if key:
        headers["authorization"] = "Bearer " + key   # omitted for keyless local runtimes
    try:
        for ev, data in sse_client.post_sse(base + "/chat/completions", headers, payload, cancelled):
            if not isinstance(data, dict):
                continue  # "[DONE]" and friends
            if data.get("error"):
                # error-shaped chunk (e.g. auth failure, model not found) — must
                # NOT be silently ignored so the stream can end as "completed"
                err = data["error"]
                msg = err.get("message") if isinstance(err, dict) else str(err)
                raise RuntimeError("openai API error: %s" % (msg or err))
            if data.get("usage"):
                yield {"type": "meta", "usage": _norm_usage(data["usage"])}
            for ch in data.get("choices", []) or []:
                d = ch.get("delta") or {}
                if d.get("reasoning_content"):
                    yield {"type": "reasoning", "text": d["reasoning_content"]}
                elif d.get("reasoning"):
                    yield {"type": "reasoning", "text": d["reasoning"]}
                if d.get("content"):
                    yield {"type": "content", "text": d["content"]}
        yield {"type": "meta", "finish": "stop"}
    except Exception as e:
        yield {"type": "content", "text": "\n[openai error] %s" % friendly_error(e)}
        yield {"type": "meta", "finish": "error"}
