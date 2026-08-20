Release gate goes green: sharded, self-cleaning, right-sized staging

## New

- **One URL configures every email Kortix sends.** Signup confirmations, magic links, invites and alerts all flow through the same `EMAIL_URL` transport with the same sender identity and templates — self-hosted installs configure email once. Supabase auth mail now goes through the same path instead of GoTrue's own SMTP.
- **One-click OAuth for MCP connectors.** Connecting an MCP server that requires OAuth 2.1 now works end-to-end from the UI or via `kortix connectors authorize` — discovery, dynamic client registration and token exchange included.
- **Secrets get an exposure and usage model.** Each secret declares how it may be exposed and which usages are assigned to it, enforced by one mechanism across every sandbox provider.
- Session sharing is now the owner's call: managers keep lifecycle control (stop, restart), but only the session's owner can share it or mint public links.

## Fixed

- **Revoked API tokens now actually stop working.** A personal access token that had been revoked could still authenticate on every surface (REST, the LLM gateway, git proxy, preview proxy, connectors) because the validation query never checked the revocation timestamp. Revoked tokens are now rejected everywhere.
- **Deleting an account now stops and removes every one of its sandboxes** — across every account the user owns and every non-terminal state — instead of only stopping the ones under the earliest-joined account.
- **A runaway agent turn can no longer take the API down.** Each session's audit-event stream is bounded (900 events per minute); past that ceiling only the high-volume streaming-delta class is dropped while lifecycle, usage and billing events keep flowing.
- **API writes are much faster under load.** Audit events are written asynchronously in batches off the request path (they were a synchronous insert into a 14-index table on every request), and the account list no longer makes one admin-API call per member to resolve owner emails. Audit reads flush the queue first, so the audit log stays read-your-writes.
- **A waking sandbox no longer looks like an error.** Every surface (web, CLI, SDK) now treats the sandbox-starting state as "waking" with retry, instead of surfacing a 503. Resuming a stopped box also dropped two provider round trips.
- **Gateway reliability:** long streaming turns are no longer killed at 255 seconds by a runtime idle timeout; Bedrock requests with trailing prefill or redacted reasoning no longer fail; the gateway's provider shaping now runs on the new AI-SDK-native transport path, which is the default everywhere.
- **Slack:** another bot @-mentioning Kortix now works; linking the bot no longer demands owner/admin (it delegates only your own authority); user lookups were sent in a form Slack silently ignored — fixed.
- **Prompt queue and composer:** forwarded prompts can no longer strand, Stop can no longer leak into the next turn, fresh sessions paint instantly in one ordered batch, and the boot-time composer shows the session's real agent.
- Deleted sessions are no longer readable by id. Listing a project's group grants is manager-only, matching the write routes.
- Sandboxes learn the managed model set from the API on every boot, so a model the picker offers is one the runtime knows.
- Keyboard scrolling in a session is treated as scroll intent: Cmd+Up no longer snaps back to the end. A `session.error` is now attributed to the turn that failed.
- Starter reflector and reviewer agents run without approval prompts. Self-hosted boxes get a daily Docker prune timer.
- **Session titles and conversation counts are recorded again.** The per-session metadata mirror was silently never written (the internal call carried no user identity, so the sandbox rejected it) — session names and conversation counts now populate for new sessions.

## Security

- The sandbox egress pin trusts the edge-populated client IP rather than spoofable forwarding headers; the App public proxy honors a token's project/session scope; trigger-session manager visibility no longer extends to session-bound agent tokens.
- The browser test suite was broadcasting a deployment-protection bypass secret to third-party hosts on every run; it now authenticates once via a scoped cookie and the secret reaches no third party.
- nodemailer upgraded across two majors to clear open advisories, including one high.

## Internal

- **Roles have one store.** The RBAC cutover made `role_assignments` the only authorization store — legacy tables became views, mirror triggers were dropped, and 3,100 lines of parallel code were deleted.
- **The production release gate is now reliable and fast.** It runs as 6 API shards + 3 browser shards, cleans up its own test debris, tolerates a traffic-degraded-but-serving gateway, can be rehearsed against staging without opening a release PR, and the test client never replays a non-idempotent request through an edge-laundered error. Staging was right-sized for it, and a workflow-gating bug that had silently frozen the staging frontend for a week is fixed.
- **Container image builds are ~7× faster.** Staging and dev images build natively per architecture with a registry layer cache (API image: ~3 minutes, was ~20), and the arm64 frontend image is now genuinely arm64.
- `CREATE INDEX CONCURRENTLY` migrations ship with a `lock_timeout` that can land on a live database, and CI blocks any new one that sets it too low.
