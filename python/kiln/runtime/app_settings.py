# app_settings.py — app-level settings that are NOT part of any conversation:
# provider configurations (name, base_url, api_key_env, enabled, schema), the
# default model for new chats, and context-compaction behavior. Stored in
# app_settings.json (gitignored), written atomically. API keys never live here
# — only the NAME of the .env variable that holds the key.
import json
import os
import tempfile
import threading

from compaction import DEFAULT_COMPACTION_SETTINGS

_DIR = os.path.dirname(os.path.abspath(__file__))
_PATH = os.environ.get("KILN_APP_SETTINGS") or os.path.join(_DIR, "app_settings.json")

_lock = threading.Lock()
_cache = None


def _defaults():
    return {
        "providers": {},
        "default": {"provider": "deepseek", "model": "deepseek-default"},
        "personalization": {"name": ""},
        "compaction": dict(DEFAULT_COMPACTION_SETTINGS),
    }


def load():
    """Return the in-memory settings dict (never stale, never None)."""
    global _cache
    with _lock:
        if _cache is None:
            try:
                with open(_PATH, "r", encoding="utf-8") as f:
                    _cache = json.load(f)
            except Exception:
                _cache = _defaults()
            if not isinstance(_cache, dict):
                _cache = _defaults()
            _cache.setdefault("providers", {})
            _cache.setdefault("default", _defaults()["default"])
            _cache.setdefault("personalization", {"name": ""})
            _cache.setdefault("compaction", dict(DEFAULT_COMPACTION_SETTINGS))
        return _cache


def _write(data):
    folder = os.path.dirname(_PATH) or "."
    fd, tmp = tempfile.mkstemp(dir=folder, prefix=".app_settings-", suffix=".tmp")
    try:
        with os.fdopen(fd, "w", encoding="utf-8") as f:
            json.dump(data, f, indent=2, ensure_ascii=False)
        os.replace(tmp, _PATH)
    except Exception:
        try:
            os.unlink(tmp)
        except OSError:
            pass
        raise


def save():
    with _lock:
        _write(_cache)


# ── provider configs ─────────────────────────────────────
def get_provider_config(provider_id):
    return load()["providers"].get(provider_id)


def set_provider_config(provider_id, cfg):
    load()["providers"][provider_id] = cfg
    save()


def delete_provider_config(provider_id):
    load()["providers"].pop(provider_id, None)
    save()


# ── default model ────────────────────────────────────────
def get_default():
    d = load()["default"]
    return dict(d)


def set_default(provider, model):
    load()["default"] = {"provider": provider, "model": model}
    save()


# ── context compaction ──────────────────────────────────
def get_compaction():
    cfg = dict(load().get("compaction") or {})
    merged = dict(DEFAULT_COMPACTION_SETTINGS)
    merged.update({k: v for k, v in cfg.items() if v is not None})
    return merged


def set_compaction(cfg):
    """Validate + persist compaction settings (enabled, reserve_tokens,
    keep_recent_tokens). Malformed values fall back to defaults."""
    c = dict(DEFAULT_COMPACTION_SETTINGS)
    if isinstance(cfg, dict):
        if "enabled" in cfg:
            c["enabled"] = bool(cfg["enabled"])
        for key in ("reserve_tokens", "keep_recent_tokens"):
            try:
                v = int(cfg.get(key))
            except (TypeError, ValueError):
                v = DEFAULT_COMPACTION_SETTINGS[key]
            c[key] = max(256, min(v, 1000000))
    load()["compaction"] = c
    save()
    return c


# ── personalization ─────────────────────────────────────
_DEFAULT_PERSONALIZATION = {
    "name": "",
    "tone": "",          # communication style, e.g. "concise", "friendly"
    "instructions": "",  # free-form custom instructions/preferences
    "autorun_default": True,  # whether new chats start in auto-run mode
    "plan_mode_default": True,  # whether new chats start in read-only plan mode
}


def get_personalization():
    p = dict(load().get("personalization") or {})
    merged = dict(_DEFAULT_PERSONALIZATION)
    merged.update({k: v for k, v in p.items() if v is not None})
    return merged


def set_personalization(p):
    """Merge + persist user preferences (name, tone, custom instructions,
    default auto-run). Unknown keys are ignored; values are trimmed."""
    cur = get_personalization()
    if isinstance(p, dict):
        if "name" in p:
            cur["name"] = (p.get("name") or "").strip()[:60]
        if "tone" in p:
            cur["tone"] = (p.get("tone") or "").strip()[:200]
        if "instructions" in p:
            cur["instructions"] = (p.get("instructions") or "").strip()[:4000]
        if "autorun_default" in p:
            cur["autorun_default"] = bool(p.get("autorun_default", True))
        if "plan_mode_default" in p:
            cur["plan_mode_default"] = bool(p.get("plan_mode_default", True))
    load()["personalization"] = cur
    save()
    return cur


def set_name(name):
    """Back-compat: set just the display name (greetings + model address)."""
    return set_personalization({"name": name})
