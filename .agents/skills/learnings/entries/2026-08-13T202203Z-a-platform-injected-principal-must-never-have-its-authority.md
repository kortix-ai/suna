---
recorded: 2026-08-13T20:22:03Z
incident_date: 2026-08-13
commit: 9694c55489
---
# A platform-injected principal must never have its authority re-derived from user config

**When:** touching code that RE-resolves an already-minted credential —
`remintGrantForAgentSwitch` / `reconcileStoredSessionAgentGrant`
(`apps/api/src/projects/lib/session-token-grant.ts`), which run on EVERY prompt
and every connector call. The `meta` coordinator is injected by
`addPlatformMetaAgent` and appears in no `kortix.yaml`, so resolving it through
the manifest returns "unlisted agent": deny-all on a governed project,
UNRESTRICTED on an ungoverned one. Both are destructive — the deny-all was
WRITTEN over the coordinator's real grant on its first turn, and the null made
the re-mint refuse the turn outright. Branch for the platform-owned principal in
the ONE pure resolver every path shares (`grantFromLoadedAgents`); a special case
at the mint alone is exactly what the re-mint then erases.
Two traps cost hours here. A comment asserting a fast path is not evidence the
fast path exists — `preview.ts:1144` says an ordinary turn "skips the manifest
read entirely" while the callee has no early return at all; read the callee. And
`authorizeV2` returns `super_admin` BEFORE the agent-grant fold, while a personal
account's primary owner has `is_super_admin = true` — so this entire bug class is
invisible on a laptop until you clear that flag.
*Incident:* the meta coordinator could not list or spawn sessions for the account
owner running it; `kortix sessions ls` / `new` 403'd from turn one onward, and
the 403 blamed their role (that misdiagnosis fixed separately in #6443).
*Enforcer:* `apps/api/src/__tests__/unit-meta-agent-grant-resolution.test.ts`
pins resolution for governed / ungoverned / unreadable manifests, the `skip`
re-mint decision, and the old destructive `write` as a regression guard. Nothing
enforces the comment-vs-callee or super-admin traps — those are prose only.
