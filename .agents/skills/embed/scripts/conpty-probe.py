"""Can this machine host a real terminal, and does typing into it work?

Run this **on the machine that will host the terminal**, before designing anything
around one. It answers the only two questions that matter, in the order they have
to be answered:

1. does a child process attached to a pseudo-console produce output at all?
2. does input written to that console actually reach the child?

They fail independently, and they look alike from the outside — a blank terminal
either way — so a single combined test misdiagnoses which half is broken.

    python conpty-probe.py            # human-readable verdict
    python conpty-probe.py --json     # machine-readable

Exit code 0 means a real terminal is possible here. 1 means input is broken.
2 means the child never produced output (attachment failed). 3 means no ConPTY.

The one-shot child in the first test is the point of it: a child that prints a
marker and exits proves, on its own, whether output flows. If that marker never
arrives, do not go looking at input — the console was never attached.

Two requirements are easy to miss, and both are silent:

* ``STARTF_USESTDHANDLES`` with all three standard handles set to
  ``INVALID_HANDLE_VALUE``. Without it the child inherits *this* process's stdio,
  so its output goes wherever this process's stdout goes (a log file, an ssh
  channel) instead of into the console, and an interactive shell exits at once
  because its stdin is at EOF.
* One ``ResizePseudoConsole`` after ``CreatePseudoConsole``. A fresh console emits
  its startup sequence and then nothing, however much the child writes.
"""

from __future__ import annotations

import ctypes
import json
import os
import sys
import threading
import time
from ctypes import wintypes as wt

EXTENDED_STARTUPINFO_PRESENT = 0x00080000
PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE = 0x00020016
STARTF_USESTDHANDLES = 0x00000100

kernel32 = ctypes.WinDLL("kernel32", use_last_error=True)


class COORD(ctypes.Structure):
    _fields_ = [("X", ctypes.c_short), ("Y", ctypes.c_short)]


class STARTUPINFOW(ctypes.Structure):
    _fields_ = [
        ("cb", wt.DWORD), ("lpReserved", wt.LPWSTR), ("lpDesktop", wt.LPWSTR),
        ("lpTitle", wt.LPWSTR), ("dwX", wt.DWORD), ("dwY", wt.DWORD),
        ("dwXSize", wt.DWORD), ("dwYSize", wt.DWORD), ("dwXCountChars", wt.DWORD),
        ("dwYCountChars", wt.DWORD), ("dwFillAttribute", wt.DWORD), ("dwFlags", wt.DWORD),
        ("wShowWindow", wt.WORD), ("cbReserved2", wt.WORD),
        ("lpReserved2", ctypes.POINTER(ctypes.c_byte)),
        ("hStdInput", wt.HANDLE), ("hStdOutput", wt.HANDLE), ("hStdError", wt.HANDLE),
    ]


class STARTUPINFOEXW(ctypes.Structure):
    _fields_ = [("StartupInfo", STARTUPINFOW), ("lpAttributeList", ctypes.c_void_p)]


class PROCESS_INFORMATION(ctypes.Structure):
    _fields_ = [("hProcess", wt.HANDLE), ("hThread", wt.HANDLE),
                ("dwProcessId", wt.DWORD), ("dwThreadId", wt.DWORD)]


def bind() -> None:
    k = kernel32
    k.CreatePipe.argtypes = [ctypes.POINTER(wt.HANDLE), ctypes.POINTER(wt.HANDLE),
                             ctypes.c_void_p, wt.DWORD]
    k.CreatePseudoConsole.argtypes = [COORD, wt.HANDLE, wt.HANDLE, wt.DWORD,
                                      ctypes.POINTER(wt.HANDLE)]
    k.CreatePseudoConsole.restype = ctypes.c_long
    k.ResizePseudoConsole.argtypes = [wt.HANDLE, COORD]
    k.ResizePseudoConsole.restype = ctypes.c_long
    k.ClosePseudoConsole.argtypes = [wt.HANDLE]
    k.InitializeProcThreadAttributeList.argtypes = [ctypes.c_void_p, wt.DWORD, wt.DWORD,
                                                    ctypes.POINTER(ctypes.c_size_t)]
    k.InitializeProcThreadAttributeList.restype = wt.BOOL
    k.UpdateProcThreadAttribute.argtypes = [ctypes.c_void_p, wt.DWORD, ctypes.c_size_t,
                                            ctypes.c_void_p, ctypes.c_size_t,
                                            ctypes.c_void_p, ctypes.POINTER(ctypes.c_size_t)]
    k.UpdateProcThreadAttribute.restype = wt.BOOL
    k.DeleteProcThreadAttributeList.argtypes = [ctypes.c_void_p]
    k.CreateProcessW.argtypes = [wt.LPCWSTR, wt.LPWSTR, ctypes.c_void_p, ctypes.c_void_p,
                                 wt.BOOL, wt.DWORD, ctypes.c_void_p, wt.LPCWSTR,
                                 ctypes.c_void_p, ctypes.POINTER(PROCESS_INFORMATION)]
    k.CreateProcessW.restype = wt.BOOL
    k.ReadFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                           ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
    k.ReadFile.restype = wt.BOOL
    k.WriteFile.argtypes = [wt.HANDLE, ctypes.c_void_p, wt.DWORD,
                            ctypes.POINTER(wt.DWORD), ctypes.c_void_p]
    k.WriteFile.restype = wt.BOOL
    k.CloseHandle.argtypes = [wt.HANDLE]
    k.TerminateProcess.argtypes = [wt.HANDLE, wt.UINT]
    k.WaitForSingleObject.argtypes = [wt.HANDLE, wt.DWORD]
    k.GetExitCodeProcess.argtypes = [wt.HANDLE, ctypes.POINTER(wt.DWORD)]


