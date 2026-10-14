Big folders in Files, a sidebar you arrange, and redesigned account settings

### New

- **Files handles big folders.** A folder with thousands of files loads in pages with **Load more**, and **Find a file** now searches file contents as well as names.
- **Arrange your project sidebar.** Choose and order the items in the project sidebar. The layout is saved on your account, so it follows you to every browser.
- **Send now on queued messages.** Each message waiting in the queue has its own **Send now**, so you can push one ahead without clearing the rest.
- **Know how long your sandbox stays on.** The composer tells you how long the sandbox stays running while you are in the session.
- **Mobile settings drill down** into each section, and a mobile invitee lands directly in the project they were invited to.
- **Backend cards show a live preview** of their Dashboard tab.
- **Quick Entry on desktop.** Start a session from any app with a global shortcut.
- **Spreadsheet previews in the Repo page**, read straight from git.
- **Redesigned account settings.** Sections are grouped under General, Access and Billing; inviting, granting access, creating tokens and registering apps open in a side sheet next to the page; new avatars.

### Improved

- An agent's question docked on the composer collapses to one line, so it no longer covers the conversation.
- The reminders calendar stays readable on busy projects.
- Sidebar, settings and count badges are more consistent across web and mobile.
- Long Slack turns are no longer stopped at 30 minutes.
- Sending a prompt is faster: it no longer waits for config updates, environment loading or model catalog repair to finish first.
- Warm sessions no longer appear in the sidebar list.
- A session whose agent asked you a question shows **Needs you** until you answer, and the question closes when the wait ends.
- A plain member sees only the members and groups they share access with.
- Web and mobile show only the trigger, review, settings and top-up controls your role allows.
- A connector whose first sync fails or needs a sign-in opens on its page with the next step ready.
- Content of a deleted session is now removed 30 days after the deletion, and its files 7 days after that.
- Groundwork for the new session history: long session texts are stored as attachments, and tool results render from the new session log where it is turned on.
- Sandboxes and CI run Bun 1.4.3.

### Fixed

- A personal access token can now approve gated connector calls.
- Changing only the expiry of someone's account access now saves.
- An App whose machine failed to start recovers on its own the next time it wakes.
- A failed autosave on repository settings or a workspace rename no longer retries forever.
- Web Push and the inbox follow the same MFA rule as the rest of your access.
- On mobile, the drawer closes as soon as you navigate.
- The Files **New** menu offers only actions that work, and sharing never suggests yourself.
- Turning Volumes on never makes an organization stateless, and every server agrees on the Volumes setting right after a change.
- A pi project's local `./` package loads from the config release and restarts pi when it changes.
- Malformed account IDs and stray characters in session logs return a clear 4xx error instead of a server error.
- The composer's stacked layers line up at full width.
- `kortix sessions wait-for` exits non-zero when the turn fails, and the CLI prints a preview URL on the host the deployment serves.
- A prompt sent without an agent runs under the session's agent.
- An App can give its readers access to the Apps it uses, and the App header shows which App you are in.
- SSO-only workspaces end the sign-ins they refuse and refuse personal access tokens; mobile sends an SSO-enforced email to SSO.
- Deleting an account stays blocked when its status check fails.
- Session screens show their labels in your language.
- Starting, restarting and repairing a session's box no longer race each other.
- Apps with volumes deploy without naming a provider, and account commands follow the project link.
- Logging out of the CLI keeps the registered host, and `kortix connectors` confirms a revocation before it reports success.
- Volumes and Stateless sessions are per-project settings.
- Mobile session lists keep loading past empty pages, and the audit log's Session filter accepts a pasted id.
- The agent tunnel records that it is offline even when it is stopped right after starting.

### Behind the scenes

- Every merge to `dev` now runs the full test suite, and releases promote only a tested commit.
- Database migrations commit one file at a time, which removes the deadlock that stalled the v0.13.54 deploy.
- Each Terraform environment keeps its state in its own region, and the security alert hub moved to eu-west-2.
- Unused infrastructure stacks were removed.
- Security fixes from an external penetration test, and row-level security on every internal table.
- Staging now runs on the same infrastructure shape as production, so release checks see what production sees.
