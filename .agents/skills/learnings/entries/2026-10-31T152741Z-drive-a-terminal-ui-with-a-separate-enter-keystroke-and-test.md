---
recorded: 2026-10-31T15:27:41Z
incident_date: 2026-10-31
---
# Drive a terminal UI with a separate Enter keystroke, and test it against a fake that reads raw chunks

**Rule:** When code types into an interactive CLI (an Ink/React terminal UI such
as `claude setup-token`) through a pseudo-terminal, write the text, wait until the
prompt echoes it, then write Enter (`\r`) in its own write. A terminal UI reads
its input in chunks, and an Enter inside the same chunk as the text is part of
a paste: the prompt shows the text and waits. A test fake for such a CLI reads
the raw terminal in chunks too; a fake built on `read -r line` accepts the
broken input and hides the bug.

**Trigger surface:** Spawning a CLI under `script`, `node-pty` or `expect` and writing answers to its prompts; writing a fake binary for such a test.

**Incident:** 2026-10-31, #11283 and #11322. "Sign in with Claude" never
connected: every real code on dev (4 sign-ins) sat in the masked prompt, the
server gave up after 60 s, and the web call failed with "Request exceeded the
25s server processing deadline". The tests passed because the fake read one
line. The first diagnosis blamed an ECS roll; the flow rows showed every
failure 60 s after the code reached the process.

**Enforcement:** `apps/api/src/projects/claude-subscription/setup-token.test.ts`:
the fake `claude` reads the raw terminal in chunks and submits only on a lone
Enter. Both code tests fail when `submit` writes the code and `\r` together.
