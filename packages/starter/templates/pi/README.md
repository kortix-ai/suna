# {{projectName}}

This project runs on the **pi runtime**.

## Layout

| Path | What it is |
| --- | --- |
| `kortix.yaml` | The manifest. `kortix_version: 3` — runtime and config dir both default to pi. |
| `.kortix/pi/agents/<name>.md` | One agent. Frontmatter is its config; the body is its system prompt. |
| `.kortix/memory/` | The project brain agents read and write. |

An agent's `.md` is compiled into the session bundle at commit time, so a
push to the default branch is what changes the agent. There is no separate
config to reload.

## How a session runs

A session boots the shared pi worker image and pulls its project's compiled
bundle — it does not clone this repo. Compute (files, shell) happens in a
separate **environment** box that starts on first use.

One session runs one agent. The agent cannot be swapped mid-session; start a
new session to use a different one.

## Verify the project

1. Create a session.
2. Send a real prompt.
3. Confirm the response completes.

A provider availability check does not prove prompt execution. Test the model
the project will actually use.

Run `kortix system-skills get kortix-system --full` for the current platform
reference.
