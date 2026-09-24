A readable audit log, agents as their own principal, and a much lighter web app

The audit log now reads as plain events instead of raw routes, agents act as
their own principal by default, the mobile app gets a large revamp, and the
marketing site ships far less JavaScript.

## New

- **An audit log you can read.** Every entry shows a readable title instead of a
  raw route, in all nine languages. Every API route and event now has a label,
  and `kortix audit ls` prints the same titles in the terminal.
- **More outcomes are audited**: sandbox-provider transitions, App deployments,
  branch cleanup (one entry per deleted remote branch), and an expired tunnel
  permission. Background jobs run each tick as a named worker, so their work is
  attributable.
- **Agents act as their own principal by default.** An agent has its own
  identity and permissions rather than borrowing the person who started it.
- **Apps are a per-agent resource** in both the editor and the CLI.
- **Reply to several passages at once** with inline quote blocks.
- **GPT-6 Sol and GPT-6 Luna** are available through a connected ChatGPT
  subscription.

## Improved

- The marketing pages are static and ship about 80% less JavaScript, and opening
  a session is faster.
- **Mobile**: onboarding, drafts, a reworked drawer header, connectors, a
  "Needs you" view, session chrome, the browser toolbar, plan rings and sheet
  contrast.
- **Desktop**: native window controls, sidebar and settings alignment, the
  collapsed sidebar accepts clicks again, and the Customize sidebar toggle stays
  clickable.
- File attachments now go through OpenAPI and HTTP connectors.

## Fixed

- Creating a session no longer fails with a server error when a transient
  git-mirror fetch fails; it retries instead.
- A trigger or channel prompt no longer freezes the mobile app.
- A request that changes nothing no longer records a change in the audit log,
  and a rate-limited request no longer stores the path it was refused on.
- A git push no longer shares its upstream connection with another push.
- OpenAI and Anthropic models are never presented as Kortix-managed.
- Quote splitting trims newlines in one pass.

