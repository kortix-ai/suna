---
name: agent-tunnel
description: "Interact with the user's local machine via Agent Tunnel. Use when you need to read/write files on their computer, run shell commands locally, take screenshots, click, type, control the mouse/keyboard, manage windows and apps, read/write the clipboard, or use the accessibility tree to interact with UI elements. Triggers: 'access my machine', 'local file', 'on my computer', 'my desktop', 'take a screenshot of my screen', 'run this on my machine', 'click on', 'open an app', 'accessibility tree'."
---

# Agent Tunnel

All local-machine operations via a single self-contained CLI script. Run with bash — no tool primitive needed, no external dependencies.

```bash
# Resolve the script path once per shell (OPENCODE_CONFIG_DIR is set in the
# sandbox; falls back to ~/.opencode where skills are deployed):
TUNNEL="${OPENCODE_CONFIG_DIR:-$HOME/.opencode}/skills/agent-tunnel/tunnel.ts"
```

## Quick Start

```bash
# Check connection status first
bun run "$TUNNEL" status

# Read a file from their machine
bun run "$TUNNEL" fs_read '{"path":"/Users/me/document.txt"}'

# Run a command on their machine
bun run "$TUNNEL" shell '{"command":"git","args":["status"],"cwd":"/Users/me/project"}'

# Take a screenshot
bun run "$TUNNEL" screenshot
```

## Commands

### status — check tunnel connections

```bash
bun run "$TUNNEL" status
```

Returns all tunnel connections with online/offline status, capabilities, and machine info.

### fs_read — read a file

```bash
bun run "$TUNNEL" fs_read '{"path":"/Users/me/file.txt"}'
bun run "$TUNNEL" fs_read '{"path":"/Users/me/file.txt","encoding":"utf-8"}'
```

### fs_write — write a file

```bash
bun run "$TUNNEL" fs_write '{"path":"/tmp/output.txt","content":"hello world"}'
```

Creates parent directories automatically.

### fs_list — list directory contents

```bash
bun run "$TUNNEL" fs_list '{"path":"/Users/me/Documents"}'
bun run "$TUNNEL" fs_list '{"path":"/Users/me/Documents","recursive":true}'
```

### shell — execute a command

```bash
bun run "$TUNNEL" shell '{"command":"ls","args":["-la"]}'
bun run "$TUNNEL" shell '{"command":"git","args":["status"],"cwd":"/Users/me/project"}'
bun run "$TUNNEL" shell '{"command":"python3","args":["script.py"],"timeout":60000}'
```

Commands run without shell interpolation (secure, array-based args). Default timeout: 30s, max: 120s.

### screenshot — capture the screen

```bash
bun run "$TUNNEL" screenshot
bun run "$TUNNEL" screenshot '{"x":0,"y":0,"width":800,"height":600}'
bun run "$TUNNEL" screenshot '{"windowId":123}'
```

Saves to a temp file and returns the path. Use the Read tool to view the image.

### click — click at coordinates

```bash
bun run "$TUNNEL" click '{"x":100,"y":200}'
bun run "$TUNNEL" click '{"x":100,"y":200,"button":"right"}'
bun run "$TUNNEL" click '{"x":100,"y":200,"clicks":2}'
bun run "$TUNNEL" click '{"x":100,"y":200,"modifiers":["cmd"]}'
```

### mouse_move — move cursor

```bash
bun run "$TUNNEL" mouse_move '{"x":500,"y":300}'
```

### mouse_drag — drag between points

```bash
bun run "$TUNNEL" mouse_drag '{"fromX":100,"fromY":100,"toX":400,"toY":400}'
bun run "$TUNNEL" mouse_drag '{"fromX":100,"fromY":100,"toX":400,"toY":400,"button":"right"}'
```

### mouse_scroll — scroll at position

```bash
bun run "$TUNNEL" mouse_scroll '{"x":500,"y":500,"deltaY":3}'
bun run "$TUNNEL" mouse_scroll '{"x":500,"y":500,"deltaX":2}'
```

Positive deltaY = scroll down, positive deltaX = scroll right.

### type — type text

```bash
bun run "$TUNNEL" type '{"text":"Hello world"}'
bun run "$TUNNEL" type '{"text":"slow typing","delay":50}'
```

Types into the currently focused application.

### key — press key combo

```bash
bun run "$TUNNEL" key '{"keys":["cmd","s"]}'
bun run "$TUNNEL" key '{"keys":["enter"]}'
bun run "$TUNNEL" key '{"keys":["ctrl","c"]}'
bun run "$TUNNEL" key '{"keys":["cmd","shift","p"]}'
```

