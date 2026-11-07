/**
 * KRTX-4437: `POST /snapshots/rebuild` and `POST /snapshots/fix-with-agent`
 * share one gate — project visible at floor 'read' (else 404), then
 * project.sandbox.write (else 403) — before they read the body or touch git.
 * Pinned through the real handlers so the two copies can become one.
 */
import { beforeEach, describe, expect, mock, test } from 'bun:test';
import { HTTPException } from 'hono/http-exception';

const PROJECT_ID = '33333333-3333-4333-8333-333333333333';
let loaded: { userId: string; row: { accountId: string; metadata: Record<string, never> } } | null;
let denied: boolean;
let calls: string[];

const realAccess = await import('../lib/access');
mock.module('../lib/access', () => ({
  ...realAccess,
  loadProjectForUser: async (_c: unknown, _projectId: string, action: string) => {
    calls.push(`load:${action}`);
    return loaded;
  },
  assertProjectCapability: async (_c: unknown, _u: string, _a: string, _p: string, action: string) => {
    calls.push(`capability:${action}`);
    if (denied) throw new HTTPException(403, { message: 'denied' });
    // Stop right after the gate: everything past it needs git and a provider.
    throw new HTTPException(418, { message: 'past the gate' });
  },
}));
const { projectsApp } = await import('../lib/app');
(await import('./sandboxes')).registerSandboxesRoutes();

beforeEach(() => {
  loaded = { userId: 'u1', row: { accountId: 'a1', metadata: {} } };
  denied = false;
  calls = [];
});

const post = (path: string) =>
  projectsApp.request(`/${PROJECT_ID}${path}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json' },
    body: '{}',
  });

for (const path of ['/snapshots/rebuild', '/snapshots/fix-with-agent']) {
  describe(path, () => {
    test("404s an unknown project at floor 'read' before any capability check", async () => {
      loaded = null;
      const response = await post(path);
      expect(response.status).toBe(404);
      expect(await response.json()).toEqual({ error: 'Not found' });
      expect(calls).toEqual(['load:read']);
    });

    test('403s without project.sandbox.write', async () => {
      denied = true;
      expect((await post(path)).status).toBe(403);
      expect(calls).toEqual(['load:read', 'capability:project.sandbox.write']);
    });

    test('a writer passes the gate in order', async () => {
      expect((await post(path)).status).toBe(418);
      expect(calls).toEqual(['load:read', 'capability:project.sandbox.write']);
    });
  });
}
