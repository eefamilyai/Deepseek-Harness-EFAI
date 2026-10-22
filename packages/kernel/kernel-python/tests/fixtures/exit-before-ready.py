# A kernel stand-in that dies before its ready frame the first time it starts.
#
# The provider retries a child that never became ready, because such a child
# never ran the cell. This fixture is how that is proved: it records the failed
# start in DSH_TEST_FAIL_ONCE and exits, so a cell that succeeds afterwards can
# only have run in a SECOND process.
import base64
import json
import os
import sys

MARKER = os.environ.get("DSH_TEST_FAIL_ONCE")

if MARKER:
    if not os.path.exists(MARKER):
        with open(MARKER, "w", encoding="utf-8") as handle:
            handle.write("first start failed\n")
        sys.exit(1)

CELL_PREFIX = "\x00KILN_CELL\x00"


def send(obj):
    sys.stdout.write(base64.b64encode(json.dumps(obj).encode("utf-8")).decode("ascii") + "\n")
    sys.stdout.flush()


send({"ready": True, "engine": "retry-fixture"})

for line in sys.stdin:
    if line.strip() == "":
        break
    code = base64.b64decode(line.strip()).decode("utf-8")
    cell_id = None
    if code.startswith(CELL_PREFIX):
        envelope = json.loads(code[len(CELL_PREFIX):])
        code = envelope.get("code", "")
        cell_id = envelope.get("id")
    send({"out": "second-start:" + code, "error": None, "id": cell_id})
