# A kernel stand-in that keeps state, so per-conversation isolation is provable.
#
# Each process holds its own namespace: `SET:a=1` here is invisible to another
# process, which is exactly what a real per-conversation kernel guarantees. The
# background cell id starts at 1 in every child, so two children collide — the
# provider has to remap them into handles of its own.
#
# Directives (cell source):
#   SET:<key>=<value>   store a value, answer "set"
#   GET:<key>           answer the value, or MISSING
#   SLEEP:<ms>          sleep, then answer "slept"
#   BG                  detach a cell and answer with backgroundId 1
import base64
import json
import sys
import time

CELL_PREFIX = "\x00KILN_CELL\x00"
CTRL_PREFIX = "\x00KILN_CTRL\x00"

_state = {}


def send(obj):
    sys.stdout.write(base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii") + "\n")
    sys.stdout.flush()


send({"ready": True, "engine": "conversation-fixture"})

for line in sys.stdin:
    if line.strip() == "":
        break
    code = base64.b64decode(line.strip()).decode("utf-8")
    cell_id = None
    if code.startswith(CELL_PREFIX):
        envelope = json.loads(code[len(CELL_PREFIX):])
        code = envelope.get("code", "")
        cell_id = envelope.get("id")
        conv = envelope.get("conv")
    elif code.startswith(CTRL_PREFIX):
        request = json.loads(code[len(CTRL_PREFIX):])
        command = request.get("cmd")
        if command == "list_names":
            send({"out": "__KILN_KERNEL_STATE__" + json.dumps({"names": sorted(_state)}),
                  "error": None, "id": request.get("id")})
        elif command == "bg_poll":
            send({"out": "__KILN_KERNEL_STATE__" + json.dumps(
                {"known": True, "running": False, "status": "finished", "text": "bg-done"}),
                "error": None, "id": request.get("id")})
        elif command == "bg_stop":
            send({"out": "__KILN_KERNEL_STATE__" + json.dumps({"stopped": True}),
                  "error": None, "id": request.get("id")})
        else:
            send({"out": "__KILN_KERNEL_STATE__" + json.dumps({}), "error": None, "id": request.get("id")})
        continue

    if code == "BG":
        send({"out": "detached", "error": None, "id": cell_id,
              "backgrounded": True, "backgroundId": 1})
        continue
    if code.startswith("SET:"):
        key, _, value = code[4:].partition("=")
        _state[key] = value
        send({"out": "set", "error": None, "id": cell_id})
        continue
    if code.startswith("GET:"):
        send({"out": _state.get(code[4:], "MISSING"), "error": None, "id": cell_id})
        continue
    if code.startswith("SLEEP:"):
        time.sleep(int(code[6:]) / 1000.0)
        send({"out": "slept", "error": None, "id": cell_id})
        continue
    send({"out": "", "error": "unknown directive: %s" % code, "id": cell_id})