class Session:
    """One pseudo-console and the child attached to it."""

    def __init__(self, command: str, cols: int = 120, rows: int = 30, cwd: str | None = None):
        self.in_write = wt.HANDLE()
        self.out_read = wt.HANDLE()
        pty_in, pty_out = wt.HANDLE(), wt.HANDLE()
        if not kernel32.CreatePipe(ctypes.byref(pty_in), ctypes.byref(self.in_write), None, 0):
            raise OSError(f"CreatePipe (stdin) failed: {ctypes.get_last_error()}")
        if not kernel32.CreatePipe(ctypes.byref(self.out_read), ctypes.byref(pty_out), None, 0):
            raise OSError(f"CreatePipe (stdout) failed: {ctypes.get_last_error()}")

        self.hpc = wt.HANDLE()
        size = COORD(cols, rows)
        hr = kernel32.CreatePseudoConsole(size, pty_in, pty_out, 0, ctypes.byref(self.hpc))
        if hr != 0:
            raise OSError(f"CreatePseudoConsole failed: 0x{hr & 0xFFFFFFFF:08x}")
        # Requirement 2: without this the console renders nothing at all.
        kernel32.ResizePseudoConsole(self.hpc, size)

        # The console owns these ends now. Holding them open here is not fatal but
        # it does stop the reader ever seeing end-of-file.
        kernel32.CloseHandle(pty_in)
        kernel32.CloseHandle(pty_out)

        need = ctypes.c_size_t(0)
        kernel32.InitializeProcThreadAttributeList(None, 1, 0, ctypes.byref(need))
        self.attr = ctypes.create_string_buffer(need.value)
        if not kernel32.InitializeProcThreadAttributeList(self.attr, 1, 0, ctypes.byref(need)):
            raise OSError(f"InitializeProcThreadAttributeList failed: {ctypes.get_last_error()}")
        # The handle *by value*, which is what the documented sample and wezterm both do.
        if not kernel32.UpdateProcThreadAttribute(
                self.attr, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                self.hpc, ctypes.sizeof(wt.HANDLE), None, None):
            raise OSError(f"UpdateProcThreadAttribute failed: {ctypes.get_last_error()}")

        startup = STARTUPINFOEXW()
        startup.StartupInfo.cb = ctypes.sizeof(STARTUPINFOEXW)
        startup.lpAttributeList = ctypes.cast(self.attr, ctypes.c_void_p)
        # Requirement 1: point the standard handles at nothing, explicitly, or the
        # child inherits this process's redirected stdio and never uses the console.
        startup.StartupInfo.dwFlags = STARTF_USESTDHANDLES
        nothing = wt.HANDLE(-1)
        startup.StartupInfo.hStdInput = nothing
        startup.StartupInfo.hStdOutput = nothing
        startup.StartupInfo.hStdError = nothing

        buf = ctypes.create_unicode_buffer(command)
        self.pi = PROCESS_INFORMATION()
        if not kernel32.CreateProcessW(None, buf, None, None, False,
                                       EXTENDED_STARTUPINFO_PRESENT, None,
                                       cwd or os.getcwd(), ctypes.byref(startup),
                                       ctypes.byref(self.pi)):
            raise OSError(f"CreateProcess failed: {ctypes.get_last_error()}")
        kernel32.DeleteProcThreadAttributeList(self.attr)
        kernel32.CloseHandle(self.pi.hThread)

        self.chunks: list[bytes] = []
        self._stop = threading.Event()
        threading.Thread(target=self._pump, daemon=True).start()

    def _pump(self) -> None:
        buf = ctypes.create_string_buffer(65536)
        got = wt.DWORD(0)
        while not self._stop.is_set():
            if not kernel32.ReadFile(self.out_read, buf, 65536, ctypes.byref(got), None):
                break
            if got.value == 0:
                break
            self.chunks.append(buf.raw[:got.value])

    def collect(self, seconds: float) -> bytes:
        time.sleep(seconds)
        return b"".join(self.chunks)

    def write(self, data: bytes) -> bool:
        written = wt.DWORD(0)
        return bool(kernel32.WriteFile(self.in_write, data, len(data),
                                       ctypes.byref(written), None))

    def alive(self) -> bool:
        return kernel32.WaitForSingleObject(self.pi.hProcess, 0) != 0

    def exit_code(self) -> int:
        code = wt.DWORD(0)
        kernel32.GetExitCodeProcess(self.pi.hProcess, ctypes.byref(code))
        return code.value

    def close(self) -> None:
        self._stop.set()
        try:
            kernel32.TerminateProcess(self.pi.hProcess, 0)
            kernel32.CloseHandle(self.pi.hProcess)
        except Exception:
            pass
        try:
            kernel32.ClosePseudoConsole(self.hpc)
        except Exception:
            pass
        for handle in (self.in_write, self.out_read):
            try:
                kernel32.CloseHandle(handle)
            except Exception:
                pass


