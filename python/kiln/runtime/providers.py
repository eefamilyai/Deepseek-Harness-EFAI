# providers.py — provider registry.
#
# Every provider is a separate module implementing the same contract:
#   PROVIDER_ID, DISPLAY_NAME, SCHEMA
#   models(cfg=None) -> list[str]
#   model_labels(cfg=None) -> dict[str, str]
#   default_model(cfg=None) -> str
#   check_config(cfg) -> (ok: bool, message: str)   # names the env var, never the key
#   stream(model, messages, opts, cancelled, cfg) -> yields
#       {"type": "reasoning" | "content" | "meta", ...}
#
# ds_direct (DeepSeek's free web session) is a first-class provider and the
# default: no API key, proof-of-work auth, and web-only model variants (Expert
# / Reasoner / Search / Vision). It predates the registry and has its own
# function signatures, so it is adapted here by a shim instead of being
# rewritten to fit the generic schema — its special behaviour stays untouched.
#
# Provider configs live in app_settings.json; keys NEVER do. A config stores
# base_url and api_key_env (the NAME of the .env variable), and the key is read
# from os.environ at request time. The redaction rule is absolute: no key value
# or cookie ever appears in an API response, event, log, or state file.
import importlib.util
import inspect
import json
import os
import urllib.error
import urllib.request

import app_settings
from token_usage import PROVIDER_LIMIT_CATALOGUES, context_limit

_DIR = os.path.dirname(os.path.abspath(__file__))

# Built-in provider order. `deepseek` first — it is the default and the whole
# reason the app exists. The openai adapter is reused for the OpenAI-compatible
# presets (OpenRouter, DeepSeek paid API) with different base/env/model lists.
# Every entry here is a preset the user can enable with one toggle + a key in
# .env. The long tail is covered two ways: OpenRouter reaches ~300 models
# behind one key, and the "Add provider" form takes any OpenAI-compatible
# base_url. `local: True` marks a keyless endpoint (Ollama / LM Studio) — no
# api_key_env, so the key check is skipped and no Authorization header is sent.
BUILTINS = [
    {"id": "deepseek", "module": "ds_direct", "schema": "deepseek-web",
     "name": "DeepSeek (free web)", "enabled": True},
    {"id": "anthropic", "module": "anthropic_provider", "schema": "anthropic",
     "name": "Anthropic (Claude)", "enabled": False,
     "base_url": "https://api.anthropic.com/v1", "api_key_env": "ANTHROPIC_API_KEY"},
    {"id": "openai", "module": "openai_provider", "schema": "openai",
     "name": "OpenAI (GPT)", "enabled": False,
     "base_url": "https://api.openai.com/v1", "api_key_env": "OPENAI_API_KEY"},
    {"id": "gemini", "module": "gemini_provider", "schema": "gemini",
     "name": "Google Gemini", "enabled": False,
     "base_url": "https://generativelanguage.googleapis.com/v1beta",
     "api_key_env": "GEMINI_API_KEY"},
    {"id": "openrouter", "module": "openai_provider", "schema": "openai",
     "name": "OpenRouter (300+ models)", "enabled": False,
     "base_url": "https://openrouter.ai/api/v1", "api_key_env": "OPENROUTER_API_KEY"},
    {"id": "deepseek-api", "module": "openai_provider", "schema": "openai",
     "name": "DeepSeek API", "enabled": False,
     "base_url": "https://api.deepseek.com", "api_key_env": "DEEPSEEK_API_KEY"},
    {"id": "groq", "module": "openai_provider", "schema": "openai",
     "name": "Groq", "enabled": False,
     "base_url": "https://api.groq.com/openai/v1", "api_key_env": "GROQ_API_KEY"},
    {"id": "xai", "module": "openai_provider", "schema": "openai",
     "name": "xAI (Grok)", "enabled": False,
     "base_url": "https://api.x.ai/v1", "api_key_env": "XAI_API_KEY"},
    {"id": "mistral", "module": "openai_provider", "schema": "openai",
     "name": "Mistral", "enabled": False,
     "base_url": "https://api.mistral.ai/v1", "api_key_env": "MISTRAL_API_KEY"},
    {"id": "together", "module": "openai_provider", "schema": "openai",
     "name": "Together AI", "enabled": False,
     "base_url": "https://api.together.xyz/v1", "api_key_env": "TOGETHER_API_KEY"},
    {"id": "fireworks", "module": "openai_provider", "schema": "openai",
     "name": "Fireworks AI", "enabled": False,
     "base_url": "https://api.fireworks.ai/inference/v1", "api_key_env": "FIREWORKS_API_KEY"},
    {"id": "perplexity", "module": "openai_provider", "schema": "openai",
     "name": "Perplexity", "enabled": False,
     "base_url": "https://api.perplexity.ai", "api_key_env": "PERPLEXITY_API_KEY"},
    {"id": "cerebras", "module": "openai_provider", "schema": "openai",
     "name": "Cerebras", "enabled": False,
     "base_url": "https://api.cerebras.ai/v1", "api_key_env": "CEREBRAS_API_KEY"},
    {"id": "nvidia", "module": "openai_provider", "schema": "openai",
     "name": "NVIDIA NIM", "enabled": False,
     "base_url": "https://integrate.api.nvidia.com/v1", "api_key_env": "NVIDIA_API_KEY"},
    # OmniRoute: a self-hosted OpenAI-compatible gateway (default port 20128).
    # 127.0.0.1 rather than localhost dodges the IPv6 resolution the project
    # warns about; the LLM endpoint is /v1 (the dashboard lives at /api).
    {"id": "omniroute", "module": "openai_provider", "schema": "openai",
     "name": "OmniRoute", "enabled": False,
     "base_url": "http://127.0.0.1:20128/v1", "api_key_env": "OMNIROUTE_API_KEY"},
    {"id": "ollama", "module": "openai_provider", "schema": "openai",
     "name": "Ollama (local)", "enabled": False, "local": True,
     "base_url": "http://localhost:11434/v1", "api_key_env": ""},
    {"id": "lmstudio", "module": "openai_provider", "schema": "openai",
     "name": "LM Studio (local)", "enabled": False, "local": True,
     "base_url": "http://localhost:1234/v1", "api_key_env": ""},
]
BUILTIN_IDS = {b["id"] for b in BUILTINS}

