/**
 * Regression test for the `effective:batch` per-probe isolation fix.
 *
 * Background: the accounts detail page fires `POST /accounts/:id/iam/members/:me/effective:batch`
 * (8 capability probes) on every load. The handler used `Promise.all` over the
 * per-probe `authorize` calls, so a SINGLE transient `authorize` rejection (a
 * momentary DB connection-pool blip under saturation — authorizeV2 issues
 * several unguarded `await db` queries per probe) rejected the WHOLE batch,
 * escalating to the global onError's opaque 500 "Internal server error". The
 * SDK surfaced that as `ApiError: Internal server error` (Better Stack pattern
 * c0e40278…, one-off / 0 users — transient-saturation signature).
 *
 * The fix (`resolveBatchProbes` in ./batch-probes) uses `Promise.allSettled` so
 * a rejected probe degrades to `{ allowed: false, reason: 'probe_error' }`
 * instead of nuking the batch. These tests pin that contract without a database
 * by injecting a mock `authorize` — the helper is deliberately a leaf module
 * with no external-dep imports so this runs under `bun test` with no install.
 */
import { describe, expect, test, mock } from 'bun:test';
import {
  resolveBatchProbes,
  type AuthorizeFn,
  type BatchProbe,
} from '../accounts/iam/batch-probes';

const TARGET_USER = 'user-1';
const ACCOUNT = 'acct-1';

// A stand-in for the real `authorize` (which hits the DB). Lets us inject
// transient failures deterministically.
const makeAuthorize = (behaviour: (action: string) => 'allow' | 'deny' | 'throw'): AuthorizeFn =>
  mock(async (_userId: string, _accountId: string, action: string) => {
    const v = behaviour(action);
    if (v === 'throw') throw new Error('simulated transient DB blip');
    return { allowed: v === 'allow', reason: v === 'allow' ? 'policy' : 'no_matching_policy' };
  }) as unknown as AuthorizeFn;

const accountProbe = (action: string): BatchProbe => ({ action, target: { type: 'account' } });

describe('resolveBatchProbes — per-probe isolation', () => {
  test('a transient authorize rejection degrades ONE probe to allowed:false / probe_error instead of rejecting the batch', async () => {
    const probes = [
      accountProbe('account.write'),
      accountProbe('member.invite'),
      accountProbe('audit.read'),
    ];
    // The middle probe's authorize transiently throws.
    const authorizeFn = makeAuthorize((a) =>
      a === 'member.invite' ? 'throw' : a === 'account.write' ? 'allow' : 'deny',
    );

    // Must NOT throw — that was the whole bug (Promise.all rejected the batch).
    const results = await resolveBatchProbes(probes, authorizeFn, TARGET_USER, ACCOUNT);

    expect(results).toHaveLength(3);
    // Probe 0 — allowed.
    expect(results[0]).toMatchObject({ action: 'account.write', allowed: true, reason: 'policy' });
    // Probe 1 — degraded to fail-closed, NOT a thrown 500.
    expect(results[1]).toMatchObject({
      action: 'member.invite',
      allowed: false,
      reason: 'probe_error',
    });
    expect(results[1].resource_type).toEqual(expect.any(String));
    expect(results[1].resource_id).toBeNull();
    // Probe 2 — still resolved normally (the transient blip didn't cascade).
    expect(results[2]).toMatchObject({
      action: 'audit.read',
      allowed: false,
      reason: 'no_matching_policy',
    });
  });

  test('every probe failing still resolves (all probe_error) instead of rejecting', async () => {
    const probes = [accountProbe('account.write'), accountProbe('account.delete')];
    const authorizeFn = makeAuthorize(() => 'throw');

    const results = await resolveBatchProbes(probes, authorizeFn, TARGET_USER, ACCOUNT);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.allowed === false && r.reason === 'probe_error')).toBe(true);
  });

  test('dedupes duplicate (action, target) probes — one authorize call, two result rows in order', async () => {
    const probes = [accountProbe('account.write'), accountProbe('account.write')];
    const authorizeFn = makeAuthorize(() => 'allow');

    const results = await resolveBatchProbes(probes, authorizeFn, TARGET_USER, ACCOUNT);

    expect(results).toHaveLength(2);
    expect(results.every((r) => r.allowed === true && r.reason === 'policy')).toBe(true);
    expect((authorizeFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(1);
  });

  test('a transient failure on a shared (action, target) key degrades all duplicates to probe_error', async () => {
    const probes = [
      accountProbe('account.write'),
      accountProbe('account.write'),
      accountProbe('member.invite'),
    ];
    const authorizeFn = makeAuthorize((a) => (a === 'account.write' ? 'throw' : 'allow'));

    const results = await resolveBatchProbes(probes, authorizeFn, TARGET_USER, ACCOUNT);

    expect(results[0]).toMatchObject({ allowed: false, reason: 'probe_error' });
    expect(results[1]).toMatchObject({ allowed: false, reason: 'probe_error' });
    expect(results[2]).toMatchObject({ allowed: true, reason: 'policy' });
  });

  test('resource-scoped probes carry their resource_id through both success and probe_error paths', async () => {
    const projectId = 'proj-42';
    const probes: BatchProbe[] = [
      { action: 'project.read', target: { type: 'project', id: projectId } },
      { action: 'project.write', target: { type: 'project', id: projectId } },
    ];
    const authorizeFn = makeAuthorize((a) => (a === 'project.read' ? 'allow' : 'throw'));

    const results = await resolveBatchProbes(probes, authorizeFn, TARGET_USER, ACCOUNT);

    expect(results[0]).toMatchObject({
      action: 'project.read',
      allowed: true,
      resource_id: projectId,
    });
    expect(results[1]).toMatchObject({
      action: 'project.write',
      allowed: false,
      reason: 'probe_error',
      resource_id: projectId,
    });
  });

  test('an empty probe list resolves to an empty result (no authorize calls)', async () => {
    const authorizeFn = makeAuthorize(() => 'allow');
    const results = await resolveBatchProbes([], authorizeFn, TARGET_USER, ACCOUNT);
    expect(results).toEqual([]);
    expect((authorizeFn as unknown as { mock: { calls: unknown[] } }).mock.calls).toHaveLength(0);
  });

  test('onProbeError is invoked once per failed probe with diagnostic context (keeps the signal visible without Sentry)', async () => {
    const probes = [
      accountProbe('account.write'),
      accountProbe('member.invite'),
      accountProbe('audit.read'),
    ];
    const authorizeFn = makeAuthorize((a) =>
      a === 'member.invite' || a === 'audit.read' ? 'throw' : 'allow',
    );
    const onProbeError = mock((_ctx: unknown) => {});

    await resolveBatchProbes(probes, authorizeFn, TARGET_USER, ACCOUNT, onProbeError as never);

    // Two probes failed → two structured-log callbacks (one each).
    expect(onProbeError).toHaveBeenCalledTimes(2);
    const firstCall = (onProbeError as unknown as { mock: { calls: unknown[][] } }).mock.calls[0][0] as {
      accountId: string;
      action: string;
      error: string;
      errorName: string;
    };
    expect(firstCall).toMatchObject({
      accountId: ACCOUNT,
      action: 'member.invite',
      error: 'simulated transient DB blip',
      errorName: 'Error',
    });
  });
});
