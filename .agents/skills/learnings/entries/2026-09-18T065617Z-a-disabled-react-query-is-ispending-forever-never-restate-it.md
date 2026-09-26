---
recorded: 2026-09-18T06:56:17Z
incident_date: 2026-09-17
commit: 96a62a893f
---
# A disabled react-query is `isPending` forever — never restate its `enabled`

**When:** reading `.isPending` from any `useQuery` whose `enabled` is
conditional, or adding a condition to an existing query's `enabled`.
A disabled query never leaves `status: 'pending'` — there is no fetch to settle
it — so any gate built on `isPending` must compensate. `useModelConnectionGate`
compensated by hand-restating each query's `enabled` inline, and the copy went
stale the first time someone changed one: `secretsQuery` gained
`&& canReadSecrets`, the restatement did not. `project.secret.read` is
manager-tier, so for every project MEMBER the query never ran, the clause was
`true && true && true` forever, and the composer model picker spun with zero
rows over a `/model-picker` catalog that had already returned 200. A third
clause (`accountStatePending`) had no guard at all.
**The rule:** do not restate `enabled` — ask what the query is DOING.
`isPending && fetchStatus === 'fetching'` is enabled-aware by construction
(exactly query-core's own `isLoading`): disabled reads `idle` and releases the
gate, offline-`paused` releases it rather than spinning over data already in the
browser, and a background refetch cannot re-open it.
**Diagnostic:** a spinner that outlives a 200 whose body is already in the
Network tab is a gate, not a fetch. Check `fetchStatus`, not `isPending`.
*Incident:* dev.kortix.com project `441011b6`, members only; introduced
`1c8b5434b8` (2026-08-19), found 2026-09-17, fixed in PR #7380. Reproduced and
A/B-proven on the real UI: same member, same project — `main` gave
`spinnerPresent:true, rowCount:0`, the fix gave `false, 8`.
*Enforcer:* `apps/web/src/features/session/entitlements-pending.test.ts` pins
the rule AND the call site (no clause may name `secretsQuery.isPending`,
`projectDetailQuery.isPending` or `accountStatePending` again). Nothing yet
lints the general pattern repo-wide — a sweep found 4 conditionally-enabled
queries read via `isPending`; this was the only live one.
*Follow-up (2026-09-18):* that sweep covered `apps/web` only and under-counted.
`packages/sdk/src/react/use-model-access.ts` carried a 5th instance —
`isLoading: query.isPending` under `enabled: !!projectId`, so
`useModelAccess(null)` (which `provider-connect.tsx:833` passes on purpose)
loaded forever. Latent, not live: no consumer rendered off that flag. Fixed to
`query.isLoading` and pinned by a rendered-hook test in
`use-model-access.test.ts` that asserts both halves — disabled reports settled
with zero fetches, enabled still reports its first fetch. A re-sweep of both
packages on 2026-09-18 found no remaining live instance: every other
`isPending` read in `packages/sdk/src/react/` is a `useMutation` (no `enabled`,
so correct), and all 4 query-shaped reads in `apps/web` are guarded by an early
return or an already-fixed helper. When the sweep is redone, sweep `packages/`
too — this hook was reachable from `apps/web` and the sweep still missed it.
