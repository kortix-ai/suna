/**
 * Pin: the resource-grants picker is a page view (KRTX-821).
 *
 * GET /{projectId}/resource-grants loads the project config through the git
 * mirror. Without the page-view opt-in the handler pays the mirror's refresh
 * — a GitHub `git fetch` (30 s budget, 3 retries) or an evicted-mirror cold
 * clone (90 s budget) — on the request path whenever the 60 s refresh
 * interval has elapsed. Prod measured that cost: across 31 slow reads the
 * config stage carried 88.5% of the time (avg 6.6 s, max 21.8 s), and on
 * 2026-09-29 the worst reads crossed the 25 s request deadline as 503s.
 *
 * The pin runs the real GET handler against a local OpenAPIHono with every
 * collaborator mocked at its module seam (no PostgreSQL, no git). It holds
 * the ORDER: `allowStaleMirrorReads()` must have run before the config load
 * starts, so `refreshMirror` serves the warm mirror and refreshes behind the
 * response — the same contract every other page-view route pins through
 * `mirror-view-stale.test.ts`.
 */
import { describe, expect, mock, test } from 'bun:test';
import { OpenAPIHono } from '@hono/zod-openapi';

const accountId = '10000000-0000-4000-8000-000000000000';
const projectId = '11111111-1111-4111-8111-111111111111';

const app = new OpenAPIHono<any>();

// Real modules load first, against real collaborators, before any mock is
// registered — only the route module (imported last) sees the mocks.
const realMirror = await import('../git/mirror');
const realProjectResources = await import('../lib/project-resources');
let staleReadCalls = 0;
mock.module('../git/mirror', () => ({
  ...realMirror,
  allowStaleMirrorReads: () => {
    staleReadCalls++;
  },
}));

mock.module('../lib/app', () => ({ projectsApp: app }));

mock.module('../lib/access', () => ({
  loadProjectForUser: async () => ({
    userId: '44444444-4444-4444-8444-444444444444',
    row: {
      accountId,
      projectId,
      name: 'picker-pin',
      repoUrl: 'https://example.test/repo',
      defaultBranch: 'main',
      manifestPath: 'kortix.yaml',
    },
  }),
  assertProjectCapability: async () => {},
  lookupEmailsByUserIds: async () => new Map<string, string>(),
  parseExpiresAtBody: (raw?: string) =>
    raw ? { ok: true as const, value: new Date(raw) } : { ok: true as const, value: null },
}));

mock.module('../../iam', () => ({
  PROJECT_ACTIONS: { PROJECT_MEMBERS_MANAGE: 'project.members.manage' },
  deleteResourceGrant: async () => true,
  isCreatableResourceType: () => true,
  listResourceGrants: async () => [],
  upsertResourceGrant: async () => ({ grantId: '00000000-0000-4000-8000-000000000001' }),
}));

/** How many opt-ins had run when the config load started. */
let staleReadCallsAtConfigLoad = -1;
mock.module('../lib/project-resources', () => ({
  ...realProjectResources,
  loadConfigWithFiles: async () => {
    staleReadCallsAtConfigLoad = staleReadCalls;
    return { agents: [], skills: [] };
  },
  projectHasResource: () => false,
  projectResourcesFromConfig: () => ({ agents: [], skills: [] }),
}));

mock.module('../../shared/db', () => ({
  db: new Proxy(
    {},
    {
      get() {
        throw new Error('unexpected db use in the page-view pin');
      },
    },
  ),
}));

await import('./resource-grants');

const getGrants = () => app.request(`/${projectId}/resource-grants`);

describe('GET resource-grants — page-view mirror opt-in', () => {
  test('the config load starts after allowStaleMirrorReads ran', async () => {
    const response = await getGrants();
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ resources: { agents: [], skills: [] }, grants: [] });
    expect(staleReadCalls).toBe(1);
    expect(staleReadCallsAtConfigLoad).toBe(1);
  });
});