# ── module loading ──────────────────────────────────────
_MODULES = {}


def _load_module(module_name):
    if module_name not in _MODULES:
        spec = importlib.util.spec_from_file_location(
            module_name, os.path.join(_DIR, module_name + ".py"))
        mod = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(mod)
        _MODULES[module_name] = mod
    return _MODULES[module_name]


def _module_for(provider_id):
    for b in BUILTINS:
        if b["id"] == provider_id:
            return _load_module(b["module"])
    return _load_module("openai_provider")  # customs default to openai schema


def _call(mod, fn, cfg):
    """Call fn(cfg), falling back to fn() for modules (like ds_direct) whose
    functions predate the config parameter.

    The calling convention is decided up front from the signature — never by
    catching TypeError, which would also swallow genuine bugs raised INSIDE a
    correctly-called f(cfg).
    """
    f = getattr(mod, fn, None)
    if f is None:
        return None
    try:
        params = inspect.signature(f).parameters
        needs_cfg = any(p.kind in (inspect.Parameter.POSITIONAL_ONLY,
                                   inspect.Parameter.POSITIONAL_OR_KEYWORD,
                                   inspect.Parameter.VAR_POSITIONAL)
                        for p in params.values())
    except (TypeError, ValueError):
        # builtins / C functions without an introspectable signature
        needs_cfg = True
    return f(cfg) if needs_cfg else f()