def main() -> int:
    as_json = "--json" in sys.argv
    root = os.environ.get("SystemRoot", r"C:\Windows")
    cmd_exe = os.path.join(root, "System32", "cmd.exe")
    powershell = os.path.join(root, r"System32\WindowsPowerShell\v1.0\powershell.exe")
    shell = powershell if os.path.isfile(powershell) else cmd_exe

    result: dict = {"output_works": False, "input_works": False, "notes": []}

    # --- Does a child attached to a console produce output? -----------------
    marker = "CONPTY-OUTPUT-MARKER"
    try:
        one_shot = Session(f'"{cmd_exe}" /c "echo {marker}"')
    except OSError as exc:
        result["fatal"] = str(exc)
        print(json.dumps(result, indent=2) if as_json else
              f"No ConPTY on this machine: {exc}\n"
              f"The kernel does not export CreatePseudoConsole (needs Windows 10 1809+).")
        return 3

    blob = one_shot.collect(5)
    result["output_works"] = marker.encode() in blob
    result["output_bytes"] = len(blob)
    result["one_shot_exit_code"] = one_shot.exit_code()
    one_shot.close()

    if not result["output_works"]:
        result["notes"].append(
            "The child produced no output. Check STARTF_USESTDHANDLES and the three "
            "INVALID_HANDLE_VALUE handles first, then the ResizePseudoConsole nudge. "
            "Do not investigate input until this passes.")
        print(json.dumps(result, indent=2) if as_json else
              "FAIL — the child produced no output.\n"
              "       Set dwFlags = STARTF_USESTDHANDLES and all three standard handles to\n"
              "       INVALID_HANDLE_VALUE, and call ResizePseudoConsole once after creating\n"
              "       the console. A child that inherits this process's stdio looks exactly\n"
              "       like this from the outside.")
        return 2

    # --- Does input reach the child? ---------------------------------------
    input_marker = "CONPTY-INPUT-MARKER"
    interactive = Session(f'"{shell}" -NoLogo -NoExit' if shell == powershell else f'"{shell}"')
    startup_bytes = interactive.collect(4)
    result["input_startup_bytes"] = len(startup_bytes)
    interactive.write(f"echo {input_marker}\r\n".encode())
    after = interactive.collect(5)
    result["input_works"] = input_marker.encode() in after
    result["shell_alive"] = interactive.alive()
    result["input_bytes"] = len(after)
    interactive.close()

    if as_json:
        print(json.dumps(result, indent=2))
    else:
        print(f"output  : {'OK' if result['output_works'] else 'BROKEN'} "
              f"({result['output_bytes']} bytes from a one-shot child)")
        print(f"input   : {'OK' if result['input_works'] else 'BROKEN'} "
              f"({result['input_bytes']} bytes after typing)")
        print()
        if result["input_works"]:
            print("A real pseudo-console works here. Build the terminal on it, and keep a "
                  "pipe-backed fallback for machines where this probe returns 3.")
        else:
            print("Output arrives but the child never acts on input. Check that the console "
                  "was resized after creation and that nothing closed the handle you write "
                  "keystrokes to. Fall back to a pipe-backed shell rather than shipping a "
                  "terminal that silently ignores typing.")

    if not result["input_works"]:
        return 1
    return 0


if __name__ == "__main__":
    if os.name != "nt":
        print("This probe is Windows-only: ConPTY has no equivalent here.")
        raise SystemExit(3)
    bind()
    raise SystemExit(main())
