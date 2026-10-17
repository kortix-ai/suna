Apps work again from older CLIs, members see only their own work, and Capture include lists

### New
- Kortix Capture records only the apps and websites you include: an organization policy plus a per-computer list.
- kortix.yaml version 3 agents can opt in to the project repository.

### Fixed
- `kortix apps` works again from CLI versions before 0.14.0. Since 0.14.0 every Apps command from an older CLI answered "Apps is not enabled for this project".
- A plain member reads and sees only their own work: their own sessions, costs and directory entry. Owners and admins are unchanged.
- The Usage cost summary no longer fails on a gateway row with an empty provider.
- A correct two-factor code opens the app at once instead of asking again.
- Loading older messages keeps you where you were reading.
- A session's side panel comes back open when you return to the session.
- Review moves under Customize. Members without the rights see no Review entry and no empty Apps row.
- The account hub drops the floating "Back to Customize" pill.
- Connectors drop the "User-managed" badge: a per-person connector shows ✓ or Needs setup.
- An older agent daemon no longer receives a governance it cannot read.
- Sales lead emails go out from production only.
- Connector MCP sync uses a bound project secret, and adding a connector keeps kortix.yaml intact.

### Under the hood
- The session-log backfill keeps its progress in the database, so it resumes when the API leader moves and skips oversized sessions.
- The retired `project.customize.*` permissions leave the catalog.
- Model catalog refresh; staging and dev deploy fixes.
