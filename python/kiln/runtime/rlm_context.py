"""RLM context-as-variable facet for the Kiln kernel (local overlay).

Implements the three primitives from the RLM paradigm on top of the existing
kernel namespace and the Python<->TS seam bridge:

  answer / set_answer / answer_ready / answer_content
      The terminal return value. The model edits `answer["content"]` in place
      and sets `answer["ready"] = True`; the harness reads it instead of
      treating an emitted assistant message as the answer.

  ctx_write / ctx_read / ctx_list
      Addressable context variables. ctx_write REPLACES (never appends), keeps
      the live object in the namespace, and writes a durable disk copy through
      the existing remember()/kiln_memory tier so it survives restarts.

  llm_batch
      Fan out clean-context child LLM calls through the harness seam; each
      child returns a value that is ASSIGNED into the namespace (`sub_N`)
      rather than appended to the transcript. The parent prints only the
      slices it chooses to see.

This module does not import kernel_child (it would circular-import); it is
installed by kernel_child via `rlm_context.install(_ns, _seam_request)`.
"""

import json


def _to_text(value):
    if isinstance(value, str):
        return value
    if isinstance(value, (bytes, bytearray)):
        return value.decode("utf-8", "replace")
    try:
        if isinstance(value, (dict, list, tuple)):
            return json.dumps(value, ensure_ascii=False, indent=2, default=repr)
    except Exception:
        pass
    return repr(value)


class RlmContext:
    def __init__(self, ns, seam_request):
        self._ns = ns
        self._seam = seam_request
        self.answer = {"content": "", "ready": False}
        self._written = set()
        # Names the model may NOT shadow with ctx_write: the namespace is the
        # harness's live surface, and overwriting a helper (remember, recall,
        # llm_batch, rlm_dump, ...) would silently break later capability.
        # Snapshot the callables present at install time; the facet's own names
        # are added by install() below.
        self._reserved = {
            key for key, value in ns.items()
            if key.startswith("_") is False and callable(value)
        }

    # -- terminal answer value ------------------------------------------------
    def set_answer(self, content, ready=True):
        self.answer["content"] = _to_text(content)
        self.answer["ready"] = bool(ready)
        return ("answer set (%d chars, ready=%s)"
                % (len(self.answer["content"]), self.answer["ready"]))

    def answer_ready(self):
        return bool(self.answer.get("ready"))

    def answer_content(self):
        return self.answer.get("content", "")

    # -- addressable context variables ---------------------------------------
    def ctx_write(self, name, value):
        key = str(name).strip()
        if not key:
            return "ctx_write: name must not be empty"
        # Fix #5: a context bind is data, never a replacement for the harness
        # surface. Refuse to shadow any pre-installed callable or this facet's
        # own primitives; the model sees the conflict instead of silently
        # losing a capability it may still need.
        if key in self._reserved:
            return ("ctx_write: %r is reserved (it is a harness/facet primitive);"
                    " choose another name" % key)
        self._ns[key] = value
        self._written.add(key)
        try:
            self._ns["remember"](key, value)
        except Exception:
            pass
        return "ctx %r = %s" % (key, type(value).__name__)

    def ctx_read(self, name, start=1, lines=200):
        key = str(name)
        if key in self._ns and not callable(self._ns[key]):
            return self._ns[key]
        try:
            return self._ns["recall"](key, start, lines)
        except Exception as exc:
            return "ctx_read %r: %s" % (key, exc)

    def ctx_list(self):
        rows = []
        for key in sorted(self._ns):
            if key.startswith("_"):
                continue
            value = self._ns[key]
            if callable(value):
                continue
            rows.append("%-24s %s" % (key, type(value).__name__))
        return "\n".join(rows) if rows else "(no context variables)"


    # -- machine-readable snapshot for the harness read-back path -----------
    _RLM_MARKER = "__KILN_RLM_STATE__"

    @staticmethod
    def _json_safe(value):
        try:
            json.dumps(value)
            return value
        except Exception:
            try:
                return repr(value)
            except Exception:
                return "<unserializable>"

    def rlm_dump(self):
        """Emit one marker line carrying answer + tracked binds as JSON.

        This is the TS->Python query target: KernelContextService runs
        ``rlm_dump()`` through ``ctx.kernel.execute`` and parses the marker.
        It is a pure read -- it mutates nothing and prints nothing else.
        """
        names = set(self._written)
        for key in self._ns:
            if key.startswith("sub_"):
                names.add(key)
        binds = {}
        for key in sorted(names):
            if key not in self._ns:
                continue
            value = self._ns[key]
            if callable(value):
                continue
            binds[key] = self._json_safe(value)
        payload = json.dumps({
            "answer": {
                "content": self.answer.get("content", ""),
                "ready": bool(self.answer.get("ready")),
            },
            "binds": binds,
        }, ensure_ascii=False, default=repr)
        print("%s %s" % (self._RLM_MARKER, payload))
        return payload

    # -- clean-context child fan-out -----------------------------------------
    def llm_batch(self, prompts, tools=None, model=None):
        if isinstance(prompts, str):
            prompts = [prompts]
        if not isinstance(prompts, (list, tuple)):
            return "llm_batch: prompts must be a list of strings"
        prompts = [str(p) for p in prompts]
        resp = self._seam("rlm.llm_batch",
                          {"prompts": prompts, "tools": tools, "model": model})
        if resp is None:
            return "llm_batch: seam unavailable"
        if not resp.get("ok"):
            if resp.get("unavailable"):
                return "llm_batch: harness seam unavailable (%s)" % resp.get("error")
            return "llm_batch error: %s" % resp.get("error")
        results = resp.get("value", {}).get("results", [])
        for i, result in enumerate(results):
            self._ns["sub_%d" % i] = result
        return results


def install(ns, seam_request):
    """Install the RLM facet into the kernel namespace. Returns the RlmContext."""
    ctx = RlmContext(ns, seam_request)
    ns["answer"] = ctx.answer
    for name in ("set_answer", "answer_ready", "answer_content",
                 "ctx_write", "ctx_read", "ctx_list", "llm_batch",
                 "rlm_dump"):
        ns[name] = getattr(ctx, name)
    # Fix #5: mark this facet's own surface as non-shadowable as well. The
    # constructor already snapshotted every pre-existing callable, so the union
    # now covers both the core helpers and the facet primitives.
    ctx._reserved.update({
        "answer", "set_answer", "answer_ready", "answer_content",
        "ctx_write", "ctx_read", "ctx_list", "llm_batch", "rlm_dump",
    })
    return ctx
