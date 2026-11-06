// KRTX-4005 — concurrent single probes for one (account, user) must share ONE
// `effective:batch` POST. A page mounting several `useCan` gates at once fired
// one GET per gate — production logged 7-8 successful GETs to the same
// /effective path within a single second. The batch endpoint answers all of
// them in one roundtrip with identical auth semantics (same member.read gate,
// same `probeActor`, same `authorize` — apps/api/src/accounts/iam/members.ts).
//
// Harness: the real fetch seam with a recording mock, like ./iam.test.ts — no
// React engine needed, the hooks' `queryFn` calls `probeEffectivePermission`
// directly. The coalescing window is one macrotask, so tests await a short
// timer before asserting.

import { beforeEach, expect, mock, test } from 'bun:test';
import { configureKortix } from '../../http/config';
import { probeEffectivePermission, probeEffectivePermissions } from './iam-probe';
import type { PermissionProbeResult } from './iam-probe';

type Call = { url: string; method: string; body?: unknown };

let calls: Call[] = [];

function recordFetch(resultsFor: (probes: Array<{ action: string }>) => PermissionProbeResult[]) {
  return mock(async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url, method, body });
    const results = resultsFor(body?.probes ?? []);
    return new Response(JSON.stringify({ results }), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  }) as unknown as typeof fetch;
}

const verdict = (allowed: boolean, action = 'project.create'): PermissionProbeResult => ({
  allowed,
  reason: allowed ? 'role' : 'not_a_member',
  action,
  resource_type: 'account',
  resource_id: null,
});

const settle = () => new Promise((r) => setTimeout(r, 10));

beforeEach(() => {
  calls = [];
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok' });
});

test('concurrent distinct single probes on one (account, user) share ONE batch POST', async () => {
  globalThis.fetch = recordFetch((probes) => probes.map((p) => verdict(true, p.action)));

  const [a, b, c] = await Promise.all([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', { action: 'member.update' }),
    probeEffectivePermission('acc-1', 'u1', { action: 'role.create' }),
  ]);
  await settle();

  expect(a).toMatchObject({ allowed: true });
  expect(b).toMatchObject({ allowed: true });
  expect(c).toMatchObject({ allowed: true });
  const posts = calls.filter((x) => x.method === 'POST');
  expect(calls.filter((x) => x.method === 'GET')).toEqual([]);
  expect(posts).toHaveLength(1);
  const [firstPost] = posts;
  expect(firstPost?.url).toContain('/accounts/acc-1/iam/members/u1/effective:batch');
  expect(firstPost?.body).toEqual({
    probes: [{ action: 'project.create' }, { action: 'member.update' }, { action: 'role.create' }],
  });
});

test('identical concurrent probes dedupe to one entry and every caller gets the verdict', async () => {
  globalThis.fetch = recordFetch((probes) => probes.map((p) => verdict(true, p.action)));

  const [a, b] = await Promise.all([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
  ]);
  await settle();

  expect(a).toMatchObject({ allowed: true });
  expect(b).toMatchObject({ allowed: true });
  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({ probes: [{ action: 'project.create' }] });
});

test('distinct authorization contexts stay isolated — one request per account and per user', async () => {
  globalThis.fetch = recordFetch((probes) => probes.map((p) => verdict(true, p.action)));

  await Promise.all([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-2', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u2', { action: 'project.create' }),
  ]);
  await settle();

  // Three distinct contexts — three requests, none merged across principals.
  expect(calls).toHaveLength(3);
  expect(new Set(calls.map((x) => x.url)).size).toBe(3);
});

test('answers map back to the right caller, not by luck of ordering', async () => {
  globalThis.fetch = recordFetch((probes) =>
    probes.map((p) => verdict(p.action === 'project.create', p.action)),
  );

  const [create, update] = await Promise.all([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', { action: 'member.update' }),
  ]);

  expect(create.allowed).toBe(true);
  expect(update.allowed).toBe(false);
  expect(update.reason).toBe('not_a_member');
});

test('a resource-scoped probe carries its target into the batch body', async () => {
  globalThis.fetch = recordFetch((probes) => probes.map((p) => verdict(true, p.action)));

  await probeEffectivePermission('acc-1', 'u1', {
    action: 'project.write',
    resourceType: 'project',
    resourceId: 'p-1',
  });
  await settle();

  expect(calls).toHaveLength(1);
  expect(calls[0]?.body).toEqual({
    probes: [{ action: 'project.write', resourceType: 'project', resourceId: 'p-1' }],
  });
});

test('a failed batch rejects every waiter — fail closed upstream', async () => {
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ error: 'boom' }), { status: 503 }),
  ) as unknown as typeof fetch;

  const settled = await Promise.allSettled([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', { action: 'member.update' }),
  ]);
  await settle();

  expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
});

test('a bucket larger than the server batch cap is chunked, every caller answered', async () => {
  globalThis.fetch = recordFetch((probes) => probes.map((p) => verdict(true, p.action)));

  const actions = Array.from({ length: 70 }, (_, i) => `action.${i}`);
  const answers = await Promise.all(
    actions.map((action) => probeEffectivePermission('acc-1', 'u1', { action })),
  );
  await settle();

  expect(answers).toHaveLength(70);
  expect(answers.every((a) => a.allowed)).toBe(true);
  // 70 probes split into 64 + 6 — two POSTs, zero GETs.
  const posts = calls.filter((x) => x.method === 'POST');
  expect(posts).toHaveLength(2);
  const probesOf = (call?: Call): unknown[] => {
    const body = call?.body;
    return body && typeof body === 'object' && 'probes' in body
      ? ((body as { probes: unknown[] }).probes ?? [])
      : [];
  };
  expect(probesOf(posts[0])).toHaveLength(64);
  expect(probesOf(posts[1])).toHaveLength(6);
});

test('the batch path itself is untouched — direct batch calls skip the coalescer', async () => {
  globalThis.fetch = recordFetch((probes) => probes.map((p) => verdict(true, p.action)));

  await probeEffectivePermissions('acc-1', 'u1', [{ action: 'project.create' }]);
  await settle();

  expect(calls).toHaveLength(1);
  expect(calls[0]?.method).toBe('POST');
});

test('a failed coalesced batch stays silent — a background read raises no toast/Sentry', async () => {
  // Old single-GET parity: iamGet reads with showErrors:false, so a denied or
  // failing background probe never reached the host error sink. The coalesced
  // POST must fail closed in the caller just as quietly.
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
  ) as unknown as typeof fetch;

  const settled = await Promise.allSettled([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
  ]);
  await settle();

  expect(settled[0]?.status).toBe('rejected');
  expect(onError).not.toHaveBeenCalled();
});

test('the direct batch API keeps its noisy default — a failure calls onError', async () => {
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  globalThis.fetch = mock(
    async () => new Response(JSON.stringify({ error: 'boom' }), { status: 500 }),
  ) as unknown as typeof fetch;

  const settled = await Promise.allSettled([
    probeEffectivePermissions('acc-1', 'u1', [{ action: 'project.create' }]),
  ]);
  await settle();

  expect(settled[0]?.status).toBe('rejected');
  expect(onError).toHaveBeenCalledTimes(1);
});
