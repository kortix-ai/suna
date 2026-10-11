Tools on every harness, one-step MCP install, and billing alerts for owners

### New

- **Tools run on both harnesses.** A tool is one module that OpenCode and pi both run. Declare a project's own tools under `tools:` in `kortix.yaml`, and limit which agents see them with `agents.<name>.tools`.
- **The Kortix tools are listed in `kortix.yaml`.** `web_search`, `image_search`, `scrape_webpage`, `memory` and `show` appear as `kortix:<name>`. Delete a line to remove that tool. `kortix tools ls` lists a project's tools, and `kortix tools eject <name>` copies one into the project so you can change it.
- **One-step MCP install.** Installing an MCP app goes straight to the server's sign-in, and a connector you authorize with your own account loads its tools. The app and connector pages are redesigned.
- **Every connector account picks its audience.** Install adds the connector to the project. **Add account** then asks for a name and **Who can use it**: only you, everyone in the project, or specific people, groups or agents.
- **Connect MCP** in the project sidebar opens the MCP connect dialog.
- **Connector calls from code.** Apps and scripts can call a project's connectors through `@kortix/sdk`, with typed handles and a stable result.
- **Reminders page.** A calendar (day, week, month) and a list with bulk pause, resume and remove. Reminders is beta: enable **Reminders** under Settings → Feature flags.
- **App event triggers (beta).** Run an agent when something happens in a connected app, such as a new email or an opened pull request. Every app that publishes events is listed, and you can browse its events before you connect it. Enable **App event triggers** under Settings → Feature flags.
- **Notification center (beta).** Kortix tells the right person when a session needs them: an in-app inbox, Web Push and email. Off by default: enable **Notification Center** under Settings → Feature flags.
- **Billing alerts for owners.** Owners get an email when the wallet reaches $0, and when a declined card turns auto top-up off. The Billing pane says why auto top-up is off. A member who runs out of credits can ask the owners from the product. Budget managers get an email at 80% and 100% of an LLM gateway budget.
- `kortix feedback "<message>"` files a bug, an idea or a friction report from a terminal or from inside a session.

### Improved

- Streaming replies appear word by word, at the pace they arrive, on web and mobile.
- A long paste (more than 1,000 characters or 10 lines) becomes a "Pasted text" tile on web and mobile.
- Every prompt a person did not type, from a reminder, a trigger, another session or Slack, shows a source pill above a plain message.
- The server owns session state and sends it on one stream, so open tabs stop polling for it.
- Config releases run for every project. What merges to the base branch reaches new sessions, and a large repository no longer loses its config release.
- A sandbox sleeps sooner: a turn that waits on a person stops keeping it awake, and an open tab keeps it awake only while someone uses it.
- pi (experimental) loads the project's root `AGENTS.md`, runs the agent you pick for a prompt, and can take back an unread steer or a queued prompt.
- Agents in a session use the `kortix` CLI for connectors; the in-sandbox `kortix-connectors` MCP server is removed. `kortix connectors connect --label` names the new account.
- The hosted MCP server at `api.kortix.com/v1/mcp` is the one Kortix MCP server. The docs-only server at `kortix.com/mcp` is retired, and `list_projects` answers an empty list on an account with no projects.
- File listings show folders with more than 1,000 files, with search on web and mobile.
- The invite page names the project and the role. After you accept an invite or switch accounts, you land in that account.
- Mobile: **New session** opens project home with the composer focused. Sessions draw tables on a full grid, hide thinking, and keep a floating composer.
- CLI: `sessions ls` and `sessions status --json` show each session's model. `triggers info` shows the webhook signing scheme with a sample. `approvals ls` prints the decision link. `projects info --json` includes the project ID.
- Session start, connector calls, cost summaries and the Reminders page use fewer database reads.
- A session with many images or binary files loads them a few at a time instead of all at once.
- **Your computer** shows the access the agent on that computer really has, in the browser and in the desktop app. Narrowing access applies at once from anywhere; widening it asks on the computer.
- 30 API routes that no client calls answer `410 Gone`.
- The subprocessor list adds six vendors.

### Fixed

