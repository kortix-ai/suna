Session log as the only history, reminder Retry, and superseded change requests

## New

- **Retry a failed reminder.** A reminder whose last run failed shows its error and a Retry button: in the session's reminders, the project Reminders list and calendar, and with `kortix reminders run <id>`. A reminder that a session's agent sets now reaches its session. Before, it failed after about 13 minutes when the session belonged to another member.
- **An agent's card shows what its configuration grants.**
- **A replaced change request reads "Superseded by #N"** and opens its replacement.
- **A filename in a reply opens the session output it names.**
- **File versions** show their session's title, agent and archive instead of a session id.

## Improved

- **The session log is the only saved history.** Opening a session reads its log first and makes no request to the old transcript. Older web, mobile and CLI builds keep working. The "Session log" feature flag is gone, because every project uses the log.
- Self-hosted Kortix converts old conversations into the session log by itself after this update.
- A pi command that exits non-zero reads as a command. A failure the agent moved past is no longer red.
- A stalled preview says so and offers Reload.
- When a provider refuses Kortix's key, Kortix shows the error once, in the search card, and names Kortix as the cause.
- Connector search survives Back, agent display names find their sessions, and a failed search batch shows its errors.
- Refreshed model catalog.

## Fixed

- An accepted invite shows the new account and project at once. A declined invite leaves the sidebar at once.
- Enter no longer submits text in the middle of a Chinese, Japanese or Korean composition.
- A permission prompt shows the current agent's name after an agent switch.
- The password reset page removes the used recovery code from the address bar.
- Security: the mobile map moves to maplibre-gl 6.12.0, which fixes a critical advisory.
- Smaller fixes: the Rooms join spinner, Capture timeline dragging, changelog links, and copying the logo.