### window_list — list all windows

```bash
bun run "$TUNNEL" window_list
```

Returns window IDs, app names, titles, positions, and sizes.

### window_focus — bring window to front

```bash
bun run "$TUNNEL" window_focus '{"windowId":123}'
```

### app_launch — launch an application

```bash
bun run "$TUNNEL" app_launch '{"app":"Safari"}'
bun run "$TUNNEL" app_launch '{"app":"Visual Studio Code"}'
```

### app_quit — quit an application

```bash
bun run "$TUNNEL" app_quit '{"app":"Safari"}'
```

### clipboard_read — read clipboard

```bash
bun run "$TUNNEL" clipboard_read
```

### clipboard_write — write to clipboard

```bash
bun run "$TUNNEL" clipboard_write '{"text":"copied text"}'
```

### screen_info — get screen resolution

```bash
bun run "$TUNNEL" screen_info
```

Returns width, height, and scale factor.

### cursor_image — screenshot around cursor

```bash
bun run "$TUNNEL" cursor_image
bun run "$TUNNEL" cursor_image '{"radius":100}'
```

Default radius: 50px. Saves to temp file. Use the Read tool to view.

### ax_tree — get accessibility tree

```bash
bun run "$TUNNEL" ax_tree
bun run "$TUNNEL" ax_tree '{"pid":1234}'
bun run "$TUNNEL" ax_tree '{"pid":1234,"maxDepth":4}'
bun run "$TUNNEL" ax_tree '{"roles":["button","textfield"]}'
```

Returns a structured tree of UI elements with roles, labels, states, and actions.

### ax_action — perform AX action

```bash
bun run "$TUNNEL" ax_action '{"elementId":"0.3.1","action":"AXPress"}'
bun run "$TUNNEL" ax_action '{"elementId":"0.3.1","action":"AXPress","pid":1234}'
```

Common actions: `AXPress`, `AXConfirm`, `AXCancel`, `AXRaise`, `AXShowMenu`.

### ax_set_value — set element value

```bash
bun run "$TUNNEL" ax_set_value '{"elementId":"0.3.1","value":"search query"}'
```

More reliable than clicking + typing for text fields and search boxes.

### ax_focus — focus an element

```bash
bun run "$TUNNEL" ax_focus '{"elementId":"0.3.1"}'
```

More reliable than clicking to focus.

### ax_search — search accessibility tree

```bash
bun run "$TUNNEL" ax_search '{"query":"Submit"}'
bun run "$TUNNEL" ax_search '{"query":"email","role":"textfield"}'
bun run "$TUNNEL" ax_search '{"query":"Save","pid":1234,"maxResults":5}'
```

Case-insensitive substring match on titles, values, and descriptions.

## Decision Tree

```
Check connection?        → status
Read/write local files?  → fs_read / fs_write / fs_list
Run a local command?     → shell
See the screen?          → screenshot / cursor_image / screen_info
Click/drag/scroll?       → click / mouse_move / mouse_drag / mouse_scroll
Type text?               → type
Keyboard shortcut?       → key
Manage windows?          → window_list / window_focus
Launch/quit apps?        → app_launch / app_quit
Clipboard?               → clipboard_read / clipboard_write
Find UI elements?        → ax_tree / ax_search
Interact with UI?        → ax_action / ax_set_value / ax_focus
```

## Workflow Pattern for Desktop Automation

1. **Status check**: `status` → verify tunnel is online
2. **Orientation**: `screenshot` + `window_list` → see what's on screen
3. **Find elements**: `ax_tree` or `ax_search` → identify UI elements
4. **Interact**: Use `ax_action`/`ax_set_value` (preferred) or `click`/`type` (fallback)
5. **Verify**: `screenshot` again → confirm the action worked

Prefer accessibility actions (`ax_*`) over coordinate-based clicks when possible — they're more reliable across screen sizes and resolutions.

## Error Handling

All commands return JSON with a `success` boolean. On errors:

| Error | Meaning | Fix |
|-------|---------|-----|
| No tunnel connection | Tunnel not set up | User needs to create + connect |
| Permission required | Need user approval | Inform user, wait for approval, retry |
| HTTP 404 | Tunnel went offline | Ask user to reconnect |
| Timeout | Command took too long | Increase timeout or simplify command |

## Output Format

All commands output JSON to stdout. Always includes `success: boolean`. Screenshots return a `path` field pointing to the saved image file.