# ── config resolution ───────────────────────────────────
def config_for(provider_id):
    """Merged config: builtin defaults + stored overrides (app_settings.json)."""
    builtin = next((b for b in BUILTINS if b["id"] == provider_id), None)
    stored = app_settings.get_provider_config(provider_id) or {}
    cfg = {"id": provider_id, "builtin": builtin is not None}
    if builtin:
        cfg["schema"] = builtin["schema"]
        for k in ("name", "base_url", "api_key_env", "enabled", "local"):
            if builtin.get(k) is not None:
                cfg.setdefault(k, builtin[k])
        cfg.setdefault("models", None)
    cfg.update({k: v for k, v in stored.items() if v is not None})
    # Register any persisted context catalogue immediately, so callers that go
    # straight from config_for() to context_limit() (server _api_start) still
    # get the real provider-reported windows, not the family fallback.
    stored_contexts = cfg.get("model_contexts")
    if stored_contexts:
        PROVIDER_LIMIT_CATALOGUES[provider_id] = stored_contexts
    return cfg


def provider_ids():
    stored_ids = [k for k in app_settings.load()["providers"]
                  if k not in BUILTIN_IDS]
    return [b["id"] for b in BUILTINS] + stored_ids


_auto_refreshed = set()   # providers we've already tried to live-query this process


def _catalog_models(provider_id, cfg, mod):
    """The models to REPORT for the picker — queried from the endpoint, never
    guessed. DeepSeek is the one exception: its free web session has a FIXED,
    known set of variants (not a hardcoded guess of someone else's catalogue),
    so it reports those directly. Every other provider reports only what a live
    `GET {base}/models` returned; without a key (or before the query) it reports
    nothing, so the picker shows 'add a key' rather than an invented list."""
    if provider_id == "deepseek":
        return _call(mod, "models", cfg) or []
    live = cfg.get("models")
    if isinstance(live, list) and live:
        return list(live)                          # a real fetch already cached
    # Enabled + keyed but nothing cached yet: query once, in-process, so the
    # first catalog read after enabling shows the endpoint's real list instead
    # of a blank. Bounded by `_auto_refreshed` so a dead endpoint isn't re-hit
    # on every catalog load.
    env = cfg.get("api_key_env") or ""
    keyed = bool(cfg.get("local")) or (env and os.environ.get(env))
    if cfg.get("enabled") and keyed and provider_id not in _auto_refreshed:
        _auto_refreshed.add(provider_id)
        try:
            ok, _n, _msg = refresh_models(provider_id)
            if ok:
                return list(config_for(provider_id).get("models") or [])
        except Exception:  # noqa: BLE001 — a failed query just means no models yet
            pass
    return []


def get_provider(provider_id):
    cfg = config_for(provider_id)
    mod = _module_for(provider_id)
    try:
        ms = _catalog_models(provider_id, cfg, mod)
        cfg = config_for(provider_id)              # a live query may have cached labels/contexts
        labels = _call(mod, "model_labels", cfg) or {}
        if isinstance(labels, dict) and hasattr(mod, "LABELS"):
            labels = getattr(mod, "LABELS")
        defm = _call(mod, "default_model", cfg) or (ms[0] if ms else "")
    except Exception:
        ms, labels, defm = [], {}, ""
    stored_contexts = cfg.get("model_contexts") or {}
    if stored_contexts:
        PROVIDER_LIMIT_CATALOGUES[provider_id] = stored_contexts

    def _limit_for(m):
        if m in stored_contexts:
            return int(stored_contexts[m])
        return context_limit(m, provider_id)

    has_key = bool((cfg.get("api_key_env") or "") and os.environ.get(cfg.get("api_key_env") or ""))
    # ds_direct is keyless in the API-key sense: it is live when a DeepSeek web
    # token/cookie is configured in ds_direct's own sources, not when an
    # api_key_env happens to be populated.
    if provider_id == "deepseek" and not has_key:
        try:
            has_key = bool(mod.configured())
        except Exception:
            has_key = False

    # Account ids for a provider that pools several logins. The harness turns
    # each into its own route so one agent can be pinned to one login. Ids only
    # — the id is an email or an explicit label, never a token or a password,
    # and this list crosses the same wire that reports `has_key` as a boolean.
    accounts = []
    if provider_id == "deepseek":
        try:
            accounts = [str(a) for a in mod.account_ids()]
        except Exception:  # noqa: BLE001 — an unreadable pool is simply no routes
            accounts = []

    return {
        "accounts": accounts,
        "id": provider_id,
        "name": cfg.get("name") or provider_id,
        "enabled": bool(cfg.get("enabled", False)),
        "builtin": bool(cfg.get("builtin", False)),
        "schema": cfg.get("schema", "openai"),
        "base_url": cfg.get("base_url", ""),
        "api_key_env": cfg.get("api_key_env", "") or "",
        "local": bool(cfg.get("local", False)),
        # whether a key is present in the environment — a boolean only, the
        # value itself is never included in any response
        "has_key": has_key,
        "stub": bool(getattr(mod, "STUB", False)),
        "models": [{"id": m, "name": (labels or {}).get(m, m),
                    "context_limit": _limit_for(m)} for m in ms],
        "default": defm,
        "tools": ["python"],
        "dangerous": [],
    }


