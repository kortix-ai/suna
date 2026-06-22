---
name: kortix-computer
description: How to reach a CONNECTED MACHINE (a user's laptop/desktop, or any computer paired over the Agent Computer Tunnel) from a Kortix session — read/write files, run shell commands, and drive the desktop (click/type/screenshot) on that machine. It works through the Executor's `computer` connector (the same connectors/discover/describe/call path as every other integration), so there is no separate tunnel client and no token. Load this when the task is about acting ON a specific physical/remote computer the user has connected ("on my laptop…", "read ~/Downloads on my machine", "run this on my desktop", "click the button on my screen"), or when the user asks how the agent reaches their computer. For files INSIDE this sandbox, just use normal shell/fs — not this.
---

<skill name="kortix-computer">

<overview>
A user can connect their own machine to Kortix over the **Agent Computer Tunnel**
(a permissioned reverse tunnel). Once connected, you reach that machine through
the **Executor** — it shows up as a single **`computer`** connector that fronts
**all** of the account's connected machines. You use the normal
`kortix-executor` MCP tools (`connectors` → `discover` → `describe` → `call`);
there is **no token and no separate tunnel CLI** — the live tunnel is the
credential, resolved server-side.

The `computer` connector's tools relay an RPC to the machine:

- **filesystem** — `computer.fs.read` / `fs.write` / `fs.list` / `fs.stat` / `fs.delete`
- **shell** — `computer.shell.exec` (stdout / stderr / exitCode)
- **desktop** — `computer.desktop.cua.click` / `type_text` / `press_key` / `hotkey` /
  `scroll` / `launch_app` / `list_apps` / `list_windows` / `get_screen_size` /
  `get_accessibility_tree`, plus `computer.desktop.cua.call` (a passthrough to
  ANY computer-use tool by name).

Every relayed tool takes a **`computer`** argument selecting which machine
(its name or id). It's optional when exactly one machine is online — then that
one is used by default.

**This is for a connected, external computer — not this sandbox.** To touch files
in your own workspace, use normal shell/fs. Reach for `computer.*` only when the
task is explicitly about the user's own machine.
</overview>

<usage>
**1. See which machines are connected.** Call the executor `call` tool:

```jsonc
{ "connector": "computer", "action": "list_computers" }
// → { "computers": [ { "id": "…", "name": "Marko's MacBook", "online": true,
//                      "capabilities": ["filesystem","shell","desktop"], "platform": "darwin" } ] }
```

If `connectors` doesn't list a `computer` connector at all, the user hasn't
connected a machine — tell them to connect one in **Customize → Computers** (or
`kortix tunnel`). If it's listed but `list_computers` shows the target `online:
false`, ask them to bring it online.

**2. Call a tool, picking the machine.** Pass `computer` (name or id). Omit it
when only one machine is online.

```jsonc
// read a file on the laptop
{ "connector": "computer", "action": "fs.read",
  "args": { "computer": "Marko's MacBook", "path": "/Users/marko/notes.md" } }

// run a command (sole online machine → no selector needed)
{ "connector": "computer", "action": "shell.exec",
  "args": { "command": "git", "args": ["status"], "cwd": "/Users/marko/proj" } }

// drive the desktop
{ "connector": "computer", "action": "desktop.cua.type_text",
  "args": { "computer": "Marko's MacBook", "text": "hello" } }
```

`describe` any tool first if unsure of its inputs (e.g.
`{ "tool": "computer.shell.exec" }`).

**3. The passthrough for the long tail.** Beyond the curated desktop actions,
`computer.desktop.cua.call` invokes any computer-use tool by name:

```jsonc
{ "connector": "computer", "action": "desktop.cua.call",
  "args": { "computer": "Marko's MacBook", "tool": "double_click", "args": { "x": 220, "y": 140 } } }
```
</usage>

<permissions>
The machine's owner grants access **per capability** (filesystem / shell /
desktop), scoped (allowed paths, allowed commands, allowed desktop features), in
**Customize → Computers**. The tunnel layer enforces this on every call — the
Executor does not bypass it.

If you call something that isn't yet granted, the call comes back as
**pending_approval**: a permission request is created and surfaced to the user in
Computers. Tell them what you're trying to do and that they need to **approve the
request in Computers**, then retry once they have. Don't try to route around a
denial (there is no token to fall back to, by design).
</permissions>

<rules>
- **Use the Executor's `computer` connector** — never hand-roll a tunnel client
  or look for a tunnel token. There isn't one in the sandbox by design.
- **Pick the machine deliberately.** When more than one is online, always pass
  `computer`; a call without it errors and lists the options. Use
  `list_computers` to choose.
- **Be careful with write/destructive ops.** `fs.write`, `fs.delete`,
  `shell.exec`, and desktop control act on someone's real machine — confirm
  intent for anything irreversible, exactly as you would locally.
- **`pending_approval` is not a failure** — it means "ask the human to grant it
  in Computers", then retry. Surface the request plainly.
- This is for an **external connected machine**. For this sandbox's own files,
  use normal shell/fs, not `computer.*`.
</rules>

</skill>
