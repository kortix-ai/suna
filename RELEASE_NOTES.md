pi by default, one model path, one Drive

## New

- **One model path: the Kortix LLM gateway.** Every project's models go through the gateway, and custom OpenAI-compatible endpoints are set up in the gateway as custom providers.
- **pi is the default agent harness.** New sessions in a project start on pi unless the project turns `pi_harness` off. Existing sessions keep their harness. Projects with the LLM gateway off stay on OpenCode.
- **One Drive with team folders.** Files lives under the gear, and `kortix drive` works from the CLI.
- **Triggers protect themselves.** A trigger that stays at its hourly run limit for 2 hours pauses itself, sends one alert, and resumes when you set `enabled: true`. A new cron trigger skips a fire while its previous run is still active (`overlap: allow` opts out).
- **`@kortix/ui` is a plug-and-play UI library.** The Kortix web app and the Lumen example now render the same session, workspace and settings screens from one package.
- **Preview text attachments in the app** before you send them.
- **Mobile 1.5.1:** iOS Liquid Glass chrome, a native glass message menu, smoother sheets and scrolling in long sessions, and an MFA focus fix.

## Improved

- Forked conversations persist and stay reachable after navigation.
- pi tells the model today's date on every turn, leaves the session title to Kortix (the header no longer flips), and the Changes tab works on pi sessions.
- Sessions report the model the conversation uses, not the model pinned at creation.
- The project home sends faster, finished replies no longer stream again, and slash skills and commands show there.
- Escape in an empty composer stops a streaming reply. The command palette opens at once, and the slash palette opens the agent picker.
- Drive shows folders as folders and keeps fixed folders in place.
- Connector catalogs resolve in one batch, and sub-agent links keep their sub-agent.
- Large files open whole instead of cutting off at 50k characters.
- Web and CLI show the same model price estimates.
- Cron triggers show the exact next run with its timezone.
- Trigger edits keep the comments in `kortix.yaml`.
- Faster gateway log and audit reads in projects with a lot of history. Gateway budgets read a running daily total (954 ms → one key read), sign-in checks no longer make an extra auth hop, and a page load fetches its project once.
- CLI: `models` lists catalog availability, `sessions new` streams readiness progress, chat and compact wake a stopped or provisioning session first, `access grant --user` uses the linked project, marketplace installs resolve short names, `doctor` names the turn error and explains warm-session retention, project and session URLs match the host, and channels show every state by default.

## Fixed

- Session notifications work in a fresh browser, and blocked notifications recover with a sound fallback.
- Usage opens from account deep links, and checkout returns to the billing page of the account that paid.
- The low-balance warning scales to the recurring grant, and a new free account no longer sees a false warning.
- A deleted project no longer reopens from cache. Enabling a gated feature no longer leaves the page, and a lost session keeps its return path. Account deletion explains that it can be cancelled.
- Compacting a busy session is refused with a clear message. Forking a stopped session explains what to do.
- New project invitees get their notification. Removed avatars are erased.
- Email confirmation is link-first, and the sign-in screen offers password sign-in.
- The app recovers from a stale code chunk instead of failing to load.
- Connected accounts stay on the personal identity.
- The first session of a new project no longer lists the project setup as its own changes.
- Session tokens can no longer leak after a session ends.
- Expired branches are deleted without cloning their history.
- Reminders re-arm from the time they resume.
- Public transcripts show failed assistant turns.
- The Agents page shows agent ids, and a direct user grant replaces the existing project role.
- The public OpenAPI spec publishes a relative server URL.
- Many smaller fixes across the CLI, triggers, auth and the web app.
