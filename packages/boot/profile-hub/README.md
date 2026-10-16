---
description: "Profile hub: the dsh profiles on this machine, the Remote surface a landing page calls, and the frame-wide page it renders into."
kind: "package-reference"
---

# @deepseek-ai/dsh-profile-hub

## Summary

The profile hub lists every profile under `<harness home>/profiles`, creates and removes self-contained ones, records which profile opens on startup, and launches a profile other than the running one as its own host process. A profile is the unit a person separates work by — `dsh --profile <name>` boots exactly one — so this package owns the directory-level facts a person acts on, and the launch that entering a different profile requires.

## Table of Contents

- [Use this package](#use-this-package)
- [What it owns](#what-it-owns)
- [The `profileHub` namespace](#the-profilehub-namespace)
- [Entering a profile](#entering-a-profile)
- [Model Experience](#model-experience)
- [Known Limitations and Deferred Work](#known-limitations-and-deferred-work)

<a id="use-this-package"></a>
## Use this package

Mount the host half wherever profiles should be manageable, and the client half in a browser composition that carries the `remote` service.

```yaml
- id: profile-hub
  name: '@deepseek-ai/dsh-profile-hub'
```

The host half requires the launcher's `profileContext`, which supplies the harness home, the running profile, and the installation to spawn with. `home`, `dshEntry`, `launcher`, and `startTimeoutMs` are Config fields, so a deployment that boots profiles from somewhere else overrides them in a row rather than editing this package.

<a id="what-it-owns"></a>
## What it owns

| Member | Contract |
|---|---|
| `listProfiles()` | Every profile, the running one, the launcher, and whether this host should open the page by itself. |
| `createProfile(request)` | Makes a self-contained profile: the running profile's bundle layers, the install entries it declares for those layers, its patch layer as the starting tuning, and three isolation rows. |
| `removeProfile(name)` | Deletes a profile directory and everything in it. Refused for the running profile, a reserved name, and a profile this hub started. |
| `setLauncherProfile(name)` | Records which profile opens the page at startup, in `<home>/profile-hub.json`. |
| `openProfile(name)` | Starts the profile as its own host and answers the URL to enter it at. A profile already started answers its existing URL. |
| `stopProfile(name)` | Stops a host this one started. |

Two files belong to this package inside a profile directory: `profile.json` (display title and working directory) and the `credentials.yaml` a self-contained profile writes its own logins into.

**Reserved names.** `desktop` and every name the installation ships a template for (`acp`, `web`, `headless`, `sdk`, `sdk-minimal`) are other owners' state: the hub lists them and can enter them, and refuses to remove or recreate them.

<a id="the-profilehub-namespace"></a>
## The `profileHub` namespace

The client half mounts the namespace from this package's own generated descriptors rather than contributing to a shared Remote assembly, so the surface ships and versions with the Host service that answers it:

```ts
import contribution from '@deepseek-ai/dsh-profile-hub/remote'
await ctx.remote.$mount(contribution)
```

The frame-wide page is one `shell.overlay` entry — the frame's own seat for a badge, status pill, or panel — so it needs no panel of its own and does not displace anything. It opens by itself on the launcher profile and stays reachable from its chip everywhere else.

<a id="entering-a-profile"></a>
## Entering a profile

A host serves exactly one profile: the composition is fixed at boot, so entering a different profile starts a second process and navigates the browser to it. The child is spawned from the running installation (`<installAnchor>/lib/bin.js`), bound to a free loopback port, and read for the `dsh web: <url>` line it prints once it serves. Every child this hub started is killed when the hub disposes.

<a id="model-experience"></a>

No runtime invariant companion is published: the hub reads profile facts from the profile directories on each call and holds only the launched-process table it owns, so no independent observation can diverge from it.

## Model Experience

None, as this package registers no prompt section, tool schema, or Session event, and entering a profile changes which harness answers, never what a request contains.

#### KV Cache effect

No model request prefix changes.

## Known Limitations and Deferred Work

<a id="known-limitations-and-deferred-work"></a>

- A launched profile is a plain Web host, not the Electron shell. Entering a profile from the Desktop app navigates its window to the browser surface, so native window chrome and shell-only actions belong to the app's own profile.
- The hub edits profile directories and their two metadata files; installing plugins into a profile is `dsh plugin --profile <name>` and stays there. `create` copies the running profile's layers, the install entries declared for them, and its tuning, so a profile's package set is changed by the CLI or the Plugins page, not by this one. Only the copied layers' entries come along: a package the source profile installed but does not compose is not this profile's.
- A profile created with `clone: true` copies the running profile's patch layer as it stands, which includes that profile's model catalogue. Trimming it is a patch-layer edit, because a row this package does not own is not its to rewrite.
