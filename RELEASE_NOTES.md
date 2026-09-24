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
- Kortix-managed models route through Morph first, with a confirmed-US,
  zero-retention failover when it is unavailable.
- **Mobile**: attachments upload through the shared SDK, a session starts
  optimistically, and there is a Members page.

## Fixed

- Creating a session no longer fails with a server error when a transient
  git-mirror fetch fails; it retries instead.
- A trigger or channel prompt no longer freezes the mobile app.
- A request that changes nothing no longer records a change in the audit log,
  and a rate-limited request no longer stores the path it was refused on.
- A git push no longer shares its upstream connection with another push.
- OpenAI and Anthropic models are never presented as Kortix-managed.
- Quote splitting trims newlines in one pass.
- A git request that cannot get its repository credential now fails with a clear,
  retryable error instead of a misleading "repository not found", and a brief
  credential failure is retried before anyone sees it.
- Session turns no longer render out of order after prompts sent from the CLI.
- On the desktop app, Back is clickable again on sign-in, `/projects`, `/new` and
  onboarding, and the window can still be dragged from those pages.
- The shader wallpaper compiles again; its uniform names used a form GPUs reject.
- When memory runs out because of files held in RAM, the memory guard now names
  them instead of reporting only that the turn stopped.
- An agent merging its own change request no longer gets a false "changes agents
  or triggers" refusal right after a push; the check reads the current branches.
- An App's Access list shows an agent grant right after it is saved.

## Security

- Session routes, public shares and proxy edges check access through one shared
  rule set, and server-managed session metadata can no longer be set by clients.
- Chat-channel webhooks are scoped to their verified project and workspace.
- Credit is granted only for settled payments.
- Tighter database grants for Supabase client roles; 57 unused legacy database
  functions are removed.
- Private sandbox ingress, token hashing, and proxy-aware IP rate limits.

