# A minimal stand-in for kernel_child.py, speaking the same frame protocol.
#
# The real runtime is ~6000 lines and boots in seconds; these tests are about
# the transport contract alone, so this fake implements exactly that contract
# and nothing else. Cell source is a directive rather than Python:
#
#   ECHO:<text>     answer with <text> as the cell's output
#   RAW:<text>      write <text> to the real fd 1 WITHOUT framing it, then
#                   answer normally -- the contamination this suite exists for
#   SILENT          answer with empty output (a cell that printed nothing)
#   EXIT            exit the process without answering
import base64
import json
import os
import sys

CELL_PREFIX = "\x00KILN_CELL\x00"
CTRL_PREFIX = "\x00KILN_CTRL\x00"

_PROTO = sys.stdout


def send(obj):
    _PROTO.write(base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii") + "\n")
    _PROTO.flush()


send({"ready": True, "engine": "fake"})

while True:
    line = sys.stdin.readline()
    if line == "" or line.strip() == "":
        break
    code = base64.b64decode(line.strip()).decode("utf-8")
    cell_id = None
    if code.startswith(CELL_PREFIX):
        envelope = json.loads(code[len(CELL_PREFIX):])
        code = envelope.get("code", "")
        cell_id = envelope.get("id")
    elif code.startswith(CTRL_PREFIX):
        req = json.loads(code[len(CTRL_PREFIX):])
        send({"out": "__KILN_KERNEL_STATE__" + json.dumps({"names": ["a", "b"]}),
              "error": None, "id": req.get("id")})
        continue

    if code == "EXIT":
        os._exit(0)
    if code.startswith("RAW:"):
        # Straight at the descriptor, exactly like os.system or a subprocess
        # that inherits stdio would. Never valid base64 JSON.
        os.write(1, (code[4:] + "\n").encode("utf-8"))
        send({"out": "after-raw", "error": None, "id": cell_id})
        continue
    if code == "SILENT":
        send({"out": "", "error": None, "id": cell_id})
        continue
    if code.startswith("ECHO:"):
        send({"out": code[5:], "error": None, "id": cell_id})
        continue
    send({"out": "", "error": "unknown directive: %s" % code, "id": cell_id})
