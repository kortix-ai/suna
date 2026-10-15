Restorable sessions, a self-healing session log, and steadier wakes

### New
- Deleted sessions stay restorable for 30 days. Undo appears on web, and `kortix sessions restore` brings one back from the CLI.
- The transcript shows a partial restore, a harness switch, hidden messages and full message texts.
- A tool call from another harness renders by its kind, so pi and OpenCode sessions read the same way.
- The Customize pages and the Models page tabs have a new layout.

### Improved
- A session rebuilds itself from its session log when its native store is missing or behind, so a box that lost its state comes back with its history.
- pi sessions record reasoning tokens, titles and sub-agent context time, and a manual compaction appears in the log at once.
- The "Worked for" fold reads like the agent's own narration, one named line per run of work.
- A turn that a provider stop or a runtime restart cuts short gets its work back exactly once.
- Waking a session on a full sandbox host retries until the host has room, instead of parking the session.
- Web page scrapes wait out slow sites instead of failing at 35 seconds.
- Connector calls and the session-list poll do less database work per request.
- A budget meter shows the spend for the budget's own period and when it resets.
- Slack file downloads retry transient failures and report the ones that stay broken.

### Fixed
- Approve and Deny show only to a viewer who can resolve the call. Everyone else sees who decides.
- Offboarding a member revokes their computer accounts and pauses their reminders in one step.
- A secret that Kortix cannot decrypt reads as undecryptable everywhere, with the steps to fix it.
- Self-hosted installs treat an auto-confirmed email as unproven: it cannot claim an invite, match SCIM or be added by email.
- Sign-in defaults to the email-link path, and sign-in email failures are kept and shown.
- `kortix sessions new --prompt` stores the prompt exactly as typed.
- The sandbox empty state's New button opens create mode.
- The 404 page keeps its own title during in-app navigation.
- The demo request form keeps your answers when a submission fails.
- Copy buttons show and announce that the copy worked.
- A relaunched session daemon cleans up the process a killed daemon left behind.
- Session abort no longer logs a false "daemon not ready" error.
