/**
 * Integration test (real route, mocked writes): a presence heartbeat starts its
 * three independent database writes together, not one behind another
 * (KRTX-2727 / KRTX-2179).
 *
 * Measured on prod (Better Stack, kortix_api_logs): PUT presence p95 sat at
 * ~2.1 s against a 514 ms baseline while every >1 s request spent its time in
 * `db;dur` (avg ~1.28 s over ~6 statements) — pool-wait on a 6-connections-per-
 * task pool, not query time. The route serialized the lease upsert, the
 * notification read-mark and the START-capability verdict — three writes and
 * reads on DISJOINT tables whose results do not depend on each other — so every
 * heartbeat drew three sequential turns on a contended pool. The route now
 * starts them together and awaits the extension last (it alone needs the
 * verdict).
 *
 * The contract pinned here, in request order:
 *   1. `markSessionNotificationsRead` is INVOKED while the lease upsert is
 *      still in flight (before it resolves) — with the serialized route it was
 *      only invoked after the upsert settled;
 *   2. the START-capability check is invoked while the upsert is still in
 *      flight;
 *   3. `extendSandboxDeadlineForPresence` runs after the writes settle, only
 *      for a caller who may start the session, and its result is the response;
 *   4. `active=false` only drops the lease.
 *
 * The route's collaborators are replaced with gated fakes, so the ordering is
 * observed exactly and no clock is waited on.
 */
import { afterEach, describe, expect, mock, test } from 'bun:test';

// ── Gated fakes, installed before anything imports the route module. ──

/** One deferred per collaborator: resolved only when the test releases it. */
function gate() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

const calls: string[] = [];
const g = {
  upsert: gate(),
  mark: gate(),
  extend: gate(),
  del: gate(),
};

function routeTarget(projectId: string, sessionId: string) {
  return `/${projectId}/sessions/${sessionId}/presence`;
}

mock.module('../projects/lib/access', () => ({
  loadProjectForUser: async () => ({
    row: {
      accountId: ACCOUNT,
      projectId: PROJECT,
      metadata: { experimental: { notification_center: true } },
    },
    userId: VIEWER,
    actor: { credential: { kind: 'jwt' } },
  }),
  assertProjectCapability: async () => undefined,
  loadVisibleSession: async () => ({ row: { status: 'running' } }),
  sessionIsTombstoned: () => false,
  projectCapabilityAllowed: async () => {
    calls.push('capability');
    return true;
  },
}));

mock.module('../projects/lib/session-presence', () => ({
  upsertSessionPresence: async () => {
    calls.push('upsert');
    await g.upsert.promise;
  },
  deleteSessionPresence: async () => {
    calls.push('delete');
    await g.del.promise;
  },
}));

mock.module('../notifications/inbox-read', () => ({
  markSessionNotificationsRead: async () => {
    calls.push('mark-read');
    await g.mark.promise;
  },
}));

mock.module('../projects/sandbox-deadline', () => ({
  extendSandboxDeadlineForPresence: async () => {
    calls.push('extend');
    await g.extend.promise;
    return { deadlineAt: new Date('2026-10-20T12:00:00Z'), capAt: new Date('2026-10-20T13:00:00Z') };
  },
}));

const { projectsApp } = await import('../projects/lib/app');
const { registerSessionPresenceRoutes } = await import('../projects/routes/session-presence');

registerSessionPresenceRoutes();

const ACCOUNT = crypto.randomUUID();
const PROJECT = crypto.randomUUID();
const SESSION = 'presence-overlap';
const VIEWER = '00000000-0000-4000-a000-000000000001';

function put(body: Record<string, unknown>) {
  // The OpenAPI app is requested directly, without the global auth middleware:
  // the route's collaborators are mocked, so no credentials are needed.
  return projectsApp.request(routeTarget(PROJECT, SESSION), {
    method: 'PUT',
    headers: { 'content-type': 'application/json' },
    body: JSON.stringify(body),
  });
}

/** Let every pending microtask (the route's starts) run. */
const tick = () => Bun.sleep(5);

/** The request under test, held so afterEach can drain it even when an
 *  assertion failed mid-test: its resumed continuations must never land in the
 *  next test's call log. */
let pending: PromiseLike<Response> | null = null;

function startRequest(body: Record<string, unknown>): void {
  pending = Promise.resolve(put(body));
}

afterEach(async () => {
  for (const key of Object.values(g)) key.release();
  if (pending) {
    await Promise.resolve(pending).catch(() => undefined);
    pending = null;
  }
  calls.length = 0;
  for (const key of Object.values(g)) Object.assign(key, gate());
});

describe('PUT /sessions/:id/presence — independent writes overlap (KRTX-2727)', () => {
  test('the read-mark and the capability check start while the lease upsert is in flight', async () => {
    startRequest({ tab_id: crypto.randomUUID(), active: true });
    await tick();

    // THE contract: with the serialized route, nothing after the upsert was
    // invoked until the upsert resolved — the upsert gate is still held here.
    expect(calls).toContain('upsert');
    expect(calls).toContain('mark-read');
    expect(calls).toContain('capability');

    g.upsert.release();
    g.mark.release();
    await tick();
    // The extension starts only after the writes settle (it alone needs the
    // capability verdict), then resolves the request.
    expect(calls).toContain('extend');
    g.extend.release();
    const res = await pending!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { awake_until: string | null; awake_cap_at: string | null };
    expect(body.awake_until).toBe('2026-10-20T12:00:00.000Z');
    expect(body.awake_cap_at).toBe('2026-10-20T13:00:00.000Z');
  });

  test('active=false only drops the lease', async () => {
    startRequest({ tab_id: crypto.randomUUID(), active: false });
    await tick();
    expect(calls).toEqual(['delete']);
    g.del.release();
    const res = await pending!;
    expect(res.status).toBe(200);
    const body = (await res.json()) as { awake_until: string | null };
    expect(body.awake_until).toBeNull();
  });
});