def get_providers():
    """Full, redacted provider list for the picker + settings panel."""
    return [get_provider(pid) for pid in provider_ids()]


def default_model(provider_id):
    cfg = config_for(provider_id)
    mod = _module_for(provider_id)
    try:
        m = _call(mod, "default_model", cfg)
        if m:
            return m
        ms = _call(mod, "models", cfg) or []
        return ms[0] if ms else ""
    except Exception:
        return ""


def validate(provider_id):
    """(ok, message) using the module's check_config. Never leaks the key."""
    mod = _module_for(provider_id)
    cfg = config_for(provider_id)
    if provider_id == "deepseek":
        try:
            ds = _load_module("ds_direct")
            if not ds.configured():
                return False, ("no DeepSeek credentials — set either a token + cookie pair, "
                               "or an email (or mobile) and password to log in with")
        except Exception:
            pass
        return True, "ok"
    try:
        return mod.check_config(cfg)
    except Exception as e:
        return False, "validation error: %s" % e


# ── fetching model lists from the provider's own listing endpoint ──
# Every provider publishes its live catalogue; hardcoding a list only guarantees
# it goes stale. Each schema shapes the response differently, so the fetch is
# dispatched by schema and normalized to (ids, labels).
_FETCH_TIMEOUT = 8
_MODEL_CAP = 200


def _get_json(url, headers=None, timeout=_FETCH_TIMEOUT):
    _validate_base_url(url)
    req = urllib.request.Request(url)
    for k, v in (headers or {}).items():
        req.add_header(k, v)
    with urllib.request.urlopen(req, timeout=timeout) as resp:
        return json.loads(resp.read().decode("utf-8", "replace"))


def _fetch_openai_models(base_url, api_key):
    """GET {base}/models — OpenAI, OpenRouter, Groq, Mistral, Together, xAI,
    Ollama, LM Studio … all speak this. Newest first when a created stamp is
    present, so the picker leads with current models.

    Returns (ids, labels, contexts). `contexts` is model_id -> context_length
    for every endpoint that exposes it (OpenRouter does).
    """
    headers = {"authorization": "Bearer " + api_key} if api_key else {}
    data = _get_json(base_url.rstrip("/") + "/models", headers)
    rows = data.get("data") if isinstance(data, dict) else data
    rows = rows or []
    rows = sorted(rows, key=lambda m: m.get("created") or 0, reverse=True)
    ids, labels, contexts = [], {}, {}
    for m in rows:
        mid = m.get("id") or m.get("name")
        if not mid:
            continue
        ids.append(mid)
        # OpenRouter/Together ship a human name; fall back to the id
        nice = m.get("name") if isinstance(m.get("name"), str) and m.get("name") != mid else None
        if nice:
            labels[mid] = nice
        cl = m.get("context_length") or m.get("context_window") or m.get("max_tokens")
        if isinstance(cl, (int, float)) and int(cl) > 0:
            contexts[mid] = int(cl)
    return ids[:_MODEL_CAP], labels, contexts


