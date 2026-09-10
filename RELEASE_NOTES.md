Reliable connector access, account settings, and session Git permissions

### Fixed
- Billing opens one subscription dialog from the account hub. Its controls remain accessible, and Escape closes the subscription dialog while keeping account settings open.
- Session Git pushes honor explicit ref grants within the effective IAM role. Manager-authorized sessions can update shared branches; agent grants cannot elevate a member to manager ref authority.
- **Connectors keep working after a bad manifest read.** A session no longer loses every connector when one read of `kortix.yaml` answers wrong. Each grant now records the manifest revision it came from; a grant read from the same revision or an older commit never replaces it, and an unreadable manifest keeps the last known grant. The channel that started a session (Slack, Teams, email) stays callable under any grant, so the agent can always report in its own thread.
- **Connector denials say why.** `connector_not_assigned` now names the agent, its granted list, the manifest revision, and what to change. A declared connector with no credential answers `connector_not_connected` and lists as `needs_auth`. Composio connectors no longer show `needs_auth` while they are connected.
- **Slack progress is never silently dropped.** `slack step` and `slack send` fail with a reason when a checkpoint or an answer does not reach the thread, instead of reporting success. A replayed idle event no longer closes a turn that just started. Button clicks carry the full turn instructions and never vanish without a trace.
- Sessions: the waiting row and the Stop button stay accurate while a prompt is in flight.
- Triggers: the manager override for reuse-mode prompt delivery works again.
- Web: auth tokens are preserved during hydration and fenced before cross-user adoption, and project access waits for auth, so cold loads no longer show "This project didn't load".
- Web: 18 toasts no longer render their own translation key; the template OG image route runs on Node and stops bundling every translation.
- Desktop: navigation layout restored, with parity checks in the package gate.

### Improved
- Self-host operators can set `KORTIX_FRONTEND_MEMORY_LIMIT` to give the frontend more memory. The setting persists through CLI updates and affects only the frontend.
- **Account hub as a modal.** Organization settings, members, groups, roles, identity, billing, and audit open over the page you are on instead of a separate route tree. The `/accounts` routes are gone; links resolve to `?accountId=` on the current page, and Back, reload, and pasted links keep working.
- Signing in paints one brand mark across the whole path to the project instead of four different loading frames.
- Command palette: file search is offered only where it can run; the Open URL row and the Jump to message page are removed; the empty state no longer names a row that is not there.

### Internal
- Release fixtures follow the current connector tab and use a normal cancellation request. Test artifacts mask diagnostic credentials and upload only after the secret guard passes.
- End-to-end flow GH-17 verifies member branch isolation and owner ref authority through real Git HTTP.
- New end-to-end flow (CONN-27) covers session grant provenance, the channel guarantee, and honest denials, with preview harness support. Browser specs follow the account hub to its new URLs; spec 23 ignores CORS preflights.
- Connector authorization tests mint credentials through the token API and close database connections after each run.
