# OPERATOR ACTION: restart the provider bridge

Status as of 10-01 02:21 local.

## What is running

Two `provider_bridge.py` processes, both started **09-30 19:41:49**:

    PID 23840   C:\Users\eejar\AppData\Roaming\uv\python\cpython-3.12-windows-x86_64-none\python.exe -u D:\deepseek-kernel-harness\python\kiln\provider_bridge.py
    PID 39780   D:\deepseek-kernel-harness\python\kiln\runtime\.venv\Scripts\python.exe -u D:\deepseek-kernel-harness\python\kiln\provider_bridge.py

`ds_direct.py` was last modified **09-30 21:24:27**, so both processes are running
code from **1 h 43 m before** that edit.

## What they are missing

| Fix | Effect while not loaded |
|-----|--------------------------|
| FIX 12 — mute ledger (`ds_muted.json`) | a mute is not persisted, so the next process re-learns it the hard way |
| FIX 14 — cross-process state merge | `ds_last_turn.json` can be clobbered between processes |
| FIX 15 — `last_prompt` pruning | the state file stays large (measured 46.76 MB → 8.85 MB with it) |
| FIX 16 — session bound | unbounded per-conversation state |
| FIX 17 — `ACCOUNT_MUTED` | **this one is in the TypeScript adapter, not the bridge** — it needs the harness, which was already restarted at 20:01 |

## What a restart does NOT do

* It does not un-mute anything. Mutes are server-side and time-based; `t1` is
  muted until **2026-10-03 16:40 UTC** regardless.
* It does not change the wire journal. The `ds_wirelog.on` marker is already
  present and the journal is already being written (2.37 MB, 1276 requests).
* It does not affect the two finished soaks (`_fastsoak_t1` 400 turns,
  `_syssoak_t2` 240 turns).

## How

Kill both PIDs and relaunch the bridge exactly as before. From an elevated
PowerShell if that is how it was started:

    Stop-Process -Id 23840, 39780 -Force

then start `provider_bridge.py` again the way it was started originally.

## The one caveat

**This session's own provider route runs through that bridge.** Restarting it
interrupts the agent mid-turn. That is why this has been left to you rather than
done here, and why it has been listed as an outstanding action for many rounds.

If you would rather not interrupt the current run, the restart can wait — the
diagnosis does not depend on it. What it would unlock is the wire journal covering
*this* agent's own traffic (currently zero entries for the account this agent
runs from) and the mute ledger actually being written.