def _fetch_anthropic_models(base_url, api_key):
    """GET {base}/models with x-api-key + anthropic-version. Anthropic returns
    a nice display_name per model."""
    if not api_key:
        return None, None, None
    import anthropic_provider as _ap
    headers = {"x-api-key": api_key, "anthropic-version": _ap.ANTHROPIC_VERSION}
    data = _get_json(base_url.rstrip("/") + "/models?limit=100", headers)
    ids, labels = [], {}
    for m in (data.get("data") or []):
        mid = m.get("id")
        if not mid:
            continue
        ids.append(mid)
        if m.get("display_name"):
            labels[mid] = m["display_name"]
    return ids[:_MODEL_CAP], labels, {}


def _fetch_gemini_models(base_url, api_key):
    """GET {base}/models?key= — Gemini names look like 'models/gemini-2.5-pro';
    keep only those that can actually generate content, strip the prefix.

    Returns (ids, labels, contexts). Gemini's metadata carries
    `inputTokenLimit`, the model's real context window.
    """
    if not api_key:
        return None, None, None
    from urllib.parse import quote
    data = _get_json(base_url.rstrip("/") + "/models?pageSize=200&key=" + quote(api_key))
    ids, labels, contexts = [], {}, {}
    for m in (data.get("models") or []):
        methods = m.get("supportedGenerationMethods") or []
        if "generateContent" not in methods:
            continue
        name = (m.get("name") or "")
        mid = name.split("/", 1)[1] if name.startswith("models/") else name
        if not mid:
            continue
        ids.append(mid)
        if m.get("displayName"):
            labels[mid] = m["displayName"]
        if isinstance(m.get("inputTokenLimit"), (int, float)) and int(m["inputTokenLimit"]) > 0:
            contexts[mid] = int(m["inputTokenLimit"])
    return ids[:_MODEL_CAP], labels, contexts


def fetch_models_for(cfg):
    """Live (ids, labels) for a provider config, by schema. (None, None) on any
    failure — the caller keeps whatever list it already had. Never raises."""
    schema = (cfg.get("schema") or "openai").lower()
    base = (cfg.get("base_url") or "").rstrip("/")
    env = cfg.get("api_key_env") or ""
    key = os.environ.get(env, "") if env else ""
    if not base:
        return None, None
    try:
        if schema == "anthropic":
            return _fetch_anthropic_models(base, key)
        if schema == "gemini":
            return _fetch_gemini_models(base, key)
        if schema == "deepseek-web":
            return None, None, None   # ds_direct has no catalogue endpoint
        return _fetch_openai_models(base, key)
    except Exception:
        return None, None, None


def fetch_models(base_url, api_key):
    """Back-compat: OpenAI-schema id list only (used by the add-provider form)."""
    try:
        ids, _, _ = _fetch_openai_models(base_url, api_key)
        return ids or None
    except Exception:
        return None


def refresh_models(provider_id):
    """Fetch the provider's live catalogue and persist it onto its stored
    config (models + model_labels). Returns (ok, count, message). The live
    list, once cached, wins over the module's hardcoded fallback everywhere.
    Never raises."""
    cfg = config_for(provider_id)
    if provider_id == "deepseek":
        return False, 0, "DeepSeek's free web session has fixed model variants — nothing to fetch"
    if not cfg.get("base_url"):
        return False, 0, "no base URL configured for this provider"
    # try the GET regardless of whether a key is set — plenty of catalogue
    # endpoints (NVIDIA NIM, local runtimes) list publicly. Only fall back to a
    # "set the key" hint when the fetch actually comes back empty.
    ids, labels, contexts = fetch_models_for(cfg)
    if not ids:
        env = cfg.get("api_key_env") or ""
        if env and not os.environ.get(env) and not cfg.get("local"):
            return False, 0, "%s is not set — add the key, then refresh" % env
        return False, 0, ("couldn't list models — check the API key and base URL, "
                          "or the endpoint may not expose a /models listing")
    stored = app_settings.get_provider_config(provider_id) or {}
    if not stored:                       # a builtin never saved before
        for k in ("name", "base_url", "api_key_env", "schema", "enabled", "local"):
            if cfg.get(k) is not None:
                stored[k] = cfg[k]
        stored["id"] = provider_id
    stored["models"] = ids
    if labels:
        stored["model_labels"] = labels
    if contexts:
        stored["model_contexts"] = contexts
    app_settings.set_provider_config(provider_id, stored)
    PROVIDER_LIMIT_CATALOGUES[provider_id] = contexts or {}
    return True, len(ids), "ok"


