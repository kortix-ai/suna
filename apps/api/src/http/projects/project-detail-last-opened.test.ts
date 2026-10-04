/**
 * GET /v1/projects/:projectId — the last-opened stamp is OFF the response path.
 *
 * The route used to `await` its `projects` write (`last_opened_at`,
 * `updated_at`) on every page view. Under DB contention (prod 2026-09-29,
 * KRTX-470) that commit wait serialized on the projects row lock and every
 * page view's latency rose with the audit ingest storm: the route's p50 stayed
 * at ~74 ms while its p95 hit 2.3 s. The stamp is a sort key for the project
 * selector and the command palette; nothing in the request reads it back, so
 * the handler now answers first and the write lands behind it — the same rule
 * the audit-pool learning fixed for POST /internal/gateway/trace (KRTX-609).
 *
 * The test drives the REAL handler with the write's promise unresolved: the
 * response must settle while the write is still pending, and the write must
 * still be issued with both columns set. `mock.module` is process-global in
 * bun:test, so this runs in its own file.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';

const PROJECT_ID = '00000000-0000-4000-a000-0000000270a0';
const ACCOUNT_ID = '00000000-0000-4000-a000-0000000270a1';
const USER_ID = '00000000-0000-4000-a000-0000000270a2';

function projectRow() {
  const now = new Date();
  return {
    projectId: PROJECT_ID,
    accountId: ACCOUNT_ID,
    name: 'last-opened-test',
    repoUrl: 'https://github.com/acme/last-opened-test.git',
    defaultBranch: 'main',
    manifestPath: 'kortix.yaml',
    status: 'active',
    metadata: null,
    lastOpenedAt: null,
    createdAt: now,
    updatedAt: now,
  };
}

/** Every `.set({...})` the handler issued, in call order. */
let setCalls: Record<string, unknown>[] = [];
/** The pending write's promise, resolved by the test. */
let releaseWrite: (() => void) | null = null;
/** Whether the pending write should reject when released. */
let rejectWrite = false;

mock.module('../../lib/db', () => ({
  hasDatabase: () => true,
  db: {
    update: () => ({
      set: (values: Record<string, unknown>) => {
        setCalls.push(values);
        return {
          where: () =>
            new Promise<void>((resolve, reject) => {
              releaseWrite = () =>
                rejectWrite ? reject(new Error('write rolled back')) : resolve();
            }),
        };
      },
    }),
  },
}));

const realAccess = await import('../../services/projects/lib/access');
mock.module('../../services/projects/lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async () => ({
    userId: USER_ID,
    row: projectRow(),
    projectRole: 'manager',
    effectiveRole: 'manager',
  }),
  assertAgentSessionWorkspaceAllowsRepository: async () => {},
  assertProjectCapability: async () => {},
  projectCapabilityAllowed: async () => true,
}));

// Registers project-detail.ts's routes onto the shared `projectsApp` singleton.
// projects.ts (which attaches the `supabaseAuth` middleware) is deliberately
// NOT imported, so this request needs no Authorization header.
const { projectsApp } = await import('./app');
(await import('./project-detail')).registerProjectDetailRoutes();

function get() {
  return projectsApp.request(`/${PROJECT_ID}`, { method: 'GET' });
}

/** The response, or a rejection if it has not settled within 1s. */
function settled(promise: Response | Promise<Response>) {
  return Promise.race([
    promise,
    new Promise<never>((_, reject) =>
      setTimeout(
        () => reject(new Error('the GET response waited for the last-opened write')),
        1_000,
      ),
    ),
  ]);
}

beforeEach(() => {
  setCalls = [];
  releaseWrite = null;
  rejectWrite = false;
});

describe('GET /:projectId — the last-opened stamp', () => {
  test('the response settles while the write is still pending, and the write is issued', async () => {
    const responsePromise = get();

    // The write was issued before the response — with both columns set.
    // Waiting for the HANDLER's first await would be too late: the assertion
    // below races the response, so if the handler awaited the write (the old
    // behavior), this 1s race rejects first and the test fails.
    const response = await settled(responsePromise);

    expect(response.status).toBe(200);
    expect(setCalls).toHaveLength(1);
    expect(setCalls[0]?.lastOpenedAt).toBeInstanceOf(Date);
    expect(setCalls[0]?.updatedAt).toBeInstanceOf(Date);
    const body = (await response.json()) as Record<string, unknown>;
    expect(body.project_id).toBe(PROJECT_ID);
    // The stamp is still pending: release it so nothing dangles.
    releaseWrite?.();
  });

  test('a failing stamp never fails the page view', async () => {
    rejectWrite = true;
    const response = await settled(get());

    expect(response.status).toBe(200);
    // The handler's `.catch` consumed the rejection; release nothing — the
    // rejected promise is already handled there.
    releaseWrite?.();
  });
});
