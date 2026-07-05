/**
 * The full wrapper-mode route policy matrix (`src/server/policy.ts`) as
 * enforced end-to-end through `/api/kortix/[...path]`, plus the per-user
 * ownership store (`src/server/users.ts`) it depends on: provisioning records
 * an owner, ownership persists across calls, and near-concurrent provisions
 * both land (no lost writes in the JSON-file store).
 */

import { afterAll, beforeAll, describe, expect, test } from 'bun:test';
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { APP_ROOT, type AppInstance, loginUser, resetUsersStore, startApp, uniqueEmail } from './harness';
import { createMockUpstream, type MockUpstream } from './mock-upstream';
import { DEMO_PASSWORD, WRAPPER_KEY, wrapperEnv } from './env';

describe('wrapper-mode policy matrix', () => {
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

  async function freshUser(prefix: string) {
    const email = uniqueEmail(prefix);
    const token = await loginUser(app, email, DEMO_PASSWORD);
    return { email, token };
  }

  function authed(token: string) {
    return { authorization: `Bearer ${token}` };
  }

  test('GET /projects is allowed and filtered to only the caller-owned projects', async () => {
    const { token } = await freshUser('list-filter');
    // A project that exists upstream but this user never provisioned.
    const other = mock.seedProject({ name: 'Someone Elses Project' });

    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'My Project' }),
    });
    expect(provision.status).toBe(201);
    const mine = (await provision.json()) as { project_id: string };

    const list = await fetch(`${app.baseUrl}/api/kortix/projects`, { headers: authed(token) });
    expect(list.status).toBe(200);
    const ids = ((await list.json()) as Array<{ project_id: string }>).map((p) => p.project_id);
    expect(ids).toContain(mine.project_id);
    expect(ids).not.toContain(other.project_id);
  });

  test('POST /projects (bare) is denied — provisioning must go through /projects/provision', async () => {
    const { token } = await freshUser('bare-post-denied');
    const res = await fetch(`${app.baseUrl}/api/kortix/projects`, {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Should be blocked' }),
    });
    expect(res.status).toBe(403);
  });

  test('POST /projects/provision is allowed and records ownership', async () => {
    const { token } = await freshUser('provision-records');
    const res = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Provisioned Project' }),
    });
    expect(res.status).toBe(201);
    const project = (await res.json()) as { project_id: string };

    const list = await fetch(`${app.baseUrl}/api/kortix/projects`, { headers: authed(token) });
    const ids = ((await list.json()) as Array<{ project_id: string }>).map((p) => p.project_id);
    expect(ids).toEqual([project.project_id]);
  });

  test('GET /projects/:id is forwarded when the caller owns it', async () => {
    const { token } = await freshUser('owned-forward');
    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Owned' }),
    });
    const project = (await provision.json()) as { project_id: string };

    mock.reset();
    const detail = await fetch(`${app.baseUrl}/api/kortix/projects/${project.project_id}`, {
      headers: authed(token),
    });
    expect(detail.status).toBe(200);
    expect((await detail.json() as { project_id: string }).project_id).toBe(project.project_id);
    expect(mock.requests).toHaveLength(1);
  });

  test('GET /projects/:id is 403 when the caller does not own it', async () => {
    const { token } = await freshUser('unowned-denied');
    const other = mock.seedProject({ name: 'Not Yours' });

    mock.reset();
    const res = await fetch(`${app.baseUrl}/api/kortix/projects/${other.project_id}`, {
      headers: authed(token),
    });
    expect(res.status).toBe(403);
    // Never even reached upstream — denied at the policy layer.
    expect(mock.requests).toHaveLength(0);
  });

  test('GET /executor/projects/:id/... is forwarded when the caller owns the project', async () => {
    const { token } = await freshUser('executor-owned');
    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Executor Owned' }),
    });
    const project = (await provision.json()) as { project_id: string };

    mock.reset();
    const res = await fetch(`${app.baseUrl}/api/kortix/executor/projects/${project.project_id}/connectors`, {
      headers: authed(token),
    });
    expect(res.status).toBe(200);
    expect(mock.requests).toHaveLength(1);
    expect(mock.requests[0]!.path).toBe(`/v1/executor/projects/${project.project_id}/connectors`);
  });

  test('GET /executor/projects/:id/... is 403 when the caller does not own the project', async () => {
    const { token } = await freshUser('executor-unowned');
    const other = mock.seedProject({ name: 'Executor Not Yours' });

    const res = await fetch(`${app.baseUrl}/api/kortix/executor/projects/${other.project_id}/connectors`, {
      headers: authed(token),
    });
    expect(res.status).toBe(403);
  });

  test('GET /accounts/me is allowed', async () => {
    const { token } = await freshUser('accounts-me');
    const res = await fetch(`${app.baseUrl}/api/kortix/accounts/me`, { headers: authed(token) });
    expect(res.status).toBe(200);
  });

  test('GET /accounts (bare, or any other accounts/* route) is denied', async () => {
    const { token } = await freshUser('accounts-denied');
    const bare = await fetch(`${app.baseUrl}/api/kortix/accounts`, { headers: authed(token) });
    expect(bare.status).toBe(403);
    const members = await fetch(`${app.baseUrl}/api/kortix/accounts/acct_test/members`, {
      headers: authed(token),
    });
    expect(members.status).toBe(403);
  });

  test('billing/* and platform/* are denied by default', async () => {
    const { token } = await freshUser('billing-platform-denied');
    const billing = await fetch(`${app.baseUrl}/api/kortix/billing/invoices`, { headers: authed(token) });
    expect(billing.status).toBe(403);
    const platform = await fetch(`${app.baseUrl}/api/kortix/platform/sandboxes`, { headers: authed(token) });
    expect(platform.status).toBe(403);
  });

  test('/p/... (sandbox runtime proxy) is allowed for any valid session', async () => {
    const { token } = await freshUser('p-allowed');
    const res = await fetch(`${app.baseUrl}/api/kortix/p/sbx_random/8000/status`, {
      headers: authed(token),
    });
    expect(res.status).toBe(200);
  });

  test('users store: near-concurrent provisions from the same user both land (no lost writes)', async () => {
    const { token, email } = await freshUser('concurrent-provision');
    const [a, b] = await Promise.all([
      fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
        method: 'POST',
        headers: { ...authed(token), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Concurrent A' }),
      }),
      fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
        method: 'POST',
        headers: { ...authed(token), 'content-type': 'application/json' },
        body: JSON.stringify({ name: 'Concurrent B' }),
      }),
    ]);
    expect(a.status).toBe(201);
    expect(b.status).toBe(201);
    const [pa, pb] = (await Promise.all([a.json(), b.json()])) as Array<{ project_id: string }>;
    expect(pa.project_id).not.toBe(pb.project_id);

    const list = await fetch(`${app.baseUrl}/api/kortix/projects`, { headers: authed(token) });
    const ids = ((await list.json()) as Array<{ project_id: string }>).map((p) => p.project_id);
    expect(ids.sort()).toEqual([pa.project_id, pb.project_id].sort());

    const store = JSON.parse(readFileSync(join(APP_ROOT, '.lumen-data', 'users.json'), 'utf8'));
    expect(store[email].sort()).toEqual([pa.project_id, pb.project_id].sort());
  });

  test('users store: ownership persists across separate proxy calls (a later "page load")', async () => {
    const { token, email } = await freshUser('persistence');
    const provision = await fetch(`${app.baseUrl}/api/kortix/projects/provision`, {
      method: 'POST',
      headers: { ...authed(token), 'content-type': 'application/json' },
      body: JSON.stringify({ name: 'Persisted' }),
    });
    const project = (await provision.json()) as { project_id: string };

    expect(existsSync(join(APP_ROOT, '.lumen-data', 'users.json'))).toBe(true);

    // Simulate a fresh page load: brand-new fetch, same bearer token.
    const later = await fetch(`${app.baseUrl}/api/kortix/projects/${project.project_id}`, {
      headers: authed(token),
    });
    expect(later.status).toBe(200);

    const store = JSON.parse(readFileSync(join(APP_ROOT, '.lumen-data', 'users.json'), 'utf8'));
    expect(store[email]).toContain(project.project_id);
  });
});
