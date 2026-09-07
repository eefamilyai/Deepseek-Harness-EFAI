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
        self._ns[key] = value
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
                 "ctx_write", "ctx_read", "ctx_list", "llm_batch"):
        ns[name] = getattr(ctx, name)
    return ctx
