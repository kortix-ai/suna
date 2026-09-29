---
name: kortix-computer
description: How to reach a user's CONNECTED COMPUTER (their laptop, desktop, or server) from a Kortix session — read/write files, run shell commands, and drive the desktop (click/type/screenshot) on that machine. A connected computer is an ACCOUNT of the project's `computer` connector, called through the same `kortix connectors` path as every other connector, with `--account` picking the machine. Load this when the task is about acting ON a specific physical computer the user has connected ("on my laptop…", "read ~/Downloads on my machine", "run this on my desktop", "click the button on my screen"), or when the user asks how the agent reaches their computer. For files INSIDE this sandbox, use normal shell/fs — not this.
---

<skill name="kortix-computer">

<overview>
A member connects their own computer to Kortix (desktop app, or
`npx @kortix/agent-tunnel connect`). Each connected computer is one
**account** of the project's **`computer`** connector — exactly like one Gmail
mailbox is one account of the Gmail connector. You reach it with the normal
connector path (`kortix connectors accounts` → `show` → `call`); there is no
token and no tunnel client in the sandbox. The live connection is the
credential, resolved server-side.

- A **private** computer (the default) is reachable only in its owner's own
  private session.
- A **shared** computer (shared with the project) is reachable by everyone in
  the project, including unattended runs (triggers, schedules, Slack).

Tools on the `computer` connector:

- `status` — the selected computer's name, `online`, platform, capabilities
- **filesystem** — `fs.read` / `fs.write` / `fs.list` / `fs.stat` / `fs.delete`
- **shell** — `shell.exec` (stdout / stderr / exitCode)
- **desktop** — `desktop.cua.click` / `type_text` / `press_key` / `hotkey` /
  `scroll` / `launch_app` / `list_apps` / `list_windows` / `get_screen_size` /
  `get_accessibility_tree`, plus `desktop.cua.call` (any computer-use tool by
  name)

**This is for a connected, external computer — not this sandbox.**
</overview>

<usage>
**1. List the computers you can reach.** Each account label is a machine name.

```sh
kortix connectors accounts computer
```

The slug is `computer` in most projects. An older project may use another
slug for its computer connector; `kortix connectors ls` shows it.

If there is no `computer` connector or no account, no computer is connected
yet. Say so and tell the human: **click "Connect your computer" in the project
sidebar** (one click in the Kortix desktop app, or a download / command in the
browser). There is no feature flag to turn on.

**2. Check the machine before real work.**

```sh
kortix connectors call computer status '{}' --account "Studio Mac"
```

**3. Call a tool on the machine you mean.** Pass `--account "<name>"` (or
`me` for your own default). With one reachable computer you may omit it.

```sh
kortix connectors call computer fs.read '{"path":"/Users/me/notes.md"}' --account "Studio Mac"
kortix connectors call computer shell.exec '{"command":"git","args":["status"],"cwd":"/Users/me/proj"}' --account "Studio Mac"
kortix connectors call computer desktop.cua.type_text '{"text":"hello"}' --account "Studio Mac"
kortix connectors call computer desktop.cua.call '{"tool":"double_click","args":{"x":220,"y":140}}' --account "Studio Mac"
```

`kortix connectors show computer.<action>` prints a tool's input schema.
</usage>

<errors>
Treat these as real outcomes; do not retry blind:

- `account_required` — several computers are reachable and none was named or
  pinned. Ask which one, then pass `--account`.
- `computer_offline` — the machine is paired but not connected. Ask the human
  to wake it or resume access in the Kortix desktop app.
- `computer_unpaired` — the account's machine was disconnected. The human must
  connect the computer again.
- `computer_capability_not_approved` — the human approved this computer
  without that capability (filesystem, shell, or desktop). They must connect
  the computer again and select it.
- `connector_not_connected` — no computer is reachable from this session.
  None is connected, or every connected computer is private to someone else
  (an unattended run reaches only computers shared with the project). With
  `--account`, the error lists `available_accounts`. Say so; do not look for
  another way in.
- `denied` — a connector policy or a grant blocks this call. Report the
  reason; do not retry.
- A call that needs approval waits for a human under the connector's policy.
  Tell them what you are doing and why.
</errors>

<rules>
- Use the `computer` connector. Never hand-roll a tunnel client or look for a
  tunnel token. There is none in the sandbox by design.
- Pick the machine deliberately. With more than one computer, name it with
  `--account`, and report which one ran (the result's `account` field).
- The computer's local config (allowed paths, blocked commands) is the hard
  ceiling. A refusal from it is final; tell the human what was blocked.
- Be careful with `fs.write`, `fs.delete`, `shell.exec`, and desktop control:
  they act on someone's real machine. Confirm intent for anything
  irreversible.
- For this sandbox's own files, use normal shell/fs, not the `computer`
  connector.
</rules>

</skill>
