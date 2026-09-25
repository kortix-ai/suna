Your own keys in Slack, Teams and the CLI, and sessions that open instantly

Your own model keys and ChatGPT subscription now work in Slack, Teams and the CLI, saved sessions open instantly, and a single Stop can no longer break a session.

## New

- **Your own keys and ChatGPT everywhere.** Models you reach through your own API keys, keys shared with you, project keys, and ChatGPT subscriptions are available in Teams, Slack and the CLI, not only the web picker.
- **Members bring their own ChatGPT subscription**, without needing permission to manage project secrets.
- **Saved sessions open on their conversation.** Opening an existing session shows skeleton rows shaped like that session while it loads, instead of the full-screen boot screen.
- **Command palette.** ⌘K opens instantly at a fixed position, and search can copy your account, project and session IDs.
- **Connect cards name the app** they connect, and render as cards even when an agent writes them in a table.
- **Mobile**: dictation in the composer, labelled queue controls with undo, and + only attaches.
- **SSO domain verification.** An enterprise account verifies its email domain with a DNS TXT record before SSO is enforced for it. Existing SSO setups keep working.

## Fixed

- One Stop during a session's first turn no longer makes every later turn end immediately, and a Stop during start-up releases the held prompt.
- A healthy Slack run is no longer closed as idle after 30 minutes of quiet work.
- A saved secret that is not granted to the session's agent is now reported as "not granted to this agent" instead of silently missing, and an agent session can sync its own secrets.
- In web terminals on custom Debian templates, Kortix tools stay on PATH and secrets load in login shells.
- An open file viewer refreshes when the agent edits the file.
- A turn that fails mid-stream shows one readable line naming the model, with details folded away.
- Streaming from OpenAI-compatible models that omit event separators no longer fails to parse.
- The web app detects the end of a turn reliably.

## Security

- Markdown, embedded frames, credential routing, share links and analytics are hardened.
- SDK token, transport, preview-credential and file-write paths are hardened.
- Connector requests are checked against private-network egress rules, and connector sync is atomic.
- Gateway usage settles exactly once per request.
- SSO emails are trusted only on verified domains, and access-control writes are scoped to their account.
- Billing wallet functions move to a private database schema.

