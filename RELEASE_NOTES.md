Agent-bound sandboxes, terminal attach, and feature flags

**New**

- Your terminal is now a first-class way to work with an agent: `kortix connect` opens a session picker and attaches a full terminal UI to any running session, and can create a session and connect in one step. Bare `kortix` shows the landing screen again.
- Feature flags: one gating primitive across API, web, and CLI. Disabled features answer with a clear `feature_disabled` error everywhere, and each project gets a dedicated Feature flags section under Customize.
- Network-boundary secrets: secrets can now be marked for delivery only inside the sandbox network boundary, enforced per provider, configurable from web and CLI. Protected Platinum credentials sync automatically, misconfigurations are caught at save time instead of at boot, and the UI only offers delivery modes the project can honour.
- A workspace switcher and a `/new` create page: switch workspaces from anywhere, reach account settings from the switcher, and create projects from one place.
- Connector approvals are reviewed inline in the session, and connector setup finishes through one atomic path — no more half-finished connections when a webhook and a redirect race each other.
- The starter ships a continual-harness skill: agent scaffolding that reviews its own sessions and refines itself over time.
- Live session reload: when a session restarts, the UI now streams the reload progress instead of going quiet.

**Improved**

- Sandbox lifetime is now bound to the agent. Active turns keep compute alive; finished or inactive sessions contract to a short retrieval window; every stop records why it happened. Wake billing starts only after the provider confirms the machine is actually running — concurrent and failed wakes no longer bill.
- Session turns read in plain language, and rendering them costs far less.
- Connector search covers the whole Pipedream catalogue, with categories filtered server-side. New sessions pick up server-resolved connector defaults.
- Computer profiles are bound per machine, personal machines are allowed in project profiles, and the Computer Tunnel is hardened with computer-use restored.
- Session titles converge on the runtime title everywhere — no more three names for one session.
- Workspace file and spreadsheet reads retry during sandbox startup instead of failing on the first try.
- Audit trails reconstruct complete session integrity chains, and runtime state survives provider restarts.

**Fixed**

- A turn that is still being written can no longer be aborted mid-write, and "Interrupted" is only shown when a turn was actually interrupted.
- The session error card no longer blinks after giving up, no longer appears while the runtime is intentionally parked, and a temporary 503 during startup is no longer treated as a failure.
- The thinking shimmer only animates the thought the model is still writing.
- Starter agent templates fetch managed skills through the CLI instead of assuming they are on disk.
- A building sandbox shows a Details action instead of a broken Retry.
- Inline content previews render again.
- The public unauthenticated /review prototype page is gone, a connector URL parsing denial-of-service is eliminated, SES mail now runs on a task role instead of an IAM user, and production deploys refuse a mismatched Supabase auth configuration.