- A Stop wins over a session that is still opening and over its queued prompts.
- A session whose sandbox provider is at capacity retries the start by itself, with backoff, instead of waiting for **Restart**.
- Queued prompts go out at the turn boundary and survive a busy queue. Only a queued prompt's author can edit, send or retry it, and an idle send shows as active, not queued.
- A session keeps its history when its runtime changes, and a degraded transcript copy no longer serves a partial history.
- A reload paints the conversation this device kept without placeholder rows first, a streamed message settles when its turn ends, and a session whose sandbox lost its state keeps the conversation this device saved.
- Session boot: `sandbox.on_boot` runs again after a session resumes, the boot finds its config when a pin file is missing, a failed environment build no longer breaks the boot, and a sandbox falls back to 4 GiB of memory when no size is set.
- A failed sub-agent run can be retried in its own thread.
- Sessions: a failed-turn notice clears after you edit and resend, the turn outcome footer is back, the restart offer on a stuck boot follows the session's state, the session list pages correctly, and other tabs learn when a turn finishes.
- The composer waits for the model list during boot, and a new free account can send with the default model.
- The connector-connected notice joins the prompt queue and reaches the running turn.
- Triggers: a cron trigger fires at most once a minute, every webhook delivery runs exactly once, a failed fire is recorded on the trigger, the list says when a trigger runs next, a fire waits when the account has no usable model, and a manual or webhook fire the account cannot pay for answers `402` with the reason instead of a server error.
- Saving a connector credential is atomic, a Slack undo call is bounded by the call deadline, and a crash in the marketplace dialog stays inside the dialog.
- The email channel shows on the channels page, and the inbox of a deleted account tells the sender once per thread.
- Change requests: large change requests show their changed files, a blank diff says why, and the side-by-side toggle works on one-sided diffs.
- Binary file previews work again, and links to a session's files open instead of showing `[blocked]`.
- Computer use on a connected computer works for every tool and survives restarts and app updates. The CLI and the desktop app run as one runtime.
- Sign-in: a magic link works when the browser drops a cookie, a sign-in no longer bounces back to the sign-in page, and a sign-in or sign-up that stalls ends with an error you can retry. On mobile, SSO sign-in completes and the login stays until you sign out.
- The onboarding wizard opens on an account's first project, owners see the create-project screen on `/projects`, and the account menu has a **Settings** row.
- After a deploy, a page that loads stale code reloads once instead of breaking.
- Account deletion works when a session sandbox exists, never deletes an operator's login, and works on self-host.
- A push to GitHub that the remote rejects with a 500 is retried, and an expired checkout link answers with a clear not-found.
- Trigger and top-up controls show only to people who may use them, and the project config lists every registered agent.
- Translations and accessible names for icon buttons and the preview toggle.
- `/download` has its site navigation again, and `/blog` serves the blog.
- CLI: `agents ls` lists the project's agents, `ship` and in-sandbox host selection use the right credentials, the CLI token list hides session tokens, `reminders ls` shows the prompt text, and `triggers fire` reports the real outcome.
- Self-host: `doctor` fails when sign-up is open and unconfirmed, `self-host status --json` prints clean JSON, the CLI refuses to rotate `API_KEY_SECRET` and `POSTGRES_PASSWORD`, and `/v1/setup/status` no longer stalls the API while it checks Docker.
- Mobile: streaming turns stay stable, change requests anchor to their turn, and the composer stays above the keyboard.

### Security

- SSO is enforced at the API for every credential. Sign-up without a browser follows the sign-up policy and SSO-only domains. The admin allowlist never matches an SSO identity, and a personal account cannot set up SAML.
- Offboarding stops what a member left behind: computer calls, reminders, pushes and group memberships. A deleted account closes every side route, account erasure removes stopped sandboxes, session files and managed repos, and deleting a project deletes its managed git repo.
- A session push reaches only people who may still open the project, and a signed-out device stops getting pushes.
- `kortix secrets unset` revokes every outstanding setup link for that secret.
- `/userinfo` rejects tokens of a deactivated OAuth client.
- A trigger with no agent runs with the permissions of the agent its run uses.
- A single-label egress wildcard matches exactly one subdomain label.
- The public installer verifies the release checksum.
- Pinning a session's runtime on the turn stream requires the session's own sandbox credential.
- Dependency updates for HIGH CVEs (gRPC, `golang.org/x/net`, sharp, the MCP SDK, undici and others), and the sandbox daemon and release scripts create temporary files owner-only.

### Not yet offered in Settings

- Apps hosting (static sites served without a sandbox, and server Apps on releases, machines and volumes, with a Convex backend as a template), project Files with per-folder access, and session boot modes with persistent machines sit behind account-level switches and are not offered in Settings yet.

### Behind the scenes

- CI runs on GitHub-hosted runners, and database indexes, connection pooling, audit storage and infrastructure checks are tightened.
