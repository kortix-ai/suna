Kortix as an MCP server

Kortix as an MCP server, Codex CLI support, reminders, approvals you can answer, and sessions that repair themselves instead of stopping.

## New

- One account-level MCP server at `/v1/mcp`, bound to your token like the CLI. It exposes sandbox shell and files, skills, and the session list; long commands run as jobs, and connected apps can be listed and revoked. `kortix mcp` runs the whole CLI as an MCP server, and a Connect MCP menu sets it up.
- The LLM gateway accepts the OpenAI Responses API, so the Codex CLI works against Kortix.
- Reminders: schedule prompts into a session, with a Reminders view and a per-project flag.
- Approvals: the agent describes each gated call, the approver can reply, and approval cards reach Slack and Teams.
- New projects get a three-step onboarding and a first chat.
- GitHub projects can be created under personal GitHub accounts, and their sessions start.
- Sandbox templates can run Docker inside the sandbox.
- Agents can store secrets they already have, and long setup links load.
- ChatGPT accounts show when they need reconnection, and a failed ChatGPT turn offers Reconnect or Connect ChatGPT.
- Saved session history is 1:1 with the live session and on by default, including sub-agents.
- The mobile app signs in to self-hosted Kortix instances.
- Slack: a session's Slack thread is bound automatically so replies come back to it, and the agent can remove its own reactions.
- The CLI saves large connector results as JSON (`--out`, and MCP results above 16 KB).

## Improved

- A project's fallback model chain runs when a model is unavailable, when a ChatGPT plan or BYOK model fails, and when every pooled account is paused or needs reconnection.
- The LLM gateway bounds requests per credential.
- DeepSeek and GLM accept images and a thinking control; model hosting is named accurately.
- Session connection and run status are accurate across web, mobile and the SDK, without flapping.
- A session is never parked while its runtime repair is still running, and its model converges when it opens.
- Sessions move off retired managed models automatically, and the error names the cause.
- Sharing a session switches it to the project's keys instead of stranding it.
- Sandbox images carry every runtime asset, and updates move only the chunks that changed.
- Audit events are ingested and reconciled without blocking requests or scanning whole tables.
- Sandbox health polls and connector listings answer faster.

## Fixed

- Every prompt file reaches the computer.
- Every agent picker lists the project's own agent roster.
- Connector toolkit search returns the same page shape as the unsearched list.
- A dead credential gets a typed 401, so retrying clients stop.
- The Firecrawl proxy rejects private and metadata URLs.
- Values can be copied out of the XLSX and CSV viewers.
- A pinned runtime that still serves no longer refuses its session.
- Old saved tool calls show what they kept; an empty session opens on its composer.
- A stopped session wakes without needing a message.
- `GET /kortix/part` in the sandbox requires the same credential as its sibling routes.
- Teams: the bot token is sent only to stored service URLs, and the sign-in link appears only in one-to-one chats.

