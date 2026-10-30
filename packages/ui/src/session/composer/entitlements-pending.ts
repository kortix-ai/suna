/**
 * Is an entitlement input still loading — asked in a way that cannot go stale.
 *
 * ## The incident this replaces
 *
 * Dev, 2026-09-17: a project MEMBER opened the composer model picker and got a
 * spinner that never resolved, while the UI's own `/model-picker` calls had
 * already returned HTTP 200 with a populated catalog. The models were in the
 * browser; the gate never let them render.
 *
 * `useModelConnectionGate` used to answer this by restating every query's
 * `enabled` condition inline:
 *
 *     const entitlementsPending =
 *       (!!projectId && projectDetailQuery.isPending) ||
 *       (!!projectId && llmGatewayEnabled && secretsQuery.isPending) ||
 *       accountStatePending;
 *
 * It had to, because a DISABLED react-query never leaves `status: 'pending'` —
 * with no fetch to settle it, `isPending` stays true forever. The restatement
 * is the only thing standing between that and an indefinite spinner, and it is
 * maintained by hand.
 *
 * It went stale the first time someone changed an `enabled` without changing
 * its copy. `secretsQuery` gained `&& canReadSecrets`; this expression did not.
 * `project.secret.read` is manager-tier, so for a member the query never ran,
 * the middle clause was permanently true, and the picker spun for everyone
 * below manager. The third clause never had a guard at all, and
 * `useAccountState` disables itself whenever the billing-account context is
 * unresolved.
 *
 * ## The rule
 *
 * Do not restate `enabled`. Ask what the query is actually DOING.
 * `fetchStatus` is the enabled-aware half of react-query's state and answers
 * directly: a query holds this gate only while it is genuinely fetching a first
 * answer.
 *
 *   - `isPending` + `fetching` → loading. Hold.
 *   - `isPending` + `idle`     → DISABLED. It is not coming. Release.
 *   - `isPending` + `paused`   → offline. The catalog is already in the
 *                                browser; a list beats an endless spinner.
 *   - settled                  → release, including during a background
 *                                refetch, which must not re-open the gate.
 *
 * That is exactly how query-core derives `isLoading`
 * (`isPending && isFetching`, queryObserver.js:310 in v5.101.2). Spelled out
 * here rather than read off `isLoading` so the disabled case is legible at the
 * call site — it is the one that caused an incident — and so this stays
 * provable in `apps/web`'s test harness, which cannot render the hook.
 *
 * Adding a fourth entitlement input now costs one array entry and carries no
 * condition to keep in sync.
 */

/** The slice of a react-query result this rule reads. */
export interface GateQuery {
  isPending: boolean;
  fetchStatus: 'fetching' | 'paused' | 'idle';
}

export function resolveEntitlementsPending(queries: readonly GateQuery[]): boolean {
  return queries.some((query) => query.isPending && query.fetchStatus === 'fetching');
}
