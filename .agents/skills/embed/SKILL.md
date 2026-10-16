---
name: embed
description: "Use when a task asks to embed something into a web page or GUI — a real terminal or shell, a native program's controls, another service's live status, a third-party viewer, or a whole page inside another page — and when an embedded thing misbehaves: a blank terminal, keystrokes that are ignored, output that streams all at once or never, a panel that disagrees with the data behind it, or a layout that collapses inside a host it was not written for. Carries the ConPTY recipe and its two silent requirements, the streaming transport that survives proxies, how to reimplement a program's controls from its own state, and the traps that cost hours."
---

# Embedding things in a web GUI

"Embed X" names a goal, not a mechanism. There are five, and picking the wrong one
is the most expensive mistake available here — it is the difference between an hour
and a day. Decide this first.

| What you are embedding | The mechanism | Never |
|---|---|---|
| A shell, console, or a program that needs a TTY | A real **pseudo-console** (ConPTY on Windows) + a terminal emulator in the browser | Fake it with pipes and claim it is a terminal |
| A **native GUI program** (Win32, .NET, Qt, Electron) | Reimplement its **control surface** from its own state files, CLI and local protocols | Try to iframe it, screenshot it, or drive its window |
| A **service's live status** | Its own protocol if it has one; otherwise its status file, then its process and ports | Scrape its log and infer |
| A **third-party web asset** (terminal emulator, editor, charts) | **Vendor it into the repo** and record version + licence | Link a CDN |
| One **page inside another** | Neither — share components or the design tokens | `<iframe>` for same-origin UI |

Two rules apply to all five:

1. **Never advertise more than you have verified.** A status line that says
   "reachable", an address that says where to connect, a chip that says "real
   terminal" — each is a claim. Make the claim track the evidence, and where there
   is no evidence, say the weaker true thing.
2. **Ship a fallback and say which one is live.** If the good mechanism is
   unavailable on the host, degrade to the lesser one *and label it*. A silently
   degraded embed is worse than an absent one, because it looks like it works.

## A real terminal

The only way to get a genuine terminal — colours, cursor addressing, TAB completion,
line editing, Ctrl-C, and full-screen programs like `vim` or `top` — is a real
pseudo-console. `CreatePseudoConsole` (Windows 10 1809+) gives you one. A piped shell
is not a substitute: it cannot host a full-screen program, and it does not echo, so
you end up reimplementing line editing badly in JavaScript.

**Run [`scripts/conpty-probe.py`](scripts/conpty-probe.py) on the target machine
first.** It answers the only two questions that matter, in the order they must be
answered — does a child produce output, and does input reach it — and it exits
non-zero when a real terminal is not possible there. Those two fail independently and
look identical from outside (a blank terminal either way), so a combined test
misdiagnoses which half is broken.

### The two requirements that are silent when missed

Everything else follows the documented sample. These two do not, and neither
raises an error:

**1. Do not let the child inherit your stdio.** This is the one that costs a day.

```
StartupInfo.dwFlags = STARTF_USESTDHANDLES
StartupInfo.hStdInput = hStdOutput = hStdError = INVALID_HANDLE_VALUE   (-1)
```

Without it the child inherits *your* redirected stdio instead of the console. Its
output then goes wherever your stdout goes — a service log, an ssh channel, a
terminal you are not looking at — and an interactive shell exits immediately, because
its stdin is at EOF. You will see: the console created successfully, the console host
running, an OSC title naming the child, `WriteFile` reporting the bytes written, and
**no output at all**. It reads exactly like broken plumbing, and it is one omission.
wezterm's `pseudocon.rs` names it in a comment; that comment is worth more than the
docs.

**2. Resize the console once after creating it.**

```
CreatePseudoConsole(size, inputRead, outputWrite, 0, &hpc)
ResizePseudoConsole(hpc, size)          // same size — this is not a no-op
```

A fresh pseudo-console emits its startup sequence (`\x1b[?9001h`, clear screen, the
OSC title) and then stays silent however much the child writes. The resize is what
starts it rendering. Without it you get a terminal that is alive, attached, and
permanently blank.

### The shape of it

