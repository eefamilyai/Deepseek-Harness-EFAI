---
description: "Publishes the running Web host's authenticated URL into an encrypted lock file, so a later process can reach a GUI whose per-boot token it never saw."
kind: "package-reference"
---


# @deepseek-ai/dsh-host-web-access

## Summary

The Web host mints one token per boot and prints it once, to stdout. Anything that did not capture that line — a supervisor that restarted the app, a second terminal, or an agent that finds the app already running — cannot open the GUI, because the token exists only in the host's memory. This row writes the authenticated URL to a documented lock file instead, sealed with a key that does not travel with it. `scripts/web-access.mjs` reads it back.

## Table of Contents

- [Use this package](#use-this-package)
- [What the sealing protects](#what-the-sealing-protects)
- [Reading the file](#reading-the-file)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount it in a host roster that serves the Web GUI; `packages/bundle/efai-base` does:

```yaml
- id: web-access
  name: '@deepseek-ai/dsh-host-web-access'
  config:
    path: ~/.dsh/run/web-access.json
    keyPath: ~/.dsh/run/web-access.key
```

Publication waits for Loader settlement, so the URL it hands out cannot point at a tree whose `/api` route owner is still mounting, and the file is withdrawn when the row unmounts — a file whose process is gone is a host that died without shutting down.

One path holds one live host. The record of a host that is still serving is the only pointer to a token that exists nowhere else, so a second host sharing the state directory publishes beside it as `web-access.<port>.json` instead of overwriting it, and withdraws only its own file. A spare host an operator or an agent starts for a test therefore cannot cost the running app its URL.

<a id="what-the-sealing-protects"></a>
## What the sealing protects

AES-256-GCM, with the key derived through scrypt over the key file, the machine name, and the user name.

- **It keeps the token out of every plain-text reader.** A grep over the state directory, a log tail, a backup, or a screenshot of the file returns ciphertext. That is the failure this exists to prevent.
- **The key file sits beside it.** A single-user machine has no keystore this process can reach without native code, so binding the derivation to the machine and user is what stands in for one: the pair is useless copied to another machine or read as another user.
- **It is not protection against a process running as this user on this machine.** Such a process can read the key file and derive the same key. On a shared machine, protect the state directory at the filesystem layer.

<a id="reading-the-file"></a>
## Reading the file

```sh
node scripts/web-access.mjs              # the newest host that is still running
node scripts/web-access.mjs --token      # only the token
node scripts/web-access.mjs --all        # one line per host published here
node scripts/web-access.mjs --port 50140 # the host serving that port
node scripts/web-access.mjs --json       # the record with the payload decrypted
```

The script mirrors the package's helpers rather than importing its built output: it is what an operator runs when the harness is otherwise unavailable, so it must not depend on a build having happened. A spec asserts the two agree, and that the published bytes carry neither the URL nor the token.

With no arguments it reads every record beside the configured path and reports the newest one whose process is alive, so a leftover file from a crashed host cannot hide the host that is serving; `--path` and `--port` name one record directly.

No runtime invariant companion is published because the only relation worth asserting — the file on disk opens with the key beside it and with nothing else — is asserted directly by this package's specs, which seal, publish, read back, and tamper with the record; a companion would re-run the same two helpers.

## Model Experience

None, as the row writes a local lock file and registers no prompt section, tool schema, or Session event.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- The key is derived from the machine and user names, which are guessable; it defeats a copied file pair, not a determined reader running as this user on this machine.
- Only the loopback URL is published. A LAN URL is a separate trust grant that this row does not read, so a remote operator still needs the startup line.