# ── streaming ───────────────────────────────────────────
def _deepseek_stream(model, messages, opts, cancelled, cfg):
    """Shim: adapt ds_direct's native signature to the registry contract.

    ds_direct keeps its own event vocabulary and session handling; only the
    envelope is normalized here. opts carries conv_id (per-conversation DeepSeek
    chat session) and temperature.
    """
    ds = _load_module("ds_direct")
    temperature = opts.get("temperature", 0.6)
    conv_id = opts.get("conv_id")
    max_tokens = opts.get("max_tokens")
    kwargs = {"temperature": temperature, "cancelled": cancelled, "conv_id": conv_id}
    if max_tokens:
        kwargs["max_tokens"] = max_tokens
    # A one-shot auxiliary call (compaction / session-title summary) runs in its
    # own throwaway chat instead of threading onto the conversation's persistent
    # one; the adapter marks it and supplies a unique conv_id.
    if opts.get("oneshot"):
        kwargs["oneshot"] = True
    # An account-pinned route names its login here; omitted means the ring picks.
    account = opts.get("account")
    if account:
        kwargs["account"] = account
    for ev in ds.stream(model, messages, **kwargs):
        # forward EVERY event ds_direct emits — dropping any of them hides
        # real signal from the UI: refs (web-search citations), notice
        # (busy-retry status), title (DeepSeek's auto-title for the chat)
        t = ev.get("type")
        if t == "refs":
            yield {"type": "refs", "refs": ev.get("refs", [])}
        elif t == "meta":
            # ds_direct's manual token accounting (input / cache_read / output /
            # reasoning) rides the same meta frame other providers use. Forward
            # it verbatim; the final `finish: stop` below closes the stream.
            yield ev
        elif t in ("content", "reasoning", "notice", "title"):
            yield {"type": t, "text": ev.get("text", "")}
    yield {"type": "meta", "finish": "stop"}


def _validate_base_url(url):
    """SSRF guard applied at the shared dispatch, so it covers builtin AND
    custom providers alike — every adapter fetches cfg.base_url and none of
    them may ever talk to a non-http(s) URL or one with embedded credentials."""
    if not url:
        return
    from urllib.parse import urlparse
    bu = urlparse(url)
    if bu.scheme not in ("http", "https") or bu.username or bu.password:
        raise ValueError("provider base_url must be http(s) without embedded credentials")


def _module_stream(provider_id, model_key, messages, opts, cancelled, cfg):
    mod = _module_for(provider_id)
    yield from mod.stream(model_key, messages, opts, cancelled, cfg)


# Clean, user-facing replacement for the context-overflow diagnostic. The meta
# frame's `error` field still carries the raw string so the harness recognises
# it and runs the same compaction as /compact; this is what the user sees
# instead of the raw "context window exceeded — ..." wording.
_COMPACT_NOTICE = (
    "This conversation reached its length limit, so I've condensed the earlier "
    "part to make room \u2014 the important context is kept, and I'm continuing."
)

