Capture on Windows, signed installers, Drive, and automation controls

**New**
- Pause all automations: one account switch stops every project's schedules, webhooks, app events and monitors.
- Trigger run limits: a trigger runs at most 60 times an hour by default, with an optional daily limit, so a runaway trigger stops itself.
- Drive in the sidebar, with a Drive page, a file viewer, upload, multi-select and file management. Session folders show Drive folders. Repo moves under Customize.
- Recently deleted lists the sessions you can restore, and a restored session keeps its conversation.
- Drop a file anywhere on a session page or the project home to attach it to your message.
- Notifications have All, Needs you and Done tabs, and the bell shows when something needs you.
- Generative UI is on by default for new sessions: the agent can answer with cards, comparisons, charts, maps and tabs. A project can turn it off in Settings.
- Computer: every access is granted at pairing with a switch for each afterwards, a new computer starts with every access selected, "Always" is remembered, and Computer Use works on Windows without console windows.
- The command palette (⌘K) opens Drive, Reminders and Repo.
- Mobile reminds you when a question has waited 60 seconds for an answer, and renders generative UI like the web app.
- Connectors v2 (experimental, per project): a catalog of vendor MCP apps signed in with OAuth that Kortix runs, app-event triggers that Kortix checks, an event inbox, and an in-place move for existing Composio and Pipedream connectors and their triggers.

**Kortix Capture**
- Windows is ready for company rollout: the install command downloads the installer, waits and reports whether it worked. The macOS and Linux commands do the same.
- Windows: the app window opens for people without admin rights, a manual MSI install never rolls back, and the app has a Windows icon.
- App rules match what an admin types on every OS: `notepad.exe` also matches the packaged Windows 11 Notepad, and the inclusion policy never records an app it cannot identify. The app catalog lists common CAD apps.
- The timeline keeps the runs of frames taken while the person is idle.
- The player shows video for computers linked to no one.
- Settings shows that Capture always starts at login.
- The Kortix desktop app is no longer recorded on Windows and Linux, as on macOS.

**Kortix Desktop**
- Windows installers for Kortix Desktop and Kortix Capture are signed by Kortix AI Corp.
- Windows: the title bar blends with the app, a Kortix menu replaces the raw menu bar, and the app has a tile icon.
- Each deployment serves its own desktop build.

**Models**
- Kortix-managed models are part of paid plans. Free accounts use their connected ChatGPT subscription or their own provider keys.
- Kimi K3 leaves the managed lineup. Sessions and defaults that used it move to DeepSeek V4.1 Flash.
- Managed models fall back across providers in a fixed order, the default model always has a fallback, and legacy model ids get their model's fallbacks. Third-party endpoints are used only with zero data retention and only from subprocessors in effect.
- Reasoning variants reach the model on the pi harness, and pi decides shell permissions command by command.
- When a managed model's provider fails, the session stays on the fallback instead of retrying the failed provider on every request.
- Model-switch notices sit above the turn's work, one row per run of identical switches.

**Self-host**
- Platinum is the default sandbox provider. Daytona remains as a legacy fallback. E2B support is removed.

**Fixed**
- Members of MFA accounts can open project-wide Apps. Reminders move under Customize.
- Signed-out devices stop getting push notifications.
- Connecting an MCP server whose URL does not answer shows the reason instead of a server error.
- A ChatGPT login that only failed a model check is no longer marked for reconnection.
- Plural forms and labels in 9 languages are corrected.
- Reopening a session paints its saved conversation at once, and older tool calls keep their command.
- A connector whose stored credential the vendor rejects is marked on the account for reconnection, and the call reports it instead of a server error.
- Billing emails reach the owners of older accounts, and a notice without a recipient is retried.

**Under the hood**
- @kortix/ui: one shared component library for the web app and SDK hosts.
- With the session log flag on, sessions read and write only the session log; older messages and sub-agent threads come from it.
- Faster requests: the gateway admits a request in one API round trip, the app shell loads after one auth round trip, project details and secrets no longer wait on a git fetch, member and session reads are indexed, and the session lifecycle queue has its own index.
- Model catalog seeds refreshed. CI signing and publish fixes for Windows builds.
