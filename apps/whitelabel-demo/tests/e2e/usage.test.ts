/**
 * `/api/usage` — aggregates `GET /projects/:id/gateway/sessions` across every
 * project the caller owns, applies `COST_MARKUP`, and degrades gracefully if
 * one project's upstream call fails.
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { type AppInstance, loginUser, resetUsersStore, startApp, uniqueEmail } from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { COST_MARKUP, DEMO_PASSWORD, wrapperEnv, WRAPPER_KEY } from './env';

async function provision(app: AppInstance, token: string, name: string): Promise<string> {
  const res = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
    method: 'POST',
    headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' },
    body: JSON.stringify({ name }),
  });
  const project = (await res.json()) as { project_id: string };
  return project.project_id;
}

describe('/api/usage', () => {
  let mock: MockUpstream;
  let app: AppInstance;

  beforeAll(async () => {
    resetUsersStore();
    mock = createMockUpstream(WRAPPER_KEY);
    app = await startApp(wrapperEnv({ KORTIX_UPSTREAM: `${mock.url}/v1` }));
  }, 30_000);

  afterAll(async () => {
    await app?.stop();
    mock?.stop();
    resetUsersStore();
  });

  test('markup math is exact for a single project', async () => {
    const email = uniqueEmail('usage-single');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const projectId = await provision(app, token, 'Usage Single');
    mock.seedGatewaySessions(projectId, [
      { session_id: 's1', total_cost: 10 },
      { session_id: 's2', total_cost: 2.5 },
    ]);

    const res = await fetch(`${app.baseUrl}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      markup: number;
      totals: { raw: number; billed: number };
      projects: Array<{ projectId: string; sessions: Array<{ billed_cost: number; total_cost: number }> }>;
    };

    expect(data.markup).toBe(Number(COST_MARKUP));
    expect(data.totals.raw).toBe(12.5);
    expect(data.totals.billed).toBe(Math.round(12.5 * Number(COST_MARKUP) * 100) / 100);

    const proj = data.projects.find((p) => p.projectId === projectId)!;
    expect(proj.sessions.find((s) => s.total_cost === 10)!.billed_cost).toBe(15);
    expect(proj.sessions.find((s) => s.total_cost === 2.5)!.billed_cost).toBe(3.75);
  });

  test('sums across multiple owned projects', async () => {
    const email = uniqueEmail('usage-multi');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const p1 = await provision(app, token, 'Usage Multi 1');
    const p2 = await provision(app, token, 'Usage Multi 2');
    mock.seedGatewaySessions(p1, [{ session_id: 'a', total_cost: 4 }]);
    mock.seedGatewaySessions(p2, [{ session_id: 'b', total_cost: 6 }]);

    const res = await fetch(`${app.baseUrl}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as { totals: { raw: number; billed: number }; projects: unknown[] };
    expect(data.projects).toHaveLength(2);
    expect(data.totals.raw).toBe(10);
    expect(data.totals.billed).toBe(15); // 10 * 1.5
  });

  test('degrades gracefully when one owned project errors upstream', async () => {
    const email = uniqueEmail('usage-degrade');
    const token = await loginUser(app, email, DEMO_PASSWORD);
    const healthy = await provision(app, token, 'Usage Healthy');
    const broken = await provision(app, token, 'Usage Broken');
    mock.seedGatewaySessions(healthy, [{ session_id: 'ok', total_cost: 8 }]);
    mock.failGatewayFor(broken);

    const res = await fetch(`${app.baseUrl}/api/usage`, { headers: { authorization: `Bearer ${token}` } });
    expect(res.status).toBe(200);
    const data = (await res.json()) as {
      totals: { raw: number; billed: number };
      projects: Array<{ projectId: string; sessions: unknown[]; error?: string }>;
    };

    const healthyEntry = data.projects.find((p) => p.projectId === healthy)!;
    const brokenEntry = data.projects.find((p) => p.projectId === broken)!;
    expect(healthyEntry.sessions).toHaveLength(1);
    expect(brokenEntry.sessions).toHaveLength(0);
    expect(brokenEntry.error).toBeTruthy();
    // Totals reflect only the healthy project — one bad upstream doesn't 500 the whole response.
    expect(data.totals.raw).toBe(8);
    expect(data.totals.billed).toBe(12);
  });
});
