Microsoft Teams for every project, secrets you can share with an agent, failed-trigger alerts, and immediate sign-out

Microsoft Teams for every project, secrets you can share with an agent, failed-trigger alerts, and immediate sign-out

### New
- **Microsoft Teams is on for every project.** There is no feature flag to turn on: connect Teams from the project's **Connectors → Channels** page. A tenant admin consents once, or the project brings its own bot. A project that connected Teams while it was a flag keeps its install. `@kortix/sdk` keeps `teams` as a deprecated flag key that always reports enabled. (#8601, #8603)
- **What Kortix says to one person in Teams stays with that person.** In a channel or group chat, only that person sees:
  - the prompt to connect an account or request access, with the connect button right in the thread;
  - command replies;
  - why a message did not run;
  - approval requests and decisions.

  Teams marks these "Only you can see this message", as Slack does. The shared "Working on it…" card appears only when the message can run. (#8609)
- **Kortix shows when your Teams app is out of date.** When your organization's Teams catalog has an older Kortix app, the Channels page and `kortix channels status` say so and name the two steps: a Teams admin publishes the update, then a team owner updates the app in each team where Teams offers it. A Teams thread that the agent may not read now comes back with who fixes it, instead of Microsoft's error alone. The Teams app moves to version 1.6.1. (#8624)
- **A failing trigger is no longer silent.** When a trigger's run fails, the Schedule page shows the trigger as failed with the reason, and the account owner gets one push when a failure streak starts, not one per fire. The next run that finishes clears it. A reused session that grew too large to compact is retired, so the next fire starts a fresh one. (#8586, #8588)
- **Human Messaging reaches every agent surface** (projects with the Human Messaging feature on). Agents in sessions, Slack, Teams and the hosted MCP server know how to ask a person and answer back, and the mobile app groups what people asked you under "Asked you". An ask from a session runs the asking session's own agent. (#8622, #8623)

- **Share a secret or a connector account with an agent.** "Who can use it" now offers agents next to people and groups. A value shared with an agent reaches every session of that agent, triggers and schedules included; running the agent stays gated by its own access. A secret link can keep the value to the person who asked. `kortix secrets share --agent <name>` does the same from the CLI. (#8635, #8638)
- **Approve or deny a connector call from the Review Center header**, next to Back, as for a change request. Deny takes an optional note that reaches the agent. Long parameter values collapse behind Show more. (#8641)
- **An agent's ask names the agent**, not the session title, in "Asked you" (Human Messaging projects). With the Human Messaging feature off, it no longer appears anywhere. (#8626, #8637)

### Security
- **Sharing a session cannot leak a personal value.** Making a session project-visible or creating a public share is refused (`409 PERSONAL_SECRET_REQUIRES_PRIVATE_SESSION`) while the session holds a value shared only with its owner. (#8635)
- **Permissions follow the capability.** A rule on `bash` also covers the terminal tools, `websearch` covers web and image search, and `webfetch` covers page scraping. Unknown tools fail closed. (#8553)

### Fixed
- **Slack and Teams sign-in links open again.** Since 2026-09-24 the link to connect a chat account answered "page not found". (#8611)
- **Accounts that require MFA work after the code is verified.** Linking Slack or Teams, and some API routes such as connectors, asked for the second factor again even after it passed. Connecting a chat account now continues by itself after the code. (#8611) Members' sessions in such an account now reach shared provider keys, including a ChatGPT login shared with the project, and changing a shared key still needs the second factor. (#8618, #8620)
- **A Slack or Teams conversation runs the model it shows.** A message without a `/model` change could run on the model of an earlier message instead of the conversation's model. (#8618)
- **Signup asks you to open the emailed link.** The confirmation screen no longer asks for a six-digit code that the email does not contain. (#8608)
- **Signing out takes effect on every route at once.** A logged-out, banned or revoked access token is rejected everywhere. Before, it stayed valid until it expired, up to an hour, on routes outside the account session check. (#8594)
- **Migrated sessions start again.** A session moved from the previous platform could hold a sign-in token that the move had revoked, and never finished starting. Opening it now restores that one token, only for the session's own box. (#8636)
- **Audit ingestion wastes fewer retries.** After a database timeout, a retry sends half the rows instead of the same statement again, and a small batch gives up after one try. (#8599)
- **Email connections survive a failed inbox listing.** When the inbox listing failed, Kortix treated it as an empty list and removed the project's email connections. It now keeps them and reports the error. (#8607)
- **The bring-your-own Teams webhook answers 404**, not 503, for a project that has no bot of its own. (#8603)
- **The Kortix icon is the same everywhere again.** The favicon, app icons and home-screen icon all show the light tile with the dark mark, in light and dark mode. (#8647)
- **Translated pages are translated again.** Blog titles and descriptions, SEO descriptions, the site description and the open-source headline show in all eight non-English languages. The brand kit had left them in English. (#8587)

### Behind the scenes
- Sandbox boot is split into session setup, prompt delivery and turn relays, with no change in behavior (#8600); its boot-order guards follow the moved code (#8627). The SDK's server entrypoint no longer imports itself in a cycle (#8591).
- Test repairs for mobile, the CLI and self-hosted Supabase, and the Stop flow (#8575, #8578, #8584, #8590). A flaky `kortixd` test resets its shared cooldown (#8598). A synthetic test token no longer trips the secret scanner (#8614, #8616). Learnings entries on translating changed copy and on Teams app updates (#8593, #8624).
- The runtime protocol is Kortix-owned: transcripts are versioned as `kortix.transcript.v1`, both agent harnesses serve Kortix turn routes, and `@kortix/sdk` no longer depends on `@opencode-ai/sdk`. (#8553)
- SDK and host refactors with no change in behavior (#8246, #8398, #8449, #8581, #8632), billing provider handlers split out (#8628), an `engineers` IAM group for MFA-gated day-to-day AWS access (#8633), and release-gate fixes (#8643, #8645, #8646, #8648, #8650, #8652). Message ids now use the platform's secure random source. (#8646, #8648)
- One migration: a nullable `run_failing_since` column on trigger runtime state (#8588).

Release source: staging `40de384e4f517dacea723221cb430ef45ffe8b00` (promotion #8642; supersedes the earlier candidate 4defc4c213).


