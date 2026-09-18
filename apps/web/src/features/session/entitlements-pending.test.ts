import { describe, expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';

import { type GateQuery, resolveEntitlementsPending } from './entitlements-pending';

/**
 * Dev incident, 2026-09-17 — project 441011b6 on dev.kortix.com.
 *
 * A project MEMBER opened the composer model picker and got a spinner that
 * never resolved. Held it 30s; still spinning. Meanwhile the UI's own two
 * `GET /v1/projects/:id/model-picker` calls had already returned HTTP 200 with
 * a 9,796-byte populated catalog. The models were in the browser. Nothing drew
 * them.
 *
 * `model-selector.tsx` renders the spinner on `modelsLoading ||
 * entitlementsPending`, and `entitlementsPending` was permanently true.
 *
 * ## Why it was permanently true
 *
 * A DISABLED react-query never leaves `status: 'pending'` — there is no fetch
 * to settle it, so `isPending` stays true for the lifetime of the component.
 * The old expression hand-mirrored each query's `enabled` condition to
 * compensate:
 *
 *     const entitlementsPending =
 *       (!!projectId && projectDetailQuery.isPending) ||
 *       (!!projectId && llmGatewayEnabled && secretsQuery.isPending) ||
 *       accountStatePending;
 *
 * `secretsQuery` is `enabled: !!projectId && llmGatewayEnabled &&
 * canReadSecrets`. The mirror is missing `canReadSecrets`. `project.secret.read`
 * is manager-tier, so for a member it is false, the query never runs, and that
 * middle clause is `true && true && true` forever.
 *
 * The third clause is worse: `accountStatePending` carries NO guard at all,
 * while `useAccountState` disables itself whenever the billing-account context
 * is unresolved (`shouldQueryAccountState`). Same failure, one render away.
 *
 * The mirror was correct when written and went stale in `1c8b5434b8`
 * (2026-08-19, "unified access control … member-view gating"), which added
 * `canReadSecrets` to the query's `enabled` and not to the mirror.
 *
 * ## The rule that replaces it
 *
 * Do not restate `enabled` — read what the query is actually DOING.
 * `fetchStatus` is the enabled-aware half of react-query's state, and a query
 * holds this gate only while it is genuinely fetching a first answer. That is
 * `isPending && fetchStatus === 'fetching'`, which is exactly how query-core
 * derives `isLoading` (`queryObserver.js:310`, v5.101.2).
 *
 * A gate that cannot go stale beats a mirror that someone has to remember.
 */

const q = (isPending: boolean, fetchStatus: GateQuery['fetchStatus']): GateQuery => ({
  isPending,
  fetchStatus,
});

/** Genuinely loading its first result. */
const loading = q(true, 'fetching');
/** Disabled — `enabled: false`. Pending forever, fetching never. */
const disabled = q(true, 'idle');
/** Resolved. */
const settled = q(false, 'idle');

describe('resolveEntitlementsPending', () => {
  test('THE BUG: a disabled query does not hold the gate', () => {
    // The member case, reduced. `secretsQuery` never runs for someone without
    // `project.secret.read`, so it reports `isPending` for as long as the
    // picker is mounted. Reading that as "still loading" is what spun forever.
    expect(resolveEntitlementsPending([disabled])).toBe(false);
  });

  test('THE INCIDENT: a member with a loaded catalog gets a list, not a spinner', () => {
    // project detail resolved, account state resolved, secrets query disabled
    // because the member may not read secrets.
    expect(resolveEntitlementsPending([settled, disabled, settled])).toBe(false);
  });

  test('a manager on the same project is unaffected — the query runs and is awaited', () => {
    expect(resolveEntitlementsPending([settled, loading, settled])).toBe(true);
  });

  test('a genuinely loading query still holds the gate', () => {
    // The gate's original purpose survives: `/model-picker` is re-served after
    // a secret write, so showing a half-loaded entitlement answer makes rows
    // appear and then vanish.
    expect(resolveEntitlementsPending([loading])).toBe(true);
  });

  test('any one loading input is enough to hold it', () => {
    expect(resolveEntitlementsPending([settled, settled, loading])).toBe(true);
  });

  test('all settled releases it', () => {
    expect(resolveEntitlementsPending([settled, settled, settled])).toBe(false);
  });

  test('no inputs is not pending', () => {
    expect(resolveEntitlementsPending([])).toBe(false);
  });

  test('an offline-paused query releases it rather than spinning forever', () => {
    // `fetchStatus: 'paused'` is react-query holding a fetch until the network
    // returns. The catalog itself is already in the browser, so the honest
    // answer offline is the model list, not an indefinite spinner.
    expect(resolveEntitlementsPending([q(true, 'paused')])).toBe(false);
  });

  test('a settled query is never pending, whatever it is doing now', () => {
    // A background refetch of data we already hold must not re-open the gate;
    // that is the flicker this gate exists to prevent, inverted.
    expect(resolveEntitlementsPending([q(false, 'fetching')])).toBe(false);
  });
});

/**
 * The helper only helps if the hook uses it. These pin the call site, because
 * the hook itself cannot be rendered in `apps/web`'s test harness — there is no
 * jsdom, and `mock.module` is process-wide across a non---isolate `bun test`
 * run. Same reason `resolveGateProjectId` is exported and asserted this way.
 */
const gateSource = readFileSync(join(import.meta.dir, 'use-model-connection-gate.tsx'), 'utf8');

describe('use-model-connection-gate call site', () => {
  // `.includes(...)` rather than `toContain` deliberately: a failed `toContain`
  // on a 200-line file prints the whole file as one escaped string, which
  // buries the actual failure in every run that touches this hook.
  const has = (needle: string) => gateSource.includes(needle);

  test('the hook computes the gate through the helper', () => {
    expect(has('resolveEntitlementsPending(')).toBe(true);
  });

  test('no clause hand-mirrors an `enabled` condition again', () => {
    // Each of these was a restatement of a query's `enabled` that had to be
    // kept in sync by hand. Restating one is how this broke.
    expect(has('secretsQuery.isPending')).toBe(false);
    expect(has('projectDetailQuery.isPending')).toBe(false);
    expect(has('accountStatePending')).toBe(false);
  });
});
