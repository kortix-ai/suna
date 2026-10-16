Credits plan, Enterprise features, restorable sessions and generative UI

### New

- **One credits plan.** Every account is on Free or Credits, with top-ups on either. Balances and usage read in credits everywhere; prices you pay stay in your currency. Raising your plan applies at once; lowering it takes effect at the next renewal, with a preview before you confirm.
- **Enterprise is a feature layer.** SSO, SCIM, roles and groups, audit and branding come with an Enterprise license or a self-serve demo. Trials are gone. Admins can now manage billing.
- **Restorable sessions.** A deleted session can be restored for 30 days, with Undo on web and `kortix sessions restore`. A session that lost its computer continues on a new one from its saved conversation, including images and files.
- **Pin and archive sessions** to keep your list in order.
- **Generative UI.** Agents can answer with visual blocks: cards, comparisons, photo steps, product cards, maps and figures, on web and mobile.
- **Themes.** Kortix palettes plus 39 interface themes, with a live preview in the command palette.
- **Kortix Apps are generally available**, and open in the session browser. Add any site as an external App by its URL, framed in Kortix. The App detail sheet, menu and connect dialog are rebuilt.
- **Kortix Capture**, a desktop recorder for your account, with its own area on the web.
- **MCP servers** connect from their URL in one step, with one-click OAuth sign-in. New MCP and Computer settings pages.
- **kortix.yaml version 3** is available as an opt-in: the project registers skills, tools and commands, and each agent enables what it uses. New projects still start on version 2, and nothing upgrades on its own. `kortix migrate` converts a project when you choose to.
- **Desktop:** the Dock and taskbar icon counts finished turns you have not seen, and right-click shows the platform menu.

### Improved

- Toasts and notifications are redesigned and say what happened, under the right session.
- The Customize and Models pages are redesigned; Slack and Teams have new connect flows.
- pi sessions: codemode is on by default, images work on the computer, and summaries and compaction are steadier.
- A session opens on its own model on web and mobile, and returning to a session tab no longer redraws the transcript.
- A draft keeps its attached files across a session switch and a reload; a typed follow-up keeps Send during a turn.
- Slash commands sent mid-turn wait for the agent to finish; @file and @agent mentions reach the agent on the first message.
- A running compaction no longer opens on a blank page; its rows sit with the turn.
- Project members with limited access see only the Customize tabs they can manage.

### Fixed

- The first renewal after checkout is no longer skipped.
- Only the person who prompted a run, the owner or a manager can stop it, and everyone sees who stopped it.
- Another person prompting a private session no longer runs with their own personal accounts.
- A deleted session's transcript, prompts and config now return not found, like the session.
- Shared sessions render their messages the same way the session does.
- An idle computer no longer sticks in starting after an update, and a prompt sent while a config change applies reaches the agent.
- Large agent configs boot; database connections retry when they never establish.
- New computer images warm up the agent runtime again, so a fresh session starts faster.
- Many smaller fixes across web, mobile, desktop, the CLI and connectors.
