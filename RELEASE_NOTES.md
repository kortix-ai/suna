Marketplace by default, People Search, SCIM provisioning, and session reliability

## New

- **Marketplace is on by default.** Every project can now browse and install marketplace skills without a feature flag. Kortix Meet, Kortix Computer, and People Search are opt-in installs rather than part of the default set.
- **People Search.** A new starter tool that searches LinkedIn profiles (backed by Apify), runs to completion without timeouts, and is billed per call.
- **Expanded skill library.** A much larger set of default skills ships with every new project, and the auto-created "My First Project" now gets the full starter pack.
- **SCIM provisioning that just works.** Error-free user provisioning from your IdP: invited users arrive active, PUT updates are supported, email lookups are dedup-safe, and Azure AD connector setup gets /ResourceTypes + /Schemas discovery. The SCIM setup dialog now shows the paste-ready absolute base URL.
- **SSO group auto-provisioning.** An opt-in toggle creates groups (and their mappings) automatically from IdP claims on login, so directory structure flows into Kortix without manual setup. SSO and SCIM settings cards got status pills and visual group mappings.
- **Upgrades section.** Projects have an Upgrades registry with a one-off prompt runner, so platform-side improvements (like a baseline refresh) can be applied to existing projects on demand.
- **Files is a standalone page** with Google Drive-style colored folder tiles, out of the Customize overlay. Customize itself moves to a master-detail sidebar for agents, skills, and commands.
- **Warm prebake on push.** Sandbox images warm when a commit lands — for every provider a session can use — so sessions on recently-active projects boot faster.
- **CLI: attach to a session.** `kortix` can now attach directly to a running session's agent from the terminal.
- **Per-account concurrent-session limits.** Accounts can carry a custom concurrent-session override, and hitting the limit now explains exactly what happened.
- **SDKs on npm.** `@kortix/sdk` and `@kortix/llm-catalog` now publish to npm with every release, in lockstep with the platform version, joining `@kortix/executor-sdk`.

## Improved

- **Sandboxes no longer idle for hours.** An observe-idle reaper with 15-minute/5-minute TTLs, a busy probe, and a provider backstop stop stopped-but-billing dead time.
- Agents automatically resume work when a turn is killed by a transient model-provider error, instead of stopping silently.
- The LLM gateway no longer forwards empty completions: it retries the same model once, then fails over to the next candidate. Upstream provider errors now surface in the stream instead of hanging it.
- The full member directory is visible to all account members (sensitive columns stay manager-only), and member counts reflect what the viewer can see. "Departments" are now "groups" throughout.
- The PDF viewer opens at a comfortable zoom with the sidebar closed, and presentation viewers drop redundant download buttons.

## Fixed

- **Change requests can no longer be empty.** An agent that committed but never pushed used to produce a silent "No changes detected" change request; the push step is now enforced and empty CRs are rejected at open time.
- **Session lifecycle races.** Starting a brand-new session no longer trips over its own creation (the create-vs-start race), deleting a session mid-provision can no longer resurrect it, the first prompt of a new session is no longer dropped while the agent restarts, a session page open on a stopped sandbox no longer hammers it with requests, and the create-first flow no longer bounces back to the project index.
- The project-home composer keeps its text while navigating into the new session, and the sidebar flyout stays open while one of its menus is open.
- Legacy `daytona` provider names are normalized at session create, so older projects keep working after the provider rename.
- Suna migration pushes are now idempotent across pods and strip oversized blobs instead of failing.
- Snapshot cache keys are scoped to in-sandbox inputs, so unrelated source changes no longer invalidate sandbox snapshots.
- AgentMail inbox limits are handled gracefully instead of erroring the channel.
- API and gateway origin load balancers only accept traffic from Cloudflare, closing a WAF-bypass path.
- Gateway request logs strip NUL bytes before persisting, fixing a recurring database write error.

## Internal

- CI hardening: staging keeps its VERSION in sync on release, a duplicate migration was deduped before it could break deploys, staging QA runs behind Vercel SSO with a bypass token, the direct prod hotfix workflow is retired, and dependency/action versions are bumped across the board.
