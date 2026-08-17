# gemini_provider.py — Google Gemini (generativelanguage) adapter.
#
# Google's API is NOT OpenAI-compatible, so it needs its own adapter:
#   POST {base}/models/{model}:streamGenerateContent?alt=sse&key={KEY}
#   body:    {"system_instruction": {...}, "contents": [{role, parts:[{text}]}],
#             "generationConfig": {...}}
#   SSE:     each data: chunk carries
#            {"candidates":[{"content":{"parts":[{"text":...}]}}], "usageMetadata": {...}}
#   auth:    the API key goes in the query string (?key=), not a header
#
# The key is read at request time from the .env variable named by
# cfg["api_key_env"] (default GEMINI_API_KEY) — never stored, logged, or
# returned. The live model list is fetched by providers.refresh_models();
# MODELS below is only a pre-fetch fallback.
import os

import sse_client
from provider_errors import friendly_error

PROVIDER_ID = "gemini"
DISPLAY_NAME = "Google Gemini"
SCHEMA = "gemini"
DEFAULT_BASE = "https://generativelanguage.googleapis.com/v1beta"
DEFAULT_ENV = "GEMINI_API_KEY"

MODELS = [
    ("gemini-2.5-pro", "Gemini 2.5 Pro"),
    ("gemini-2.5-flash", "Gemini 2.5 Flash"),
    ("gemini-2.0-flash", "Gemini 2.0 Flash"),
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
        return False, "%s is not set — add it in Settings › Providers or in .env" % env
    if len(key) < 12:
        return False, "%s looks too short for an API key" % env
    return True, "ok"


# ── message mapping ──────────────────────────────────────
# Gemini has no "system" role: system text goes in a separate
# `system_instruction`, and the only turn roles are "user" and "model".
def _to_gemini(messages):
    system_parts = []
    contents = []
    for m in messages:
        role = m.get("role")
        text = m.get("content", "") or ""
        if role in ("system", "developer"):
            if text:
                system_parts.append(text)
            continue
        grole = "model" if role == "assistant" else "user"
        # Gemini rejects empty parts and consecutive same-role turns; merge a
        # run of the same role into one content block
        if contents and contents[-1]["role"] == grole:
            contents[-1]["parts"].append({"text": text})
        else:
            contents.append({"role": grole, "parts": [{"text": text}]})
    return system_parts, contents


def _norm_usage(u):
    if not isinstance(u, dict):
        return {}
    out = {}
    if u.get("promptTokenCount") is not None:
        out["input"] = u.get("promptTokenCount")
    # candidatesTokenCount is the generated (visible) text; thoughtsTokenCount is
    # the hidden reasoning — kept in its OWN category, not folded into output
    if u.get("candidatesTokenCount"):
        out["output"] = u.get("candidatesTokenCount")
    if u.get("thoughtsTokenCount"):
        out["reasoning"] = u.get("thoughtsTokenCount")
    if u.get("cachedContentTokenCount"):
        out["cache_read"] = u.get("cachedContentTokenCount")
    return out


def stream(model, messages, opts, cancelled, cfg):
    opts = opts or {}
    base, env, key = _resolve(cfg)
    if not key:
        yield {"type": "content",
               "text": "\n[gemini] %s is not set — add the key in Settings › Providers "
                       "or in .env to use this provider." % env}
        yield {"type": "meta", "finish": "error"}
        return
    system_parts, contents = _to_gemini(messages)
    gen_cfg = {}
    if opts.get("temperature") is not None:
        gen_cfg["temperature"] = opts["temperature"]
    if opts.get("top_p") is not None:
        gen_cfg["topP"] = opts["top_p"]
    if opts.get("max_tokens") is not None:
        gen_cfg["maxOutputTokens"] = opts["max_tokens"]
    payload = {"contents": contents}
    if system_parts:
        payload["system_instruction"] = {"parts": [{"text": "\n\n".join(system_parts)}]}
    if gen_cfg:
        payload["generationConfig"] = gen_cfg
    # the key rides in the query string; content-type only in the header
    from urllib.parse import quote
    url = "%s/models/%s:streamGenerateContent?alt=sse&key=%s" % (
        base, quote(model), quote(key))
    headers = {"content-type": "application/json", "accept": "text/event-stream"}
    try:
        for _ev, data in sse_client.post_sse(url, headers, payload, cancelled):
            if not isinstance(data, dict):
                continue
            if data.get("error"):
                err = data["error"]
                msg = err.get("message") if isinstance(err, dict) else str(err)
                raise RuntimeError("gemini API error: %s" % (msg or err))
            for cand in data.get("candidates", []) or []:
                for part in (cand.get("content") or {}).get("parts", []) or []:
                    # a part flagged `thought` is Gemini's reasoning trace
                    if part.get("thought") and part.get("text"):
                        yield {"type": "reasoning", "text": part["text"]}
                    elif part.get("text"):
                        yield {"type": "content", "text": part["text"]}
            if data.get("usageMetadata"):
                yield {"type": "meta", "usage": _norm_usage(data["usageMetadata"])}
        yield {"type": "meta", "finish": "stop"}
    except Exception as e:
        yield {"type": "content", "text": "\n[gemini error] %s" % friendly_error(e)}
        yield {"type": "meta", "finish": "error"}