def stream(provider_id, model_key, messages, opts=None, cancelled=None):
    """Provider dispatch: yield normalized events for the loop.

    Events: {"type": "reasoning"|"content"|"meta", ...}; meta may carry a
    `usage` dict (real numbers win over the estimator) and a `finish` marker.
    Errors become content + meta{finish:error} — never raised to the loop.
    """
    opts = dict(opts or {})
    cancelled = cancelled or (lambda: False)
    cfg = config_for(provider_id)
    try:
        # deepseek talks to its own hardcoded endpoints; every adapter-backed
        # provider (builtin or custom) gets its base_url checked up front
        if provider_id != "deepseek":
            _validate_base_url(cfg.get("base_url") or "")
        if provider_id == "deepseek":
            gen = _deepseek_stream(model_key, messages, opts, cancelled, cfg)
        else:
            gen = _module_stream(provider_id, model_key, messages, opts, cancelled, cfg)
        for ev in gen:
            yield ev
    except Exception as e:
        # The reason rides the meta frame's `error` field, not just the content:
        # the harness classifies the failure from that field (context overflow →
        # /compact + retry, rate limit → wait, else transport) and must never
        # have to scrape it back out of model-facing prose. Dropping it here made
        # every raised failure look like a generic transport error.
        raw = str(e)
        # Context-overflow keeps the raw wording in the machine `error` field
        # (the harness classifies from it and runs /compact), but the visible
        # content is a clean note rather than the internal diagnostic. Every
        # other failure keeps the labelled diagnostic so the user can tell it
        # apart from model prose.
        if "context window exceeded" in raw.lower():
            visible = _COMPACT_NOTICE
        else:
            visible = "[provider error] " + raw
        yield {"type": "content", "text": "\n" + visible}
        yield {"type": "meta", "finish": "error", "error": raw}


class ProviderClient:
    """Loop-facing provider: bound to one provider id, hides the registry."""

    def __init__(self, provider_id):
        self.provider_id = provider_id

    def stream(self, model_key, messages, opts=None, cancelled=lambda: False):
        opts = dict(opts or {})
        opts["provider"] = self.provider_id
        yield from stream(self.provider_id, model_key, messages, opts, cancelled)


class FakeProvider:
    """Scripted provider for loop testing (no network)."""
    def __init__(self, script):
        self.script = script
        self.i = 0

    def stream(self, model_key, messages, opts=None, cancelled=None):
        opts = opts or {}
        cancelled = cancelled or (lambda: False)
        idx = self.i
        self.i += 1
        if idx >= len(self.script):
            yield {"type": "content", "text": "The task is complete.\n{[(<DONE>)]}"}
            yield {"type": "meta", "finish": "stop"}
            return
        entry = self.script[idx]
        t = entry.get('type')
        if t == 'prose':
            yield {"type": "content", "text": entry.get('text','')}
            yield {"type": "meta", "finish": "stop"}
        elif t == 'code':
            code = entry.get('code','')
            text = f"Let me run that:\n```python\n{code}\n```"
            yield {"type": "content", "text": text}
        elif t == 'done':
            yield {"type": "content", "text": entry.get('text','Done.')+"\n{[(<DONE>)]}"}
            yield {"type": "meta", "finish": "stop"}
        elif t == 'bash':
            text = f"Let me run that:\n```bash\n{entry.get('code','')}\n```"
            yield {"type": "content", "text": text}
        elif t == 'show':
            text = f"Here's the code:\n```py\n{entry.get('code','')}\n```"
            yield {"type": "content", "text": text}
        elif t == 'raw':
            # emit content verbatim (used to test DSML tool-call handling)
            yield {"type": "content", "text": entry.get('text', '')}
            yield {"type": "meta", "finish": "stop"}
        elif t == 'reasoning':
            # thinking block, then the visible answer
            yield {"type": "reasoning", "text": entry.get('text', 'thinking')}
            if entry.get('answer'):
                yield {"type": "content", "text": entry['answer']}
                yield {"type": "meta", "finish": "stop"}
        else:
            yield {"type": "content", "text": "..."}
            yield {"type": "meta", "finish": "stop"}
