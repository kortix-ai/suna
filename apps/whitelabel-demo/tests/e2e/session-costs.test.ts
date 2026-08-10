import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import {
  APP_SETUP_TIMEOUT_MS,
  type AppInstance,
  createTestKortix,
  loginUser,
  resetUsersStore,
  startApp,
  uniqueEmail,
} from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { COST_MARKUP, DEMO_PASSWORD, wrapperEnv, WRAPPER_KEY } from './env';

const REMOVED_ATTRIBUTION_PATTERN = new RegExp(
  `${['end', 'user', 'ref'].join('_')}|${['origin', 'ref'].join('_')}`,
);

async function provision(
  app: AppInstance,
  token: string,
  name: string,
): Promise<string> {
  const project = await createTestKortix(app, token).projects.provision({
    name,
  });
  return project.project_id;
}

describe('/api/session-costs', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
  }, APP_SETUP_TIMEOUT_MS);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  test('markup math is exact for a single project', async () => {
    const email = uniqueEmail('cost-single');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const workspaceId = await provision(app, token, 'Usage Single');
    mock.seedSessionCosts(workspaceId, [
      { session_id: 's1', total_cost: 10 },
      { session_id: 's2', total_cost: 2.5 },
    ]);

    const res = await fetch(`${app.baseUrl}/api/session-costs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      markup: number;
      totals: { raw: number; billed: number };
      projects: Array<{
        workspaceId: string;
        sessions: Array<{ billed_cost: number; total_cost: number }>;
      }>;
    };

    expect(data.markup).toBe(Number(COST_MARKUP));
    expect(data.totals.raw).toBe(12.5);
    expect(data.totals.billed).toBe(
      Math.round(12.5 * Number(COST_MARKUP) * 100) / 100,
    );
    expect(data).not.toHaveProperty('endUserRef');
    expect(data).not.toHaveProperty('by_end_user');
    expect(data).not.toHaveProperty('mine');
    expect(data).not.toHaveProperty('unattributed_cost');
    expect(JSON.stringify(data)).not.toMatch(REMOVED_ATTRIBUTION_PATTERN);

    const proj = data.projects.find((p) => p.workspaceId === workspaceId)!;
    expect(proj.sessions.find((s) => s.total_cost === 10)!.billed_cost).toBe(
      15,
    );
    expect(proj.sessions.find((s) => s.total_cost === 2.5)!.billed_cost).toBe(
      3.75,
    );
    expect(
      mock.requests.some(
        (request) =>
          request.path ===
          `/v1/usage/session-costs?project_id=${workspaceId}&limit=100&offset=0`,
      ),
    ).toBe(true);
  });

  test('sums across multiple owned projects', async () => {
    const email = uniqueEmail('cost-multi');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const p1 = await provision(app, token, 'Usage Multi 1');
    const p2 = await provision(app, token, 'Usage Multi 2');
    mock.seedSessionCosts(p1, [{ session_id: 'a', total_cost: 4 }]);
    mock.seedSessionCosts(p2, [{ session_id: 'b', total_cost: 6 }]);

    const res = await fetch(`${app.baseUrl}/api/session-costs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totals: { raw: number; billed: number };
      projects: unknown[];
    };
    expect(data.projects).toHaveLength(2);
    expect(data.totals.raw).toBe(10);
    expect(data.totals.billed).toBe(15); // 10 * 1.5
  });

  test('degrades gracefully when one owned project errors upstream', async () => {
    const email = uniqueEmail('cost-degrade');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const healthy = await provision(app, token, 'Usage Healthy');
    const broken = await provision(app, token, 'Usage Broken');
    mock.seedSessionCosts(healthy, [{ session_id: 'ok', total_cost: 8 }]);
    mock.failSessionCostsFor(broken);

    const res = await fetch(`${app.baseUrl}/api/session-costs`, {
      headers: { authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totals: { raw: number; billed: number };
      projects: Array<{
        workspaceId: string;
        sessions: unknown[];
        error?: string;
      }>;
    };

    const healthyEntry = data.projects.find((p) => p.workspaceId === healthy)!;
    const brokenEntry = data.projects.find((p) => p.workspaceId === broken)!;
    expect(healthyEntry.sessions).toHaveLength(1);
    expect(brokenEntry.sessions).toHaveLength(0);
    expect(brokenEntry.error).toBeTruthy();
    expect(data.totals.raw).toBe(8);
    expect(data.totals.billed).toBe(12);
  });
});
