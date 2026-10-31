---
name: agent-desktop
description: Operate desktop apps on the session desktop through the accessibility tree — the file manager, the terminal window, LibreOffice, dialogs, any GTK or Electron app. Use when a task needs a native app's window rather than a web page ("open this file in LibreOffice and export it", "click through the installer", "what does the dialog say"). For web pages use agent-browser.
metadata:
  source: vercel-labs/agent-desktop
---

# agent-desktop

The `agent-desktop` CLI is **already installed** in this Kortix sandbox and on
`$PATH`. It sees desktop apps through the accessibility tree and acts on
elements by ref, the same loop as `agent-browser`: snapshot, act on a ref,
snapshot again to verify.

## Start here

This file is a discovery stub, not the usage guide. Before the first command,
load the guide that matches the installed version:

```bash
agent-desktop skills get desktop    # the loop, refs, verification and retry rules
agent-desktop skills get platform   # what works on Linux (AT-SPI, X11)
```

## On the session desktop

- The user watches the desktop live in the **Desktop** panel and can take over.
- `agent-desktop list-apps` shows the apps it can see; `snapshot --app <name> -i`
  returns refs like `@s8f3k2p9:e8`. A ref belongs to its snapshot.
- Ref actions go through the accessibility API without moving the mouse. A
  terminal window has no type action: add `--headed` to send real keystrokes.
- Web pages belong to `agent-browser`, the one shared browser.
- Every command prints one JSON envelope. Retry only when
  `error.disposition.retry` is `safe`.
