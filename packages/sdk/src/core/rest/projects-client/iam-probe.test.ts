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

// KRTX-4042 — the batch route 400s the WHOLE batch when one probe is invalid
// (apps/api/src/accounts/iam/members.ts), while the single GET answers each
// probe alone. This mock follows both routes' validation rules: the server
// knows only 'account' and 'project' (apps/api/src/iam/actions.ts).
const SERVER_RESOURCE_TYPES = ['account', 'project'];

type WireProbe = { action: string; resourceType?: string; resourceId?: string };

/** Installs a typed fetch handler: Bun's `typeof fetch` also carries `preconnect`. */
function serveFetch(
  handler: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>,
): void {
  globalThis.fetch = Object.assign(handler, { preconnect: fetch.preconnect });
}

/** null = valid; otherwise the 400 message the route returns. */
function invalidReason(probe: WireProbe, route: 'single' | 'batch'): string | null {
  const { resourceType: type, resourceId: id } = probe;
  if (type === undefined || type === 'account') return null;
  if (SERVER_RESOURCE_TYPES.includes(type)) return id ? null : 'resourceId required';
  // The single route treats an unknown type as an account probe (probeObject).
  return route === 'batch' ? 'resourceType is not a known resource type' : null;
}

function serveByServerRules(allowedActions: string[]): void {
  const answer = (probe: WireProbe) => verdict(allowedActions.includes(probe.action), probe.action);
  const json = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { 'content-type': 'application/json' } });
  serveFetch(async (input, init) => {
    const url = new URL(
      typeof input === 'string' ? input : input instanceof URL ? input.href : input.url,
    );
    const method = init?.method ?? 'GET';
    const body = init?.body ? JSON.parse(String(init.body)) : undefined;
    calls.push({ url: url.href, method, body });
    if (method === 'POST') {
      const probes: WireProbe[] = body.probes;
      const bad = probes.map((p) => invalidReason(p, 'batch')).find((r) => r !== null);
      return bad ? json(400, { error: bad }) : json(200, { results: probes.map(answer) });
    }
    const probe: WireProbe = {
      action: url.searchParams.get('action') ?? '',
      resourceType: url.searchParams.get('resourceType') ?? undefined,
      resourceId: url.searchParams.get('resourceId') ?? undefined,
    };
    const bad = invalidReason(probe, 'single');
    const { resource_id: _omitted, ...single } = answer(probe);
    return bad ? json(400, { error: bad }) : json(200, single);
  });
}

test('one invalid probe does not fail its valid sibling — the sibling gets its verdict', async () => {
  serveByServerRules(['project.create']);

  const settled = await Promise.allSettled([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', {
      action: 'project.read',
      resourceType: 'project',
      resourceId: '',
    }),
  ]);

  expect(settled[0]).toEqual({ status: 'fulfilled', value: verdict(true, 'project.create') });
  expect(settled[1]?.status).toBe('rejected');
});

test('an unknown resourceType probe and its sibling both resolve via the single GET', async () => {
  serveByServerRules(['project.create']);

  const [create, sandbox] = await Promise.all([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', {
      action: 'sandbox.read',
      resourceType: 'sandbox',
      resourceId: 's-1',
    }),
  ]);

  expect(create).toEqual(verdict(true, 'project.create'));
  expect(sandbox).toEqual(verdict(false, 'sandbox.read'));
  // One rejected POST, then each entry alone on the old GET path.
  expect(calls.map((c) => c.method)).toEqual(['POST', 'GET', 'GET']);
  expect(calls[2]?.url).toBe(
    'http://test.local/accounts/acc-1/iam/members/u1/effective?action=sandbox.read&resourceType=sandbox&resourceId=s-1',
  );
});

test('a lone unknown-resourceType probe is answered, as the single GET answered it', async () => {
  serveByServerRules([]);

  const answer = await probeEffectivePermission('acc-1', 'u1', {
    action: 'sandbox.read',
    resourceType: 'sandbox',
    resourceId: 's-1',
  });

  expect(answer).toEqual(verdict(false, 'sandbox.read'));
});

test('a valid project probe answered by the fallback keeps its resource_id', async () => {
  serveByServerRules(['project.write']);

  const settled = await Promise.allSettled([
    probeEffectivePermission('acc-1', 'u1', {
      action: 'project.write',
      resourceType: 'project',
      resourceId: 'p-1',
    }),
    probeEffectivePermission('acc-1', 'u1', {
      action: 'project.read',
      resourceType: 'project',
      resourceId: '',
    }),
  ]);

  expect(settled[0]).toEqual({
    status: 'fulfilled',
    value: { ...verdict(true, 'project.write'), resource_id: 'p-1' },
  });
});

test('a batch 5xx does not fan out to single GETs — every waiter fails closed', async () => {
  serveFetch(async (input, init) => {
    calls.push({ url: String(input), method: init?.method ?? 'GET' });
    return new Response(JSON.stringify({ error: 'boom' }), { status: 503 });
  });

  const settled = await Promise.allSettled([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', { action: 'member.update' }),
  ]);

  expect(settled.map((s) => s.status)).toEqual(['rejected', 'rejected']);
  expect(calls.map((c) => c.method)).toEqual(['POST']);
});

test('a fallback single GET stays silent — no toast/Sentry for a background read', async () => {
  const onError = mock(() => {});
  configureKortix({ backendUrl: 'http://test.local', getToken: async () => 'tok', onError });
  serveByServerRules([]);

  const settled = await Promise.allSettled([
    probeEffectivePermission('acc-1', 'u1', { action: 'project.create' }),
    probeEffectivePermission('acc-1', 'u1', {
      action: 'project.read',
      resourceType: 'project',
      resourceId: '',
    }),
  ]);

  expect(settled.map((s) => s.status)).toEqual(['fulfilled', 'rejected']);
  expect(onError).not.toHaveBeenCalled();
});
