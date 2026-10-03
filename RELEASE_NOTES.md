Your computer on the web, a rebuilt audit log, and editable queued prompts

## New

- **Your computer, on the web.** Each physical computer appears once, even after you re-pair it. Computer Use runs inside the Kortix desktop app, and it asks for every macOS permission right after you connect. Pairings with no hardware id that stay silent for 30 days are removed.
- **Edit a queued prompt in place.** The prompt queue sits in its own card above the composer.
- **Review Center** has its own page. You approve requests in a modal on the approve page.
- **Channel bindings** live in one dialog, with one tab per platform and a settings dialog for each binding. Teams bindings read "Team › Channel" and include the thread title.
- **Shared sessions** show who sent each message, with an avatar per sender.
- **Marketplace redesign:** one card per item, a file tree in the sidebar, and related skills.
- **A new /developers page.** Its "copy prompt command" output now pastes safely into any POSIX shell.
- **One-day personal API keys.** You can create a key that expires after one day.
- **Apps on mobile:** a new Apps tab in the project drawer.
- **Show files** name the file in a hover card.

## Improved

- **Audit log, rebuilt.** Events are written to weekly partitions with time-ordered ids, without the per-session lock that slowed ingestion. Noise rows (missing-secret probes, a login event per request) are gone. Weeks older than 90 days move to S3 under Object Lock, and exports read archived weeks too.
- **The agent harness:** Kortix tools run on both supported harnesses, and the web, CLI, and mobile clients render from the Kortix session contract.
- **Slack:** messages name people and channels instead of showing ids, and plan steps render channels natively. Agent history and thread reads name each author. Slack shows its own logo everywhere.
- **Connectors:** discovery tries managed connectors first, with explicit API and MCP sources. Discovery still works when a spec source cannot load.
- **Sandbox file uploads** send 8 MiB requests, so a 1 MiB file uploads in about 2 s instead of 20 s.
- **Sessions** honor US compute placement and reuse warm sessions. Warm sessions you are billed for stay visible in the session list. You can switch agents in a started session, and the locked agent picker explains why it is locked.
- **Each sandbox** sends its calls to its own regional control plane.
- **Database health:** RLS policies evaluate the signed-in user once per query, duplicate indexes are dropped, foreign keys are indexed, and unused legacy tables are removed.
- **Apps:** deleting an App deletes its deployment images, and you can delete a single deployment.
- **Invite emails** name the invited address.

## Fixed

- A session whose turn ends with a terminal error now parks, instead of staying busy.
- The CLI: `--host` and named-host project context route to the right host, browser login uses the target host, and `--json` output carries no human notices. `accounts current --json` exits 1 when no account is active, `projects use` reports errors instead of crashing, and `tokens rm` with a malformed id returns 400.
- Credit balances read the same on the CLI and the web, and a free account sees its balance on Plan.
- Sign-in keeps the details of an email sign-in failure. Rate-limit errors show guidance instead of raw text, and account deletion ends active sessions at once.
- The web: the command palette finds active projects, the selected language persists, the account hub opens from deep links, connected-account settings open again, and settings rows stack on narrow screens. The Apps card shows its live preview again.
- Video: unsupported fullscreen and blocked autoplay no longer raise errors.
- Mobile: the composer detects mention and command triggers at the caret, not only at the end of the text.
- Marketplace installs report failures instead of exiting silently.