```
CreatePipe(&ptyIn,  &weWrite)     // ptyIn  = read end  -> console's input
CreatePipe(&weRead, &ptyOut)      // ptyOut = write end -> console's output
CreatePseudoConsole(size, ptyIn, ptyOut, 0, &hpc)
ResizePseudoConsole(hpc, size)                       // requirement 2
CloseHandle(ptyIn); CloseHandle(ptyOut)              // the console owns them now
InitializeProcThreadAttributeList ×2                 // query the size, then allocate
UpdateProcThreadAttribute(list, 0, PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE,
                          hpc, sizeof(HPCON), NULL, NULL)   // the handle BY VALUE
CreateProcess(cmd, ..., EXTENDED_STARTUPINFO_PRESENT, ..., &siex.StartupInfo, &pi)
```

`PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` is `22 | 0x00020000` = `0x00020016`. Keep
`weWrite` (keystrokes) and `weRead` (output) and close neither until the session
ends. Verify against a working implementation before believing your own reading of
the docs — the [Microsoft EchoCon sample](https://github.com/microsoft/terminal/tree/main/samples/ConPTY)
and wezterm's `pty/src/win/` are both worth ten minutes.

### Call it from a subprocess when you are probing

A wrong ctypes struct can take the interpreter down. Iterate in a standalone script
you can run repeatedly, and only move the recipe into a long-lived process once it
works. A probe that kills its own host tells you nothing about the bug.

## Streaming live output to the browser

Server-Sent Events carry one direction well and are one `<EventSource>` away. Input
comes back over a normal POST.

- **Frame binary as base64.** `event: out\ndata: <base64>\n\n`. Raw bytes will
  eventually contain a newline that breaks the framing.
- **Send a heartbeat** (`: keep-alive\n\n`) on idle, or an intermediary decides the
  connection is dead.
- **Requires HTTP/1.1 and no `Content-Length`**, and flush after every write. Send
  `Cache-Control: no-store, no-transform` and `X-Accel-Buffering: no` so a proxy does
  not decide to buffer the whole thing.
- **Close the connection when the stream ends** — you cannot reuse a connection whose
  length was never declared.
- **Treat a browser disconnect as normal.** The user navigating away mid-stream is
  routine; catch the write error and keep the session alive rather than tearing it
  down.
- **Do not audit keystrokes.** Audit whole lines. A log of every character buries
  everything else, including the thing you needed.

When you test this through a proxy, and you get a 403, **do not conclude the route is
blocked**: a burst of requests from one client gets rate-limited, and the same route
answers 200 seconds later. Space the requests out before you go looking for a rule.

## The browser side

**Vendor the emulator; never link a CDN.** A strict `script-src 'self'` policy and an
offline host both break CDN links, and the failure is a blank panel. Put the files in
the repo, record package, version and licence next to them, and note how to update
them.

**Do not reimplement what the console already does.** With a real PTY the shell echoes
the keystrokes, handles arrow-key history, TAB completion and Ctrl-C natively — the
client's entire job is to shuttle bytes and report its size. Local echo, a local line
buffer, and a hand-rolled history are all *bugs* in that design, and they show up as
every command appearing twice.

**Wire the size through.** On load, on panel switch, and on window resize, tell the
server the terminal's dimensions so it can `ResizePseudoConsole`. A terminal that
wraps at 80 columns inside a 160-column window is the visible symptom of skipping it.

**Fit after layout, not before.** A terminal opened into a hidden or unsized
container measures zero; fit it once the element is actually laid out.

## Embedding a native program's controls

You cannot iframe a Win32 window. Do not try: do not screenshot it on a timer, do not
automate its UI. Instead read the program's own state and offer its actions natively.

1. **Find where it persists state.** Search every profile, not just the current
   one — `C:\Users\*\AppData\Roaming\<App>\`, its install directory, `ProgramData`.
   A service account's `%APPDATA%` is not the profile a user-facing app writes to,
   so discover rather than assume. Prefer whatever changed most recently.
2. **Look for a CLI before scraping files.** A documented verb set is a contract; a
   file layout is an implementation detail that will move.
3. **Get live status from the thing itself.** If it speaks a protocol, speak it: a
   game server's query handshake, a service's health endpoint. Reading the process
   list only proves a process exists — a file listing only proves a file exists.
   A live query proves the thing is actually up, and it usually returns richer
   detail (counts, versions, health) for free.
4. **Resolve what you display.** A port number means nothing on its own. Enumerate
   what is actually listening and label each port with the service behind it, so the
   user picks a service instead of typing a number that may have nothing behind it.
5. **Match processes by port ownership, not by command line.** A launcher stub and
   the real process can carry *identical* command lines; picking the wrong one gives
   you a 9 MB reading for a server using 900 MB. The process holding the listening
   port is unambiguous.
6. **Edit files surgically.** Rewriting a config wholesale silently drops comments
   and every key you did not know about. Change only the keys the user changed, keep
   a timestamped backup, and for anything that can take a service down, **validate
   before writing** and run the service's own check afterwards.
7. **Say when a change needs a restart.** A settings panel that does not mention it
   leaves the user believing a change did nothing.

## Embedding a page inside another page

Do not. If two surfaces must look like one product, share the design system, not the
DOM.

The failure mode to know: **a generic element selector written for one page silently
captures the other.** A rule like `main { max-width: 1240px; margin: 0 auto }` was
written for a public page and matched the admin console's `<main>` too — and on a
grid item, `margin: auto` **cancels the stretch**, so instead of merely being capped
the element shrank to its fit-content width and centred itself. The console spent
weeks rendering in a 455px column inside a 1204px area, which read as "the design is
plain" rather than "the layout is broken".

Scope layout rules with a child combinator (`body > main`) or a class. And when a
layout looks wrong, **measure it** rather than adjusting CSS by eye:

```js
getComputedStyle(el).gridTemplateColumns, el.getBoundingClientRect().width
```

## Traps

1. **A child that inherits your stdio looks like a broken console.** See above; it is
   the single most expensive trap in this file.
2. **A fresh pseudo-console renders nothing until it is resized.**
3. **Where the parent's stdout goes decides how a broken console looks.** Test from a
   process whose stdout is a terminal and the child's output appears there, so the
   embed looks like it is "writing to the wrong place". Test from a process whose
   stdout is a pipe — a build tool, an ssh session, a sandboxed command runner — and
   the child's output vanishes and an interactive shell exits at once, so the embed
   looks like it "never attached". Same bug, two costumes. Do not conclude that the
   environment is at fault: run the probe and fix the stdio handles first.
4. **Errant shells get blamed for real bugs.** It is tempting to decide "the sandbox
   blocks this" or "it only works on the server" when a probe fails and succeeds in
   different wrappers. Both are testable in minutes with the probe — do that before
   writing the environment off. In this file's history, a sandbox was blamed for a
   missing `STARTF_USESTDHANDLES` for a long time.
5. **`Win32_Process.WorkingSetSize` and `Get-Process`'s `WorkingSet64` can disagree.**
   When two sources disagree about a headline number, check it against a third.
6. **PowerShell echoes every line it reads from a pipe.** Harmless with a real PTY;
   with a piped shell it doubles every command unless you suppress the server copy.
7. **Forwarding partial lines defeats line-based filtering.** If you hold back a line
   that matches a pattern, hold the *partial* line too while it could still become
   that pattern — otherwise it is already gone when the rest arrives.
8. **Check the method before the path in a request router.** A `POST` to a path that
   has a GET handler matched first returns a perfectly valid listing, so a failed
   write looks like a success.
9. **A wrong config key fails silently.** `config.get("port")` returning nothing
   raises nothing; every label downstream is quietly wrong. Read the schema.
10. **Fixed sleeps make flaky screenshots and false diagnoses.** Wait for the content
    you expect, with a *per-view* selector — a shared "any rows at all" test passes on
    another panel's markup and photographs an empty one.
11. **A cached payload outlives the code that wrote it.** After fixing a formatter,
    old data can still be served from a valid cache. Clear it and re-verify.
12. **Buffer means nothing without context.** Base64-encode a size you send; state a
    colour against fixed limits, not against the other readings. A ranking ("hottest
    sensors") tells you which number is largest, not which part is hot — group by what
    the sensor measures and colour by absolute thresholds.

## Verifying an embed

An embed is not done because a screenshot looks right — a blank terminal
photographs beautifully. Prove it, in this order:

1. **The mechanism exists here** — run the probe on the target host, not on your own.
2. **Output flows** — a child that prints a marker; check the marker arrived.
3. **Input works** — type a command that echoes a marker; check the marker came back.
4. **It survives the real path** — through TLS, through the reverse proxy, through the
   tunnel. Streaming is the part that breaks there.
5. **The fallback is labelled** — force it if you can, and confirm the UI says which
   one is live.
6. **Nothing regressed** — capture every view and check the console for errors, with
   content-aware waits.

Then keep the deployment honest: hash the files you shipped and compare them with what
the server is actually running, so a change that was deployed but not restarted is
reported rather than silently served.
