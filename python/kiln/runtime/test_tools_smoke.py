#!/usr/bin/env python
"""Smoke-test every public kernel tool through a real kernel_child.py subprocess.

Run:  python test_tools_smoke.py
The bundled interpreter lives at ./.venv/Scripts/python.exe (or sys.executable here).
"""
import base64, json, os, queue, subprocess, sys, threading

KERNEL = os.path.join(os.path.dirname(os.path.abspath(__file__)), "kernel_child.py")
PY = sys.executable


def main():
    proc = subprocess.Popen([PY, KERNEL], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
                            stderr=subprocess.PIPE, bufsize=0)
    q = queue.Queue()

    def reader():
        for raw in iter(proc.stdout.readline, b""):
            line = raw.strip()
            if not line:
                continue
            try:
                q.put(json.loads(base64.b64decode(line).decode("utf-8")))
            except Exception as e:
                q.put({"__reader_error__": repr(e)})

    threading.Thread(target=reader, daemon=True).start()

    def send(code):
        proc.stdin.write(base64.b64encode(code.encode("utf-8")) + b"\n")
        proc.stdin.flush()

    def recv(timeout=120):
        return q.get(timeout=timeout)

    try:
        ready = recv(20)
        assert ready.get("ready"), ready

        with open(os.path.join(os.path.dirname(os.path.abspath(__file__)), "_smoke_cell.py"),
                  "r", encoding="utf-8") as f:
            cell = f.read()

        send(cell)
        result = recv(120)
        print(result.get("out", ""))
        if result.get("error"):
            print("CELL ERROR:\n", result["error"], file=sys.stderr)
            return 2
        # score: count PASS/FAIL markers from stdout
        out = result.get("out", "")
        passed = out.count('"status": "PASS"') + out.count("PASS")
        failed = out.count('"status": "FAIL"') + out.count("FAIL")
        print(f"\n[runner] approx PASS={passed} FAIL={failed}")
        return 0 if failed == 0 else 1
    finally:
        try:
            proc.stdin.close()
        except Exception:
            pass
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
