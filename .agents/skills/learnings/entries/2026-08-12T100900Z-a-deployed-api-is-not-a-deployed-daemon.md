---
recorded: 2026-08-12T10:09:00Z
incident_date: 2026-08-12
commit: da9af7cb9d
---
# A deployed API is not a deployed daemon

**When:** shipping any change to `apps/kortix-sandbox-agent-server`, or turning
on something that depends on one. `/health` reporting your commit proves the API
rolled; it says nothing about the sandbox. The daemon is gzipped into the
snapshot build context (`apps/api/src/snapshots/build-context.ts:185`) and
reaches a session only after that snapshot is rebuilt or agent-swapped
(`snapshots/templates.ts:613`) AND the warm pool has cycled off the old one.
Prove it in the guest, not from the API:
`grep -aoE "<expected literal>" /usr/local/bin/kortix-agent` in a session
created after the deploy — the Bun-compiled binary embeds its source strings.
Sequence any dependent flag flip AFTER that probe passes.
*Incident:* near-miss, same day as the MCP-argv fix below. Deploy Dev went green
and `dev-api` reported `66b6148d`, but two sandboxes created ~15 min later both
still had the pre-fix `"connector"` spelling. Merging the flag that enables the
MCP face on that evidence would have given every session a server whose command
exits 2 — a broken MCP entry where there had been none.
